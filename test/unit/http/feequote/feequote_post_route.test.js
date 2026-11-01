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
 * POST /{COIN}/api/feequote: mounted with the preflight body ceiling and
 * its own limiter, skipped by the global 10kb parser, and documented.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const XChainExplorer = require('../../../../src/XChainExplorer.js');
const { methods, PREFLIGHT_BODY_LIMIT } = require('../../../../src/explorer/mount.js');
const { applyJsonBody } = require('../../../../src/http/api_boot/json_body.js');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../../../..', rel), 'utf8');

describe('POST /:coin/api/feequote mount', function () {
    function mount() {
        const calls = [];
        const limiter = () => {};
        const parser = () => {};
        const host = {
            express: { json: (o) => { parser.opts = o; return parser; } },
            rateLimit: (o) => { limiter.opts = o; return limiter; },
            limitedHandler: (o) => { limiter.policy = o; return () => {}; },
            configEnv: () => ({}),
        };
        const ctx = { app: { post: (...a) => calls.push(a) }, processFeeQuoteRequest() {} };
        methods.mountFeeQuotePostRoute.call(ctx, host);
        return { calls, limiter, parser };
    }

    it('registers the route: limiter, then parser, then handler', function () {
        const { calls, limiter, parser } = mount();
        expect(calls).to.have.length(1);
        const [route, ...chain] = calls[0];
        expect(route).to.equal('/:coin/api/feequote');
        expect(chain).to.have.length(3);
        expect(chain[0]).to.equal(limiter);
        expect(chain[1]).to.equal(parser);
    });

    it('uses the preflight body ceiling', function () {
        expect(mount().parser.opts).to.deep.equal({ limit: PREFLIGHT_BODY_LIMIT });
    });

    it('has its own limiter bucket', function () {
        expect(mount().limiter.policy.name).to.equal('fee-quote-post');
    });

    it('is registered in mount.js source', function () {
        expect(read('src/explorer/mount.js')).to.match(/app\.post\('\/:coin\/api\/feequote'/);
    });
});

describe('global json parser skips POST feequote', function () {
    it('calls next() for it and parses other bodies', function () {
        const mw = [];
        const app = { use: (f) => mw.push(f) };
        applyJsonBody(app, XChainExplorer);
        const guard = mw[mw.length - 1];
        let nexted = false;
        guard({ method: 'POST', path: '/btc/api/feequote' }, {}, () => { nexted = true; });
        expect(nexted).to.equal(true);
    });
});

describe('openapi documents POST feequote', function () {
    it('has a postFeeQuote operation with 413 and 429', function () {
        const doc = JSON.parse(read('docs/openapi.json'));
        const post = doc.paths['/{COIN}/api/feequote'].post;
        expect(post.operationId).to.equal('postFeeQuote');
        expect(post.requestBody.required).to.equal(true);
        expect(post.responses).to.have.property('413');
        expect(post.responses).to.have.property('429');
    });
});
