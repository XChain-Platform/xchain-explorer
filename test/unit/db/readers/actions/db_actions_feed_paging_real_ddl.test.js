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
 * The raw /explorer/actions feed paged the way the DataTables client pages
 * it (first, next with the last row's cursor, last with the client's total,
 * prev from the last page), through the real query builder, the real paging
 * window and tables built from the indexer's real DDL. Each page must hold the
 * next run of actions; a feed whose cursor is dropped answers page 2 and the
 * last page with no rows.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../../fixtures/mock-query-args.js');
const { openIndexerTables, runOnSqlite } = require('../../../../helpers/indexer_ddl_sqlite.js');
const { runListQuery } = require('../../../../../src/db/query_sql/data_rows.js');
const paging = require('../../../../../src/explorer/paging.js').methods;

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const TABLES = ['actions', 'blocks', 'transactions', 'index_actions', 'index_addresses', 'index_transactions'];
const TOTAL  = 10;

let sqlite, db, util;

// Actions 1..10, two per block from 200, all SEND except a tx-less ANCHOR at 6.
function seed(){
    for(const t of TABLES) sqlite.exec('DELETE FROM ' + t + ';');
    const send   = Number(sqlite.prepare("INSERT INTO index_actions (action) VALUES ('SEND')").run().lastInsertRowid);
    const anchor = Number(sqlite.prepare("INSERT INTO index_actions (action) VALUES ('ANCHOR')").run().lastInsertRowid);
    const source = Number(sqlite.prepare("INSERT INTO index_addresses (address) VALUES ('addr1')").run().lastInsertRowid);
    for(let b = 200; b <= 204; b++)
        sqlite.prepare('INSERT INTO blocks (block_index, block_time) VALUES (?, ?)').run(b, 1700000000 + b);
    for(let i = 1; i <= TOTAL; i++){
        const block = 200 + Math.floor((i - 1) / 2);
        const txless = (i === 6);
        if(!txless){
            const hash = Number(sqlite.prepare('INSERT INTO index_transactions (hash) VALUES (?)').run('h' + i).lastInsertRowid);
            sqlite.prepare('INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES (?, ?, ?, ?)').run(i, block, hash, source);
        }
        sqlite.prepare('INSERT INTO actions (action_index, block_index, tx_index, action_id, action_format, source_id) VALUES (?, ?, ?, ?, 0, ?)')
            .run(i, block, txless ? null : i, txless ? anchor : send, txless ? null : source);
    }
}

// One explorer request for the feed, as resolve_route builds it from the query string.
async function page(q){
    const config = makeConfig({
        type: 'explorer',
        data: {
            method: 'getActions', search: undefined, type: null,
            query: Object.assign({ length: '3' }, q),
            sql: { order: null, limit: null },
            offset: { action: q.action, start: (q.offset === undefined) ? false : q.offset, stop: null }
        }
    });
    const [query, args, count] = await db.getQuery(config);
    const [data, total] = await runListQuery(db, config, query, args, count);
    return paging.getPagingDataResults.call({ util, db }, config, data, total);
}

const cursors = (rows) => rows.map((r) => r[r.length - 1]);
// The display count is a mathjs BigNumber from the paging helpers' bc math.
const plain   = (rows) => rows.map((r) => [String(r[0]), ...r.slice(1)]);

describe('getActions explorer paging against the real indexer DDL', function () {
    before(function () {
        sqlite = openIndexerTables(this, TABLES);
    });
    beforeEach(() => {
        seed();
        const configInfo = createConfigInfoStub();
        util = new Utility(configInfo);
        db   = new Database({ configInfo, util });
        sinon.stub(db, 'doQuery').callsFake(async (c, q, a) => runOnSqlite(sqlite, q, a));
    });
    afterEach(() => sinon.restore());

    it('first opens at the newest actions, numbered down from the total', async () => {
        const rows = await page({ start: '0', action: 'first' });
        expect(plain(rows)).to.deep.equal([
            ['10', 204, 1700000204, 'addr1', 'SEND', 10],
            ['9', 204, 1700000204, 'addr1', 'SEND', 9],
            ['8', 203, 1700000203, 'addr1', 'SEND', 8]
        ]);
    });

    it('next continues below the last cursor, the tx-less action included', async () => {
        const rows = await page({ start: '3', action: 'next', offset: '8', total: String(TOTAL) });
        expect(plain(rows)).to.deep.equal([
            ['7', 203, 1700000203, 'addr1', 'SEND',   7],
            ['6', 202, 1700000202, null,    'ANCHOR', 6],
            ['5', 202, 1700000202, 'addr1', 'SEND',   5]
        ]);
        expect(cursors(await page({ start: '6', action: 'next', offset: '5', total: String(TOTAL) }))).to.deep.equal([4, 3, 2]);
    });

    it('last holds the oldest remainder the client total leaves', async () => {
        const rows = await page({ start: '9', action: 'last', total: String(TOTAL) });
        expect(plain(rows)).to.deep.equal([['1', 200, 1700000200, 'addr1', 'SEND', 1]]);
    });

    it('prev from the last page returns the page above it, newest first', async () => {
        const rows = await page({ start: '6', action: 'prev', offset: '1', total: String(TOTAL) });
        expect(plain(rows).map((r) => [r[0], r[5]])).to.deep.equal([['4', 4], ['3', 3], ['2', 2]]);
    });

    it('the row query carries the inbound cursor as a bound predicate', async () => {
        const seen = [];
        db.doQuery.callsFake(async (c, q, a) => { seen.push({ q, a }); return runOnSqlite(sqlite, q, a); });
        await page({ start: '3', action: 'next', offset: '8', total: String(TOTAL) });
        const list = seen.find((s) => s.q.includes('ORDER BY m.action_index'));
        expect(list.q).to.include('AND m.action_index < ?');
        expect(list.q).to.match(/LIMIT 3$/);
        expect(list.a).to.deep.equal([8]);
    });
});
