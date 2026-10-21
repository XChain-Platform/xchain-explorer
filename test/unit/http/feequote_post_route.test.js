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
 * POST /{COIN}/api/feequote: mounted with the preflight body ceiling and its
 * own limiter, answered by the same handler as the GET, and documented.
 */

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const { srcText } = require('../../helpers/source_text');
const XChainExplorer = require('../../../src/XChainExplorer.js');
const IndexerConnector = require('../../../src/connectors/indexer.js');
const mount = require('../../../src/explorer/mount.js');
const SPEC = require('../../../docs/openapi.json');

describe('POST /:coin/api/feequote mount', function () {
    afterEach(() => sinon.restore());

    function mounted() {
        const calls = [];
        const app = { post: (...a) => calls.push(['post', ...a]), get: () => {} };
        const express = { json: (o) => { const f = () => {}; f.opts = o; return f; } };
        const limiter = () => {};
        const host = { express, rateLimit: () => limiter, limitedHandler: () => () => {}, configEnv: () => ({}) };
        const ctx = { app, processFeeQuoteRequest: sinon.stub() };
        mount.methods.mountFeeQuotePostRoute.call(ctx, host);
        return { calls, ctx };
    }

    it('registers limiter, then the preflight-sized parser, then the handler', function () {
        const { calls } = mounted();
        expect(calls).to.have.length(1);
        const [, path, limiter, parser, handler] = calls[0];
        expect(path).to.equal('/:coin/api/feequote');
        expect(limiter).to.be.a('function');
        expect(parser.opts).to.deep.equal({ limit: mount.PREFLIGHT_BODY_LIMIT });
        expect(handler).to.be.a('function');
    });

    it('feeds the JSON body to the shared handler as its query', function () {
        const { calls, ctx } = mounted();
        const req = { params: { coin: 'RBTC' }, query: { action: 'IGNORED' }, body: { action: 'SEND', params: 'a|b' } };
        calls[0][4](req, {});
        const seen = ctx.processFeeQuoteRequest.firstCall.args[0];
        expect(seen.query).to.deep.equal({ action: 'SEND', params: 'a|b' });
        expect(seen.params).to.deep.equal({ coin: 'RBTC' });
    });

    it('treats a non-object body as empty so the handler answers MISSING_PARAMETER', function () {
        const { calls, ctx } = mounted();
        calls[0][4]({ params: {}, query: {}, body: [1] }, {});
        expect(ctx.processFeeQuoteRequest.firstCall.args[0].query).to.deep.equal({});
    });

    it('the shared handler quotes from a body view', async function () {
        sinon.stub(IndexerConnector, 'resolveIndexerUrl').returns('http://x:1');
        const stub = sinon.stub(IndexerConnector.prototype, 'feequote').resolves({ supported: true, valid: true });
        const { calls } = mounted();
        const ctx = {
            configInfo: { getConfig: async () => ({}) },
            parseCoinCode: () => ({ coin: 'btc', network: 'regtest' }),
            util: { isNull: (v) => v === undefined || v === null || v === '' },
            feeQuoteWithBusyRetry: XChainExplorer.prototype.feeQuoteWithBusyRetry,
        };
        let out;
        const res = { status() { return this; }, json(o) { out = o; return this; } };
        const view = Object.create({ params: { coin: 'RBTC' } }, { query: { value: { action: 'SEND' } } });
        await XChainExplorer.prototype.processFeeQuoteRequest.call(ctx, view, res);
        expect(out.valid).to.equal(true);
        expect(stub.calledOnce).to.equal(true);
        expect(calls).to.have.length(1);
    });
});

describe('POST feequote global body guard', function () {
    it('lets the route-level parser handle POST feequote', function () {
        const { applySecurityHeaders } = require('../../../src/http/api_boot/security_headers.js');
        const used = [];
        const app = { use: (f) => used.push(f) };
        applySecurityHeaders(app, { env: {} }, { isPreflightPostRequest: () => false });
        const guard = used[used.length - 1];
        const pass = (method, path) => { let next = false; guard({ method, path, headers: {} }, {}, () => { next = true; }); return next; };
        expect(pass('POST', '/RBTC/api/feequote')).to.equal(true);
        expect(pass('POST', '/RBTC/api/feequote/')).to.equal(true);
        // The global parser also calls next() for a body-less request, so the negative
        // side is pinned at the source: only the two predicates bypass it.
        expect(srcText('src/http/api_boot/security_headers.js')).to.match(/isPreflightPostRequest\(req\) \|\| isFeeQuotePostRequest\(req\)/);
    });
});

describe('POST feequote docs and wiring', function () {
    it('is documented beside the GET with 413 and 429', function () {
        const item = SPEC.paths['/{COIN}/api/feequote'];
        expect(item.get).to.be.an('object');
        expect(item.post.operationId).to.equal('postFeequote');
        expect(item.post.requestBody.content['application/json'].schema.required).to.deep.equal(['action']);
        expect(item.post.responses).to.have.all.keys('200', '400', '404', '413', '429', '503');
    });

    it('is registered in mount.js with the per-route parser', function () {
        const SRC = srcText('src/explorer/mount.js');
        expect(SRC).to.match(/app\.post\('\/:coin\/api\/feequote'/);
        expect(SRC).to.match(/buildFeeQuotePostLimiter\(host\)/);
    });
});
