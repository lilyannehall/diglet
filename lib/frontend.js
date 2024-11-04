'use strict';

const { HSTS_POLICY_HEADER } = require('./server');
const path = require('path');
const express = require('express');
const serveStatic = require('serve-static');
const pkg = require('../package');
const merge = require('merge');
const tld = require('tldjs');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');

/**
 * Frontend application that provides an interface to route incoming
 * connections
 */
class Frontend extends EventEmitter {

  static get DEFAULTS() {
    return {
      tlsCredentials: { key: null, cert: null }
    };
  }

  /**
   * @constructor
   */
  constructor(options){
    super();
    this._opts = this._checkOptions(merge(Frontend.DEFAULTS, options));
    this._credentials = this._opts.tlsCredentials;
    this._started = Date.now();
    this._app = express();

    this._bootstrap();
  }

  /**
   * @private
   */
  _bootstrap() {
    this._app.set('view engine', 'pug');
    this._app.set('views', path.join(__dirname, '../web/views'));
    this._app.use(serveStatic(path.join(__dirname, '../web/static')));
    this._app.use(this.handleServerRequest.bind(this));
    this._app.get('/', this._serveRoot.bind(this));
    this._app.get('/:id', this._serveTunnelInfo.bind(this));
    this._app.use((req, res) => this._serveMissing(req, res));
    this._app.use((err, req, res, next) =>
      this._serveError(err, req, res, next));
  }

  /**
   * @private
   */
  _serveRoot(request, response) {
    const locals = {
      version: pkg.version,
      started: this._started
    };

    response.format({
      html: () => response.render('landing', locals),
      json: () => response.json(locals)
    });
  }

  /**
   * @private
   */
  _serveTunnelInfo(request, response, next) {
    const proxy = request.params.id;

    this.emit('PROXY_QUERY', {
      proxy,
      queryHandler(info) {
        if (!info) {
          const err = new Error(
            `Our server moles could not find info on the tunnel "${proxy}".`
          );
          err.code = 404;
          return next(err);
        }

        response.format({
          html: () => response.render('info', info),
          json: () => response.json(info)
        });
      }
    });
  }

  /**
   * @private
   */
  _serveMissing(request, response) {
    const error = {
      code: 404,
      message: 'Our server moles could not find that resource.'
    };
    this._serveMissingOrError(error, request, response);
  }

  /**
   * @private
   */
  _serveError(error, request, response, next) {
    if (!error) {
      return next();
    }
    error.code = 500;
    this._serveMissingOrError(error, request, response);
  }

  /**
   * @private
   */
  _serveMissingOrError(error, request, response) {
    const code = error.code || 500;

    response.append('Strict-Transport-Security', HSTS_POLICY_HEADER);
    response.status(code);
    response.format({
      html: () => response.render('error', { code, message: error.message }),
      json: () => response.json({ code, message: error.message })
    });
    response.connection.destroy();
  }

  /**
   * @private
   */
  _checkOptions(o) {
    return o;
  }

  static getProxyIdFromSubdomain(request, hostname) {
    let subdomain = tld.getSubdomain(request.headers.host);
    let parts = subdomain ? subdomain.split('.') : [];

    if (request.headers.host === hostname) {
      return '';
    } else if (parts.length > 1) {
      return parts[0];
    } else {
      return subdomain;
    }
  }

  handleServerRequest(request, response, next) {
    let proxyId = Frontend.getProxyIdFromSubdomain(request,
      this._opts.hostname);

    if (!proxyId) {
      return next();
    }

    this.emit('INCOMING_HTTPS', { proxy: proxyId, request, response, next });
  }

  handleServerUpgrade(request, socket) {
    let proxyId = Frontend.getProxyIdFromSubdomain(request,
      this._opts.hostname);

    if (!proxyId) {
      return socket.destroy();
    }

    this.emit('INCOMING_WSS', { proxy: proxyId, request, socket });
  }

  listen() {
    this.proxy = https.createServer(this._credentials, this._app);

    this.proxy.on('upgrade', (req, sock) => {
      this.handleServerUpgrade(req, sock);
    });

    this.proxy.listen(...arguments);
  }

  redirect() {
    this.redirect = http.createServer(function(req, res) {
      res.writeHead(301, {
        Location: `https://${req.headers.host}${req.url}`
      });
      res.end();
    }).listen(...arguments);
  }

}

module.exports = Frontend;
