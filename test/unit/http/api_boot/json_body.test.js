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
const zlib       = require('zlib');
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
    app.get('/:coin/api/tx/:id', (req, res) => res.json({ ok: true }));
    app.get('/:coin/api/address/:addr', (req, res) => res.json({ ok: true }));
    app.get('/:coin/api/status', (req, res) => res.json({ ok: true }));
    app.get('/boom/generic', () => { throw new Error('secret internal /XChainExplorer/node_modules/x'); });
    app.get('/boom/client', (req, res, next) => next(Object.assign(new Error('nope at node_modules'), { status: 403 })));
    app.get('/boom/late', (req, res, next) => { res.write('partial'); next(new Error('after headers')); });
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
            .set('Content-Type', 'application/json').send(bigJson(3 * 1024 * 1024));
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

    it('answers malformed compressed bodies in each published refusal shape', async function () {
        for (const encoding of ['gzip', 'deflate', 'br']) {
            for (const path of ['/RBTC/api/balances', '/RBTC/api/preflight', '/', '/RBTC/api/']) {
                const res = await request.post(path).set('Content-Type', 'application/json')
                    .set('Content-Encoding', encoding).serialize((body) => body)
                    .send(Buffer.from('not a compressed stream'));
                expect(res.status, encoding + ' ' + path).to.equal(400);
                if (path === '/' || path === '/RBTC/api/')
                    expect(res.body.error.code, encoding + ' ' + path).to.equal(-32700);
                else expect(res.body.code, encoding + ' ' + path).to.equal('INVALID_JSON_BODY');
            }
        }
    });

    it('continues accepting well-formed gzip JSON', async function () {
        const body = zlib.gzipSync(Buffer.from('{"addresses":[]}'));
        const rest = await request.post('/RBTC/api/balances').set('Content-Type', 'application/json')
            .set('Content-Encoding', 'gzip').serialize((value) => value).send(body);
        expect(rest.status).to.equal(200);
        const rpcBody = zlib.gzipSync(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}'));
        const rpc = await request.post('/').set('Content-Type', 'application/json')
            .set('Content-Encoding', 'gzip').serialize((value) => value).send(rpcBody);
        expect(rpc.status).to.equal(200);
        expect(rpc.body.result).to.equal('pong');
    });

});

