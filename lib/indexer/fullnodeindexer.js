/*!
 * fullnodeindexer.js - full node indexer for bcoin
 * Copyright (c) 2018, the bcoin developers (MIT License).
 * https://github.com/bcoin-org/bcoin
 */

'use strict';

const assert = require('bsert');
const EventEmitter = require('events');
const Validator = require('bval');
const TXIndexer = require('./txindexer');
const AddrIndexer = require('./addrindexer');
const MempoolIndexer = require('./mempoolindexer');
const Address = require('../primitives/address');

/**
 * FullNodeIndexer
 * @alias module:indexer.FullNodeIndexer
 * @extends EventEmitter
 */

class FullNodeIndexer extends EventEmitter {
  /**
   * Create a indexer
   * @constructor
   * @param {Object} options
   */

  constructor(node) {
    super();

    const options = {
      network: node.network,
      logger: node.logger,
      node: node,
      chain: node.chain,
      mempool: node.mempool,
      memory: node.config.bool('memory'),
      prefix: node.config.filter('index').str('prefix') || node.config.prefix
    };

    this.chain = node.chain; // TODO: remove
    this.mempoolindex = new MempoolIndexer(options);
    this.spv = node.chain.options.spv;
    this.txindex = null;
    this.addrindex = null;

    if (node.config.bool('index-tx'))
      this.txindex = new TXIndexer(options);

    if (node.config.bool('index-address'))
      this.addrindex = new AddrIndexer(options);

    // UTXO by address
    node.http.get('/coin/address/:address', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const address = valid.str('address');

      enforce(address, 'Address is required.');
      enforce(!this.spv, 'Cannot get coins in SPV mode.');

      const addr = Address.fromString(address, this.network);
      const coins = await this.getCoinsByAddress(addr);
      const result = [];

      for (const coin of coins)
        result.push(coin.getJSON(this.network));

      res.json(200, result);
    });

    // Bulk read UTXOs
    node.http.post('/coin/address', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const address = valid.array('addresses');

      enforce(address, 'Address is required.');
      enforce(!this.spv, 'Cannot get coins in SPV mode.');

      const coins = await this.getCoinsByAddress(address);
      const result = [];

      for (const coin of coins)
        result.push(coin.getJSON(this.network));

      res.json(200, result);
    });

    // TX by hash
    node.http.get('/tx/:hash', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const hash = valid.brhash('hash');

      enforce(hash, 'Hash is required.');
      enforce(!this.spv, 'Cannot get TX in SPV mode.');

      const meta = await this.getMeta(hash);

      if (!meta) {
        res.json(404);
        return;
      }

      const view = await this.getMetaView(meta);

      res.json(200, meta.getJSON(this.network, view, node.chain.height));
    });

    // TX by address
    node.http.get('/tx/address/:address', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const address = valid.str('address');

      enforce(address, 'Address is required.');
      enforce(!this.spv, 'Cannot get TX in SPV mode.');

      const addr = Address.fromString(address, this.network);
      const metas = await this.getMetaByAddress(addr);
      const result = [];

      for (const meta of metas) {
        const view = await this.getMetaView(meta);
        result.push(meta.getJSON(this.network, view, node.chain.height));
      }

      res.json(200, result);
    });

    // Bulk read TXs
    node.http.post('/tx/address', async (req, res) => {
      const valid = Validator.fromRequest(req);
      const address = valid.array('addresses');

      enforce(address, 'Address is required.');
      enforce(!this.spv, 'Cannot get TX in SPV mode.');

      const metas = await this.getMetaByAddress(address);
      const result = [];

      for (const meta of metas) {
        const view = await this.getMetaView(meta);
        result.push(meta.getJSON(this.network, view, node.chain.height));
      }

      res.json(200, result);
    });
  }

  init() {
    if (this.txindex)
      this.txindex.on('error', err => this.emit('error', err));

    if (this.addrindex)
      this.addrindex.on('error', err => this.emit('error', err));

    this.mempoolindex.on('error', err => this.emit('error', err));
  }

  async open() {
    if (this.txindex)
      await this.txindex.open();

    if (this.addrindex)
      await this.addrindex.open();
  }

  async close() {
    if (this.txindex)
      await this.txindex.close();

    if (this.addrindex)
      await this.addrindex.close();
  }

  /**
   * Test whether the mempool or tx index contains a transaction.
   * @param {Hash} hash
   * @returns {Promise} - Returns Boolean.
   */

  async hasTX(hash) {
    if (this.mempoolindex.hasTX(hash))
      return true;

    if (this.txindex)
      return this.txindex.hasTX(hash);

    return false;
  }

  /**
   * Retrieve a transaction.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link TX}.
   */

  async getTX(hash) {
    const mtx = await this.getMeta(hash);

    if (!mtx)
      return null;

    return mtx.tx;
  }

  /**
   * Get a transaction with metadata.
   * @param {Hash} hash
   * @returns {Promise} - Returns {@link TXMeta}.
   */

  async getMeta(hash) {
    const meta = await this.mempoolindex.getMeta(hash);

    if (meta)
      return meta;

    if (this.txindex)
        return this.txindex.getMeta(hash);

    return null;
  }

  /**
   * Retrieve a spent coin viewpoint from mempool or tx index.
   * @TODO: depends on chain for backward compat - remove
   * @param {TXMeta} meta
   * @returns {Promise} - Returns {@link CoinView}.
   */

  async getMetaView(meta) {
    if (meta.height === -1)
      return this.mempoolindex.getSpentView(meta.tx);

    if (this.txindex)
      return this.txindex.getSpentView(meta.tx);

    return this.chain.getCoinView(meta.tx);
  }

  /**
   * Retrieve transactions pertaining to an
   * address from the mempool or chain database.
   * @param {Address} addrs
   * @returns {Promise} - Returns {@link TX}[].
   */

  async getTXByAddress(addrs) {
    const mtxs = await this.getMetaByAddress(addrs);
    const out = [];

    for (const mtx of mtxs)
      out.push(mtx.tx);

    return out;
  }

  /**
   * Retrieve transactions pertaining to an
   * address from the mempool or chain database.
   * @param {Address} addrs
   * @returns {Promise} - Returns {@link TXMeta}[].
   */

  async getMetaByAddress(addrs) {
    const mempool = this.mempoolindex.getMetaByAddress(addrs);

    if (this.txindex && this.addrindex) {
      if (!Array.isArray(addrs))
        addrs = [addrs];

      const hashes = await this.addrindex.getHashesByAddress(addrs);
      const mtxs = [];

      for (const hash of hashes) {
        const mtx = await this.txindex.getMeta(hash);
        assert(mtx);
        mtxs.push(mtx);
      }
      return mtxs.concat(mempool);
    }

    return mempool;
  }

  /**
   * Get all coins pertinent to an address.
   * @param {Address[]} addrs
   * @returns {Promise} - Returns {@link Coin}[].
   */

  async getCoinsByAddress(addrs) {
    if (this.addrindex)
      return this.addrindex.getCoinsByAddress(addrs);

    return [];
  }
}

/*
 * Helpers
 */

function enforce(value, msg) {
  if (!value) {
    const err = new Error(msg);
    err.statusCode = 400;
    throw err;
  }
}

module.exports = FullNodeIndexer;
