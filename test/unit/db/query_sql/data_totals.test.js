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
 * Unit tests for the per-tip list totals cache (src/db/query_sql/data_totals.js).
 *
 * doQuery is routed on the SQL text, as in db_network_totals_cache.test.js:
 * the tip probe answers the mutable tip, a COUNT answers the mutable total and
 * is counted, anything else is a page row. The tip memo is disabled so every
 * call re-reads the tip.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { countTotal, TIP_TOTAL_METHODS } = require('../../../../src/db/query_sql/data_totals.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const ENV_KEYS = ['EXPLORER_TIP_MEMO_MS', 'EXPLORER_LIST_TOTALS_CACHE_MS',
    'EXPLORER_MIRROR_TOTALS_CACHE_MS', 'EXPLORER_LIST_TOTALS_CACHE_MAX'];
const COUNT = 'SELECT count(*) as total FROM issues m ' +
    'INNER JOIN actions a1 ON (a1.action_index=m.action_index) ' +
    'LEFT JOIN index_memos m1 ON (m1.id=m.memo_id) WHERE m.action_index IS NOT NULL';

let state, db, stub;

function makeDb(){
    const configInfo = createConfigInfoStub();
    const instance = new Database({ configInfo, util: new Utility(configInfo) });
    instance.getCanonicalTick = async (config, value) => value;
    stub = sinon.stub(instance, 'doQuery').callsFake(async (config, sql) => {
        if(/MAX\(block_index\)/.test(sql)){
            if(state.tipFails) throw new Error('tip probe failed');
            return [{ tip: state.tip }];
        }
        if(/count\(/i.test(sql)){
            state.counts.push(sql);
            if(state.countFails) throw new Error('count failed');
            return [{ total: state.total }];
        }
        return [{ action_index: 1 }];
    });
    return instance;
}

function cfg(method = 'getIssues', overrides = {}){
    return makeConfig(Object.assign({ coin: 'BTC' }, overrides, { data: Object.assign({ method }, overrides.data || {}) }));
}

function rewindEntries(ms){
    for(const entry of db._listTotalsCache.values()) entry.at -= ms;
}

function useFixture(){
    beforeEach(function(){
        process.env.EXPLORER_TIP_MEMO_MS = '0';
        state = { tip: 100, total: 7, counts: [] };
        db = makeDb();
    });

    afterEach(function(){
        sinon.restore();
        for(const key of ENV_KEYS) delete process.env[key];
    });
}

describe('list totals cache: keying', function(){
    useFixture();

    it('counts once for repeated requests at one tip', async function(){
        expect(await countTotal(db, cfg(), COUNT, [])).to.equal(7);
        state.total = 99;
        expect(await countTotal(db, cfg(), COUNT, [])).to.equal(7);
        expect(state.counts).to.have.length(1);
    });

    it('re-counts once the indexed tip moves', async function(){
        await countTotal(db, cfg(), COUNT, []);
        state.tip = 101;
        state.total = 8;
        expect(await countTotal(db, cfg(), COUNT, [])).to.equal(8);
        expect(state.counts).to.have.length(2);
    });

    it('re-counts after a reorg bumps the coin generation at the same tip', async function(){
        await countTotal(db, cfg(), COUNT, []);
        db.bumpReorgGeneration('BTC');
        state.total = 5;
        expect(await countTotal(db, cfg(), COUNT, [])).to.equal(5);
        expect(state.counts).to.have.length(2);
    });

    it('keeps coins, methods and bind arguments apart', async function(){
        await countTotal(db, cfg(), COUNT, ['A']);
        await countTotal(db, cfg(), COUNT, ['B']);
        await countTotal(db, cfg('getMints'), COUNT, ['A']);
        await countTotal(db, cfg('getIssues', { coin: 'LTC' }), COUNT, ['A']);
        await countTotal(db, cfg(), COUNT, ['A']);
        expect(state.counts).to.have.length(4);
    });

    it('serves every page of one list from a single count through getData', async function(){
        for(const page of [1, 2, 3])
            await db.getData(cfg('getIssues', { type: 'api', data: { query: { page } } }));
        expect(state.counts).to.have.length(1);
    });

    it('serves the explorer first, next and last pages from a single count', async function(){
        const pages = [{ start: 0, length: 10, action: 'first' },
                       { start: 10, length: 10, action: 'next', offset: 50, total: 7 },
                       { start: 0, length: 10, action: 'last', total: 7 }];
        for(const query of pages)
            await db.getData(cfg('getIssues', { type: 'explorer', data: { query } }));
        expect(state.counts).to.have.length(1);
    });
});

describe('list totals cache: lifetime', function(){
    useFixture();

    it('expires an entry on the TTL ceiling at an unmoved tip', async function(){
        await countTotal(db, cfg(), COUNT, []);
        rewindEntries(59000);
        await countTotal(db, cfg(), COUNT, []);
        expect(state.counts).to.have.length(1);
        rewindEntries(2000);
        await countTotal(db, cfg(), COUNT, []);
        expect(state.counts).to.have.length(2);
    });

    it('bypasses the cache when the tip probe fails', async function(){
        state.tipFails = true;
        await countTotal(db, cfg(), COUNT, []);
        await countTotal(db, cfg(), COUNT, []);
        expect(state.counts).to.have.length(2);
        expect(db._listTotalsCache).to.equal(undefined);
    });

    it('shares one count between simultaneous cold requests', async function(){
        const totals = await Promise.all([1, 2, 3].map(() => countTotal(db, cfg(), COUNT, [])));
        expect(totals).to.deep.equal([7, 7, 7]);
        expect(state.counts).to.have.length(1);
    });

    it('does not cache a failed count', async function(){
        state.countFails = true;
        let err = null;
        try { await countTotal(db, cfg(), COUNT, []); } catch(e){ err = e; }
        expect(err).to.be.an('error');
        state.countFails = false;
        expect(await countTotal(db, cfg(), COUNT, [])).to.equal(7);
        expect(db._listTotalsLoads.size).to.equal(0);
    });

    it('caps the map and evicts the oldest entry', async function(){
        process.env.EXPLORER_LIST_TOTALS_CACHE_MAX = '2';
        for(const arg of ['A', 'B', 'C'])
            await countTotal(db, cfg(), COUNT, [arg]);
        expect(db._listTotalsCache.size).to.equal(2);
        await countTotal(db, cfg(), COUNT, ['A']);
        expect(state.counts).to.have.length(4);
    });
});

describe('list totals cache: which methods', function(){
    useFixture();

    it('prunes the COUNT of a tip-bound list and leaves its page query whole', async function(){
        await db.getData(cfg('getIssues', { type: 'api' }));
        const [pageSql] = stub.getCalls().map(c => c.args[1]).filter(sql => /ORDER BY/.test(sql));
        expect(pageSql).to.match(/LEFT\s+JOIN index_memos\s+m1/);
        expect(state.counts[0]).to.not.match(/index_memos/);
        expect(state.counts[0]).to.match(/^SELECT count\(\*\) as total FROM issues m INNER JOIN actions/);
    });

    it('runs the COUNT as built, every time, for a method outside both sets', async function(){
        await countTotal(db, cfg('getXcalls'), COUNT, []);
        await countTotal(db, cfg('getXcalls'), COUNT, []);
        expect(state.counts).to.deep.equal([COUNT, COUNT]);
    });

    it('caches price snapshot totals unpruned on the shorter mirror TTL', async function(){
        await countTotal(db, cfg('getPriceSnapshots'), COUNT, []);
        rewindEntries(14000);
        await countTotal(db, cfg('getPriceSnapshots'), COUNT, []);
        expect(state.counts).to.deep.equal([COUNT]);
        rewindEntries(2000);
        await countTotal(db, cfg('getPriceSnapshots'), COUNT, []);
        expect(state.counts).to.have.length(2);
    });

    it('lists only methods the Database answers', function(){
        for(const method of TIP_TOTAL_METHODS)
            expect(db[method], method).to.be.a('function');
    });
});
