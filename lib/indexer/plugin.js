/*!
 * plugin.js - indexer plugin for bcoin
 * Copyright (c) 2017-2018, Christopher Jeffrey (MIT License).
 * https://github.com/handshake-org/hsd
 */

'use strict';

const EventEmitter = require('events');
const FullNodeIndexer = require('./fullnodeindexer');

/**
 * @exports indexer/plugin
 */

const plugin = exports;

/**
 * Plugin
 * @extends EventEmitter
 */

class Plugin extends EventEmitter {
  /**
   * Create a plugin.
   * @constructor
   * @param {Node} node
   */

  constructor(node) {
    super();

    this.indexer = new FullNodeIndexer(node);
  }

  init() {
    this.indexer.init();
  }

  async open() {
    await this.indexer.open();
  }

  async close() {
    await this.indexer.close();
  }
}

/**
 * Plugin name.
 * @const {String}
 */

plugin.id = 'indexer';

/**
 * Plugin initialization.
 * @param {Node} node
 * @returns {WalletDB}
 */

plugin.init = function init(node) {
  return new Plugin(node);
};
