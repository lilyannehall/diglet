#!/usr/bin/env node

'use strict';

const { camelCase } = require('camel-case');
const colors = require('colors/safe');
const pkg = require('../package');
const fs = require('fs');
const async = require('async');
const https = require('https');
const Diglet = require('..');
const path = require('path');
const bunyan = require('bunyan');
const config = require('./_config');
const program = require('commander');

const started = Date.now();
const cpus = require('os').cpus().length;

program
  .version(require('../package').version)
  .option('-d, --debug', 'show verbose logs')
  .parse(process.argv);

if (!config.ServerPrivateKey || !config.ServerSSLCertificate) {
  console.error('\n  error: no private key or certificate defined in config');
  process.exit(1);
}

config.ServerPrivateKey = fs.readFileSync(config.ServerPrivateKey);
config.ServerSSLCertificate = fs.readFileSync(config.ServerSSLCertificate);

const logger = bunyan.createLogger({
  name: 'diglet-server',
  level: program.debug ? 'info' : 'error'
});
const options = {};

for (let prop in config) {
  options[camelCase(prop)] = config[prop];
}

const app = new Diglet({
  logger,
  ...options
});


console.info(colors.bold(fs.readFileSync(
  path.join(__dirname, '../logo.txt')).toString()));
console.info(colors.italic(fs.readFileSync(
  path.join(__dirname, '../copyright.txt')).toString()));

app.listen(function() {
  console.info(colors.bold('  Your proxy frontend is available at the following URL(s):'));
  console.info('  ');
  console.info(`      https://${config.Hostname}:${config.ProxyPort}`);
  console.info(`      https://*.${config.Hostname}:${config.ProxyPort}`);
  console.info('  ');
  console.log(colors.bold(`   Your tunnel backend is available at the following URL(s):`));
  console.info('  ');
  console.info(`      https://${config.Hostname}:${config.TunnelPort}`);
  console.info('  ');
});


