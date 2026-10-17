/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * The fee schedule cache: one indexer read per URL per lifetime, shared by
 * concurrent callers, never storing a failure, and bridging a failing indexer
 * with the last good answer only inside the stale ceiling. The route test at
 * the end proves GET /{COIN}/api/feeschedule reads through it.
 */

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const XChainExplorer = require('../../../../src/XChainExplorer.js');
const IndexerConnector = require('../../../../src/connectors/indexer.js');
const { FeeScheduleCache, feeScheduleCache } = require('../../../../src/explorer/fees_preflight/fee_schedule_cache.js');

const URL_A = 'http://indexer-a:1';
const URL_B = 'http://indexer-b:1';
const SCHEDULE   = { coin: 'BTC', network: 'regtest', blockIndex: 100, prices: { available: true } };
const SCHEDULE_2 = { coin: 'BTC', network: 'regtest', blockIndex: 101, prices: { available: true } };

function clockedCache(){
    const clock = { t: 1000000 };
    const cache = new FeeScheduleCache({ now: () => clock.t });
    return { cache, clock };
}

function withEnv(vars){
    const prev = {};
    for(const k of Object.keys(vars)){ prev[k] = process.env[k]; process.env[k] = vars[k]; }
    return () => {
        for(const k of Object.keys(prev)){
            if(prev[k] === undefined) delete process.env[k];
            else process.env[k] = prev[k];
        }
    };
}

describe('FeeScheduleCache', function () {
    let restoreEnv;
    beforeEach(() => { restoreEnv = withEnv({ EXPLORER_FEESCHEDULE_CACHE_MS: '15000', EXPLORER_FEESCHEDULE_STALE_MAX_MS: '120000' }); });
    afterEach(() => { restoreEnv(); sinon.restore(); });

    it('serves a second read inside the lifetime without asking the indexer', async function () {
        const { cache, clock } = clockedCache();
        const fetch = sinon.stub().resolves(SCHEDULE);
        expect(await cache.get(URL_A, fetch)).to.equal(SCHEDULE);
        clock.t += 14999;
        expect(await cache.get(URL_A, fetch)).to.equal(SCHEDULE);
        expect(fetch.callCount).to.equal(1);
    });

    it('asks the indexer again once the lifetime has passed', async function () {
        const { cache, clock } = clockedCache();
        const fetch = sinon.stub();
        fetch.onCall(0).resolves(SCHEDULE);
        fetch.onCall(1).resolves(SCHEDULE_2);
        await cache.get(URL_A, fetch);
        clock.t += 15000;
        expect(await cache.get(URL_A, fetch)).to.equal(SCHEDULE_2);
        expect(fetch.callCount).to.equal(2);
    });

    it('collapses concurrent misses on one URL into one indexer read', async function () {
        const { cache } = clockedCache();
        let release;
        const fetch = sinon.stub().returns(new Promise(resolve => { release = resolve; }));
        const reads = [cache.get(URL_A, fetch), cache.get(URL_A, fetch), cache.get(URL_A, fetch)];
        release(SCHEDULE);
        const answers = await Promise.all(reads);
        expect(fetch.callCount).to.equal(1);
        expect(answers).to.deep.equal([SCHEDULE, SCHEDULE, SCHEDULE]);
    });

});

describe('FeeScheduleCache: keys and failures', function () {
    let restoreEnv;
    beforeEach(() => { restoreEnv = withEnv({ EXPLORER_FEESCHEDULE_CACHE_MS: '15000', EXPLORER_FEESCHEDULE_STALE_MAX_MS: '120000' }); });
    afterEach(() => { restoreEnv(); sinon.restore(); });

    it('keeps one entry per indexer URL', async function () {
        const { cache } = clockedCache();
        const fetchA = sinon.stub().resolves(SCHEDULE);
        const fetchB = sinon.stub().resolves(SCHEDULE_2);
        expect(await cache.get(URL_A, fetchA)).to.equal(SCHEDULE);
        expect(await cache.get(URL_B, fetchB)).to.equal(SCHEDULE_2);
        expect(await cache.get(URL_A, fetchA)).to.equal(SCHEDULE);
        expect(fetchA.callCount).to.equal(1);
        expect(fetchB.callCount).to.equal(1);
    });

    it('never stores a thrown upstream failure', async function () {
        const { cache } = clockedCache();
        const fetch = sinon.stub();
        fetch.onCall(0).rejects(new Error('ECONNREFUSED'));
        fetch.onCall(1).resolves(SCHEDULE);
        let thrown = null;
        try { await cache.get(URL_A, fetch); } catch(e){ thrown = e; }
        expect(thrown && thrown.message).to.equal('ECONNREFUSED');
        expect(await cache.get(URL_A, fetch)).to.equal(SCHEDULE);
        expect(fetch.callCount).to.equal(2);
    });

    it('never stores the indexer\'s own error result, and passes it on unchanged', async function () {
        const { cache } = clockedCache();
        const notReady = { error: 'indexer not ready' };
        const fetch = sinon.stub();
        fetch.onCall(0).resolves(notReady);
        fetch.onCall(1).resolves(null);
        fetch.onCall(2).resolves(SCHEDULE);
        expect(await cache.get(URL_A, fetch)).to.equal(notReady);
        expect(await cache.get(URL_A, fetch)).to.equal(null);
        expect(await cache.get(URL_A, fetch)).to.equal(SCHEDULE);
        expect(fetch.callCount).to.equal(3);
    });

});

