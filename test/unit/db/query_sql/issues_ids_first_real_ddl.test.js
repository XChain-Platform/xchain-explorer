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
 * The issues list picks its page by id and decorates only those rows. Every
 * lane and paging direction runs here against tables built from the indexer's
 * real DDL, next to the single statement it stands in for, and must return the
 * same rows and the same total. The seed carries what a wrong leg would trip
 * on: non-issue actions in the issue blocks, tx-less actions, an action whose
 * source falls back to its transaction, dangling display ids, an issue with no
 * action and an action with no block. A duplicated blocks row makes the ids leg
 * repeat an id, and that page must run as the single statement.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { openIndexerTables, runOnSqlite } = require('../../../helpers/indexer_ddl_sqlite.js');
const { listQueryArgs, runListQuery } = require('../../../../src/db/query_sql/data_rows.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const TABLES = ['issues', 'actions', 'blocks', 'transactions', 'index_addresses', 'index_statuses',
                'index_transactions', 'index_tickers', 'index_actions', 'index_memos'];

let sqlite, db, seen;

function run(q, a){
    return runOnSqlite(sqlite, q, a);
}

function insert(table, row){
    const cols = Object.keys(row);
    run('INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')', Object.values(row));
}

// Actions 1..30 over blocks 100..104; block 104 has no blocks row. Every third
// action is a SEND with no issues row; the rest are ISSUEs. Actions 7 and 22
// are tx-less, 11 and 25 take their source from their transaction.
function seedActions(){
    for(const [id, address] of [[1, 'X1'], [2, 'X2']]) insert('index_addresses', { id, address });
    for(const [id, tick] of [[1, 'TOKA'], [2, 'TOKB']]) insert('index_tickers', { id, tick });
    insert('index_statuses', { id: 1, status: 'valid' });
    insert('index_memos', { id: 1, memo: 'm' });
    insert('index_actions', { id: 1, action: 'ISSUE' });
    insert('index_actions', { id: 2, action: 'SEND' });
    for(const b of [100, 101, 102, 103]) insert('blocks', { block_index: b, block_time: 1700000000 + b });
    for(let i = 1; i <= 30; i++){
        const block = (i <= 16) ? 100 : (i === 29 ? 104 : 101 + (i % 3));
        const txless = [7, 22].includes(i);
        if(!txless){
            insert('index_transactions', { id: i, hash: 'h' + i });
            insert('transactions', { tx_index: i, block_index: block, tx_hash_id: i, source_id: (i % 2) ? 1 : 2 });
        }
        insert('actions', { action_index: i, block_index: block, tx_index: txless ? null : i, tx_vout: txless ? null : 0,
                            action_id: (i % 3 === 0) ? 2 : 1, action_format: 0,
                            source_id: [11, 25].includes(i) ? null : ((i % 4) ? 1 : 2) });
    }
}

// Issue rows for every ISSUE action, one issue with no action (40), and display
// ids that resolve, are NULL, or dangle.
function seedIssues(){
    for(let i = 1; i <= 30; i++){
        if(i % 3 === 0) continue;
        insert('issues', { action_index: i, tick_id: (i % 2) ? 1 : 2, transfer_id: (i % 5 === 0) ? 9 : null,
                           memo_id: (i % 4 === 0) ? 1 : null, status_id: (i % 7 === 0) ? 5 : 1, description: 'd' + i });
    }
    insert('issues', { action_index: 40, tick_id: 1, status_id: 1, description: 'orphan' });
}

const LANES = [[null, null], ['block', '100'], ['block', '101'], ['block', '103'],
               ['address', 'X1'], ['source', 'X2'], ['token', 'TOKA']];

const PAGES = [
    { label: 'first',      transport: 'explorer', order: 'DESC', limit: 4 },
    { label: 'next',       transport: 'explorer', order: 'DESC', limit: 4, offset: ' AND m.action_index < ?', offsetArgs: [14] },
    { label: 'prev',       transport: 'explorer', order: 'ASC',  limit: 3, offset: ' AND m.action_index > ? AND m.action_index < ?', offsetArgs: [4, 20] },
    { label: 'last',       transport: 'explorer', order: 'ASC',  limit: 3, offset: ' AND m.action_index <= ?', offsetArgs: [10] },
    { label: 'api page 2', transport: 'api',      order: 'DESC', limit: 3, apiOffset: 3 },
    { label: 'api past the end', transport: 'api', order: 'DESC', limit: 3, apiOffset: 40 }
];

async function issuesConfig(type, search, page){
    const config = makeConfig({
        type: page.transport,
        data: { method: 'getIssues', search, type, query: {},
                sql: { order: page.order, limit: page.limit, apiOffset: page.apiOffset || 0,
                       where: { data: '', offset: page.offset || '', offsetArgs: page.offsetArgs || [] } } }
    });
    config.data.sql.where.data = await db.getQueryWhereSql(config);
    return config;
}

