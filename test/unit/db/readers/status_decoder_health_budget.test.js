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
 * /api/status reads every coin's decoder health(). The explorer is ONE source
 * IP to each decoder, whose per-IP limit (DECODER_RATE_LIMIT_RPM, default
 * 100/min) is shared by every explorer client, so one client polling /status
 * within the explorer's own per-IP limit must not spend that budget: a burst
 * of status reads costs at most one health call per decoder per cache window,
 * and the count does not grow with the number of reads. A decoder 429 is the
 * explorer being throttled, not the decoder being down, so it never reads
 * 'unreachable', and the mempool snapshot that shares the budget still answers.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const axios      = require('axios');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);
const URLS = { BTC: 'http://decoder-btc-mainnet:3002', RBTC: 'http://decoder-btc-regtest:3002' };
const ENV_KEYS = ['DECODER_API_URL', 'DECODER_API_URL_BTC_MAINNET', 'DECODER_API_URL_BTC_REGTEST'];
const HEALTHY = { status: 'healthy', chainTipBlock: 900500, lag_blocks: 0 };

function makeStatusDb(){
    const db = new Database({ configInfo, util });
    db.pools = { BTC: { pool: {}, config: {} }, RBTC: { pool: {}, config: {} } };
    db.decoderApiUrl = Object.assign({}, URLS);
    sinon.stub(db, 'getMaxBlockIndex').resolves(100);
    sinon.stub(db, 'getMaxBlockTime').resolves(Math.floor(Date.now() / 1000));
    sinon.stub(db, 'getDecoderTip').resolves(100);
    sinon.stub(db, 'getReplicaHaltStatus').resolves(null);
    return db;
}

function rateLimitError(){
    const e = new Error('Request failed with status code 429');
    e.response = { status: 429, data: { error: 'Too many requests' } };
    return e;
}

// A decoder that admits `limit` calls per source, then answers 429 like the
// decoder's express-rate-limit does. Counts every call per URL and method.
function fakeDecoder(limit){
    const calls = {};
    const stub = sinon.stub(axios, 'post').callsFake(async (url, body) => {
        calls[url] = calls[url] || { total: 0, health: 0, getmempool: 0 };
        calls[url].total++;
        calls[url][body.method] = (calls[url][body.method] || 0) + 1;
        if (calls[url].total > limit) throw rateLimitError();
        if (body.method === 'health') return { data: { result: HEALTHY } };
        return { data: { result: { node_tx_count: 3, node_updated_at: Date.now(), stale: false,
            read_ok_at: Date.now(), total: 1, rows: [{ tx_hash: 'a', source: 's', data: 'SEND|0|TOK|1|d', first_seen: 1 }] } } };
    });
    return { calls, stub };
}

async function burst(db, n){
    let last;
    for (let i = 0; i < n; i++) [last] = await db.getStatus({});
    return last;
}

function isolateDecoderEnv(){
    let saved;
    beforeEach(() => {
        saved = {};
        for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    });
    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
        sinon.restore();
    });
}

describe('getStatus decoder health stays inside the shared decoder rate budget', function () {
    isolateDecoderEnv();

    it('makes the same number of health calls per decoder at 10 and at 100 status reads', async function () {
        const counts = [];
        for (const n of [10, 100]) {
            const db = makeStatusDb();
            const { calls } = fakeDecoder(Infinity);
            const data = await burst(db, n);
            expect(data.decoder_health).to.deep.equal({ BTC: 'healthy', RBTC: 'healthy' });
            counts.push([calls[URLS.BTC].health, calls[URLS.RBTC].health]);
            sinon.restore();
        }
        expect(counts[0]).to.deep.equal([1, 1]);
        expect(counts[1]).to.deep.equal(counts[0]);
    });

    it('shares one in-flight health call across concurrent status reads', async function () {
        const db = makeStatusDb();
        const { calls } = fakeDecoder(Infinity);
        const reports = await Promise.all(Array.from({ length: 20 }, () => db.getStatus({})));
        for (const [data] of reports) expect(data.decoder_health.RBTC).to.equal('healthy');
        expect(calls[URLS.BTC].health).to.equal(1);
        expect(calls[URLS.RBTC].health).to.equal(1);
    });

    it('keeps the mempool snapshot answering after a 100-read status burst on a 100/min decoder', async function () {
        const db = makeStatusDb();
        const { calls } = fakeDecoder(100);
        await burst(db, 100);
        const snap = await db.getDecoderMempoolSnapshot({ coin: 'RBTC' });
        expect(snap, 'mempool snapshot after the burst').to.not.equal(null);
        expect(snap.total).to.equal(1);
        expect(calls[URLS.RBTC].total).to.be.at.most(100);
    });

});

describe('getStatus tells a throttled decoder from a down one', function () {
    isolateDecoderEnv();

    it('never reports a decoder 429 as unreachable, and keeps the last good reading', async function () {
        const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
        const db = makeStatusDb();
        const post = sinon.stub(axios, 'post');
        post.onCall(0).resolves({ data: { result: HEALTHY } });
        post.onCall(1).resolves({ data: { result: HEALTHY } });
        post.rejects(rateLimitError());
        let [data] = await db.getStatus({});
        expect(data.decoder_health.RBTC).to.equal('healthy');
        clock.tick(60 * 1000);
        [data] = await db.getStatus({});
        expect(post.callCount).to.be.greaterThan(2);
        expect(data.decoder_health.RBTC).to.equal('healthy');
        expect(data.chain_tip.RBTC).to.equal(900500);
    });

    it('reads a 429 with no good reading behind it as rate-limited, not unreachable', async function () {
        const db = makeStatusDb();
        sinon.stub(axios, 'post').rejects(rateLimitError());
        const [data] = await db.getStatus({});
        expect(data.decoder_health.RBTC).to.equal('rate-limited');
        expect(data.decoder_health.BTC).to.equal('rate-limited');
    });

    it('still reads a real connection failure as unreachable', async function () {
        const db = makeStatusDb();
        const e = new Error('connect ECONNREFUSED 127.0.0.1:3002');
        e.code = 'ECONNREFUSED';
        sinon.stub(axios, 'post').rejects(e);
        const [data] = await db.getStatus({});
        expect(data.decoder_health.RBTC).to.equal('unreachable');
        expect(data.chain_tip.RBTC).to.be.null;
    });
});
