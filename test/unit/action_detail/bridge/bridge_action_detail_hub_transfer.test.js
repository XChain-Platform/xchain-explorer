/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The XBRIDGE handler's user-leg state, read from the hub-mirrored
 * bridge_transfers in the co-located hub DB (src/action-detail/tokens.js).
 *
 * WHY THIS READ EXISTS. A user leg's settle lands on the OTHER chain, so this
 * chain's bridge_settlements never holds a row for it. Before this read, every
 * lock and burn rendered "in flight" forever, even long after its transfer
 * finalized. The hub-mirrored transfer, keyed by the leg's source ref, is what
 * this chain actually knows about it.
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');

const { REGISTRY }     = require('../../../../src/action-detail');
const { DbQueryError } = require('../../../../src/db/shared.js');
const sources          = require('../../../../src/db/readers/checkpoints/sources.js');
const cacheParts       = require('../../../../src/db/connection/cache.js');

const TRANSFER = { transfer_id: 'a'.repeat(64), status: 'finalized', effective_time: 1700000600,
                   dest_chain: 'DOGE', dest_address: 'Ddest', snapshot_block: 900 };

const SETTLE_ROW = { transfer_id: 'e'.repeat(64), kind: 'transfer', block_index: 77,
                     src_chain: 'BTC', src_action_index: 42, dest_chain: 'DOGE',
                     dest_address: 'Ddest', tick: 'BTC.FUFU' };

// MariaDB 1146 as doQuery raises it, for a hub DB that predates the bridge tables.
function missingTableError() {
    const driver = new Error("Table 'hub.bridge_transfers' doesn't exist");
    driver.errno = 1146;
    driver.code  = 'ER_NO_SUCH_TABLE';
    return new DbQueryError('SQL query failed: ' + driver.message, driver);
}

// A replica that HAS bridge_settlements, with a co-located hub DB answering `state.transfers`.
function harness(overrides) {
    const state = { queries: [], settle: [], transfers: [], hub: { name: 'hub_db', chain: 'BTC', network: 'regtest' },
                    ...overrides };
    const db = {
        checkpointDb: state.hub ? { RBTC: state.hub } : {},
        bridgeTransferSource: sources.bridgeTransferSource,
        async doQuery(config, sql, args) {
            state.queries.push({ sql, args });
            if (/information_schema\.TABLES/i.test(sql)) return (args || []).map(name => ({ TABLE_NAME: name }));
            if (/FROM bridge_settlements/.test(sql)) return state.settle;
            if (/bridge_transfers/.test(sql)) {
                if (state.transferFails) throw state.transferFails;
                return state.transfers;
            }
            return [];
        }
    };
    const run = async (data) => {
        await REGISTRY.XBRIDGE.afterMain({ db, config: { coin: 'RBTC' }, action_index: 4242 }, data);
        return data;
    };
    return { state, run };
}

const transferReads = state => state.queries.filter(q => /bridge_transfers/.test(q.sql));

describe('XBRIDGE user leg state from the hub-mirrored transfer @regression', function () {

    it('reads the co-located hub DB by source ref, never the replica own copy', async function () {
        const h = harness({ transfers: [TRANSFER] });
        await h.run({ action_format: 0 });
        const reads = transferReads(h.state);
        assert.equal(reads.length, 1);
        assert.match(reads[0].sql, /FROM `hub_db`\.bridge_transfers/, 'schema-qualified to the hub DB');
        assert.deepEqual(reads[0].args, ['BTC', 4242, 'regtest'], 'base chain, the leg own index, the network');
        assert.match(reads[0].sql, /ORDER BY \(status='finalized'\) DESC, id DESC/, 'one row, chosen deterministically');
    });

    it('ends the in-flight state once the transfer is finalized, and names it', async function () {
        const data = await harness({ transfers: [TRANSFER] }).run({ action_format: 0 });
        assert.equal(data.bridge_pending, false, 'a finalized transfer is no longer in flight');
        assert.equal(data.transfer_id, 'a'.repeat(64));
        assert.equal(data.bridge_transfer_status, 'finalized');
        assert.equal(data.bridge_effective_time, 1700000600);
        assert.deepEqual(data.bridge_transfer, TRANSFER);
        assert.equal(data.bridge_settlement, null, 'the settle row stays the far chain business');
    });

    it('reports a retracted transfer as retracted, not in flight', async function () {
        const data = await harness({ transfers: [{ ...TRANSFER, status: 'retracted' }] }).run({ action_format: 4 });
        assert.equal(data.bridge_pending, false);
        assert.equal(data.bridge_transfer_status, 'retracted');
    });

    it('stays in flight when the hub DB was read and holds no transfer for the leg', async function () {
        const data = await harness().run({ action_format: 1 });
        assert.equal(data.bridge_pending, true);
        assert.equal(data.transfer_id, null);
        assert.equal(Object.hasOwn(data, 'bridge_transfer_status'), false);
    });
});

