// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// POST /{COIN}/api/feequote: mounted with the preflight body ceiling and its own
// limiter, skipped by the global 10kb parser, and documented in openapi.

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const express = require('express');
const XChainExplorer = require('../../../src/XChainExplorer.js');
const { methods, PREFLIGHT_BODY_LIMIT } = require('../../../src/explorer/mount.js');
const { applySecurityHeaders } = require('../../../src/http/api_boot/security_headers.js');

const REPO = path.join(__dirname, '..', '..', '..');

function fakeHost(){
    const limiter = (name) => { const f = (req, res, next) => next(); f.limiterName = name; return f; };
    return {
        express,
        rateLimit: (opts) => { const f = (req, res, next) => next(); f.opts = opts; return f; },
        limitedHandler: () => () => {},
        configEnv: () => ({}),
        limiter,
    };
}

describe('POST /:coin/api/feequote mount', function () {
    it('registers a limiter, then a parser, then the handler', function () {
        const calls = [];
        const ctx = { app: { post: (...a) => calls.push(a) }, processFeeQuoteRequest(){} };
        methods.mountFeeQuotePostRoute.call(ctx, fakeHost());
        expect(calls).to.have.length(1);
        const [route, ...handlers] = calls[0];
        expect(route).to.equal('/:coin/api/feequote');
        expect(handlers).to.have.length(3);
        expect(handlers[0].opts.limit).to.equal(60);
    });

    it('is called by mountRoutes after the preflight POST', function () {
        const src = fs.readFileSync(path.join(REPO, 'src/explorer/mount.js'), 'utf8');
        expect(src.indexOf('this.mountFeeQuotePostRoute(host)')).to.be.greaterThan(src.indexOf('this.mountPreflightPostRoute(host)'));
    });

    it('shares the preflight body ceiling', function () {
        expect(PREFLIGHT_BODY_LIMIT).to.equal('1mb');
    });
});

describe('global body parser skips POST /feequote', function () {
    it('lets a body above 10kb through to the route parser', async function () {
        const app = express();
        applySecurityHeaders(app, { env: {} }, XChainExplorer);
        app.post('/:coin/api/feequote', express.json({ limit: '1mb' }), (req, res) => res.json({ len: req.body.params.length }));
        app.post('/:coin/api/other', (req, res) => res.json({ ok: true }));
        const server = app.listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        try {
            const base = 'http://127.0.0.1:' + server.address().port;
            const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
            const big = { action: 'BATCH', params: 'a'.repeat(50000) };
            const ok = await post('/RBTC/api/feequote', big);
            expect(ok.status).to.equal(200);
            expect((await ok.json()).len).to.equal(50000);
            expect((await post('/RBTC/api/other', big)).status).to.equal(413);
        } finally { server.close(); }
    });
});

describe('openapi documents POST /{COIN}/api/feequote', function () {
    it('declares the operation with a body and 413/429', function () {
        const spec = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/openapi.json'), 'utf8'));
        const op = spec.paths['/{COIN}/api/feequote'].post;
        expect(op.operationId).to.equal('postFeeQuote');
        expect(op.requestBody.required).to.equal(true);
        expect(op.responses).to.include.keys('413', '429');
    });
});
