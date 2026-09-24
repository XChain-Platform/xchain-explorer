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
 * The XBRIDGE action-detail handler against BOTH replica schema shapes.
 *
 * bridge_settlements is created by the indexer's bridge-tables migration, which a
 * replica takes on its operator's schedule. Naming a table the connected schema does
 * not carry is MariaDB 1146 for the whole statement, so before this guard every
 * XBRIDGE action page answered 500 against a replica that had not taken it, the same
 * class of failure that held the fleet's explorer at the previous release.
 *
 * The doQuery double EMULATES the server rather than canning an answer: a statement
 * naming a table the fixture schema does not hold is rejected with a real 1146,
 * which is what makes these assertions about behaviour and not about a string the
 * handler also writes.
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');

const { REGISTRY }     = require('../../../src/action-detail');
const { DbQueryError } = require('../../../src/db/shared.js');
const { SCHEMA_PROBE_TTL_MS } = require('../../../src/db/schema_probe.js');

const SETTLE_ROW = { transfer_id: 'e'.repeat(64), kind: 'transfer', block_index: 77,
                     src_chain: 'BTC', src_action_index: 42, dest_chain: 'DOGE',
                     dest_address: 'Ddest', tick: 'BTC.FUFU' };

// MariaDB 1146 as it reaches a handler: the driver's error wrapped as the `cause` of
// the DbQueryError doQuery raises.
function missingTableError(table) {
    const driver = new Error(`Table 'replica.${table}' doesn't exist`);
    driver.errno = 1146;
    driver.code  = 'ER_NO_SUCH_TABLE';
    return new DbQueryError('SQL query failed: ' + driver.message, driver);
}

// Stands in for a replica whose schema holds exactly `state.tables`. The settle read
// is refused the way the server refuses it when the table is not there.
function makeDb(state) {
    return {
        async doQuery(config, sql, args) {
            state.queries.push({ coin: config.coin, sql, args });
            if (/information_schema\.TABLES/i.test(sql)) {
                if (state.probeFails) throw new DbQueryError('information_schema refused');
                return state.tables.map(name => ({ TABLE_NAME: name }));
            }
            if (/FROM bridge_settlements/.test(sql)) {
                if (state.readFails) throw state.readFails;
                if (!state.tables.includes('bridge_settlements')) throw missingTableError('bridge_settlements');
                return state.rows;
            }
            if (/FROM\s+xbridges/.test(sql)) {
                if (!state.tables.includes('xbridges')) throw missingTableError('xbridges');
                return state.record || [];
            }
            return [];
        }
    };
}

function harness(overrides) {
    const state = { queries: [], tables: [], rows: [], ...overrides };
    const db    = makeDb(state);
    const run   = async (data, coin = 'DOGE', action_index = 4242) => {
        await REGISTRY.XBRIDGE.afterMain({ db, config: { coin }, action_index }, data);
        return data;
    };
    return { state, db, run };
}

const settleQueries = state => state.queries.filter(q => /FROM bridge_settlements/.test(q.sql));
// The settle table's own probe: the xbridges read asks about its table separately.
const probeQueries  = state => state.queries.filter(q => /information_schema\.TABLES/i.test(q.sql)
                                                        && (q.args || []).includes('bridge_settlements'));
const withTable     = extra => harness({ tables: ['bridge_settlements'], rows: [SETTLE_ROW], ...extra });
const withoutTable  = extra => harness({ tables: [], ...extra });

const BRIDGE_KEYS = ['bridge_settlement', 'transfer_id', 'bridge_kind', 'bridge_pending',
                     'dest_chain', 'dest_address', 'decimals', 'min_depth', 'memo', 'status'];

describe('XBRIDGE detail on a replica that HAS bridge_settlements @regression', function () {

    it('reads the settle row and reports it exactly as before the guard', async function () {
        const h    = withTable();
        const data = await h.run({ action_format: 5 });
        assert.equal(data.transfer_id, 'e'.repeat(64));
        assert.equal(data.bridge_kind, 'transfer');
        assert.equal(data.bridge_pending, false);
        assert.deepEqual(data.bridge_settlement, SETTLE_ROW);
    });

    it('still reports a user leg with no row as in flight, not as unknown', async function () {
        const h    = withTable({ rows: [] });
        const data = await h.run({ action_format: 3 });
        assert.equal(data.bridge_pending, true, 'the far leg has not landed; the table WAS read');
        assert.equal(data.bridge_settlement, null);
    });

    it('asks the schema once and then reads, one statement each', async function () {
        const h = withTable();
        await h.run({ action_format: 5 });
        assert.equal(probeQueries(h.state).length, 1);
        assert.equal(settleQueries(h.state).length, 1);
    });
});

