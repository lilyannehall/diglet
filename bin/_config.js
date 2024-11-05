'use strict';

const config = require('rc')('diglet', {
  Hostname: 'tun.tacticalchihuahua.lol',
  ProxyPort: 443,
  RedirectPort: 80,
  TunnelPort: 8443,
  ServerPrivateKey: '',
  ServerSSLCertificate: '',
  Whitelist: false
});

module.exports = config;