describe('XBRIDGE user leg state when the hub DB cannot answer @regression', function () {

    it('omits the pending claim when no hub DB is configured, and reads nothing', async function () {
        const h    = harness({ hub: null });
        const data = await h.run({ action_format: 0 });
        assert.equal(Object.hasOwn(data, 'bridge_pending'), false, 'nothing was read, so nothing is claimed');
        assert.equal(transferReads(h.state).length, 0);
    });

    it('omits the pending claim when the hub DB name is not a safe identifier', async function () {
        const h    = harness({ hub: { name: 'hub`; DROP', chain: 'BTC', network: 'regtest' } });
        const data = await h.run({ action_format: 0 });
        assert.equal(Object.hasOwn(data, 'bridge_pending'), false);
        assert.equal(transferReads(h.state).length, 0, 'an unsafe name never reaches a statement');
    });

    it('omits the pending claim when the hub DB lacks the table, without failing the page', async function () {
        const data = await harness({ transferFails: missingTableError() }).run({ action_format: 3 });
        assert.equal(Object.hasOwn(data, 'bridge_pending'), false);
    });

    it('propagates a hub DB failure that is not a missing table', async function () {
        const h = harness({ transferFails: new DbQueryError('Database connection unavailable after 3 retries') });
        await assert.rejects(() => h.run({ action_format: 0 }), /connection unavailable/);
    });

    it('never reads the mirror for an injected leg, whose source ref is on another chain', async function () {
        const settled = harness({ settle: [SETTLE_ROW], transfers: [TRANSFER] });
        const data    = await settled.run({ action_format: 5 });
        assert.equal(data.transfer_id, 'e'.repeat(64), 'the injected leg keeps its own settle row');
        assert.equal(transferReads(settled.state).length, 0);
        const orphan = harness({ transfers: [TRANSFER] });
        await orphan.run({ action_format: 2 });
        assert.equal(transferReads(orphan.state).length, 0, 'an injected leg index is not a source ref');
    });
});

// The action LRU has no TTL, so a response the hub can still move must never enter it.
const cacheable = data => cacheParts.isCacheableAction.call({ util: { isNull: v => v === null || v === undefined } },
                                                           { action: 'XBRIDGE', action_index: 4242, ...data });

describe('XBRIDGE user leg state stays out of the action cache @regression', function () {

    it('refuses an in-flight user leg, so the finalize is seen on the next read', async function () {
        const data = await harness().run({ action_format: 0 });
        assert.equal(data.bridge_transfer, null, 'present while null: the mirror was read');
        assert.equal(cacheable(data), false);
    });

    it('refuses a finalized user leg too, since the hub can still retract it', async function () {
        assert.equal(cacheable(await harness({ transfers: [TRANSFER] }).run({ action_format: 0 })), false);
    });

    it('still caches an injected leg, whose settle row only a reorg can move', async function () {
        assert.equal(cacheable(await harness({ settle: [SETTLE_ROW] }).run({ action_format: 5 })), true);
    });
});