describe('json body: thrown errors on the boot steps', function () {
    let request;
    before(function () {
        request = supertest(bootApp());
    });

    it('answers a malformed percent-escape in a route param with a JSON 400 and no stack', async function () {
        for(const p of ['/RBTC/api/tx/%E0%A4%A', '/%ZZ/api/status', '/RBTC/api/address/%']){
            const res = await request.get(p).set('Origin', 'https://example.com');
            expect(res.status, p).to.equal(400);
            expect(res.headers['content-type'], p).to.match(/json/);
            expect(res.body.code, p).to.equal('INVALID_PARAMETER');
            expect(res.text, p).to.not.match(/URIError|node_modules|\n\s+at /);
            expect(res.headers['access-control-allow-origin'], p).to.equal('https://example.com');
        }
    });

    it('answers any other thrown error with a bounded JSON body and no stack', async function () {
        const res = await request.get('/boom/generic');
        expect(res.status).to.equal(500);
        expect(res.headers['content-type']).to.match(/application\/json/);
        expect(res.body.code).to.equal('INTERNAL_ERROR');
        expect(res.text).to.not.match(/node_modules|XChainExplorer|Error:|\n\s+at |secret/);
        const client = await request.get('/boom/client');
        expect(client.status).to.equal(403);
        expect(client.headers['content-type']).to.match(/application\/json/);
        expect(client.body.code).to.equal('BAD_REQUEST');
        expect(client.text).to.not.match(/node_modules|nope/);
    });

    it('delegates to the default handler once headers are sent', async function () {
        const res = await request.get('/boom/late').catch((e) => e);
        // The socket is torn down by the default handler; no JSON error body is appended.
        expect(res.text || '').to.not.include('INTERNAL_ERROR');
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

    it('answers untyped decompressor errors but leaves other untyped 400s alone', function () {
        const decode = Object.assign(new Error('decode'), { status: 400, errno: -3, code: 'Z_DATA_ERROR' });
        const rpc = fakeRes();
        expect(sendBodyError(decode, { path: '/' }, rpc)).to.equal(true);
        expect(rpc.sent.error.code).to.equal(-32700);
        const plain = Object.assign(new Error('plain'), { status: 400 });
        expect(sendBodyError(plain, { path: '/RBTC/api/balances' }, fakeRes())).to.equal(false);
    });

    it('answers a synthetic URIError with status 400 and leaves a status-less one alone', function () {
        const res = fakeRes();
        const err = Object.assign(new URIError('Failed to decode param'), { status: 400 });
        expect(sendBodyError(err, { path: '/x' }, res)).to.equal(true);
        expect(res.code).to.equal(400);
        expect(res.sent.code).to.equal('INVALID_PARAMETER');
        expect(sendBodyError(new URIError('x'), { path: '/x' }, fakeRes())).to.equal(false);
    });

    it('treats only / and /{COIN}/api as the dispatcher paths', function () {
        for (const p of ['/', '/RBTC/api', '/RBTC/api/']) expect(isJsonRpcPath(p), p).to.equal(true);
        for (const p of ['/RBTC/api/balances', '/RBTC/explorer/blocks', '/RBTC']) expect(isJsonRpcPath(p), p).to.equal(false);
    });
});

// A JSON object whose serialized length is exactly n bytes.
const jsonOfBytes = (n) => '{"pad":"' + 'x'.repeat(n - 10) + '"}';
// A JSON-RPC ping whose serialized length is exactly n bytes.
const pingOfBytes = (n) => {
    const head = '{"jsonrpc":"2.0","id":1,"method":"ping","pad":"';
    return head + 'x'.repeat(n - head.length - 2) + '"}';
};

describe('json body ceilings at the byte boundary', function () {
    const TEN_KB = 10 * 1024;
    let request;
    before(function () {
        request = supertest(bootApp());
    });
    const send = (path, body) => request.post(path).set('Content-Type', 'application/json').send(body);

    it('accepts a REST body of exactly 10kb and refuses one byte more', async function () {
        expect((await send('/RBTC/api/balances', jsonOfBytes(TEN_KB))).status).to.equal(200);
        const over = await send('/RBTC/api/balances', jsonOfBytes(TEN_KB + 1));
        expect(over.status).to.equal(413);
        expect(over.body.code).to.equal('BODY_TOO_LARGE');
    });

    it('holds both dispatcher paths to the same 10kb boundary', async function () {
        for (const p of ['/', '/RBTC/api/']) {
            const ok = await send(p, pingOfBytes(TEN_KB));
            expect(ok.status, p).to.equal(200);
            expect(ok.body.result, p).to.equal('pong');
            const over = await send(p, pingOfBytes(TEN_KB + 1));
            expect(over.status, p).to.equal(413);
            expect(over.body.error.code, p).to.equal(-32600);
        }
    });

    it('pins the preflight route ceiling to 2.5mb and accepts its worst legal body', async function () {
        expect(PREFLIGHT_BODY_LIMIT).to.equal('2.5mb');
        const limit = 2.5 * 1024 * 1024;
        const worst = JSON.stringify({ params: '\u0001'.repeat(XChainExplorer.MAX_PREFLIGHT_PARAMS_LENGTH) });
        expect(Buffer.byteLength(worst)).to.be.greaterThan(2.3 * 1000 * 1000).and.to.be.lessThan(limit);
        expect((await send('/RBTC/api/preflight', worst)).status).to.equal(200);
        expect((await send('/RBTC/api/preflight', jsonOfBytes(limit + 1))).status).to.equal(413);
    });
});

describe('json body: one global parser', function () {
    const fs = require('fs');
    const path = require('path');
    const read = (f) => fs.readFileSync(path.join(__dirname, '../../../../src/http/api_boot', f), 'utf8');

    it('builds the 10kb parser once and shares it with the pre-gate dispatcher parse', function () {
        const files = fs.readdirSync(path.join(__dirname, '../../../../src/http/api_boot')).filter((f) => f.endsWith('.js'));
        const builders = files.filter((f) => /express\.json\(/.test(read(f)));
        expect(builders).to.deep.equal(['json_body.js']);
        expect(read('json_body.js').match(/express\.json\(\{\s*limit:\s*'10kb'\s*\}\)/g)).to.have.length(1);
        expect(read('rate_limits.js')).to.match(/globalJsonBody\(req, res, next\)/);
    });

    it('answers an oversized body on an unclaimed POST path in the REST shape', async function () {
        const res = await supertest(bootApp()).post('/RBTC/api/tx/abc')
            .set('Content-Type', 'application/json').send(jsonOfBytes(20 * 1024));
        expect(res.status).to.equal(413);
        expect(res.body).to.deep.equal({ error: 'Request body too large', code: 'BODY_TOO_LARGE' });
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
