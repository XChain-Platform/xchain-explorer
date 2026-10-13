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
 * getHistoryData picks a page of action_indexes first and decorates only
 * those rows. These tests pin that SQL shape, and run the feed against tables
 * built from the indexer's real DDL next to the single-statement DISTINCT
 * query it stands in for, so every feed type and paging direction is shown to
 * return the same rows and the same total. A duplicated mapping or blocks row
 * is seeded too: there the ids leg repeats an id and the page must fall back
 * to the DISTINCT statement.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { openIndexerTables, runOnSqlite } = require('../../../helpers/indexer_ddl_sqlite.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const TABLES = ['actions', 'blocks', 'transactions', 'index_actions', 'index_transactions', 'mappings_actions', 'batches'];
const ADDRESS_ID = 7;
const TICK_ID    = 4;

// The single-statement page and count the ids-first legs replace, as the
// reference every result below is compared against.
function referencePage(cursor, source, where, order, limit, apiOffset){
    return `SELECT DISTINCT(` + cursor + `) as action_index, a2.action, b1.block_index,
                b1.block_time as timestamp, t2.hash as tx_hash, t1.tx_index,
                (SELECT bpx.action_index FROM actions apx
                    INNER JOIN batches bpx ON (bpx.action_index=apx.action_index)
                    WHERE apx.tx_index=a1.tx_index AND apx.tx_vout=a1.tx_vout
                        AND apx.action_index!=a1.action_index LIMIT 1) as parent_batch_action_index
            FROM ` + source + `
                INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
            WHERE ` + where + ` ORDER BY ` + cursor + ` ` + order + ` LIMIT ` + limit
            + ((apiOffset > 0) ? ' OFFSET ?' : '');
}

function referenceCount(cursor, source, where){
    return `SELECT count(DISTINCT(` + cursor + `)) as count FROM ` + source + `
                INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
            WHERE ` + where;
}

function shapeOf(type){
    const mapped = ['address', 'token'].includes(type);
    return {
        cursor: mapped ? 'm.action_index' : 'a1.action_index',
        source: mapped ? 'mappings_actions m INNER JOIN actions a1 ON (a1.action_index=m.action_index)' : 'actions a1'
    };
}

let sqlite, db, seen;

function seed(){
    for(const t of TABLES) sqlite.exec('DELETE FROM ' + t + ';');
    const name = {};
    for(const a of ['SEND', 'BATCH', 'ANCHOR'])
        name[a] = Number(sqlite.prepare('INSERT INTO index_actions (action) VALUES (?)').run(a).lastInsertRowid);
    for(const b of [100, 101, 102, 103])
        sqlite.prepare('INSERT INTO blocks (block_index, block_time) VALUES (?, ?)').run(b, 1700000000 + b);
    // Actions 1..20 over blocks 100..104; block 104 has no blocks row, so action 20
    // is outside every feed. Action 9 is tx-less. Action 12 is a BATCH whose
    // children 13 and 14 share its (tx_index, tx_vout).
    for(let i = 1; i <= 20; i++){
        const block = (i === 20) ? 104 : 100 + Math.floor((i - 1) / 5);
        const tx    = (i === 9) ? null : ([13, 14].includes(i) ? 12 : i);
        if(tx !== null && tx === i){
            const hash = Number(sqlite.prepare('INSERT INTO index_transactions (hash) VALUES (?)').run('h' + i).lastInsertRowid);
            sqlite.prepare('INSERT INTO transactions (tx_index, block_index, tx_hash_id) VALUES (?, ?, ?)').run(i, block, hash);
        }
        const action = (i === 12) ? name.BATCH : ((i === 9) ? name.ANCHOR : name.SEND);
        sqlite.prepare('INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id) VALUES (?, ?, ?, ?, ?)')
            .run(i, block, tx, (tx === null) ? null : 0, action);
    }
    sqlite.prepare('INSERT INTO batches (action_index) VALUES (12)').run();
    // Address rows include an action with no blocks row (20) and one with no action (25).
    for(const i of [2, 3, 5, 8, 12, 13, 14, 17, 19, 20, 25])
        mapping(i, 2, ADDRESS_ID);
    for(const i of [3, 6, 13, 18])
        mapping(i, 1, TICK_ID);
    // Same id under the other mapping type: must not leak into the address feed.
    mapping(4, 1, ADDRESS_ID);
}

function mapping(actionIndex, typeId, id){
    sqlite.prepare('INSERT INTO mappings_actions (action_index, type_id, id) VALUES (?, ?, ?)').run(actionIndex, typeId, id);
}

const FEEDS = [
    ['address', 'addr1'],
    ['token',   'TOK'],
    ['block',   '102'],
    ['recent',  'addr1'],
    ['recent',  'null'],
    [null,      null]
];

const PAGES = [
    { label: 'first',     transport: 'explorer', order: 'DESC', limit: 3 },
    { label: 'next',      transport: 'explorer', order: 'DESC', limit: 3, offset: { action: 'next', start: 14 } },
    { label: 'prev',      transport: 'explorer', order: 'ASC',  limit: 3, offset: { action: 'prev', start: 5 } },
    { label: 'last',      transport: 'explorer', order: 'ASC',  limit: 2, offset: { action: 'last', start: null } },
    { label: 'api page 2', transport: 'api',     order: 'DESC', limit: 3, apiOffset: 3 },
    { label: 'api past the end', transport: 'api', order: 'DESC', limit: 3, apiOffset: 30 }
];

async function historyConfig(type, search, page){
    const config = makeConfig({
        type: page.transport,
        data: {
            method: 'getHistory', search, type,
            sql: { order: page.order, limit: page.limit, apiOffset: page.apiOffset || 0, where: { data: '', offset: '' } },
            query: {},
            offset: page.offset || { action: null, start: null, stop: null }
        }
    });
    config.data.sql.where.data = await db.getQueryWhereSql(config);
    return config;
}

// What the single-statement form returns for the same request.
function reference(config, total){
    const { type, search, sql, offset } = config.data;
    const { cursor, source } = shapeOf(type);
    // The pre-change WHERE named the block on b1, which the join equates with a1.
    let where = sql.where.data.replace('a1.block_index=?', 'b1.block_index=?');
    let args  = (type == 'block') ? [search] : (['address', 'token'].includes(type) ? [type == 'address' ? ADDRESS_ID : TICK_ID] : []);
    const countRows = runOnSqlite(sqlite, referenceCount(cursor, source, where), args);
    if(offset && offset.action && offset.start){
        where += ' AND ' + cursor + ((offset.action == 'prev') ? ' > ?' : ' < ?');
        args = [...args, offset.start];
    }
    const apiOffset = (config.type == 'api') ? sql.apiOffset : 0;
    const rows = runOnSqlite(sqlite, referencePage(cursor, source, where, sql.order, sql.limit, apiOffset),
        (apiOffset > 0) ? [...args, apiOffset] : args);
    return { rows, count: Number(countRows[0].count) };
}

// Shared hooks for the two suites below: a seeded SQLite copy of the real
// indexer tables behind db.doQuery, recording every statement sent.
function useSeededHistoryDb(){
    before(function () {
        sqlite = openIndexerTables(this, TABLES);
    });
    beforeEach(() => {
        seed();
        const configInfo = createConfigInfoStub();
        db   = new Database({ configInfo, util: new Utility(configInfo) });
        seen = [];
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => { seen.push(q); return runOnSqlite(sqlite, q, a); });
        sinon.stub(db, 'getAddressId').resolves(ADDRESS_ID);
        sinon.stub(db, 'getTickId').resolves(TICK_ID);
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, rows) => rows);
    });
    afterEach(() => sinon.restore());
}

