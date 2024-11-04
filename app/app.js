'use strict';

const { ipcRenderer, remote } = require('electron');
const { shell, app, dialog } = remote;

const async = require('async');
const { randomBytes } = require('crypto');
const config = require('../bin/_config');
const bunyan = require('bunyan');
const httpServer = require('http-server');
const { Tunnel } = require('../lib');
const Vue = require('vue/dist/vue');


const diglet = new Vue({
  el: '#app',
  data: {
    tunnels: [],
    showPortField: false,
    portFieldValue: ''
  },
  methods: {
    addFiles: function() {
      remote.dialog.showOpenDialog({
        title: 'Select Directory',
        buttonLabel: 'Establish Tunnel',
        properties: ['openDirectory']
      }).then(result => {
        if (result.filePaths.length) {
          this.tunnels.push({ rootdir: result.filePaths.join(',') });
        }
      });
    },
    togglePortPrompt: function() {
      this.showPortField = !this.showPortField;
      setTimeout(() => {
        if (this.$refs.port) {
          this.$refs.port.focus();
        }
      }, 10);
    },
    clickOutsidePrompt: function(e) {
      if (this.showPortField) {
        if (e.target.className.includes('_prompt')) {
          e.stopPropagation();
        } else {
          this.togglePortPrompt();
        }
      }
    },
    addService: function() {
      const win = remote.getCurrentWindow();
      const port = parseInt(this.portFieldValue);

      if (port && !Number.isNaN(port) && Number.isFinite(port) && port > 0) {
        this.tunnels.push({ localServerPort: port });
      } else {
        dialog.showMessageBox(win, {
          type: 'error',
          message: `The port ${port} is not valid, try again.`,
          buttons: ['Dismiss']
        });
      }

      this.showPortField = false;
      this.portFieldValue = '';
    },
    closeWindow: function() {
      const win = remote.getCurrentWindow();

      if (!this.tunnels.length) {
        win.close();
      } else {
        dialog.showMessageBox(win, {
          type: 'question',
          message: 'Are you sure you want to terminate any active tunnels?',
          buttons: ['Cancel', 'Terminate & Exit']
        }).then(({ response }) => {
          if (response === 1) {
            win.close();
          }
        });
      }
    },
    maxWindow: function() {
      const win = remote.getCurrentWindow();
      if (!win.isMaximized()) {
        win.maximize();
      } else {
        win.unmaximize();
      }
    },
    minWindow: function() {
      const win = remote.getCurrentWindow();
      win.minimize();
    }
  },
  mounted: function() {
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    });
    document.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }
});

const tunnel = Vue.component('tunnel', {
  data: function() {
    return {
      isShutdown: false,
      loading: false,
      tunnelEstablished: false,
      tunnelUrls: [],
      error: '',
    };
  },
  methods: {
    setupWebServer: function(cb) {
      if (!this.rootdir) {
        return cb(); // NB: Tunnel was created with a port
      }

      this.server = httpServer.createServer({
        root: this.rootdir
      });

      this.server.listen(0, () => {
        cb && cb();
      });
    },
    establishTunnel: function(cb) {
      this.tunnelUrls = [];
      this.logger = bunyan.createLogger({ name: 'digletapp' });
      this.tunnel = new Tunnel({
        localAddress: '127.0.0.1',
        localPort: this.localPortTarget,
        remoteAddress: config.Hostname,
        remotePort: parseInt(config.TunnelPort),
        logger: this.logger,
        privateKey: randomBytes(32),
      });

      this.tunnel.once('connected', () => {
        this.tunnelUrls.push(this.tunnel.url);
        this.tunnel.queryProxyInfoFromServer({ rejectUnauthorized: false })
          .then(info => {
            this.tunnelUrls.push(this.tunnel.aliasUrl(info.alias));
            cb && cb();
          })
          .catch(cb);
      });

      this.tunnel.once('error', cb);
      this.tunnel.open();
    },
    init: function() {
      this.loading = true;
      async.series([
        (cb) => this.setupWebServer(cb),
        (cb) => this.establishTunnel(cb)
      ], err => {
        this.loading = false;
        this.error = err ? err.message : '';
        this.tunnelEstablished = !!err;
      });
    },
    openLink: function(url) {
      shell.openExternal(url);
    },
    shutdown: function() {
      const win = remote.getCurrentWindow();
      const name = this.rootdir || `localhost:${this.localServerPort}`;

      dialog.showMessageBox(win, {
        type: 'question',
        message: `Terminate the tunnel for ${name}?`,
        buttons: ['Cancel', 'Terminate']
      }).then(({ response }) => {
        if (response === 1) {
          if (this.server) {
            this.server.server.close();
          }
          this.tunnel.close();
          this.isShutdown = true;
          this.loading = false;
        }
      })
    }
  },
  props: {
    rootdir: {
      type: String,
      default: ''
    },
    localServerPort: {
      type: Number,
      default: 0
    }
  },
  mounted: function() {
    this.init();
  },
  computed: {
    localPortTarget: function() {
      if (this.server) {
        return this.server.server.address().port;
      } else {
        return this.localServerPort;
      }
    }
  },
  template: `
    <div class="tunnel">
      <ul>
        <li class="status-icon">
          <img class="left status" src="assets/vendor/adwaita-scalable/status/network-error-symbolic.svg" v-if="error || isShutdown">
          <img class="left status" src="assets/vendor/adwaita-scalable/status/network-no-route-symbolic.svg" v-if="!error && loading">
          <img class="left status" src="assets/vendor/adwaita-scalable/status/network-transmit-receive-symbolic.svg" v-if="!error && !loading && !isShutdown">
        </li>
        <li class="tunnel-info">
          <ul>
            <li v-if="rootdir"><i class="fas fa-folder"></i> {{rootdir}}</li>
            <li v-if="!rootdir && localServerPort"><i class="fas fa-desktop"></i> localhost:{{localServerPort}}</li>
            <li v-if="!isShutdown"><i class="fas fa-link"></i> <a href="#" v-on:click="openLink(tunnelUrls[tunnelUrls.length - 1])">{{tunnelUrls[tunnelUrls.length - 1]}}</a></li>
            <li v-if="isShutdown"><span class="error">{{error || 'Terminated by user'}}</span></li>
          </ul>
        </li>
        <li class="right" v-if="!isShutdown">
          <button class="action right" v-on:click="shutdown"><img src="assets/vendor/adwaita-scalable/actions/process-stop-symbolic.svg"></button>
        </li>
      </ul>
    </div>
  `
});
