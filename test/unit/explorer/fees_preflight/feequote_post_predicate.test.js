// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const { expect } = require('chai');
const XChainExplorer = require('../../../../src/XChainExplorer.js');

describe('isFeeQuotePostRequest', function () {
    const f = XChainExplorer.isFeeQuotePostRequest;
    it('matches POST /{COIN}/api/feequote', function () {
        expect(f({ method: 'POST', path: '/BTC/api/feequote' })).to.equal(true);
        expect(f({ method: 'post', path: '/RBTC/api/feequote/' })).to.equal(true);
    });
    it('rejects other methods and paths', function () {
        expect(f({ method: 'GET', path: '/BTC/api/feequote' })).to.equal(false);
        expect(f({ method: 'POST', path: '/BTC/api/preflight' })).to.equal(false);
        expect(f({ method: 'POST', path: '/BTC/api/feequote/x' })).to.equal(false);
        expect(f(null)).to.equal(false);
    });
});
