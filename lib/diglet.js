'use strict';

const { createLogger } = require('bunyan');
const merge = require('merge');
const async = require('async')
// const https = require('https');
const { EventEmitter } = require('events');
const Server = require('./server');
const Frontend = require('./frontend');


/**
 * Manages a diglet instance
 */
class Diglet extends EventEmitter {

  static get DEFAULTS() {
    return {
      hostname: 'tunnel.deadcanaries.org',
      proxyPort: 443,
      redirectPort: 80,
      tunnelPort: 8443,
      serverPrivateKey: null,
      serverSSLCertificate: null,
      whitelist: false,
      logger: createLogger({ name: 'diglet' }),
    };
  }

  _checkOptions(o) {
    o.proxyPort = parseInt(o.proxyPort);
    o.tunnelPort = parseInt(o.tunnelPort);
    o.redirectPort = parseInt(o.redirectPort);
    return o;
  }

  /**
   * @constructor
   * @param {object} [options]
   */
  constructor(options = {}) {
    super();

    this._opts = this._checkOptions(merge(Diglet.DEFAULTS, options));
    this._logger = this._opts.logger;

    this._credentials = {
      key: this._opts.serverPrivateKey,
      cert: this._opts.serverSslCertificate
    };

    this.server = new Server({
      ...this._opts,
      ...this._credentials
    });
    this.frontend = new Frontend({
      tlsCredentials: this._credentials,
      ...this._opts
    });

    this.frontend.on('INCOMING_HTTPS', ({ proxy, request, response, next }) => {
      this.server.routeHttpRequest(proxy, request, response, next);
    });
    this.frontend.on('INCOMING_WSS', ({ proxy, request, socket }) => {
      this.server.routeWebSocketConnection(proxy, request, socket);
    });
    this.frontend.on('PROXY_QUERY', ({ proxy, queryHandler }) => {
      queryHandler(this.server.getProxyInfoById(proxy));
    });
  }

  /**
   * Establishes the server in a forked process
   */
  listen(callback) {
    async.parallel([
      (done) => this.server.listen(this._opts.tunnelPort, done),
      (done) => this.frontend.listen(this._opts.proxyPort, done),
      (done) => this.frontend.redirect(this._opts.redirectPort, done)
    ], err => {
      callback(err);
    });
  }

  /**
   * Closes servers
   */
  close() {
    this.frontend.proxy.close();
    this.frontend.redirect.close();
    this.server._server.close();
  }

}

module.exports = Diglet;