describe('XBRIDGE detail on a replica WITHOUT it (no bridge migration) @regression', function () {

    it('answers the action instead of failing the page', async function () {
        const h    = withoutTable();
        const data = await h.run({ action_format: 3, action: 'XBRIDGE' });
        assert.equal(data.action, 'XBRIDGE', 'the baseline row is what the page renders from');
    });

    it('names bridge_settlements in no statement at all', async function () {
        const h = withoutTable();
        await h.run({ action_format: 3 });
        assert.equal(settleQueries(h.state).length, 0, 'a statement that cannot work must not be sent');
    });

    it('OMITS every bridge key rather than nulling it', async function () {
        const h    = withoutTable();
        const data = await h.run({ action_format: 3 });
        // Absence is the honest answer: nothing was read about this leg's settlement.
        // `bridge_pending: true` would tell a holder their transfer is in flight, and
        // the detail card renders that claim as an "in flight" badge.
        for (const key of BRIDGE_KEYS)
            assert.equal(Object.hasOwn(data, key), false, key + ' must be absent, not defaulted');
    });

    it('leaves a tick the baseline resolved untouched', async function () {
        const h    = withoutTable();
        const data = await h.run({ action_format: 3, tick: 'FUFU' });
        assert.equal(data.tick, 'FUFU');
    });
});

describe('XBRIDGE detail schema probe @regression', function () {

    it('is memoized per coin, not asked per request', async function () {
        const h = withTable();
        await h.run({ action_format: 5 });
        await h.run({ action_format: 5 });
        await h.run({ action_format: 5 });
        assert.equal(probeQueries(h.state).length, 1);
        assert.equal(settleQueries(h.state).length, 3);
    });

    it('does not let one coin answer for another', async function () {
        const h = withTable();
        await h.run({ action_format: 5 }, 'DOGE');
        await h.run({ action_format: 5 }, 'BTC');
        assert.equal(probeQueries(h.state).length, 2);
        assert.deepEqual(probeQueries(h.state).map(q => q.coin), ['DOGE', 'BTC']);
    });

    it('re-probes once a negative answer ages out, so a migration heals a live explorer', async function () {
        const h = withoutTable();
        await h.run({ action_format: 3 });
        h.state.tables = ['bridge_settlements'];
        h.state.rows   = [SETTLE_ROW];
        h.db.schemaTableMemo.DOGE['bridge_settlements'].at = Date.now() - (SCHEMA_PROBE_TTL_MS * 10);
        const data = await h.run({ action_format: 5 });
        assert.equal(data.transfer_id, 'e'.repeat(64), 'the applied migration must be picked up');
        assert.equal(probeQueries(h.state).length, 2);
    });

    it('keeps a positive answer without re-asking', async function () {
        const h = withTable();
        await h.run({ action_format: 5 });
        h.db.schemaTableMemo.DOGE['bridge_settlements'].at = Date.now() - (SCHEMA_PROBE_TTL_MS * 10);
        await h.run({ action_format: 5 });
        assert.equal(probeQueries(h.state).length, 1, 'a table cannot vanish under a running explorer');
    });
});

