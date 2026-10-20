// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// The XPOLICY and LIST_SHARE action-detail handlers: indexer-minted anchors whose
// settlement row is keyed by the anchor's own action_index and whose signed snapshot
// is read from the hub mirror by the id that row carries.

'use strict';

const assert = require('node:assert/strict');
const { REGISTRY, ACTION_TYPES } = require('../../../../src/action-detail');
const sources = require('../../../../src/db/readers/checkpoints/sources.js');

const SNAP = 'a'.repeat(64);
const HUB = { DOGE: { name: 'hubdb', chain: 'DOGE', network: 'testnet' } };

function missingTable() {
    const e = new Error("Table 'hubdb.list_snapshots' doesn't exist");
    e.errno = 1146;
    return e;
}

function ctx(tables, answers, checkpointDb = HUB) {
    const queries = [];
    return {
        queries,
        ctx: {
            action_index: 777,
            config: { coin: 'DOGE' },
            db: {
                checkpointDb,
                bridgeSnapshotSource: sources.bridgeSnapshotSource,
                async doQuery(config, sql, args) {
                    queries.push({ sql, args });
                    if (/information_schema\.TABLES/i.test(sql)) return tables.map(t => ({ TABLE_NAME: t }));
                    for (const [needle, rows] of answers) {
                        if (!sql.includes(needle)) continue;
                        if (rows instanceof Error) throw rows;
                        return rows;
                    }
                    return [];
                }
            }
        }
    };
}

// The replica carries its own snapshot tables, which sync never fills: a read of them is the defect.
const BOTH = ['bridge_settlements', 'policy_snapshots', 'list_snapshots'];
const reads = (h, table) => h.queries.filter(q => new RegExp('FROM ' + table).test(q.sql));
const hubReads = (h, table) => h.queries.filter(q => q.sql.includes('FROM `hubdb`.' + table));

function assertsRegistration() {
    for (const name of ['XPOLICY', 'LIST_SHARE']) {
        assert.ok(REGISTRY[name], name + ' has no handler');
        assert.ok(ACTION_TYPES.includes(name));
        assert.deepEqual(REGISTRY[name].queries(), { query: null, query2: null, query3: null });
    }
}

async function assertsPolicySnapshot() {
    const settle = { transfer_id: SNAP, kind: 'policy', block_index: 9, src_chain: 'BTC',
                     src_action_index: null, dest_chain: 'DOGE', dest_address: null, tick: 'FUFU' };
    const snap = { snapshot_id: SNAP, policy_seq: 3, origin_chain: 'BTC', tick: 'FUFU' };
    const h = ctx(BOTH, [['FROM bridge_settlements', [settle]], ['FROM `hubdb`.policy_snapshots', [snap]]]);
    const data = {};
    await REGISTRY.XPOLICY.afterMain(h.ctx, data);
    assert.deepEqual(reads(h, 'bridge_settlements')[0].args, [777]);
    assert.deepEqual(hubReads(h, 'policy_snapshots')[0].args, [SNAP, 'testnet']);
    assert.match(hubReads(h, 'policy_snapshots')[0].sql, /WHERE snapshot_id=\? AND network=\?/);
    assert.equal(reads(h, 'policy_snapshots').length, 0);
    assert.equal(hubReads(h, 'list_snapshots').length, 0);
    assert.equal(data.snapshot_id, SNAP);
    assert.deepEqual(data.bridge_settlement, settle);
    assert.deepEqual(data.policy_snapshot, snap);
}

async function assertsListSnapshot() {
    const settle = { transfer_id: SNAP, kind: 'list', block_index: 9, src_chain: 'BTC',
                     src_action_index: 12, dest_chain: 'DOGE', dest_address: null, tick: null };
    const snap = { snapshot_id: SNAP, seq: 2, home_chain: 'BTC', home_list_index: 12 };
    const h = ctx(BOTH, [['FROM bridge_settlements', [settle]], ['FROM `hubdb`.list_snapshots', [snap]]]);
    const data = {};
    await REGISTRY.LIST_SHARE.afterMain(h.ctx, data);
    assert.deepEqual(hubReads(h, 'list_snapshots')[0].args, [SNAP, 'testnet']);
    assert.equal(reads(h, 'list_snapshots').length, 0);
    assert.equal(hubReads(h, 'policy_snapshots').length, 0);
    assert.deepEqual(data.list_snapshot, snap);
}

async function assertsMissingSettlement() {
    const h = ctx(BOTH, []);
    const data = {};
    await REGISTRY.XPOLICY.afterMain(h.ctx, data);
    assert.equal(data.bridge_settlement, null);
    assert.equal(data.snapshot_id, null);
    assert.equal('policy_snapshot' in data, false);
    assert.equal(hubReads(h, 'policy_snapshots').length, 0);
}

async function assertsMissingSettlementTable() {
    const h = ctx([], []);
    const data = {};
    await REGISTRY.LIST_SHARE.afterMain(h.ctx, data);
    assert.deepEqual(data, {});
    assert.equal(reads(h, 'bridge_settlements').length, 0);
}

async function assertsMissingSnapshotTable() {
    const settle = { transfer_id: SNAP, kind: 'list' };
    const h = ctx(['bridge_settlements'],
        [['FROM bridge_settlements', [settle]], ['FROM `hubdb`.list_snapshots', missingTable()]]);
    const data = {};
    await REGISTRY.LIST_SHARE.afterMain(h.ctx, data);
    assert.equal(data.snapshot_id, SNAP);
    assert.equal('list_snapshot' in data, false);
    assert.equal(hubReads(h, 'list_snapshots').length, 1);
    assert.equal(reads(h, 'list_snapshots').length, 0);
}

async function assertsNoHubDb() {
    const settle = { transfer_id: SNAP, kind: 'policy' };
    const h = ctx(BOTH, [['FROM bridge_settlements', [settle]], ['policy_snapshots', [{ snapshot_id: SNAP }]]], {});
    const data = {};
    await REGISTRY.XPOLICY.afterMain(h.ctx, data);
    assert.equal(data.snapshot_id, SNAP);
    assert.equal('policy_snapshot' in data, false);
    assert.equal(h.queries.filter(q => q.sql.includes('policy_snapshots')).length, 0);
}

describe('settlement-anchor action detail handlers @regression', function () {
    it('registers XPOLICY and LIST_SHARE with no static query slots', assertsRegistration);
    it('XPOLICY reads the settlement by its own index, then the policy snapshot by transfer_id', assertsPolicySnapshot);
    it('LIST_SHARE reads the list snapshot, not the policy one', assertsListSnapshot);
    it('reports a missing settlement row as null without reading a snapshot', assertsMissingSettlement);
    it('omits every key on a replica without bridge_settlements and names no table', assertsMissingSettlementTable);
    it('omits the snapshot key when only the snapshot table is absent', assertsMissingSnapshotTable);
    it('omits the snapshot key when no co-located hub DB is configured', assertsNoHubDb);
});
