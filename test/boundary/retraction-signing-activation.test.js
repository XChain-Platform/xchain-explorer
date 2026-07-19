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
 * Boundary tests: signed-retraction activation gate (crypto-financial).
 *
 * isRetractionSigningActive() decides whether a quorum-class mirror retraction
 * must carry a 2f+1 co-signature. A one-block error at the flag-day would flip
 * a whole era into (or out of) the enforced regime, so the exact inclusive
 * boundary and the numeric extremes / coercion edges are pinned here.
 *
 * Run: mocha test/boundary/retraction-signing-activation.test.js --timeout 0
 */

'use strict';

const assert = require('assert');
const {
    RETRACTION_SIGNING_ACTIVATION,
    isRetractionSigningActive,
} = require('../../src/retraction_signing_activation.js');

const M = RETRACTION_SIGNING_ACTIVATION.mainnet;

describe('boundary: isRetractionSigningActive mainnet flag-day', function () {
    it('is off one block below and on exactly at the threshold (inclusive)', function () {
        assert.strictEqual(isRetractionSigningActive(M - 1, 'mainnet'), false);
        assert.strictEqual(isRetractionSigningActive(M, 'mainnet'), true);
    });

    it('stays on for the block immediately after and far beyond the threshold', function () {
        assert.strictEqual(isRetractionSigningActive(M + 1, 'mainnet'), true);
        assert.strictEqual(isRetractionSigningActive(Number.MAX_SAFE_INTEGER, 'mainnet'), true);
    });

    it('treats the numeric string exactly at the boundary the same as the number', function () {
        assert.strictEqual(isRetractionSigningActive(String(M), 'mainnet'), true);
        assert.strictEqual(isRetractionSigningActive(String(M - 1), 'mainnet'), false);
        // parseInt tolerates trailing non-digits; a decimal at the boundary truncates toward the era start.
        assert.strictEqual(isRetractionSigningActive(`${M}.9`, 'mainnet'), true);
        assert.strictEqual(isRetractionSigningActive(`${M - 1}.9`, 'mainnet'), false);
    });
});

describe('boundary: isRetractionSigningActive genesis-armed networks', function () {
    it('is on at height 0 for testnet and regtest (threshold 0, inclusive)', function () {
        assert.strictEqual(RETRACTION_SIGNING_ACTIVATION.testnet, 0);
        assert.strictEqual(RETRACTION_SIGNING_ACTIVATION.regtest, 0);
        assert.strictEqual(isRetractionSigningActive(0, 'testnet'), true);
        assert.strictEqual(isRetractionSigningActive(0, 'regtest'), true);
    });

    it('rejects a negative height even where the threshold is 0', function () {
        assert.strictEqual(isRetractionSigningActive(-1, 'regtest'), false);
    });
});

describe('boundary: isRetractionSigningActive degenerate inputs fail safe', function () {
    it('returns false (never throws) at the non-numeric extremes', function () {
        for (const bad of [NaN, Infinity, -Infinity, undefined, null, '', 'abc', {}, []]) {
            assert.strictEqual(isRetractionSigningActive(bad, 'mainnet'), false, `input ${String(bad)} must fail safe`);
        }
    });

    it('returns false for any unknown network at every height', function () {
        for (const h of [0, M, Number.MAX_SAFE_INTEGER]) {
            assert.strictEqual(isRetractionSigningActive(h, 'devnet'), false);
            assert.strictEqual(isRetractionSigningActive(h, undefined), false);
        }
    });
});
