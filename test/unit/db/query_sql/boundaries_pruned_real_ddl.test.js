/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The explorer page boundaries run over the pruned table set the list's count
 * and ids leg use, and a block lane drives from actions. Every method, lane
 * and paging direction runs here against tables built from the indexer's real
 * DDL, next to the boundary statements as written (with the tx-less rewrite
 * the emittable methods get), and each statement pair must return the same
 * rows and getQueryOffsets the same cursors. The methods cover a DISTINCT
 * projection over multi-leg sends, a two-party address lane, and a method
 * whose stop statement keeps its INNER transactions join. The seed carries
 * tx-less actions, an action whose source falls back to its transaction, and
 * an action whose block has no blocks row.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { openIndexerTables, runOnSqlite } = require('../../../helpers/indexer_ddl_sqlite.js');
const { runListQuery } = require('../../../../src/db/query_sql/data_rows.js');
const { historyCursor, boundaryWhere, firstLastSql, stopSql } = require('../../../../src/db/query_sql/offset_boundaries.js');
const { optionalTransactionSql } = require('../../../../src/db/readers/txless_actions.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const TABLES = ['issues', 'sends', 'dispenses', 'dispensers', 'actions', 'blocks', 'transactions',
                'index_addresses', 'index_statuses', 'index_transactions', 'index_tickers', 'index_actions', 'index_memos'];

// The methods whose boundary reads go through the tx-less rewrite (EMITTABLE_METHODS).
const TXLESS = new Set(['getIssues', 'getSends']);
const METHODS = ['getIssues', 'getSends', 'getDispenses'];
const LANES = [[null, null], ['block', '100'], ['block', '101'], ['block', '104'],
               ['address', 'X1'], ['address', 'X2'], ['token', 'TOKA']];
const LENGTH = 4;
const STEPS = [['first', false], ['last', false], ['next', 25], ['next', 12], ['prev', 4], ['prev', 18]];

let sqlite, db, sent;

function run(q, a){
    return runOnSqlite(sqlite, q, a);
}

function insert(table, row){
    const cols = Object.keys(row);
    run('INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')', Object.values(row));
}

// Actions 1..30 over blocks 100..104; block 104 has no blocks row. Actions 7
// and 22 are tx-less, 11 and 25 take their source from their transaction.
function seedActions(){
    for(const [id, address] of [[1, 'X1'], [2, 'X2']]) insert('index_addresses', { id, address });
    for(const [id, tick] of [[1, 'TOKA'], [2, 'TOKB']]) insert('index_tickers', { id, tick });
    insert('index_statuses', { id: 1, status: 'valid' });
    for(const b of [100, 101, 102, 103]) insert('blocks', { block_index: b, block_time: 1700000000 + b });
    for(let i = 1; i <= 30; i++){
        const block = (i <= 16) ? 100 : (i === 29 ? 104 : 101 + (i % 3));
        const txless = [7, 22].includes(i);
        if(!txless){
            insert('index_transactions', { id: i, hash: 'h' + i });
            insert('transactions', { tx_index: i, block_index: block, tx_hash_id: i, source_id: (i % 2) ? 1 : 2 });
        }
        insert('actions', { action_index: i, block_index: block, tx_index: txless ? null : i, tx_vout: txless ? null : 0,
                            action_id: 1, action_format: 0, source_id: [11, 25].includes(i) ? null : ((i % 4) ? 1 : 2) });
    }
}

// Issues on most actions, sends with two legs on every third one, and fills of
// one dispenser (at action 40, owned by X2) on every fifth and on 7, 22, 29.
function seedLists(){
    for(let i = 1; i <= 30; i++){
        if(i % 3)
            insert('issues', { action_index: i, tick_id: (i % 2) ? 1 : 2, status_id: 1, description: 'd' + i });
        else for(const leg of [0, 1])
            insert('sends', { action_index: i, tick_id: (i % 2) ? 1 : 2, destination_id: leg ? 2 : 1, amount: '1', status_id: 1, leg_ordinal: leg });
        if(i % 5 === 0 || [7, 22, 29].includes(i))
            insert('dispenses', { action_index: i, dispenser_action_index: 40, get_tick_id: (i % 2) ? 1 : 2,
                                  give_tick_id: 2, destination_id: (i % 2) ? 1 : 2, status_id: 1 });
    }
    insert('dispensers', { action_index: 40, get_tick_id: 1, give_tick_id: 2, get_address_id: 2, status_id: 1 });
}

function boundaryConfig(method, type, search, action){
    return makeConfig({ type: 'explorer', data: { method, type, search, offset: { action, start: null, stop: null } } });
}

// getQueryOffsets over the statements as the builders write them, through the
// tx-less rewrite where the method takes it, run directly. Records each
// statement it runs.
async function referenceOffsets(config, offset1, length, out){
    const { method, type } = config.data;
    const action = config.data.offset.action;
    const { where, whereArgs } = await boundaryWhere(db, config);
    const ctx = { method, type, action, table: method.slice(3).toLowerCase(), where, whereArgs, length,
                  ...historyCursor(method, type), pagesOverBlocks: false };
    const asWritten = (sql) => TXLESS.has(method) ? optionalTransactionSql(sql) : sql;
    const exec = (sql, args) => { out.push({ sql, args }); return run(sql, args); };
    if(['first', 'last'].includes(action)){
        const rows = exec(asWritten(firstLastSql(ctx, action == 'first' ? 'DESC' : 'ASC', action == 'first' ? 1 : length + 1)), whereArgs);
        if(rows.length)
            offset1 = Number(rows[rows.length - 1].offset_index) + (action == 'first' ? 1 : 0);
    }
    if(!offset1)
        return [offset1, false];
    const stop = where + ' AND m.action_index ' + (action == 'prev' ? '>' : '<') + ' ?';
    const rows = exec(asWritten(stopSql(ctx, stop, 'DESC', length + 1)), [...whereArgs, offset1]);
    return [offset1, rows.length == length + 1 ? Number(rows[rows.length - 1].offset_index) : false];
}

