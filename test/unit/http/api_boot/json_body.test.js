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
 *
 * Body refusals through the real boot steps, mounted in createApp's order: a
 * malformed or oversized JSON body answers with a registered code (or a
 * JSON-RPC error on the dispatcher's paths), carries the CORS and rate-limit
 * headers, and never the framework's HTML page. The mount-order pin below
 * ties this app to createApp, which a unit test cannot load (api.js boots).
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const express    = require('express');
const supertest  = require('supertest');
const { srcText } = require('../../../helpers/source_text');
const XChainExplorer = require('../../../../src/XChainExplorer.js');
const { PREFLIGHT_BODY_LIMIT } = require('../../../../src/explorer/mount.js');
const { applyCors }       = require('../../../../src/http/api_boot/cors.js');
const { applyRateLimits } = require('../../../../src/http/api_boot/rate_limits.js');
const { mountJsonRpc }    = require('../../../../src/http/api_boot/json_rpc.js');
const { applyJsonBody, applyBodyErrorHandler, sendBodyError, isJsonRpcPath } =
    require('../../../../src/http/api_boot/json_body.js');

// The createApp mount order, with one REST route and the preflight route's own parser.
function bootApp(){
    const configInfo = { env: {} };
    const app = express();
    applyCors(app, configInfo);
    applyRateLimits(app, configInfo, () => false);
    applyJsonBody(app, XChainExplorer);
    app.post('/:coin/api/balances', (req, res) => res.json({ ok: true }));
    app.post('/:coin/api/preflight', express.json({ limit: PREFLIGHT_BODY_LIMIT }), (req, res) => res.json({ ok: true }));
    mountJsonRpc(app, configInfo, { ping: () => 'pong' });
    applyBodyErrorHandler(app);
    return app;
}

const bigJson = (bytes) => JSON.stringify({ pad: 'x'.repeat(bytes) });

describe('json body refusals on the boot steps', function () {
    let request;
    before(function () {
        request = supertest(bootApp());
    });

    it('answers a malformed REST body with INVALID_JSON_BODY, CORS and rate-limit headers', async function () {
        const res = await request.post('/RBTC/api/balances')
            .set('Content-Type', 'application/json').set('Origin', 'https://example.com')
            .send('{bad');
        expect(res.status).to.equal(400);
        expect(res.headers['content-type']).to.match(/application\/json/);
        expect(res.body.code).to.equal('INVALID_JSON_BODY');
        expect(res.headers['access-control-allow-origin']).to.equal('https://example.com');
        expect(res.headers).to.have.property('ratelimit-remaining');
    });

    it('answers a REST body over the global ceiling with 413 BODY_TOO_LARGE', async function () {
        const res = await request.post('/RBTC/api/balances')
            .set('Content-Type', 'application/json').send(bigJson(20 * 1024));
        expect(res.status).to.equal(413);
        expect(res.body.code).to.equal('BODY_TOO_LARGE');
    });

    it('answers a preflight body over its own route ceiling with 413 BODY_TOO_LARGE', async function () {
        const res = await request.post('/RBTC/api/preflight')
            .set('Content-Type', 'application/json').send(bigJson(2 * 1024 * 1024));
        expect(res.status).to.equal(413);
        expect(res.body.code).to.equal('BODY_TOO_LARGE');
    });

    it('answers a malformed body on POST / with JSON-RPC -32700', async function () {
        const res = await request.post('/').set('Content-Type', 'application/json').send('{bad');
        expect(res.status).to.equal(400);
        expect(res.body).to.deep.include({ jsonrpc: '2.0', id: null });
        expect(res.body.error.code).to.equal(-32700);
    });

    it('answers an oversized body on POST /{COIN}/api/ with JSON-RPC -32600', async function () {
        const res = await request.post('/RBTC/api/').set('Content-Type', 'application/json')
            .send(bigJson(20 * 1024));
        expect(res.status).to.equal(413);
        expect(res.body.error.code).to.equal(-32600);
    });

    it('still serves a well-formed body', async function () {
        const res = await request.post('/RBTC/api/balances').set('Content-Type', 'application/json')
            .send({ addresses: [] });
        expect(res.status).to.equal(200);
        expect(res.body).to.deep.equal({ ok: true });
    });
});

describe('json body refusal rules', function () {
    function fakeRes(){
        const res = { sent: null, code: 0 };
        res.status = (c) => { res.code = c; return res; };
        res.json = (b) => { res.sent = b; return res; };
        return res;
    }

    it('leaves a non-body error to the default handler', function () {
        const res = fakeRes();
        expect(sendBodyError(new Error('boom'), { path: '/RBTC/api/balances' }, res)).to.equal(false);
        const serverSide = Object.assign(new Error('x'), { type: 'entity.parse.failed', status: 500 });
        expect(sendBodyError(serverSide, { path: '/' }, res)).to.equal(false);
        expect(res.sent).to.equal(null);
    });

    it('treats only / and /{COIN}/api as the dispatcher paths', function () {
        for (const p of ['/', '/RBTC/api', '/RBTC/api/']) expect(isJsonRpcPath(p), p).to.equal(true);
        for (const p of ['/RBTC/api/balances', '/RBTC/explorer/blocks', '/RBTC']) expect(isJsonRpcPath(p), p).to.equal(false);
    });
});

describe('json body: mount order', function () {
    it('mounts the parser after the guards and the refusal handler last', function () {
        const src = srcText('src/api.js');
        const body = src.slice(src.indexOf('function createApp('), src.indexOf('async function startApi('));
        const parser = body.indexOf('applyJsonBody(app');
        expect(parser, 'createApp no longer mounts the body parser').to.be.greaterThan(-1);
        for (const step of ['applyCors(app', 'applyRateLimits(app', 'applyObservability(app'])
            expect(body.indexOf(step), step).to.be.lessThan(parser);
        for (const step of ['mountBridgePanelRoutes(app', 'new XChainExplorer(app', 'mountJsonRpc(app'])
            expect(body.indexOf(step), step).to.be.greaterThan(parser);
        expect(body.indexOf('applyBodyErrorHandler(app')).to.be.greaterThan(body.indexOf('mountJsonRpc(app'));
    });
});
