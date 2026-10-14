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
 * Amounts computed in SQL DECIMAL arithmetic reach the wire in the canonical
 * form the indexer stores ('1.5', '21000000'), not at the CAST scale the
 * driver returns ('1.50000000', '21000000.000000000000000000'); amounts read
 * straight from a VARCHAR column stay byte-exact.
 */

'use strict';

const { expect } = require('chai');
const proxyquire = require('proxyquire');
const Utility    = require('../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { makeConfig }           = require('../../fixtures/mock-query-args.js');
const { openIndexerTables, runOnSqlite } = require('../../helpers/indexer_ddl_sqlite.js');
const { feeRows } = require('../../../src/action-detail/contracts.js');
const { applyPostPasses } = require('../../../src/db/query_sql/data_post.js');

const Database = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

function makeDb(rows){
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.doQuery = async (config, sql) => rows(String(sql));
    return db;
}

describe('inferred contract fee amounts against the real indexer DDL', function () {
    const TABLES = ['fees', 'contract_executions', 'actions', 'index_actions', 'index_statuses', 'debits'];
    let sqlite;

    before(function () {
        sqlite = openIndexerTables(this, TABLES);
        if(!sqlite) return;
        const insert = (sql, ...args) => Number(sqlite.prepare(sql).run(...args).lastInsertRowid);
        const execute = insert("INSERT INTO index_actions (action) VALUES ('EXECUTE')");
        const valid   = insert("INSERT INTO index_statuses (status) VALUES ('valid')");
        for(const [idx, amounts] of [[1, ['1.25', '0.25']], [2, ['2']], [3, []]]){
            insert('INSERT INTO actions (action_index, block_index, tx_index, action_id, action_format) VALUES (?, 1, ?, ?, 0)', idx, idx, execute);
            insert('INSERT INTO contract_executions (action_index, contract_index, caller_id, gas_used, gas_limit, status_id, block_index) VALUES (?, 9, 5, 10, 100, ?, 1)', idx, valid);
            for(const amount of amounts)
                insert('INSERT INTO debits (action_index, address_id, tick_id, amount) VALUES (?, 5, 1, ?)', idx, amount);
        }
        insert('INSERT INTO actions (action_index, block_index, tx_index, action_id, action_format) VALUES (4, 1, 4, ?, 0)', execute);
        insert("INSERT INTO fees (action_index, tick_id, amount, method, xchain_amount, status_id, fee_version) VALUES (4, 1, '10.0', 1, '10.0', ?, 2)", valid);
    });

    function amounts(){
        const rows = runOnSqlite(sqlite, 'SELECT * FROM ' + feeRows() + ' m ORDER BY m.action_index');
        return rows.map((r) => [r.action_index, r.amount, r.xchain_amount]);
    }

    it('serves an inferred sum as its canonical decimal string', function () {
        expect(amounts().slice(0, 2)).to.deep.equal([[1, '1.5', '1.5'], [2, '2', '2']]);
    });

    it('leaves a persisted fee amount exactly as stored', function () {
        expect(amounts().find((r) => r[0] === 4)).to.deep.equal([4, '10.0', '10.0']);
    });
});

describe('DECIMAL sums on the rich list and the order list', function () {
    it('serves held_total in the form supply uses', async function () {
        const db = makeDb((sql) => {
            if(/FROM index_tickers WHERE tick=/.test(sql)) return [{ id: 1 }];
            if(/FROM\s+tokens m/.test(sql)) return [{ tick: 'TOKEN', supply: '21000000', decimals: 0 }];
            if(/held_total/.test(sql)) return [{ holder_count: 2n, held_total: '21000000.000000000000000000' }];
            return [];
        });
        const config = makeConfig({ type: 'api', data: { method: 'getRichList', search: 'TOKEN', type: 'token' } });
        const [body] = await db.getRichList(config);
        expect(body.held_total).to.equal('21000000');
        expect(body.supply).to.equal('21000000');
    });

    it('trims give_remaining on an order row and leaves the stored amounts alone', async function () {
        const db = makeDb(() => []);
        const config = makeConfig({ type: 'api', data: { method: 'getOrders' } });
        const rows = [{ action_index: 1, give_amount: '1.50', give_remaining: '1.500000000000000000' },
            { action_index: 2, give_amount: '3', give_remaining: '0.000000000000000000' },
            { action_index: 3, give_amount: '3', give_remaining: null }];
        const out = await applyPostPasses(db, config, rows);
        expect(out.map((r) => [r.give_amount, r.give_remaining])).to.deep.equal([['1.50', '1.5'], ['3', '0'], ['3', null]]);
    });

    it('ranks rich list holders on a tiebreaker after the DECIMAL amount', async function () {
        const seen = [];
        const db = makeDb((sql) => {
            seen.push(sql);
            if(/FROM index_tickers WHERE tick=/.test(sql)) return [{ id: 1 }];
            if(/FROM\s+tokens m/.test(sql)) return [{ tick: 'TOKEN', supply: '1' }];
            return [];
        });
        await db.getRichList(makeConfig({ type: 'api', data: { method: 'getRichList', search: 'TOKEN', type: 'token' } }));
        expect(seen.join('\n')).to.match(/ORDER BY CAST\(m\.amount AS DECIMAL\(65,18\)\) DESC, m\.address_id DESC/);
    });
});