describe('XBRIDGE detail when the probe answers wrong @regression', function () {

    it('recovers from the 1146 a stale positive memo earns, and records the real shape', async function () {
        const h = withoutTable();
        h.db.schemaTableMemo = { DOGE: { 'bridge_settlements': { present: true, at: Date.now() } } };
        const data = await h.run({ action_format: 3 });
        for (const key of BRIDGE_KEYS)
            assert.equal(Object.hasOwn(data, key), false, key + ' must be absent after the recovery');
        assert.equal(settleQueries(h.state).length, 1, 'exactly one statement pays for the wrong memo');
        assert.equal(h.db.schemaTableMemo.DOGE['bridge_settlements'].present, false);
        await h.run({ action_format: 3 });
        assert.equal(settleQueries(h.state).length, 1, 'and the next request does not pay it again');
    });

    it('reads the table when information_schema itself refuses', async function () {
        const h    = withTable({ probeFails: true });
        const data = await h.run({ action_format: 5 });
        assert.equal(data.transfer_id, 'e'.repeat(64), 'a failed probe must not degrade a good replica');
        await h.run({ action_format: 5 });
        assert.equal(probeQueries(h.state).length, 2, 'nothing is memoized off a failed probe');
    });

    it('still degrades when the probe fails against a pre-bridge replica', async function () {
        const h    = withoutTable({ probeFails: true });
        const data = await h.run({ action_format: 3 });
        assert.equal(Object.hasOwn(data, 'bridge_pending'), false);
        assert.equal(settleQueries(h.state).length, 1, 'the 1146 net is what catches this one');
    });

    it('propagates a failure that is not a missing table', async function () {
        const h = withTable({ readFails: new DbQueryError('Database connection unavailable after 3 retries') });
        await assert.rejects(() => h.run({ action_format: 5 }), /connection unavailable/);
    });
});

// The user leg's OWN record. Its settle row lands on the other chain, so on the chain
// it was broadcast from the xbridges row is the only place these facts are recorded.
const RECORD = { dest_chain: 'DOGE', dest_address: 'Ddest', tick: 'XCHAIN', decimals: 8,
                 min_depth: 0, memo: 'to my doge wallet', status: 'valid' };
const RECORD_KEYS = BRIDGE_KEYS.slice(4);
const withRecord  = extra => harness({ tables: ['xbridges', 'bridge_settlements'], record: [RECORD], ...extra });
const recordReads = state => state.queries.filter(q => /FROM\s+xbridges/.test(q.sql));

describe('XBRIDGE detail: the user leg own xbridges record @regression', function () {

    it('lifts destination, decimals, min depth, memo and verdict, and stays in flight', async function () {
        const h    = withRecord();
        const data = await h.run({ action_format: 0 });
        for (const key of RECORD_KEYS)
            assert.equal(data[key], RECORD[key], key);
        assert.equal(data.tick, 'XCHAIN', 'the token the leg named, where the baseline had none');
        assert.equal(recordReads(h.state)[0].args[0], 4242, 'keyed by the leg OWN action_index');
        assert.equal(data.bridge_pending, true, 'its settlement is still on the other chain');
    });

    it('keeps a tick the baseline resolved, and adds nothing for a leg with no row', async function () {
        const kept = await withRecord({ record: [{ ...RECORD, tick: 'OTHER' }] }).run({ action_format: 3, tick: 'FUFU' });
        assert.equal(kept.tick, 'FUFU');
        const injected = await withRecord({ record: [] }).run({ action_format: 5 });
        for (const key of RECORD_KEYS)
            assert.equal(Object.hasOwn(injected, key), false, key + ' must be absent');
    });

    it('names xbridges in no statement on a replica without it, and still reads the settlement', async function () {
        const h    = withTable({ rows: [] });
        const data = await h.run({ action_format: 0 });
        assert.equal(recordReads(h.state).length, 0, 'a statement that cannot work must not be sent');
        for (const key of RECORD_KEYS)
            assert.equal(Object.hasOwn(data, key), false, key + ' must be absent, not defaulted');
        assert.equal(data.bridge_pending, true, 'the settle table was read, so the pending claim stands');
    });

    it('recovers from the 1146 a stale positive memo earns, and records the real shape', async function () {
        const h = withTable({ rows: [] });
        h.db.schemaTableMemo = { DOGE: { xbridges: { present: true, at: Date.now() } } };
        const data = await h.run({ action_format: 0 });
        assert.equal(Object.hasOwn(data, 'dest_chain'), false);
        assert.equal(h.db.schemaTableMemo.DOGE.xbridges.present, false);
        await h.run({ action_format: 0 });
        assert.equal(recordReads(h.state).length, 1, 'exactly one statement pays for the wrong memo');
    });
});
