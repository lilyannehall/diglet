'use strict';

if (require('is-electron')()) {
  require('./app');
} else {
  module.exports = require('./lib');
}

