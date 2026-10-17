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
 * Cache-Control through the real request path: a table route answered by
 * the catch-all pipeline, the OpenAPI listener, a pre-wildcard compute route,
 * and the error answers from the pipeline, an unmatched path and the
 * app-wide limiter.
 */

'use strict';

const request    = require('supertest');
const sinon      = require('sinon');
const { expect } = require('chai');

const IndexerConnector = require('../../../../src/connectors/indexer.js');
const { CACHE_CLASSES } = require('../../../../src/http/cache_control.js');
const { buildApp, state } = require('./support/app.js');

const ROWS = [{ action_index: 1, block_index: 100, tx_hash: 'a'.repeat(64) }];

function varyFields(res) {
    return String(res.headers.vary || '').split(',').map(s => s.trim().toLowerCase());
}

describe('cache control: successful answers through the real app', function () {
    beforeEach(() => { state.getDataResult = [ROWS, ROWS.length]; state.getDataError = null; });
    afterEach(() => sinon.restore());

    it('caches a table route briefly and varies it on Origin', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/BTC/api/sends/addr1/address').set('Origin', 'https://wallet.example');
        expect(res.status).to.equal(200);
        expect(res.headers['cache-control']).to.equal(CACHE_CLASSES.tip);
        expect(res.headers['access-control-allow-origin']).to.equal('https://wallet.example');
        expect(varyFields(res)).to.include.members(['origin', 'accept-encoding']);
    });

    it('varies on Origin when an allowlist refuses the caller and CORS adds no header', async () => {
        const { app } = buildApp({ corsOrigin: 'https://allowed.example' });
        const res = await request(app).get('/BTC/api/sends/addr1/address').set('Origin', 'https://other.example');
        expect(res.status).to.equal(200);
        expect(res.headers).to.not.have.property('access-control-allow-origin');
        expect(res.headers['cache-control']).to.equal(CACHE_CLASSES.tip);
        expect(varyFields(res)).to.include('origin');
    });

    it('caches an explorer feed with the same tip class', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/BTC/explorer/sends/addr1/address').query({ start: 0, length: 10 });
        expect(res.status).to.equal(200);
        expect(res.headers['cache-control']).to.equal(CACHE_CLASSES.tip);
    });

    it('serves the OpenAPI document with the document class, on a 304 too', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/openapi.json');
        expect(res.status).to.equal(200);
        expect(res.headers['cache-control']).to.equal(CACHE_CLASSES.document);
        expect(res.headers.etag, 'express no longer emits an ETag').to.be.a('string');
        // A 304 replaces the stored copy's headers, so it must carry the class.
        const again = await request(app).get('/openapi.json').set('If-None-Match', res.headers.etag);
        expect(again.status).to.equal(304);
        expect(again.headers['cache-control']).to.equal(CACHE_CLASSES.document);
    });
});

describe('cache control: successful answers that are never cached', function () {
    beforeEach(() => { state.getDataResult = [ROWS, ROWS.length]; state.getDataError = null; });
    afterEach(() => sinon.restore());

    it('never caches a fee quote, even a successful one', async () => {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://indexer.invalid:1');
        sinon.stub(IndexerConnector.prototype, 'feequote').resolves({ supported: true, valid: true, requiredFeeSats: 2000 });
        const { app } = buildApp();
        const res = await request(app).get('/RBTC/api/feequote').query({ action: 'ISSUE', params: '0|NEWTICK', source: 'me' });
        expect(res.status).to.equal(200);
        expect(res.body.requiredFeeSats).to.equal(2000);
        expect(res.headers['cache-control']).to.equal('no-store');
    });

    it('caches a pre-wildcard listener by its own entry, not its family', async () => {
        const { app, explorer } = buildApp();
        explorer.db.checkpointDb = { BTC: { name: 'hub_mirror', chain: 'BTC', network: 'mainnet' } };
        explorer.db.getBridgeTransfers = async () => [];
        const res = await request(app).get('/BTC/api/bridge-transfers/FUFU');
        expect(res.status).to.equal(200);
        expect(res.headers['cache-control']).to.equal(CACHE_CLASSES.tip);
    });

    it('never caches the mempool', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/BTC/api/mempool');
        expect(res.status).to.equal(200);
        expect(res.headers['cache-control']).to.equal('no-store');
    });
});

describe('cache control: error answers through the real app', function () {
    beforeEach(() => { state.getDataResult = [ROWS, ROWS.length]; state.getDataError = null; });

    it('never caches a database failure on a cacheable route', async () => {
        state.getDataError = new Error('pool exhausted');
        const { app } = buildApp();
        const res = await request(app).get('/BTC/api/sends/addr1/address');
        expect(res.status).to.equal(500);
        expect(res.headers['cache-control']).to.equal('no-store');
    });

    it('never caches the JSON 404 for an unmatched API path', async () => {
        const { app } = buildApp();
        const res = await request(app).get('/BTC/api/not_a_route/x/block');
        expect(res.status).to.equal(404);
        expect(res.headers['cache-control']).to.equal('no-store');
    });

    it('never caches a rate-limit refusal answered before any route', async () => {
        const { app } = buildApp({ rateLimitRpm: 1 });
        const ok = await request(app).get('/BTC/api/network');
        expect(ok.status).to.equal(200);
        const refused = await request(app).get('/BTC/api/network');
        expect(refused.status).to.equal(429);
        expect(refused.headers['cache-control']).to.equal('no-store');
    });

    it('never caches an error page outside the API either', async () => {
        const { app } = buildApp();
        for (const path of ['/BTC/no_such_page', '/js/does-not-exist.js']) {
            const res = await request(app).get(path);
            expect(res.status, path).to.equal(404);
            expect(res.headers['cache-control'], path).to.equal('no-store');
        }
    });

    it('never caches a bridge route that cannot reach its source', async () => {
        const { app } = buildApp({ hub: { call: async () => null } });
        const res = await request(app).get('/BTC/api/bridge-invariant/FUFU');
        expect(res.status).to.equal(503);
        expect(res.headers['cache-control']).to.equal('no-store');
    });
});
