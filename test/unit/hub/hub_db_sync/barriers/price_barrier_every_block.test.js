// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

process.env.INDEXER_COIN = 'BTC';
process.env.INDEXER_NETWORK = 'regtest';

const assert = require('assert');
const sinon = require('sinon');

const HubDbSync = require('../../../../../src/hub/hub_db_sync.js');
const { getLogger } = require('../../../../../src/observability/index.js');

function makeSync(network, coin) {
    const sync = new HubDbSync(
        { doQuery: async () => [] },
        { hubUrl: 'http://hub.test', network, coin }
    );
    sync.priceBootstrapped = false;
    sync.priceSyncHeight = 0;
    sync.priceSyncMaxTimestamp = 0;
    sync.streamWatermark = 0;
    sync.refreshPriceSyncHeight = async () => {};
    return sync;
}

async function assertBarriersQueue(network, coin, blockTime) {
    const sync = makeSync(network, coin);
    const timeBarrier = sync.waitForPriceSyncTime(blockTime, 30);
    const heightBarrier = sync.waitForPriceSyncHeight(500, 30, blockTime);

    assert.strictEqual(sync._priceTimeWaiters.length, 1,
        `${coin}:${network} at ${blockTime} must queue the time barrier`);
    assert.strictEqual(sync._priceWaiters.length, 1,
        `${coin}:${network} at ${blockTime} must queue the height barrier`);

    await Promise.all([
        assert.rejects(timeBarrier, /price time-sync barrier timed out/),
        assert.rejects(heightBarrier, /price sync barrier timed out/),
    ]);
    assert.strictEqual(sync._priceTimeWaiters.length, 0);
    assert.strictEqual(sync._priceWaiters.length, 0);
}

async function assertRefloor(network) {
    const errorLog = sinon.stub(getLogger(), 'error');
    try {
        const sync = makeSync(network, 'BTC');
        sync._priceMirrorFloorTs = 3601;

        const barrier = sync.waitForPriceSyncTime(1, 30);
        assert.strictEqual(sync._priceMirrorRefloor, true, network);
        await assert.rejects(barrier, /price time-sync barrier timed out/);
    } finally {
        errorLog.restore();
    }
}

describe('HubDbSync price barriers apply to every block @regression @tier1', function () {
    it('queues both barriers for BTC mainnet at block time 1', async function () {
        await assertBarriersQueue('mainnet', 'BTC', 1);
    });
    it('queues both barriers for BTC mainnet at block time 1700000000', async function () {
        await assertBarriersQueue('mainnet', 'BTC', 1700000000);
    });
    it('queues both barriers for LTC mainnet at block time 1', async function () {
        await assertBarriersQueue('mainnet', 'LTC', 1);
    });
    it('queues both barriers for LTC mainnet at block time 1700000000', async function () {
        await assertBarriersQueue('mainnet', 'LTC', 1700000000);
    });
    it('queues both barriers for DOGE mainnet at block time 1', async function () {
        await assertBarriersQueue('mainnet', 'DOGE', 1);
    });
    it('queues both barriers for DOGE mainnet at block time 1700000000', async function () {
        await assertBarriersQueue('mainnet', 'DOGE', 1700000000);
    });

    it('queues both barriers for BTC testnet at block time 1', async function () {
        await assertBarriersQueue('testnet', 'BTC', 1);
    });
    it('queues both barriers for BTC testnet at block time 1700000000', async function () {
        await assertBarriersQueue('testnet', 'BTC', 1700000000);
    });
    it('queues both barriers for LTC testnet at block time 1', async function () {
        await assertBarriersQueue('testnet', 'LTC', 1);
    });
    it('queues both barriers for LTC testnet at block time 1700000000', async function () {
        await assertBarriersQueue('testnet', 'LTC', 1700000000);
    });
    it('queues both barriers for DOGE testnet at block time 1', async function () {
        await assertBarriersQueue('testnet', 'DOGE', 1);
    });
    it('queues both barriers for DOGE testnet at block time 1700000000', async function () {
        await assertBarriersQueue('testnet', 'DOGE', 1700000000);
    });

    it('queues both barriers for BTC regtest at block time 1', async function () {
        await assertBarriersQueue('regtest', 'BTC', 1);
    });
    it('queues both barriers for BTC regtest at block time 1700000000', async function () {
        await assertBarriersQueue('regtest', 'BTC', 1700000000);
    });
    it('queues both barriers for LTC regtest at block time 1', async function () {
        await assertBarriersQueue('regtest', 'LTC', 1);
    });
    it('queues both barriers for LTC regtest at block time 1700000000', async function () {
        await assertBarriersQueue('regtest', 'LTC', 1700000000);
    });
    it('queues both barriers for DOGE regtest at block time 1', async function () {
        await assertBarriersQueue('regtest', 'DOGE', 1);
    });
    it('queues both barriers for DOGE regtest at block time 1700000000', async function () {
        await assertBarriersQueue('regtest', 'DOGE', 1700000000);
    });

    it('re-floors a bounded mirror for the earliest mainnet block', async function () {
        await assertRefloor('mainnet');
    });
    it('re-floors a bounded mirror for the earliest testnet block', async function () {
        await assertRefloor('testnet');
    });
    it('re-floors a bounded mirror for the earliest regtest block', async function () {
        await assertRefloor('regtest');
    });
});
