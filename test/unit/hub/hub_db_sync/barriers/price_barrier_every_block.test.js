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

const NETWORKS = ['mainnet', 'testnet', 'regtest'];
const COINS = ['BTC', 'LTC', 'DOGE'];
const BLOCK_TIMES = [1, 1700000000];

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

describe('HubDbSync price barriers apply to every block @regression @tier1', function () {
    for (const network of NETWORKS) {
        for (const coin of COINS) {
            for (const blockTime of BLOCK_TIMES) {
                it(`queues both barriers for ${coin} ${network} at block time ${blockTime}`,
                    async function () {
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
                    });
            }
        }
    }

    for (const network of NETWORKS) {
        it(`re-floors a bounded mirror for the earliest ${network} block`, async function () {
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
        });
    }
});
