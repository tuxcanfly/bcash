/* eslint-env mocha */
/* eslint prefer-arrow-callback: "off" */

'use strict';

const assert = require('./util/assert');
const reorg = require('./util/reorg');
const Chain = require('../lib/blockchain/chain');
const WorkerPool = require('../lib/workers/workerpool');
const Miner = require('../lib/mining/miner');
const MemWallet = require('./util/memwallet');
const MTX = require('../lib/primitives/mtx');
const TXIndexer = require('../lib/indexer/txindexer');
const AddrIndexer = require('../lib/indexer/addrindexer');
const Network = require('../lib/protocol/network');
const random = require('bcrypto/lib/random');
const network = Network.get('regtest');

const workers = new WorkerPool({
  enabled: true
});

const chain = new Chain({
  memory: true,
  network,
  workers
});

const miner = new Miner({
  chain,
  version: 4,
  workers
});

const cpu = miner.cpu;

const wallet = new MemWallet({
  network
});

const txindexer = new TXIndexer({
  'memory': true,
  'network': network,
  'chain': chain
});

const addrindexer = new AddrIndexer({
  'memory': true,
  'network': network,
  'chain': chain
});

chain.on('connect', (entry, block) => {
  wallet.addBlock(entry, block.txs);
});

chain.on('disconnect', (entry, block) => {
  wallet.removeBlock(entry, block.txs);
});

function less(a, b) {
  const ha = a.hash();
  const hb = b.hash();

  for (let i = 31; i >= 0; i--) {
    if (ha[i] < hb[i])
      return true;

    if (ha[i] > hb[i])
      return false;
  }

  return false;
}

describe('Indexer', function() {
  this.timeout(45000);

  it('should open indexer', async () => {
    await chain.open();
    await miner.open();
    await txindexer.open();
    await addrindexer.open();
  });

  it('should index 10 blocks', async () => {
    miner.addresses.length = 0;
    miner.addAddress(wallet.getReceive());
    for (let i = 0; i < 10; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }

    assert.strictEqual(chain.height, 10);
    assert.strictEqual(txindexer.state.startHeight, 10);
    assert.strictEqual(addrindexer.state.startHeight, 10);

    const coins =
      await addrindexer.getCoinsByAddress(miner.getAddress());
    assert.strictEqual(coins.length, 10);

    for (const coin of coins) {
      const meta = await txindexer.getMeta(coin.hash);
      assert.bufferEqual(meta.tx.hash(), coin.hash);
    }
  });

  it('should rescan and reindex 10 missed blocks', async () => {
    await txindexer.disconnect();
    await addrindexer.disconnect();

    for (let i = 0; i < 10; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }

    assert.strictEqual(chain.height, 20);

    await txindexer.connect();
    await addrindexer.connect();

    await new Promise(r => addrindexer.once('chain tip', r));

    assert.strictEqual(txindexer.state.startHeight, 20);
    assert.strictEqual(addrindexer.state.startHeight, 20);

    const coins =
      await addrindexer.getCoinsByAddress(miner.getAddress());
    assert.strictEqual(coins.length, 20);

    for (const coin of coins) {
      const meta = await txindexer.getMeta(coin.hash);
      assert.bufferEqual(meta.tx.hash(), coin.hash);
    }
  });

  it('should handle indexing a reorg', async () => {
    await reorg(chain, cpu, 10);

    assert.strictEqual(txindexer.state.startHeight, 31);
    assert.strictEqual(addrindexer.state.startHeight, 31);

    const coins =
      await addrindexer.getCoinsByAddress(miner.getAddress());
    assert.strictEqual(coins.length, 31);

    for (const coin of coins) {
      const meta = await txindexer.getMeta(coin.hash);
      assert.bufferEqual(meta.tx.hash(), coin.hash);
    }
  });

  it('should mine blocks more than coinbase height', async () => {
    miner.addresses.length = 0;
    miner.addAddress(wallet.getReceive());
    for (let i = 0; i < 100; i++) {
      const block = await cpu.mineBlock();
      assert(block);
      assert(await chain.add(block));
    }

    assert.strictEqual(chain.height, 131);
    assert.strictEqual(txindexer.state.startHeight, 131);
    assert.strictEqual(addrindexer.state.startHeight, 131);
  });

  it('should have correct coinview for unconfirmed chain', async () => {
    const job = await cpu.createJob();
    const block = await chain.getBlock(chain.height - 99);
    const cb = block.txs[0];
    const addr = wallet.getAddress();
    const fund = new MTX();

    fund.addTX(cb, 0);
    fund.addOutput(addr, 1e8);

    wallet.sign(fund);

    const tx1 = fund.toTX();

    // find a pair of dependent txs such that
    // tx2 < tx1 and tx2 spends tx1
    // to test out of order indexing
    for (;;) {
      const spend = new MTX();
      spend.addTX(tx1, 0);
      spend.addOutput(addr, random.randomRange(0, 1e8));
      wallet.sign(spend);

      const tx2 = spend.toTX();
      if (!less(tx2, tx1))
        continue;

      job.pushTX(tx2);
      job.pushTX(tx1);
      break;
    }

    job.refresh();

    const block1 = await job.mineAsync();
    assert(await chain.add(block1));
    await addrindexer.getCoinsByAddress(addr);
  });
});