// The single statement and the reader's own COUNT, run directly, as the
// reference every result below is compared against.
function reference(config, query, count){
    const where = config.data.sql.where;
    let base = listQueryArgs(db, config, null);
    if(where.dataArgs) base = [...where.dataArgs];
    let args = [...base, ...where.offsetArgs];
    if(config.type == 'api' && config.data.sql.apiOffset > 0){
        query += ' OFFSET ?';
        args.push(config.data.sql.apiOffset);
    }
    return { rows: run(query, args), total: Number(run(count, base)[0].total) };
}

async function runIssues(config){
    const [query, args, count, page] = await db.getIssues(config);
    const result = await runListQuery(db, config, query, args, count, page);
    return { query, count, page, result };
}

function useSeededIssuesDb(){
    before(function () {
        sqlite = openIndexerTables(this, TABLES);
    });
    beforeEach(() => {
        for(const t of TABLES) sqlite.exec('DELETE FROM ' + t + ';');
        seedActions();
        seedIssues();
        const configInfo = createConfigInfoStub();
        db   = new Database({ configInfo, util: new Utility(configInfo) });
        seen = [];
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { seen.push(q); return run(q, a); });
        sinon.stub(db, 'resultCacheGeneration').resolves(null);
    });
    afterEach(() => sinon.restore());
}

describe('db.getIssues: ids-first page against the real indexer DDL', function () {
    useSeededIssuesDb();

    for(const [type, search] of LANES){
        for(const page of PAGES){
            it(`type=${type} search=${search}, ${page.label}: same rows and total as the single statement`, async () => {
                const config = await issuesConfig(type, search, page);
                const { query, count, page: plan, result } = await runIssues(config);
                const ref = reference(config, query, count);
                expect(plan).to.not.equal(null);
                expect(result[0]).to.deep.equal(ref.rows);
                expect(result[1]).to.equal(ref.total);
                expect(seen.some((q) => q.includes('a5.action') && /LIMIT \d+/.test(q))).to.equal(false);
            });
        }
    }

    it('the seed reaches every case it is built for', async () => {
        const config = await issuesConfig('block', '100', PAGES[0]);
        const ref = reference(config, (await db.getIssues(config))[0], (await db.getIssues(config))[2]);
        expect(ref.total).to.equal(11);
        expect(run('SELECT count(*) as n FROM issues m LEFT JOIN actions a1 ON (a1.action_index=m.action_index) WHERE a1.action_index IS NULL')[0].n).to.equal(1);
    });
});

describe('db.getIssues: ids-first edge cases against the real indexer DDL', function () {
    useSeededIssuesDb();

    it('a duplicated blocks row repeats an id, and the page runs as the single statement', async () => {
        insert('blocks', { block_index: 102, block_time: 1 });
        const config = await issuesConfig('block', '102', { transport: 'explorer', order: 'DESC', limit: 3 });
        const { query, count, result } = await runIssues(config);
        expect(result[0]).to.deep.equal(reference(config, query, count).rows);
        expect(result[0]).to.have.lengthOf(3);
        expect(seen).to.include(query);
    });

    it('a page with no matching rows answers empty without a decorate leg', async () => {
        const config = await issuesConfig('block', '104', PAGES[0]);
        const { result } = await runIssues(config);
        expect(result).to.deep.equal([[], 0]);
        expect(seen.some((q) => q.includes('m.action_index IN ('))).to.equal(false);
    });
});

describe('db.getIssues: the SQL each leg sends', function () {
    useSeededIssuesDb();

    async function legs(type, search, page){
        const config = await issuesConfig(type, search, page);
        await runIssues(config);
        return { ids: seen.find((q) => /as action_index FROM/.test(q)), rows: seen.find((q) => q.includes('m.action_index IN (')) };
    }

    it('the block lane drives the ids leg from actions, with no display join', async () => {
        const { ids } = await legs('block', '100', PAGES[1]);
        expect(ids).to.match(/^SELECT STRAIGHT_JOIN a1\.action_index as action_index FROM actions a1 INNER JOIN issues m ON \(m\.action_index=a1\.action_index\) INNER JOIN blocks\s+b1 ON \(b1\.block_index=a1\.block_index\) WHERE m\.action_index IS NOT NULL AND a1\.block_index=\? AND m\.action_index < \? ORDER BY a1\.action_index DESC LIMIT 4$/);
    });

    it('the address lane keeps only the transactions join its WHERE names', async () => {
        const { ids } = await legs('address', 'X1', PAGES[0]);
        expect(ids).to.match(/^SELECT m\.action_index as action_index FROM issues m INNER JOIN actions\s+a1 .* INNER JOIN blocks\s+b1 .* LEFT\s+JOIN transactions\s+t1 ON \(t1\.tx_index=a1\.tx_index\) WHERE /);
        expect(ids).to.not.match(/index_(addresses|statuses|memos|actions|transactions)/);
    });

    it('an API page binds its OFFSET on the ids leg, and the rows leg takes no LIMIT', async () => {
        const { ids, rows } = await legs(null, null, PAGES[4]);
        expect(ids).to.match(/LIMIT 3 OFFSET \?$/);
        expect(rows).to.match(/WHERE m\.action_index IN \(\?,\?,\?\)\s+ORDER BY m\.action_index DESC$/);
    });
});
