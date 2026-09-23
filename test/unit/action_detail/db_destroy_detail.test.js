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
 * DESTROY action detail: destroys.action_index is non-unique since the
 * indexer's 2026-08-15 migration (one row per multi-destroy leg), so the
 * detail must read every leg the way SEND does, not one arbitrary row.
 *
 * Both leg lists sort on leg_ordinal, the wire position the indexer stamps and
 * indexes for this read, and on nothing else: a value-column sort reorders the
 * legs against the transaction. A replica without the column keeps the unsorted
 * read, and a statement that names it there is refused with a real 1054.
 *********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../../src/lib/utility.js');
const { DbQueryError } = require('../../../src/db/shared.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');

const Database = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const ACTION = 4242;

const HEADER_ROW = {
    action: 'DESTROY', action_format: 1, action_index: ACTION, source: 'addr-1',
    tick: 'AAA', amount: '1.00000000', block_index: 100, timestamp: 1700000000,
    tx_hash: 'hash', tx_index: 7, memo: 'first', status: 'valid'
};
const LEGS = [
    { tick: 'AAA', amount: '1.00000000', memo: 'first',  status: 'valid' },
    { tick: 'BBB', amount: '2.00000000', memo: null,     status: 'valid' },
    { tick: 'CCC', amount: '3.00000000', memo: 'third',  status: 'invalid: insufficient funds' }
];

// Build a db whose doQuery answers by statement shape, recording every statement.
function makeDb() {
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    const db         = new Database({ configInfo, util });
    db.queries = [];
    db.doQuery = async (config, sql) => {
        const text = String(sql);
        db.queries.push(text);
        if (/FROM\s+destroys/.test(text) && text.includes('LIMIT 1')) return [HEADER_ROW];
        if (/FROM\s+destroys/.test(text)) return LEGS;
        return [];
    };
    db.getActionType      = async () => 'DESTROY';
    db.getActionFeeData   = async () => null;
    db.getTransactionData = async () => null;
    return db;
}

const config = { coin: 'LTC', data: {} };

describe('DESTROY action detail @regression', function () {

    it('returns every burn leg as data.destroys, not the LIMIT 1 header leg alone', async function () {
        const db   = makeDb();
        const data = await db.getActionData(config, ACTION);
        assert.strictEqual(data.action, 'DESTROY');
        assert.ok(Array.isArray(data.destroys), 'destroys must be the per-leg list');
        assert.strictEqual(data.destroys.length, 3);
        assert.deepStrictEqual(data.destroys.map((l) => l.tick), ['AAA', 'BBB', 'CCC']);
        assert.strictEqual(data.destroys[2].status, 'invalid: insufficient funds', 'per-leg status survives');
    });

    it('keeps the published header fields for single-value consumers', async function () {
        const db   = makeDb();
        const data = await db.getActionData(config, ACTION);
        assert.strictEqual(data.tick, 'AAA');
        assert.strictEqual(data.amount, '1.00000000');
        assert.strictEqual(data.memo, 'first');
    });

    // Refuse any sort key but leg_ordinal: ordering by tick_id reorders the legs
    // against the transaction. Action 1183, broadcast CAMPB then XCHAIN, read back
    // XCHAIN first under such a sort. The leg_ordinal sort is pinned below.
    it('issues an unlimited leg query that does not reorder the legs', async function () {
        const db = makeDb();
        await db.getActionData(config, ACTION);
        const legQuery = db.queries.find((q) => q.includes('FROM') && q.includes('destroys d1') && !q.includes('LIMIT 1'));
        assert.ok(legQuery, 'a second destroys query must run');
        const sortKeys = legQuery.replace(/\s+/g, ' ').split(/ORDER BY/i).slice(1).join(',');
        assert.ok(!sortKeys || /^\s*d1\.leg_ordinal ASC\s*$/.test(sortKeys),
                  'a value-column sort key here silently contradicts the transaction (see RDOGE action 1183)');
    });
});

const ORDER_LEGS = [{ tick: 'CAMPB', amount: '2' }, { tick: 'XCHAIN', amount: '3' }];

function unknownColumnError() {
    const driver = new Error("Unknown column 'leg_ordinal' in 'order clause'");
    driver.errno = 1054;
    driver.code  = 'ER_BAD_FIELD_ERROR';
    return new DbQueryError('SQL query failed: ' + driver.message, driver);
}

// A db over a replica that does or does not carry leg_ordinal, emulating the 1054.
function makeLegDb(type, state) {
    const db = makeDb();
    db.getActionType = async () => type;
    db.doQuery = async (cfg, sql) => {
        const text = String(sql);
        state.queries.push(text);
        if (/information_schema\.COLUMNS/i.test(text))
            return state.hasColumn ? [{ COLUMN_NAME: 'leg_ordinal' }] : [];
        if (/leg_ordinal/.test(text) && !state.hasColumn) throw unknownColumnError();
        if (/FROM\s+(sends|destroys)/.test(text) && !text.includes('LIMIT 1')) return ORDER_LEGS;
        return [];
    };
    return db;
}

const legReads = (state, table) => state.queries.filter((q) => new RegExp('FROM\\s+' + table).test(q) && !q.includes('LIMIT 1'));

for (const [type, table, alias, key] of [['DESTROY', 'destroys', 'd1', 'destroys'], ['SEND', 'sends', 's1', 'sends']]) {
    describe(type + ' detail leg order @regression', function () {

        it('sorts the legs on leg_ordinal and on nothing else', async function () {
            const state = { queries: [], hasColumn: true };
            const data  = await makeLegDb(type, state).getActionData(config, 1183);
            const reads = legReads(state, table);
            assert.strictEqual(reads.length, 1);
            const orderBy = reads[0].slice(reads[0].search(/ORDER\s+BY/i)).replace(/\s+/g, ' ').trim();
            assert.strictEqual(orderBy, 'ORDER BY ' + alias + '.leg_ordinal ASC');
            assert.deepStrictEqual(data[key], ORDER_LEGS);
        });

        it('takes the unsorted read on a replica without the column', async function () {
            const state = { queries: [], hasColumn: false };
            const data  = await makeLegDb(type, state).getActionData(config, 1183);
            const reads = legReads(state, table);
            assert.strictEqual(reads.length, 1);
            assert.ok(!/ORDER\s+BY/i.test(reads[0]), 'the statement must not name a column the schema lacks');
            assert.deepStrictEqual(data[key], ORDER_LEGS);
        });

        it('recovers from the 1054 a stale positive memo earns, then stops paying it', async function () {
            const state = { queries: [], hasColumn: false };
            const db    = makeLegDb(type, state);
            db.schemaColumnMemo = { [config.coin]: { [table + ':leg_ordinal']: { present: true, at: Date.now() } } };
            const data  = await db.getActionData(config, 1183);
            assert.deepStrictEqual(data[key], ORDER_LEGS, 'the page still gets its legs');
            assert.strictEqual(db.schemaColumnMemo[config.coin][table + ':leg_ordinal'].present, false);
            await db.getActionData(config, 1184);
            const ordered = legReads(state, table).filter((q) => /leg_ordinal/.test(q));
            assert.strictEqual(ordered.length, 1, 'exactly one statement pays for the wrong memo');
        });
    });
}