function useSeededDb(){
    before(function () {
        sqlite = openIndexerTables(this, TABLES);
    });
    beforeEach(() => {
        for(const t of TABLES) sqlite.exec('DELETE FROM ' + t + ';');
        seedActions();
        seedLists();
        const configInfo = createConfigInfoStub();
        db   = new Database({ configInfo, util: new Utility(configInfo) });
        sent = [];
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { sent.push({ sql: q, args: a || [] }); return run(q, a); });
        sinon.stub(db, 'resultCacheGeneration').resolves(null);
    });
    afterEach(() => sinon.restore());
}

// Both readings of one step: the cursors, and every boundary statement each sent.
async function bothReadings(method, type, search, action, offset1){
    const config = boundaryConfig(method, type, search, action);
    const live   = await db.getQueryOffsets(config, offset1, LENGTH);
    const liveSql = sent.filter((s) => s.sql.includes('offset_index'));
    const ref = [];
    const refOffsets = await referenceOffsets(boundaryConfig(method, type, search, action), offset1, LENGTH, ref);
    return { live, liveSql, refOffsets, ref };
}

function expectNoDisplayJoin(type, sql){
    if(type != 'address')
        expect(sql).to.not.match(/LEFT\s+JOIN transactions/);
    if(!/JOIN transactions/.test(sql))
        expect(sql).to.not.include('t1.');
    if(type == 'block')
        expect(sql).to.match(/^SELECT (DISTINCT )?STRAIGHT_JOIN a1\.action_index as offset_index FROM actions a1 INNER JOIN \w+ m ON \(m\.action_index=a1\.action_index\) /);
}

describe('explorer page boundaries over the pruned tables, against the real indexer DDL', function () {
    useSeededDb();

    for(const method of METHODS){
        for(const [type, search] of LANES){
            it(`${method} type=${type} search=${search}: same cursors and boundary rows as the statements as written`, async () => {
                for(const [action, offset1] of STEPS){
                    sent = [];
                    const step = `${action} from ${offset1}`;
                    const { live, liveSql, refOffsets, ref } = await bothReadings(method, type, search, action, offset1);
                    expect(live, step).to.deep.equal(refOffsets);
                    expect(liveSql.length, step).to.equal(ref.length);
                    liveSql.forEach((s, i) => {
                        expect(run(s.sql, s.args), step + ' statement ' + i).to.deep.equal(run(ref[i].sql, ref[i].args));
                        expectNoDisplayJoin(type, s.sql);
                    });
                }
            });
        }
    }

    it('the seed reaches every case it is built for', async () => {
        const { live } = await bothReadings('getSends', 'block', '100', 'first', false);
        expect(live).to.deep.equal([16, 3]);
        const dispenses = await bothReadings('getDispenses', null, null, 'next', 31);
        expect(dispenses.ref[0].sql).to.match(/INNER\s+JOIN transactions/);
        expect(run(dispenses.ref[0].sql, dispenses.ref[0].args).map((r) => r.offset_index)).to.not.include(22);
        const issues = await bothReadings('getIssues', null, null, 'last', false);
        expect(run(issues.ref[0].sql, issues.ref[0].args).map((r) => r.offset_index)).to.include(7);
    });

    it('a duplicated blocks row repeats a boundary row in both readings alike', async () => {
        insert('blocks', { block_index: 101, block_time: 1 });
        for(const method of METHODS){
            sent = [];
            const { live, liveSql, refOffsets, ref } = await bothReadings(method, 'block', '101', 'last', false);
            expect(live, method).to.deep.equal(refOffsets);
            liveSql.forEach((s, i) => expect(run(s.sql, s.args), method).to.deep.equal(run(ref[i].sql, ref[i].args)));
        }
    });
});

// One explorer issues page from resolved cursors, through getIssues and runListQuery.
async function issuesPage(type, search, action, [start, stop]){
    const order  = ['prev', 'last'].includes(action) ? 'ASC' : 'DESC';
    const config = makeConfig({ type: 'explorer', data: { method: 'getIssues', type, search, query: {},
        offset: { action, start, stop }, sql: { order, limit: LENGTH } } });
    config.data.sql.where.data = await db.getQueryWhereSql(config);
    const [offset, offsetArgs] = await db.getQueryOffsetSql(config);
    Object.assign(config.data.sql.where, { offset, offsetArgs });
    const [query, args, count, page] = await db.getIssues(config);
    return (await runListQuery(db, config, query, args, count, page))[0];
}

describe('explorer issues pages over the pruned boundaries, against the real indexer DDL', function () {
    useSeededDb();

    for(const [type, search] of LANES){
        it(`type=${type} search=${search}: first, next, prev and last pages match the statements as written`, async () => {
            for(const [action, offset1] of STEPS){
                const { live, refOffsets } = await bothReadings('getIssues', type, search, action, offset1);
                const rows = await issuesPage(type, search, action, live);
                expect(rows, `${action} from ${offset1}`).to.deep.equal(await issuesPage(type, search, action, refOffsets));
                if(action == 'first' && type != 'block')
                    expect(rows, 'first page').to.have.lengthOf(LENGTH);
            }
        });
    }
});
