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

const SNAP = 'a'.repeat(64);

function ctx(tables, answers) {
    const queries = [];
    return {
        queries,
        ctx: {
            action_index: 777,
            config: { coin: 'DOGE' },
            db: {
                async doQuery(config, sql, args) {
                    queries.push({ sql, args });
                    if (/information_schema\.TABLES/i.test(sql)) return tables.map(t => ({ TABLE_NAME: t }));
                    for (const [needle, rows] of answers) if (sql.includes(needle)) return rows;
                    return [];
                }
            }
        }
    };
}

const BOTH = ['bridge_settlements', 'policy_snapshots', 'list_snapshots'];
const reads = (h, table) => h.queries.filter(q => new RegExp('FROM ' + table).test(q.sql));

describe('settlement-anchor action detail handlers @regression', function () {
    it('registers XPOLICY and LIST_SHARE with no static query slots', function () {
        for (const name of ['XPOLICY', 'LIST_SHARE']) {
            assert.ok(REGISTRY[name], name + ' has no handler');
            assert.ok(ACTION_TYPES.includes(name));
            assert.deepEqual(REGISTRY[name].queries(), { query: null, query2: null, query3: null });
        }
    });

    it('XPOLICY reads the settlement by its own index, then the policy snapshot by transfer_id', async function () {
        const settle = { transfer_id: SNAP, kind: 'policy', block_index: 9, src_chain: 'BTC',
                         src_action_index: null, dest_chain: 'DOGE', dest_address: null, tick: 'FUFU' };
        const snap = { snapshot_id: SNAP, policy_seq: 3, origin_chain: 'BTC', tick: 'FUFU' };
        const h = ctx(BOTH, [['FROM bridge_settlements', [settle]], ['FROM policy_snapshots', [snap]]]);
        const data = {};
        await REGISTRY.XPOLICY.afterMain(h.ctx, data);
        assert.deepEqual(reads(h, 'bridge_settlements')[0].args, [777]);
        assert.deepEqual(reads(h, 'policy_snapshots')[0].args, [SNAP]);
        assert.equal(reads(h, 'list_snapshots').length, 0);
        assert.equal(data.snapshot_id, SNAP);
        assert.deepEqual(data.bridge_settlement, settle);
        assert.deepEqual(data.policy_snapshot, snap);
    });

    it('LIST_SHARE reads the list snapshot, not the policy one', async function () {
        const settle = { transfer_id: SNAP, kind: 'list', block_index: 9, src_chain: 'BTC',
                         src_action_index: 12, dest_chain: 'DOGE', dest_address: null, tick: null };
        const snap = { snapshot_id: SNAP, seq: 2, home_chain: 'BTC', home_list_index: 12 };
        const h = ctx(BOTH, [['FROM bridge_settlements', [settle]], ['FROM list_snapshots', [snap]]]);
        const data = {};
        await REGISTRY.LIST_SHARE.afterMain(h.ctx, data);
        assert.deepEqual(reads(h, 'list_snapshots')[0].args, [SNAP]);
        assert.equal(reads(h, 'policy_snapshots').length, 0);
        assert.deepEqual(data.list_snapshot, snap);
    });

    it('reports a missing settlement row as null without reading a snapshot', async function () {
        const h = ctx(BOTH, []);
        const data = {};
        await REGISTRY.XPOLICY.afterMain(h.ctx, data);
        assert.equal(data.bridge_settlement, null);
        assert.equal(data.snapshot_id, null);
        assert.equal('policy_snapshot' in data, false);
        assert.equal(reads(h, 'policy_snapshots').length, 0);
    });

    it('omits every key on a replica without bridge_settlements and names no table', async function () {
        const h = ctx([], []);
        const data = {};
        await REGISTRY.LIST_SHARE.afterMain(h.ctx, data);
        assert.deepEqual(data, {});
        assert.equal(reads(h, 'bridge_settlements').length, 0);
    });

    it('omits the snapshot key when only the snapshot table is absent', async function () {
        const settle = { transfer_id: SNAP, kind: 'list' };
        const h = ctx(['bridge_settlements'], [['FROM bridge_settlements', [settle]]]);
        const data = {};
        await REGISTRY.LIST_SHARE.afterMain(h.ctx, data);
        assert.equal(data.snapshot_id, SNAP);
        assert.equal('list_snapshot' in data, false);
        assert.equal(reads(h, 'list_snapshots').length, 0);
    });
});
