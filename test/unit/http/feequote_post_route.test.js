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
 * POST /{COIN}/api/feequote: mounted with the preflight body ceiling
 * and its own limiter, skipped by the global 10kb parser, documented
 * in openapi.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { methods, PREFLIGHT_BODY_LIMIT } = require('../../../src/explorer/mount.js');
const { isFeeQuotePostRequest } = require('../../../src/http/api_boot/security_headers.js');

const ROOT = path.join(__dirname, '..', '..', '..');

describe('POST /:coin/api/feequote mount', function () {
    function mount() {
        const calls = [];
        const express = { json: (o) => { const f = () => {}; f.opts = o; return f; } };
        const limiter = () => {};
        const host = {
            express, rateLimit: () => limiter, limitedHandler: () => () => {},
            configEnv: () => ({}),
        };
        const seen = [];
        const ctx = {
            app: { post: (route, ...handlers) => calls.push({ route, handlers }) },
            processFeeQuoteRequest: (req, res) => seen.push(req),
        };
        methods.mountFeeQuotePostRoute.call(ctx, host);
        return { calls, seen, limiter };
    }

    it('registers limiter, then body parser at the preflight ceiling, then handler', function () {
        const { calls } = mount();
        expect(calls).to.have.length(1);
        expect(calls[0].route).to.equal('/:coin/api/feequote');
        expect(calls[0].handlers).to.have.length(3);
        expect(calls[0].handlers[1].opts).to.deep.equal({ limit: PREFLIGHT_BODY_LIMIT });
    });

    it('hands the body to the shared handler as its query', function () {
        const { calls, seen } = mount();
        const req = { params: { coin: 'RBTC' }, query: {}, body: { action: 'ISSUE', params: 'a|b' } };
        calls[0].handlers[2](req, {});
        expect(seen[0].query).to.deep.equal({ action: 'ISSUE', params: 'a|b' });
        expect(seen[0].params).to.deep.equal({ coin: 'RBTC' });
    });

    it('treats a missing or non-object body as an empty query', function () {
        const { calls, seen } = mount();
        calls[0].handlers[2]({ params: {}, query: { x: 1 } }, {});
        calls[0].handlers[2]({ params: {}, query: {}, body: [1] }, {});
        expect(seen[0].query).to.deep.equal({});
        expect(seen[1].query).to.deep.equal({});
    });

    it('is registered in source with a literal route for the coverage check', function () {
        const src = fs.readFileSync(path.join(ROOT, 'src/explorer/mount.js'), 'utf8');
        expect(src).to.match(/app\.post\('\/:coin\/api\/feequote'/);
    });
});

describe('global body parser skip for feequote POST', function () {
    it('matches only POST on the feequote path', function () {
        const yes = (m, p) => isFeeQuotePostRequest({ method: m, path: p });
        expect(yes('POST', '/RBTC/api/feequote')).to.equal(true);
        expect(yes('post', '/RBTC/api/feequote/')).to.equal(true);
        expect(yes('GET', '/RBTC/api/feequote')).to.equal(false);
        expect(yes('POST', '/RBTC/api/feequote/x')).to.equal(false);
        expect(yes('POST', '/RBTC/api/oraclefeequote')).to.equal(false);
        expect(isFeeQuotePostRequest(null)).to.equal(false);
        expect(isFeeQuotePostRequest({})).to.equal(false);
    });
});

describe('POST feequote in openapi', function () {
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/openapi.json'), 'utf8'));
    it('documents the POST beside the GET with body, 413 and 429', function () {
        const item = spec.paths['/{COIN}/api/feequote'];
        expect(item.get).to.exist;
        expect(item.post.operationId).to.equal('postFeeQuote');
        expect(item.post.requestBody.required).to.equal(true);
        expect(item.post.responses).to.include.keys('200', '400', '413', '429');
    });
});