describe('db.getHistoryData: ids-first page against the real indexer DDL', function () {
    useSeededHistoryDb();

    for(const [type, search] of FEEDS){
        for(const page of PAGES){
            it(`type=${type} search=${search}, ${page.label}: same rows and total as the DISTINCT statement`, async () => {
                const config = await historyConfig(type, search, page);
                const [rows, total] = await db.getHistoryData(config);
                const ref = reference(config);
                expect(rows).to.deep.equal(ref.rows);
                // search=null on a list feed answers the highest action_index instead of a COUNT.
                if(search == 'null' && type != 'token')
                    expect(total).to.equal(20);
                else
                    expect(total).to.equal(ref.count);
                expect(seen.some((q) => q.includes('DISTINCT(' + shapeOf(type).cursor + ') as action_index'))).to.equal(false);
            });
        }
    }
});

describe('db.getHistoryData: ids-first edge cases against the real indexer DDL', function () {
    useSeededHistoryDb();

    it('a page past the API OFFSET is empty, not the first page again', async () => {
        const config = await historyConfig('address', 'addr1', PAGES[5]);
        const [rows, total] = await db.getHistoryData(config);
        expect(rows).to.deep.equal([]);
        expect(total).to.equal(9);
    });

    it('a duplicated mapping row repeats an id, and the page falls back to the DISTINCT statement', async () => {
        mapping(13, 2, ADDRESS_ID);
        const config = await historyConfig('address', 'addr1', { transport: 'explorer', order: 'DESC', limit: 5 });
        const [rows] = await db.getHistoryData(config);
        expect(rows).to.deep.equal(reference(config).rows);
        expect(rows.map((r) => r.action_index)).to.deep.equal([19, 17, 14, 13, 12]);
        expect(seen.some((q) => q.includes('DISTINCT(m.action_index) as action_index'))).to.equal(true);
    });

    it('a duplicated blocks row with its own block_time keeps both rows, as the DISTINCT statement does', async () => {
        sqlite.prepare('INSERT INTO blocks (block_index, block_time) VALUES (102, 1)').run();
        const config = await historyConfig('block', '102', { transport: 'explorer', order: 'DESC', limit: 4 });
        const [rows, total] = await db.getHistoryData(config);
        const ref = reference(config);
        expect(rows).to.deep.equal(ref.rows);
        expect(total).to.equal(ref.count);
        expect(rows).to.have.lengthOf(4);
    });

    it('the parent BATCH rides on its children and on nothing else', async () => {
        const config = await historyConfig('block', '102', { transport: 'explorer', order: 'DESC', limit: 5 });
        const [rows] = await db.getHistoryData(config);
        const parent = Object.fromEntries(rows.map((r) => [r.action_index, r.parent_batch_action_index]));
        expect(parent).to.deep.equal({ 15: null, 14: 12, 13: 12, 12: null, 11: null });
    });
});

