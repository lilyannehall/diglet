'use strict';

const { EventEmitter } = require('events');
const merge = require('merge');
const http = require('http');
const net = require('tls');
const { createLogger } = require('bunyan');
const crypto = require('crypto');
const Proxy = require('./proxy');
const Handshake = require('./handshake');
const randomWord = require('random-word');


/** Manages a collection of proxy tunnels and routing incoming requests */
class Server extends EventEmitter {

  static get HSTS_POLICY_HEADER() {
    return 'max-age=31536000; includeSubDomains';
  }

  static get DEFAULTS() {
    return {
      proxyMaxConnections: 96,
      logger: createLogger({ name: 'diglet' }),
      whitelist: false,
      key: null,
      cert: null,
      subdomainAliasLength: 2,
    };
  }

  /**
   * Represents a tunnel/proxy server
   * @param {Object} options
   * @param {Number} [options.proxyMaxConnections=48] - Max tunnels for proxy
   * @param {Object} [options.logger=console] - Custom logger to use
   */
  constructor(options) {
    super();

    this._opts = this._checkOptions(merge(Server.DEFAULTS, options));
    this._proxies = new Map();
    this._aliases = new Map();
    this._logger = this._opts.logger;
    this._server = net.createServer({
      key: this._opts.key,
      cert: this._opts.cert
    }, sock => this._handleTunnelClient(sock));

    this._getAliasForProxy = this._opts.getAliasById ||
      this._getRandomUnusedAlias;
  }

  /**
   * Listens for tunnel clients on the port
   * @param {number} port
   */
  listen() {
    this._server.listen(...arguments);
  }

  /**
   * Validates options given to constructor
   * @private
   */
  _checkOptions(o) {
    return o;
  }

  /**
   * Establishes a handshake with a tunnel client and creates a proxy
   * @private
   */
  _handleTunnelClient(socket) {
    const challenge = Handshake.challenge();

    socket.once('data', message => {
      this._logger.info('received challenge response from client');

      const handshake = Handshake.from(message);
      const id = crypto.createHash('rmd160').update(
        crypto.createHash('sha256').update(handshake.pubkey || '').digest()
      ).digest('hex');

      if (Buffer.compare(challenge, handshake.challenge) !== 0) {
        this._logger.info('invalid challenge response - bad challenge');
        return socket.destroy();
      }

      if (!handshake.verify()) {
        this._logger.info('invalid challenge response - bad signature');
        return socket.destroy();
      }

      if (this._opts.whitelist && this._opts.whitelist.indexOf(id) === -1) {
        this._logger.info('invalid challenge response - not in whitelist');
        return socket.destroy();
      }

      let proxy = this._proxies.get(id);

      if (!proxy) {
        proxy = this._proxies.get(id) || new Proxy({
          id,
          logger: this._logger,
        });

        this._aliases.set(this._getAliasForProxy(id), id);
        this._proxies.set(id, proxy);
      }

      proxy.push(socket);
    });

    socket.on('error', err => {
      this._logger.warn(err.message);
      socket.destroy();
    });

    this._logger.info('tunnel client opened, issuing challenge');
    socket.write(challenge);
  }

  /**
   * @private
   */
  _respondErrorNoTunnelConnected(proxyId, request, response, next) {
    this._logger.warn('no proxy with id %s exists', proxyId);

    const error = {
      code: 502,
      message: 'Our server moles found your tunnel, ' +
        'but there isn\'t anyone at the other end.'
    };

    next(error);
  }

  /**
   * @private
   */
  _respondErrorNotServicable(proxyId, request, response, next) {
    this._logger.warn('proxy with id %s cannot service request', proxyId);

    const error = {
      code: 504,
      message: 'Our server moles found your tunnel, ' +
        'but couldn\'t get through it. Try again later!'
    };

    next(error);
  }