describe('FeeScheduleCache: the stale bridge', function () {
    let restoreEnv;
    beforeEach(() => { restoreEnv = withEnv({ EXPLORER_FEESCHEDULE_CACHE_MS: '15000', EXPLORER_FEESCHEDULE_STALE_MAX_MS: '120000' }); });
    afterEach(() => { restoreEnv(); sinon.restore(); });

    it('bridges a failing indexer with the last good answer inside the stale ceiling', async function () {
        const { cache, clock } = clockedCache();
        const fetch = sinon.stub();
        fetch.onCall(0).resolves(SCHEDULE);
        fetch.onCall(1).rejects(new Error('timeout of 5000ms exceeded'));
        fetch.onCall(2).resolves({ error: 'failed to fetch fee schedule' });
        await cache.get(URL_A, fetch);
        clock.t += 60000;
        expect(await cache.get(URL_A, fetch)).to.equal(SCHEDULE);
        expect(await cache.get(URL_A, fetch)).to.equal(SCHEDULE);
        expect(fetch.callCount).to.equal(3);
    });

    it('lets the failure through once the last good answer is past the stale ceiling', async function () {
        const { cache, clock } = clockedCache();
        const failed = { error: 'failed to fetch fee schedule' };
        const fetch = sinon.stub();
        fetch.onCall(0).resolves(SCHEDULE);
        fetch.onCall(1).rejects(new Error('ECONNREFUSED'));
        fetch.onCall(2).resolves(failed);
        await cache.get(URL_A, fetch);
        clock.t += 120000;
        let thrown = null;
        try { await cache.get(URL_A, fetch); } catch(e){ thrown = e; }
        expect(thrown && thrown.message).to.equal('ECONNREFUSED');
        expect(await cache.get(URL_A, fetch)).to.equal(failed);
    });

    it('hands every concurrent waiter the same failure, then retries on the next read', async function () {
        const { cache } = clockedCache();
        let fail;
        const fetch = sinon.stub();
        fetch.onCall(0).returns(new Promise((resolve, reject) => { fail = reject; }));
        fetch.onCall(1).resolves(SCHEDULE);
        const reads = [cache.get(URL_A, fetch), cache.get(URL_A, fetch)].map(p => p.catch(e => e.message));
        fail(new Error('ECONNRESET'));
        expect(await Promise.all(reads)).to.deep.equal(['ECONNRESET', 'ECONNRESET']);
        expect(await cache.get(URL_A, fetch)).to.equal(SCHEDULE);
        expect(fetch.callCount).to.equal(2);
    });
});

function fakeThis(){
    return {
        configInfo: { getConfig: async () => ({}) },
        parseCoinCode: () => ({ coin: 'BTC', network: 'regtest' }),
        util: { isNull: (v) => v === undefined || v === null || v === '' },
    };
}

function mockRes(){
    return {
        _status: 200, _json: undefined,
        status(c){ this._status = c; return this; },
        json(o){ this._json = o; return this; },
    };
}

async function callRoute(){
    const res = mockRes();
    await XChainExplorer.prototype.processFeeScheduleRequest.call(fakeThis(), { params: { coin: 'RBTC' }, query: {} }, res);
    return res;
}

describe('GET /{COIN}/api/feeschedule reads through the fee schedule cache', function () {
    beforeEach(() => feeScheduleCache.clear());
    afterEach(() => { feeScheduleCache.clear(); sinon.restore(); });

    it('answers repeat requests from one indexer read', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns(URL_A);
        const stub = sinon.stub(IndexerConnector.prototype, 'feeschedule').resolves(SCHEDULE);
        const first = await callRoute();
        const second = await callRoute();
        expect(first._status).to.equal(200);
        expect(second._json).to.deep.equal(SCHEDULE);
        expect(stub.callCount).to.equal(1);
    });

    it('answers 502 when the indexer fails and no good answer is held', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns(URL_A);
        sinon.stub(IndexerConnector.prototype, 'feeschedule').rejects(new Error('ECONNREFUSED'));
        const res = await callRoute();
        expect(res._status).to.equal(502);
        expect(res._json.code).to.equal('UPSTREAM_ERROR');
    });
});
