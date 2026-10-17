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
 * The paging contracts every list keeps: each explorer feed is paged one
 * named way, its rows end with the cursor it pages on, the prev stop marker
 * reads upward, self-run readers honour the page and report a numeric total,
 * and a malformed paging parameter answers 400 instead of a default or a 500.
 */

'use strict';

const { expect }   = require('chai');
const proxyquire   = require('proxyquire');
const Utility      = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const tables = require('../../../../src/db/method_tables.js');
const { explorer: FEEDS } = require('../../../../src/explorer/routes/explorer_feeds.js');
const { stakeLifecycleRows } = require('../../../../src/explorer/paging/list_rows.js');
const { stopOffset } = require('../../../../src/db/query_sql/offset_boundaries.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

function makeDb(rows){
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    const calls = [];
    db.doQuery = async (config, sql, args) => { calls.push({ sql: String(sql), args }); return rows ? rows(String(sql)) : []; };
    db.calls = calls;
    return db;
}

function feedMethods(){
    return [...new Set(Object.values(FEEDS).map((v) => (Array.isArray(v) ? v[0] : v)))];
}

async function refusal(promise){
    return promise.then(() => null, (e) => (e && e.name === 'DbInputError') ? e.code : e);
}

describe('every explorer feed pages one named way', function () {
    // Lists the explorer serves whole: the market overview has no cursor to page on.
    const UNPAGED = ['getMarkets'];

    it('names each feed method as boundary-paged, cursor-paged, slice-paged or unpaged', function () {
        for(const method of feedMethods()){
            const ways = [Boolean(tables.boundaryTable(method)), tables.CURSOR_PAGED_METHODS.includes(method),
                tables.SLICE_PAGED_METHODS.includes(method), UNPAGED.includes(method)].filter(Boolean);
            expect(ways, method).to.have.lengthOf(1);
        }
    });

    it('maps multi-word action tables explicitly instead of deriving them from the method', function () {
        expect(tables.boundaryTable('getOrderMatches')).to.equal(null);
        expect(tables.CURSOR_PAGED_METHODS).to.include('getOrderMatches');
        expect(tables.boundaryTable('getSends')).to.equal('sends');
        expect(tables.boundaryTable('constructor')).to.equal(null);
    });

    it('passes the inbound cursor through for a feed with no boundary table', async function () {
        const db = makeDb();
        for(const method of ['getOrderMatches', 'getContracts', 'getStakes', 'getValidatorRewards']){
            const config = makeConfig({ type: 'explorer', data: { method, type: null, offset: { action: 'next' } } });
            expect(await db.getQueryOffsets(config, '19', 10), method).to.deep.equal(['19', false]);
        }
    });

    it('pages multi-row lists by row position, fetching start+length rows', async function () {
        const db = makeDb();
        for(const method of tables.MULTI_ROW_METHODS){
            db[method] = async () => ['SELECT 1', [], ''];
            const config = makeConfig({ type: 'explorer',
                data: { method, query: { start: '20', length: '10', action: 'prev', offset: '7' }, offset: { action: 'prev' } } });
            await db.getQuery(config);
            expect(Number(config.data.sql.limit), method).to.equal(30);
            expect(config.data.offset.action, method).to.equal('next');
            expect(config.data.sql.where.offset, method).to.equal('');
        }
    });
});

describe('explorer rows end with the cursor their list pages on', function () {
    it('ends a full-node verification row with its id and keeps action_index beside it', function () {
        const row = stakeLifecycleRows({ action_index: 40, id: 7, passed: 1 },
            { count_reverse: 1, status: 1, method: 'getFullNodeVerifications' });
        expect(row[row.length - 1]).to.equal(7);
        expect(row[9]).to.equal(40);
    });

    it('selects the id the full-node verification list orders by', async function () {
        const db = makeDb();
        const config = makeConfig({ data: { method: 'getFullNodeVerifications', sql: { where: { data: '1=1' } } } });
        const [query] = await db.getFullNodeVerifications(config);
        expect(query).to.match(/SELECT\s+a4\.action,\s+m\.id,/);
        expect(query).to.include('ORDER BY m.id');
    });

    it('ends an attestation row with its action_index after the batch fields', function () {
        const row = stakeLifecycleRows({ action_index: 30, batch_total_chunks: null },
            { count_reverse: 1, status: 1, method: 'getAttestations' });
        expect(row[row.length - 1]).to.equal(30);
        expect(row[10]).to.equal(30);
    });
});

describe('the explorer stop marker walks away from the cursor', function () {
    function ctx(method, action){
        return { method, action, table: method === 'getTokens' ? 'tokens' : 'addresses', where: '', whereArgs: [],
            hCursor: 'a1.action_index', hSource: 'actions a1', length: 3 };
    }

    it('reads the prev stop marker upward and the next one downward', async function () {
        const db = makeDb();
        await stopOffset(db, makeConfig(), ctx('getAddresses', 'prev'), 23);
        await stopOffset(db, makeConfig(), ctx('getAddresses', 'next'), 23);
        expect(db.calls[0].sql).to.match(/m\.action_index > \?[\s\S]*ORDER BY m\.action_index ASC/);
        expect(db.calls[1].sql).to.match(/m\.action_index < \?[\s\S]*ORDER BY m\.action_index DESC/);
    });

    it('reads the tokens stop marker on the m.id cursor the list pages on', async function () {
        const db = makeDb();
        await stopOffset(db, makeConfig(), ctx('getTokens', 'prev'), 23);
        expect(db.calls[0].sql).to.match(/m\.id as offset_index[\s\S]*m\.id > \?[\s\S]*ORDER BY m\.id ASC/);
    });
});

describe('self-run list readers honour the page and report a numeric total', function () {
    function blocksDb(){
        return makeDb((sql) => (/count\(\*\)/i.test(sql) ? [{ total: 11n }] : []));
    }

    it('applies the API page to /api/blocks and counts as a number', async function () {
        const db = blocksDb();
        const config = makeConfig({ type: 'api', data: { method: 'getBlocks', query: { limit: '2', page: '3' } } });
        const [, total] = await db.getData(config);
        const rows = db.calls.find((c) => /SELECT\s+block_index,\s+block_time/.test(c.sql));
        expect(total).to.equal(11);
        expect(rows.sql).to.match(/LIMIT 2 OFFSET \?$/);
        expect(rows.args).to.deep.equal([4]);
    });

    it('applies the explorer cursor and the API page to market history, its total still a string', async function () {
        const db = makeDb((sql) => (/count\(\*\)/i.test(sql) ? [{ total: 5n }] : []));
        const api = makeConfig({ type: 'api', data: { method: 'getMarketHistory', search: 'A', search2: 'B',
            query: { limit: '2', page: '2' } } });
        expect(String((await db.getData(api))[1])).to.equal('5');
        expect(db.calls[db.calls.length - 1].sql).to.match(/OFFSET \?$/);
        db.calls.length = 0;
        const explorer = makeConfig({ type: 'explorer', data: { method: 'getMarketHistory', search: 'A', search2: 'B',
            query: { start: '2', length: '2', action: 'next', offset: '9' }, offset: { action: 'next', start: '9' } } });
        await db.getData(explorer);
        const rows = db.calls.find((c) => /ORDER BY m\.action_index/.test(c.sql));
        expect(rows.sql).to.include('AND m.action_index < ?');
        expect(rows.args[rows.args.length - 1]).to.equal(9);
    });
});

describe('malformed paging parameters answer 400', function () {
    function apiConfig(query){
        return makeConfig({ type: 'api', data: { method: 'probe', query } });
    }
    function explorerConfig(method, query){
        return makeConfig({ type: 'explorer', data: { method, query, offset: { action: query.action } } });
    }
    let db;
    beforeEach(() => { db = makeDb(); db.probe = async () => ['SELECT 1', [], '']; db.getBalances = db.probe; });

    it('refuses a non-integer or out-of-range limit and an unknown sortorder', async function () {
        for(const limit of ['0', '-1', 'abc', '1.5', '1e3', '99999999999999999999', ['1', '2']])
            expect(await refusal(db.getQuery(apiConfig({ limit }))), JSON.stringify(limit)).to.equal('INVALID_LIMIT');
        for(const sortorder of ['sideways', 'random', '1', 'asc ', ['asc', 'desc']])
            expect(await refusal(db.getQuery(apiConfig({ sortorder }))), JSON.stringify(sortorder)).to.equal('INVALID_SORTORDER');
    });

    it('keeps valid paging requests as they were', async function () {
        const big = apiConfig({ limit: '500', sortorder: 'ASC' });
        await db.getQuery(big);
        expect(big.data.sql.limit).to.equal(100);
        expect(big.data.sql.order).to.equal('ASC');
        const plain = apiConfig({ limit: '', sortorder: '', page: '' });
        await db.getQuery(plain);
        expect([plain.data.sql.limit, plain.data.sql.order, plain.data.sql.apiOffset]).to.deep.equal([100, 'DESC', 0]);
    });

    it('refuses a fractional or non-numeric explorer length instead of emitting LIMIT 1.5', async function () {
        db.getActions = db.probe;
        for(const length of ['1.5', '2.25', 'abc', '0', '-1'])
            expect(await refusal(db.getQuery(explorerConfig('getActions', { start: '0', length, action: 'first' }))),
                length).to.equal('INVALID_LENGTH');
        const last = explorerConfig('getActions', { start: '10', length: '10', action: 'last', total: '12.5' });
        last.data.query.total = '12.5';
        await db.getQuery(last);
        expect(Number.isInteger(last.data.sql.limit)).to.equal(true);
    });

    it('refuses a non-integer explorer offset on a cursor-paged feed', async function () {
        db.getBlocks = db.probe;
        for(const offset of ['7junk', '٣', '７', '😀', "1' OR '1'='1", ' 7', '1.5'])
            expect(await refusal(db.getQuery(explorerConfig('getBlocks', { start: '10', length: '10', action: 'next', offset }))),
                offset).to.equal('INVALID_OFFSET');
    });

    it('ignores the offset on a feed paged by row position, whose last cell is not a cursor', async function () {
        const config = explorerConfig('getBalances', { start: '10', length: '10', action: 'next', offset: 'TOKEN' });
        expect(await refusal(db.getQuery(config))).to.equal(null);
    });
});
