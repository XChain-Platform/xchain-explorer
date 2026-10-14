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
 * List paging walked end to end through the real query builder, the real
 * paging window and tables built from the indexer's real DDL: every row once
 * on both transports, totals that count the rows the list shows, prev that
 * returns the page it left, and keyset continuations that stay in range.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { openIndexerTables, runOnSqlite } = require('../../../helpers/indexer_ddl_sqlite.js');
const paging = require('../../../../src/explorer/paging.js').methods;
const { assembleResponse } = require('../../../../src/explorer/request/assemble_response.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const TABLES = ['actions', 'blocks', 'transactions', 'index_actions', 'index_addresses', 'index_transactions',
    'index_tickers', 'index_memos', 'index_statuses', 'credits', 'addresses', 'balances', 'tokens'];

// Actions with several credits each: [action_index, [[address, amount], ...], txless].
const CREDITS = [[1, [['a1', '1']]], [2, [['a1', '2'], ['a2', '2'], ['a3', '2']]], [3, [['a2', '3']], true],
    [4, [['a3', '4']]], [5, [['a1', '5'], ['a2', '5'], ['a3', '5']]], [6, [['a1', '6']]]];
const CREDIT_ROWS = CREDITS.reduce((n, [, legs]) => n + legs.length, 0);

let sqlite, db, util, ids;

function insert(sql, ...args){
    return Number(sqlite.prepare(sql).run(...args).lastInsertRowid);
}

function seed(){
    for(const t of TABLES) sqlite.exec('DELETE FROM ' + t + ';');
    ids = { action: insert("INSERT INTO index_actions (action) VALUES ('SEND')"),
        valid: insert("INSERT INTO index_statuses (status) VALUES ('valid')"),
        tick: insert("INSERT INTO index_tickers (tick, block_index) VALUES ('TOKEN', 100)") };
    for(const a of ['a1', 'a2', 'a3'])
        ids[a] = insert('INSERT INTO index_addresses (address) VALUES (?)', a);
    for(let i = 1; i <= 8; i++){
        insert('INSERT INTO blocks (block_index, block_time) VALUES (?, ?)', 100 + i, 1700000000 + i);
        const txless = CREDITS.some(([idx, , none]) => idx === i && none);
        if(!txless){
            const hash = insert('INSERT INTO index_transactions (hash) VALUES (?)', 'h' + i);
            insert('INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES (?, ?, ?, ?)', i, 100 + i, hash, ids.a1);
        }
        insert('INSERT INTO actions (action_index, block_index, tx_index, action_id, action_format, source_id) VALUES (?, ?, ?, ?, 0, ?)',
            i, 100 + i, txless ? null : i, ids.action, ids.a1);
        insert('INSERT INTO addresses (action_index, status_id) VALUES (?, ?)', i, ids.valid);
    }
    for(const [idx, legs] of CREDITS)
        for(const [address, amount] of legs)
            insert('INSERT INTO credits (action_index, address_id, tick_id, amount) VALUES (?, ?, ?, ?)', idx, ids[address], ids.tick, amount);
    insert("INSERT INTO tokens (tick_id, action_index, supply, decimals) VALUES (?, 1, '30', 0)", ids.tick);
    for(const a of ['a1', 'a2', 'a3'])
        insert("INSERT INTO balances (address_id, tick_id, amount) VALUES (?, ?, '10')", ids[a], ids.tick);
}

// One list request the way resolve_route builds it from the query string.
async function list(type, method, query, filter){
    const config = makeConfig({
        type,
        data: Object.assign({
            method, search: undefined, type: null, query,
            sql: { order: null, limit: null },
            offset: { action: query.action, start: (query.offset === undefined) ? false : query.offset, stop: null }
        }, filter)
    });
    const [data, total] = await db.getData(config);
    const st = { cfg: config, data, total, response: {} };
    assembleResponse({ util, db, getPagingDataResults: paging.getPagingDataResults }, st);
    return st.response.json;
}

// The DataTables client: first, then next with the last row's last cell.
async function walkExplorer(method, length){
    const rows = [];
    let offset;
    let total = Infinity;
    for(let start = 0; start < total; start += length){
        const query = { start: String(start), length: String(length), action: start ? 'next' : 'first' };
        if(start) query.offset = String(offset);
        const json = await list('explorer', method, query);
        total = json.recordsTotal;
        if(!json.data.length) break;
        json.data.forEach((r) => rows.push(JSON.stringify(r.slice(1))));
        offset = json.data[json.data.length - 1].slice(-1)[0];
    }
    return { rows, total };
}

