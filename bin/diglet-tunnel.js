#!/usr/bin/env node

'use strict';

const colors = require('colors/safe');
const path = require('path');
const os = require('os');
const bunyan = require('bunyan');
const diglet = require('..');
const config = require('./_config');
const fs = require('fs');
const { randomBytes } = require('crypto');
const secp256k1 = require('secp256k1');
const httpServer = require('http-server');
const program = require('commander');
const DEFAULT_KEY_PATH = path.join(os.homedir(), '.diglet.prv');


program
  .version(require('../package').version)
  .option('--port <port>', 'local port to reverse tunnel')
  .option('--save [path]', 'save the generated key')
  .option('--load [path]', 'load the saved key')
  .option('--https', 'indicate the local server uses tls')
  .option('--www [public_dir]', 'start a static server in the given directory')
  .option('--debug', 'show verbose logs')
  .parse(process.argv);

if (program.save && program.load) {
  console.error('\n  error: cannot use `--save` and `--load` together');
  process.exit(1);
}

if (program.save && typeof program.save !== 'string') {
  program.save = DEFAULT_KEY_PATH;
}

if (program.load && typeof program.load !== 'string') {
  program.load = DEFAULT_KEY_PATH;
}

function startLocalStaticServer() {
  return new Promise(function(resolve) {
    const www = httpServer.createServer({
      root: typeof program.www === 'string'
        ? program.www
        : './'
    });

    www.listen(program.port ? parseInt(program.port) : 0, function() {
      program.port = www.server.address().port;

      console.info('  ');
      console.info(colors.bold('  Local static web server:'));
      console.info('  ');
      console.info(`      http://localhost:${program.port}`);

      resolve();
    });
  });
}

function getPrivateKey() {
  if (program.load) {
    return fs.readFileSync(program.load);
  }

  let key = Buffer.from([]);

  while (!secp256k1.privateKeyVerify(key)) {
    key = randomBytes(32);
  }

  if (program.save) {
    fs.writeFileSync(program.save, key);
  }

  return key;
}

function getTunnel() {
  const logger = bunyan.createLogger({ name: 'diglet-client', level: program.debug ? 'info' : 'error' });
  const tunnel = new diglet.Tunnel({
    localAddress: '127.0.0.1',
    localPort: parseInt(program.port),
    remoteAddress: config.Hostname,
    remotePort: config.TunnelPort,
    logger,
    privateKey: getPrivateKey(),
    secureLocalConnection: program.https
  });

  return tunnel;
}

console.info(colors.bold(fs.readFileSync(
  path.join(__dirname, '../logo.txt')).toString()));
console.info(colors.italic(fs.readFileSync(
  path.join(__dirname, '../copyright.txt')).toString()));

const start = async function() {
  if (program.www) {
    await startLocalStaticServer();
  }

  const tunnel = getTunnel();

  console.info('  ');
  console.info(colors.bold('  Check tunnel info and diagnostics:'));
  console.info('  ');
  console.info(`      https://${config.Hostname}/${tunnel.id}`);

  tunnel.once('connected', () => {
    console.info('  ');
    console.info(colors.bold('  Your tunnel is available at the following URL(s):'));
    console.info('  ');
    console.info(`      ${tunnel.url}`);

    tunnel.queryProxyInfoFromServer({ rejectUnauthorized: false })
      .then(info => {
        console.info(`      ${tunnel.aliasUrl(info.alias)}`);
        console.info('  ');
        console.info('  ');
      })
      .catch(err => {
        console.error(`  ERR! ${err.message}`);
      });
  });

  tunnel.open();
};

start();

