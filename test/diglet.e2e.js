'use strict';

const async = require('async');
const { Diglet, Tunnel } = require('..');
const { expect } = require('chai');
const pem = require('pem');
const http = require('http');
const https = require('https');
const ws = require('ws');
const { randomBytes } = require('crypto');
const logger = require('bunyan').createLogger({ name: '_', level: 'fatal' });

describe('@class Server + @Tunnel (end-to-end)', function() {

  let diglet, privkey, local, wss, tunnel;

  before(function(done) {
    privkey = randomBytes(32);

    async.series([
      // Create the diglet server
      function(next) {
        pem.createCertificate({
          days: 1,
          selfSigned: true
        }, function (err, keys) {
          if (err) {
            return next(err);
          }
          diglet = new Diglet({
            logger,
            hostname: '127.0.0.1',
            proxyPort: 9443,
            redirectPort: 9080,
            tunnelPort: 9444,
            serverSslCertificate: keys.certificate,
            serverPrivateKey: keys.serviceKey,
            getAliasById: () => '127', // NB: domain hack for local testing
          });

          diglet.listen(next);
        });
      },
      // Create the local server(s)
      function(next) {
        local = http.createServer(function(req, res) {
          res.writeHead(200);
          res.write('hello diglet');
          res.end();
        });
        wss = new ws.Server({ server: local });

        wss.on('connection', function(sock) {
          sock.on('message', function(data) {
            sock.send(data);
          });
        });

        local.listen(9090, next);
      },
      // Create the tunnel connection
      function(next) {
        tunnel = new Tunnel({
          localAddress: 'localhost',
          localPort: 9090,
          remoteAddress: 'localhost',
          remotePort: 9444,
          privateKey: privkey,
          logger,
        });

        tunnel.once('connected', next).open();
      },
    ], done);
  });

  it('should get the proxy info', function(done) {
    tunnel.queryProxyInfoFromServer({
      port: 9443,
      rejectUnauthorized: false
    }).then(info => {
      expect(!!info.alias).to.equal(true);
      done();
    }, done);
  });

  it('should reverse tunnel the http requests (1000x)', function(done) {
    this.timeout(0);
    async.timesLimit(1000, 10, function(i, next) {
      let req = https.get({
        host: '127.0.0.1',
        port: 9443,
        path: '/',
        rejectUnauthorized: false
      }, function(res) {
        let body = '';
        res.on('data', function(data) {
          body += data.toString()
        });
        res.on('end', function() {
          expect(body).to.equal('hello diglet');
          expect(res.statusCode).to.equal(200);
          expect(typeof res.headers['strict-transport-security'])
            .to.equal('string');
          next();
        });
      });
      req.on('error', next);
    }, done);
  });

  it('should reverse tunnel the websocket connection (1000x)', function(done) {
    this.timeout(0);
    async.timesLimit(1000, 10, function(i, next) {
      const sock = new ws('wss://127.0.0.1:9443', {
        rejectUnauthorized: false
      });
      sock.on('open', function() {
        sock.send(`hello diglet ${i}`);
      });
      sock.on('message', function(data) {
        expect(data.toString()).to.equal(`hello diglet ${i}`);
        sock.close();
        next();
      });
      sock.on('error', next);
    }, done);
  });

  after(function(done) {
    diglet.close();
    local.close();
    done();
  });

});