const key = (r) => [r.action_index, r.address, r.amount].join('|');

// Follow a keyset walk from one bound; returns the cursor values seen, in order.
async function keysetWalk(name, bound, sortorder){
    const next = (name === 'after') ? 'next_after' : 'next_before';
    const seen = [];
    let cursor = bound;
    for(let n = 0; n < 10 && cursor !== undefined; n++){
        const query = { limit: '2', [name]: cursor };
        if(sortorder) query.sortorder = sortorder;
        const json = await list('api', 'getAddresses', query);
        const page = json.data.map((r) => r.action_index);
        const shown = page.slice().sort((a, b) => (sortorder === 'asc' ? a - b : b - a));
        expect(page, name + ' page shown in sortorder').to.deep.equal(shown);
        seen.push(...page);
        cursor = json[next];
    }
    return seen;
}

// Build the real tables once and reseed them, with a Database reading them, per test.
function useRealTables(){
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
}

describe('multi-row list paging against the real indexer DDL', function () {
    useRealTables();

    it('walks every credit once on the explorer feed, pages past the first included', async () => {
        for(const length of [2, 3, 4]){
            const { rows, total } = await walkExplorer('getCredits', length);
            expect(rows, 'length ' + length).to.have.lengthOf(CREDIT_ROWS);
            expect(new Set(rows).size, 'length ' + length).to.equal(CREDIT_ROWS);
            expect(total).to.equal(CREDIT_ROWS);
        }
    });

    it('counts the tx-less credit the list shows', async () => {
        const json = await list('api', 'getCredits', { limit: '100' });
        expect(json.data).to.have.lengthOf(CREDIT_ROWS);
        expect(json.total).to.equal(CREDIT_ROWS);
        expect(json.data.map((r) => r.action_index)).to.include(3);
    });

    it('pages API credits on a total order: no row split or repeated, asc the reverse of desc', async () => {
        const all  = (await list('api', 'getCredits', { limit: '100' })).data.map(key);
        const asc  = (await list('api', 'getCredits', { limit: '100', sortorder: 'asc' })).data.map(key);
        expect(asc).to.deep.equal(all.slice().reverse());
        const walked = [];
        for(let page = 1; page <= 6; page++)
            (await list('api', 'getCredits', { limit: '2', page: String(page) })).data.forEach((r) => walked.push(key(r)));
        expect(walked).to.deep.equal(all);
    });
});

describe('list cursors and ranking against the real indexer DDL', function () {
    useRealTables();

    it('prev from page 3 returns page 2 exactly', async () => {
        const page2 = await list('explorer', 'getAddresses', { start: '3', length: '3', action: 'next', offset: '6' });
        const page3 = await list('explorer', 'getAddresses', { start: '6', length: '3', action: 'next', offset: '2' });
        const back  = await list('explorer', 'getAddresses', { start: '3', length: '3', action: 'prev', offset: String(page3.data[0].slice(-1)[0]) });
        expect(page2.data.map((r) => r.slice(-1)[0])).to.deep.equal([5, 4, 2]);
        expect(back.data).to.deep.equal(page2.data);
    });

    it('keeps an after walk above its bound in the default descending order', async () => {
        expect(await keysetWalk('after', '2')).to.deep.equal([5, 4, 7, 6, 8]);
    });

    it('keeps a before walk below its bound in ascending order', async () => {
        expect(await keysetWalk('before', '6', 'asc')).to.deep.equal([4, 5, 1, 2]);
    });

    it('ranks equal holder balances on a tiebreaker, asc the reverse of desc', async () => {
        const token = { search: 'TOKEN', type: 'token' };
        const desc = (await list('api', 'getHolders', { limit: '10' }, token)).data.map((r) => r.address);
        const asc  = (await list('api', 'getHolders', { limit: '10', sortorder: 'asc' }, token)).data.map((r) => r.address);
        expect(desc).to.deep.equal(['a3', 'a2', 'a1']);
        expect(asc).to.deep.equal(desc.slice().reverse());
    });
});
