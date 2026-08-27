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
 *********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
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

    // Refuse a sort key: destroys records no leg position, so ordering by
    // tick_id reorders the legs against the transaction. Action 1183, broadcast
    // CAMPB then XCHAIN, read back XCHAIN first under such a sort.
    it('issues an unlimited leg query that does not reorder the legs', async function () {
        const db = makeDb();
        await db.getActionData(config, ACTION);
        const legQuery = db.queries.find((q) => q.includes('FROM') && q.includes('destroys d1') && !q.includes('LIMIT 1'));
        assert.ok(legQuery, 'a second destroys query must run');
        assert.ok(!/ORDER BY/i.test(legQuery),
                  'a sort key here silently contradicts the transaction (see RDOGE action 1183)');
    });
});
