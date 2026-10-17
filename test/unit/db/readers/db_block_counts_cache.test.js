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
 *
 * The blocks list caches each block's per-action-type counts, because a block's
 * counts never change once a later block is indexed above it and the count UNION
 * over the oldest, busiest blocks is the slowest part of the page. These pin what
 * the cache may hold (never the tip, never a failed read), what it retires (a
 * reorg generation bump, the oldest entry past the cap), and that the feed rows
 * it serves are the rows the uncached path builds.
 *
 *********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

// Per-block counts the fake chain holds: action table rows and format 5 renames.
const ACTION_ROWS = {
    12: [{ action: 'sends', count: 3 }, { action: 'lists', count: 1 }],
    11: [{ action: 'issuances', count: 2 }],
    10: []
};
const RENAME_ROWS = { 12: 1, 11: 0, 10: 0 };

// A Database over a fake chain whose indexed tip is `state.tip` and whose page is
// `state.page`. Every query is recorded so a test can see which blocks were counted.
function makeDb(state){
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    const db         = new Database({ configInfo, util });
    db.actionTables = ['sends', 'issuances', 'lists'];
    db.pools = { BTC: { config: { database: 'xchain_btc' }, pool: {} } };
    db.calls = [];
    db.doQuery = async (config, sql, args) => {
        const call = { sql: String(sql), args: args || [] };
        db.calls.push(call);
        if(state.fail && /UNION ALL/.test(call.sql)) throw state.fail;
        if(/MAX\(block_index\) AS tip/.test(call.sql)) return [{ tip: state.tip }];
        if(/count\(\*\) as total/.test(call.sql)) return [{ total: state.page.length }];
        if(/block_time/.test(call.sql)) return state.page.map(b => ({ block_index: b, block_time: b * 100 }));
        if(/list_metas/.test(call.sql))
            return call.args.filter(b => RENAME_ROWS[b]).map(b => ({ block_index: b, count: RENAME_ROWS[b] }));
        const rows = [];
        for(const b of new Set(call.args))
            for(const r of ACTION_ROWS[b] || []) rows.push({ block_index: b, action: r.action, count: r.count });
        return rows;
    };
    return db;
}

function blocksConfig(){
    return makeConfig({ coin: 'BTC', data: { method: 'getBlocks', sql: {
        order: 'DESC', limit: 10,
        where: { data: 'b1.block_index IS NOT NULL', offset: '', offsetArgs: [] }
    } } });
}

const countCalls = db => db.calls.filter(c => /UNION ALL/.test(c.sql));
const metaCalls  = db => db.calls.filter(c => /list_metas/.test(c.sql));
// The blocks one count UNION was asked about: every table branch binds the same list.
const unionBlocks = call => call.args.slice(0, call.args.length / 3);

const EXPECTED = [
    { block_index: 12, timestamp: 1200, actions: { sends: 3, lists: 2 } },
    { block_index: 11, timestamp: 1100, actions: { issuances: 2 } },
    { block_index: 10, timestamp: 1000, actions: {} }
];

describe('blocks list per-block action count cache', function(){

    it('serves the same feed rows from the cache as from the count queries', async function(){
        const db = makeDb({ tip: '20', page: [12, 11, 10] });
        const [cold] = await db.getBlocks(blocksConfig());
        assert.deepStrictEqual(cold, EXPECTED);
        db.calls = [];
        const [warm] = await db.getBlocks(blocksConfig());
        assert.deepStrictEqual(warm, EXPECTED);
        assert.strictEqual(countCalls(db).length, 0, 'a fully cached page still ran the count UNION');
        assert.strictEqual(metaCalls(db).length, 0, 'a fully cached page still ran the rename count');
    });

    it('counts only the blocks the cache misses', async function(){
        const state = { tip: '20', page: [12, 11] };
        const db = makeDb(state);
        await db.getBlocks(blocksConfig());
        state.page = [12, 11, 10];
        db.calls = [];
        const [rows] = await db.getBlocks(blocksConfig());
        assert.deepStrictEqual(rows, EXPECTED);
        assert.deepStrictEqual(countCalls(db).map(unionBlocks), [[10]]);
        assert.deepStrictEqual(metaCalls(db).map(c => c.args), [[10]]);
    });

    it('misses every entry after a reorg generation bump', async function(){
        const db = makeDb({ tip: '20', page: [12, 11, 10] });
        await db.getBlocks(blocksConfig());
        db.bumpReorgGeneration('BTC');
        db.calls = [];
        const [rows] = await db.getBlocks(blocksConfig());
        assert.deepStrictEqual(rows, EXPECTED);
        assert.deepStrictEqual(countCalls(db).map(unionBlocks), [[12, 11, 10]]);
    });

    it('never caches the indexed tip block', async function(){
        const db = makeDb({ tip: '12', page: [12, 11, 10] });
        await db.getBlocks(blocksConfig());
        db.calls = [];
        await db.getBlocks(blocksConfig());
        assert.deepStrictEqual(countCalls(db).map(unionBlocks), [[12]],
            'the tip block was served from the cache while its rows may still be landing');
    });

});

describe('blocks list per-block action count cache (continued)', function(){

    it('caches nothing when the tip probe fails or the chain is empty', async function(){
        for(const tip of [null, undefined]){
            const db = makeDb({ tip, page: [12, 11, 10] });
            if(tip === null){
                const doQuery = db.doQuery;
                db.doQuery = async (config, sql, args) => {
                    if(/MAX\(block_index\) AS tip/.test(String(sql))) throw new Error('probe down');
                    return doQuery(config, sql, args);
                };
            }
            await db.getBlocks(blocksConfig());
            assert.strictEqual(db._blockCountsCache.size, 0);
        }
    });

    it('never caches a failed read', async function(){
        const failure = new Error('connection lost');
        const state = { tip: '20', page: [12, 11, 10], fail: failure };
        const db = makeDb(state);
        await assert.rejects(db.getBlocks(blocksConfig()), e => e === failure);
        assert.strictEqual(db._blockCountsCache.size, 0);
        state.fail = null;
        db.calls = [];
        const [rows] = await db.getBlocks(blocksConfig());
        assert.deepStrictEqual(rows, EXPECTED);
        assert.deepStrictEqual(countCalls(db).map(unionBlocks), [[12, 11, 10]]);
    });

    it('evicts the oldest block past the size cap', async function(){
        const state = { tip: '20', page: [12, 11] };
        const db = makeDb(state);
        db._blockCountsCacheMax = 2;
        await db.getBlocks(blocksConfig());
        state.page = [10];
        await db.getBlocks(blocksConfig());
        assert.strictEqual(db._blockCountsCache.size, 2);
        db.calls = [];
        state.page = [12, 11, 10];
        await db.getBlocks(blocksConfig());
        assert.deepStrictEqual(countCalls(db).map(unionBlocks), [[12]],
            'the cap evicted something other than the least recently used block');
    });

    it('hands out copies, so a caller edit never reaches the cache', async function(){
        const db = makeDb({ tip: '20', page: [12, 11, 10] });
        const [first] = await db.getBlocks(blocksConfig());
        first[0].actions.sends = 999;
        const [second] = await db.getBlocks(blocksConfig());
        second[1].actions.issuances = 999;
        const [third] = await db.getBlocks(blocksConfig());
        assert.deepStrictEqual(third, EXPECTED);
    });
});