describe('db.getHistoryData: the SQL each leg sends', function () {
    beforeEach(() => {
        const configInfo = createConfigInfoStub();
        db   = new Database({ configInfo, util: new Utility(configInfo) });
        seen = [];
        sinon.stub(db, 'getAddressId').resolves(ADDRESS_ID);
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, rows) => rows);
    });
    afterEach(() => sinon.restore());

    async function capture(page){
        const legs = {};
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => {
            if(q.includes('count(DISTINCT')){ legs.count = { q, a }; return [{ count: 3 }]; }
            if(q.includes('IN (')){ legs.rows = { q, a }; return []; }
            legs.ids = { q, a };
            return [{ action_index: 9 }, { action_index: 8 }, { action_index: 7 }];
        });
        const config = await historyConfig('address', 'addr1', page);
        await db.getHistoryData(config);
        return legs;
    }

    it('the ids leg selects only the cursor, with no DISTINCT and no decoration, bounded by LIMIT', async () => {
        const { ids } = await capture({ transport: 'explorer', order: 'DESC', limit: 10, offset: { action: 'next', start: 50 } });
        expect(ids.q).to.match(/^SELECT STRAIGHT_JOIN\s+m\.action_index as action_index\s+FROM\s+mappings_actions m\s+INNER JOIN actions\s+a1 ON \(a1\.action_index=m\.action_index\)\s+INNER JOIN blocks\s+b1 ON \(b1\.block_index=a1\.block_index\)\s+WHERE m\.action_index IS NOT NULL AND m\.type_id=2 AND m\.id=\? AND m\.action_index < \?\s+ORDER BY m\.action_index DESC\s+LIMIT 10$/);
        expect(ids.a).to.deep.equal([ADDRESS_ID, 50]);
        expect(ids.q).to.not.include('DISTINCT');
        expect(ids.q).to.not.include('batches');
        expect(ids.q).to.not.match(/LEFT\s+JOIN/);
    });

    it('the rows leg decorates exactly the picked ids, in cursor order, with the parent lookup', async () => {
        const { rows } = await capture({ transport: 'explorer', order: 'DESC', limit: 10 });
        expect(rows.a).to.deep.equal([9, 8, 7]);
        expect(rows.q).to.include('WHERE a1.action_index IN (?,?,?)');
        expect(rows.q).to.match(/ORDER BY a1\.action_index DESC$/);
        expect(rows.q).to.include('as parent_batch_action_index');
        expect(rows.q).to.not.include('LIMIT 10');
    });

    it('the count keeps the membership joins, checks blocks through EXISTS and drops the LEFT joins', async () => {
        const { count } = await capture({ transport: 'explorer', order: 'DESC', limit: 10 });
        expect(count.q).to.match(/^SELECT\s+count\(DISTINCT\(m\.action_index\)\) as count\s+FROM\s+mappings_actions m\s+INNER JOIN actions\s+a1 ON \(a1\.action_index=m\.action_index\)\s+WHERE m\.action_index IS NOT NULL AND m\.type_id=2 AND m\.id=\?\s+AND EXISTS \(SELECT 1 FROM blocks b1 WHERE b1\.block_index=a1\.block_index\)$/);
        expect(count.q).to.not.match(/LEFT\s+JOIN/);
        expect(count.a).to.deep.equal([ADDRESS_ID]);
    });

    it('an API page binds its OFFSET last on the ids leg, capped by the shared 100k ceiling', async () => {
        const { ids } = await capture({ transport: 'api', order: 'DESC', limit: 100, apiOffset: 100000 });
        expect(ids.q).to.match(/LIMIT 100 OFFSET \?$/);
        expect(ids.a).to.deep.equal([ADDRESS_ID, 100000]);
    });

    it('an explorer request never carries an OFFSET', async () => {
        const { ids } = await capture({ transport: 'explorer', order: 'DESC', limit: 10, apiOffset: 30 });
        expect(ids.q).to.not.include('OFFSET');
    });
});
