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
 * Boundary tests: signed-retraction flag-day gate (isRetractionSigningActive)
 *
 * Exercises the crypto-financial activation threshold at/below/above the
 * per-network boundary, on an unknown network, and against non-finite input.
 * Assertions are written against the function's BEHAVIOR (the threshold is
 * read from the exported table, not hardcoded) so the suite does not break
 * when the mainnet snapshot_block era literal is re-derived.
 *
 * Run: mocha test/boundary/unit/retraction-signing-boundaries.test.js --timeout 0
 */

'use strict';

const { expect } = require('chai');
const {
    RETRACTION_SIGNING_ACTIVATION,
    isRetractionSigningActive
} = require('../../../src/retraction_signing_activation');

describe('Boundary: isRetractionSigningActive()', function () {

    // Drive the boundary from the exported table so the test tracks the armed
    // value rather than pinning a specific literal.
    const MAINNET = RETRACTION_SIGNING_ACTIVATION.mainnet;

    it('is OFF exactly one block below the mainnet threshold', function () {
        expect(isRetractionSigningActive(MAINNET - 1, 'mainnet')).to.equal(false);
    });

    it('is ON exactly AT the mainnet threshold (>= is inclusive)', function () {
        expect(isRetractionSigningActive(MAINNET, 'mainnet')).to.equal(true);
    });

    it('is ON one block above the mainnet threshold', function () {
        expect(isRetractionSigningActive(MAINNET + 1, 'mainnet')).to.equal(true);
    });

    it('honors a zero threshold for testnet (any finite snapshot_block is ON)', function () {
        expect(RETRACTION_SIGNING_ACTIVATION.testnet).to.equal(0);
        expect(isRetractionSigningActive(0, 'testnet')).to.equal(true);
        expect(isRetractionSigningActive(1, 'testnet')).to.equal(true);
    });

    it('honors a zero threshold for regtest (any finite snapshot_block is ON)', function () {
        expect(RETRACTION_SIGNING_ACTIVATION.regtest).to.equal(0);
        expect(isRetractionSigningActive(0, 'regtest')).to.equal(true);
    });

    it('is OFF for an unknown / unrecognized network (rolling-deploy safe)', function () {
        expect(isRetractionSigningActive(MAINNET + 1000, 'ganache')).to.equal(false);
        expect(isRetractionSigningActive(1, undefined)).to.equal(false);
        expect(isRetractionSigningActive(1, null)).to.equal(false);
    });

    it('accepts a numeric-string snapshot_block (parseInt) at the boundary', function () {
        expect(isRetractionSigningActive(String(MAINNET), 'mainnet')).to.equal(true);
        expect(isRetractionSigningActive(String(MAINNET - 1), 'mainnet')).to.equal(false);
    });

    it('is OFF for non-finite snapshot_block input', function () {
        expect(isRetractionSigningActive(NaN, 'mainnet')).to.equal(false);
        expect(isRetractionSigningActive(Infinity, 'mainnet')).to.equal(false);
        expect(isRetractionSigningActive(-Infinity, 'mainnet')).to.equal(false);
        expect(isRetractionSigningActive(null, 'mainnet')).to.equal(false);
        expect(isRetractionSigningActive(undefined, 'mainnet')).to.equal(false);
        expect(isRetractionSigningActive('not-a-number', 'mainnet')).to.equal(false);
    });
});
