// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const assert = require('assert');
const HubDbSync = require('../../../../src/hub/hub_db_sync.js');

const NETWORKS = ['mainnet', 'testnet', 'regtest'];
const COINS = ['BTC', 'LTC', 'DOGE'];
const SNAPSHOT_BLOCKS = [7, 900000];

function poolWithoutIndexer() {
    return {
        doQuery: async () => assert.fail('unexpected database query'),
        query: async () => assert.fail('unexpected database query')
    };
}

describe('capability_snapshots without an authoritative stake database', function () {
    it('never holds or refuses a row and never makes a proof HTTP request', async function () {
        for (const network of NETWORKS) {
            for (const coin of COINS) {
                for (const snapshotBlock of SNAPSHOT_BLOCKS) {
                    const sync = new HubDbSync(poolWithoutIndexer(), {
                        coin,
                        network,
                        hubUrl: 'http://hub.test'
                    });
                    let httpGets = 0;
                    sync.httpGet = async () => {
                        httpGets += 1;
                        return { status: 200, body: '{}' };
                    };
                    const row = {
                        snapshot_block: snapshotBlock,
                        capability: 'oracle_publish',
                        signing_pubkey: 'a'.repeat(64),
                        source: 'b'.repeat(64),
                        amount: '1'
                    };

                    assert.strictEqual(sync.authoritativeStakeDb(), null);
                    assert.strictEqual(await sync.refuseUnprovenCapabilitySnapshot(row), false);
                    assert.strictEqual(httpGets, 0);
                }
            }
        }
    });
});