  /**
   * Routes the incoming HTTP request to it's corresponding proxy
   * @param {String} proxyId - The unique ID for the proxy instance
   * @param {http.IncomingMessage} request
   * @param {http.ServerResponse} response
   */
  routeHttpRequest(proxyId, request, response, next) {
    if (this._aliases.has(proxyId)) {
      proxyId = this._aliases.get(proxyId);
    }

    const proxy = this._proxies.get(proxyId);

    this._logger.info('routing HTTP request to proxy');

    if (!proxy) {
      return this._respondErrorNoTunnelConnected(proxyId, request, response,
        next);
    }

    let responseDidFinish = false;

    const _onFinished = () => {
      this._logger.info('response finished, destroying connection');
      responseDidFinish = true;
      request.connection.destroy();
    };

    response
      .once('finish', _onFinished)
      .once('error', _onFinished)
      .once('close', _onFinished);

    const getSocketHandler = (proxySocket, addSocketBackToPool) => {
      if (responseDidFinish) {
        this._logger.warn('response already finished, aborting');
        return addSocketBackToPool && addSocketBackToPool();
      } else if (!proxySocket) {
        this._logger.warn('no proxied sockets back to client are available');
        return this._respondErrorNotServicable(proxyId, request, response,
          next);
      }

      const clientRequest = http.request({
        path: request.url,
        method: request.method,
        headers: request.headers,
        createConnection: () => proxySocket
      });

      const _forwardResponse = (clientResponse) => {
        this._logger.info('forwarding tunneled response back to requester');
        proxySocket.setTimeout(0);
        response.writeHead(clientResponse.statusCode, {
          'Strict-Transport-Security': Server.HSTS_POLICY_HEADER,
          ...clientResponse.headers
        });
        clientResponse.pipe(response);
      };

      this._logger.info('tunneling request through to client');
      proxySocket.setTimeout(8000);
      proxySocket.on('timeout', () => {
        this._respondErrorNotServicable(proxyId, request, response, next);
        clientRequest.abort();
        proxySocket.destroy();
      });
      response.once('finish', () => {
        addSocketBackToPool();
      });
      clientRequest.on('abort', () => proxy.pop(getSocketHandler));
      clientRequest.on('response', (resp) => _forwardResponse(resp));
      clientRequest.on('error', () => request.connection.destroy());
      request.pipe(clientRequest);
    };

    this._logger.info('getting proxy tunnel socket back to client...');
    proxy.pop(getSocketHandler);
  }

  /**
   * Routes the incoming WebSocket connection to it's corresponding proxy
   * @param {String} proxyId - The unique ID for the proxy instance
   * @param {http.IncomingMessage} request
   * @param {net.Socket} socket
   */
  routeWebSocketConnection(proxyId, request, socket) {
    if (this._aliases.has(proxyId)) {
      proxyId = this._aliases.get(proxyId);
    }

    const proxy = this._proxies.get(proxyId);

    if (!proxy) {
      return socket.destroy();
    }

    let socketDidFinish = false;

    socket.once('end', () => socketDidFinish = true);
    proxy.pop(function(proxySocket) {
      if (socketDidFinish) {
        return;
      } else if (!proxySocket) {
        socket.destroy();
        request.connection.destroy();
        return;
      }

      proxySocket.pipe(socket).pipe(proxySocket);
      proxySocket.write(Server.recreateWebSocketHeaders(request));
    });
  }

  /**
   * Recreates the header information for websocket connections
   * @private
   */
  static recreateWebSocketHeaders(request) {
    var headers = [
      `${request.method} ${request.url} HTTP/${request.httpVersion}`
    ];

    for (let i = 0; i < (request.rawHeaders.length - 1); i += 2) {
      headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
    }

    headers.push(`Strict-Transport-Security: ${Server.HSTS_POLICY_HEADER}`);
    headers.push('');
    headers.push('');

    return headers.join('\r\n');
  }

  /**
   * Returns some metadata / diagnostic information about a given proxy
   * @param {string} id - Public key hash
   * @returns {object}
   */
  getProxyInfoById(id) {
    if (!this._proxies.has(id)) {
      return null;
    }

    const info = this._proxies.get(id).info;
    const aliasIndex = [...this._aliases.values()].indexOf(id);
    const alias = [...this._aliases.keys()][aliasIndex];

    return { alias, ...info };
  }

  /**
   * Generates a human-readable subdomain to alias a pubkey
   * for this session
   * @param {array} exclude - Recurse until result is not in this list
   * @param {number} [words] - Total words to use
   * @private
   */
  _getRandomUnusedAlias() {
    let alias = '';

    while (alias.split('-').length <= this._opts.subdomainAliasLength) {
      alias += `-${randomWord()}`;
    }

    if (this._aliases.has(alias)) {
      return Server._getRandomUnusedAlias();
    }

    return alias.substr(1);
  }

}

module.exports = Server;
