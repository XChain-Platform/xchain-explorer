// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// POST /{COIN}/api/feequote: mounted with the pre-flight body ceiling and its own
// limiter, skipped by the global 10kb parser, and documented in openapi.

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const XChainExplorer = require('../../../src/XChainExplorer.js');

const REPO = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

describe('POST /:coin/api/feequote wiring', function () {
    const MOUNT = read('src/explorer/mount.js');

    it('registers the route with its own limiter before its own body parser', function () {
        expect(MOUNT).to.match(/app\.post\('\/:coin\/api\/feequote',\s*feeQuotePostLimiter,\s*express\.json\(\{\s*limit:\s*PREFLIGHT_BODY_LIMIT\s*\}\)/);
        expect(MOUNT).to.match(/buildFeeQuotePostLimiter\(host\)/);
    });

    it('routes the global 10kb parser around that one request', function () {
        const SEC = read('src/http/api_boot/security_headers.js');
        expect(SEC).to.match(/isFeeQuotePostRequest\(req\)/);
        expect(XChainExplorer.isFeeQuotePostRequest({ method: 'POST', path: '/RBTC/api/feequote' })).to.equal(true);
        expect(XChainExplorer.isFeeQuotePostRequest({ method: 'GET', path: '/RBTC/api/feequote' })).to.equal(false);
    });
});

describe('POST /{COIN}/api/feequote in openapi.json', function () {
    it('documents postFeeQuote with a body, 413 and 429', function () {
        const spec = JSON.parse(read('docs/openapi.json'));
        const item = spec.paths['/{COIN}/api/feequote'];
        expect(item.get).to.be.an('object');
        expect(item.post.operationId).to.equal('postFeeQuote');
        expect(item.post.requestBody.required).to.equal(true);
        expect(item.post.responses).to.include.keys('413', '429');
    });
});
