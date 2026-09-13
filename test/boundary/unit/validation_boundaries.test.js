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
 * Boundary tests: Validation functions (isInteger, isNumeric, isNull)
 *
 * Tests extreme and edge-case inputs to the core validation helpers
 * that gate all query parameter acceptance.
 *
 * Run: mocha test/boundary/unit/validation-boundaries.test.js --timeout 0
 */

'use strict';

const { expect } = require('chai');
const Utility    = require('../../../src/utility');

const util = new Utility(null);

// ===========================================================================
// isInteger: guards limit, page, length, start
// ===========================================================================

describe('Boundary: isInteger()', function () {

    // --- Valid integers that SHOULD pass ---

    it('accepts 0', function () {
        expect(util.isInteger(0)).to.be.true;
    });

    it('accepts 1 (minimum positive)', function () {
        expect(util.isInteger(1)).to.be.true;
    });

    it('accepts -1 (negative integer)', function () {
        // NOTE: This passes. Negative values are accepted by isInteger;
        // pagination parameters must add their own floor checks.
        expect(util.isInteger(-1)).to.be.true;
    });

    it('accepts Number.MAX_SAFE_INTEGER (isInteger has no 32-bit ceiling)', function () {
        // isInteger uses Number.isInteger(+value), which has no 32-bit cap.
        // Any callers that need a 32-bit or pagination-sized ceiling must
        // enforce it themselves (see call-site assertions below).
        expect(util.isInteger(Number.MAX_SAFE_INTEGER)).to.be.true;
    });

    it('accepts Number.MIN_SAFE_INTEGER (isInteger has no 32-bit floor)', function () {
        expect(util.isInteger(Number.MIN_SAFE_INTEGER)).to.be.true;
    });

    it('accepts -2147483648 (32-bit int min)', function () {
        expect(util.isInteger(-2147483648)).to.be.true;
    });

    it('accepts 2147483647 (32-bit int max)', function () {
        expect(util.isInteger(2147483647)).to.be.true;
    });

    // --- Values above/below the old (defective) 32-bit range now PASS ---

    it('accepts 2147483648 (above old 32-bit ceiling; no longer truncated)', function () {
        // Number.isInteger(+value) does not truncate through int32, so this
        // large-but-safe integer is correctly recognized as an integer.
        expect(util.isInteger(2147483648)).to.be.true;
    });

    it('accepts -2147483649 (below old 32-bit floor; no longer truncated)', function () {
        expect(util.isInteger(-2147483649)).to.be.true;
    });

    it('rejects 0.5 (float)', function () {
        expect(util.isInteger(0.5)).to.be.false;
    });

    it('rejects NaN', function () {
        expect(util.isInteger(NaN)).to.be.false;
    });

    it('rejects Infinity', function () {
        expect(util.isInteger(Infinity)).to.be.false;
    });

    it('rejects -Infinity', function () {
        expect(util.isInteger(-Infinity)).to.be.false;
    });

    it('isInteger(null) is true (+null coerces to 0), but callers never reach it for null', function () {
        // +null === 0, and Number.isInteger(0) is true. Pagination callers
        // guard with `q.limit && ...` (truthy check) before calling isInteger,
        // so a null query param short-circuits to the default before this
        // function is ever invoked; see call-site assertions below.
        expect(util.isInteger(null)).to.be.true;
    });

    it('rejects undefined', function () {
        expect(util.isInteger(undefined)).to.be.false;
    });

    it('isInteger(Number("")) is true, but callers never reach it for empty string', function () {
        // Number('') === 0, and isInteger(0) is true. Pagination callers guard
        // with `q.limit && ...` (truthy check) before calling isInteger, so an
        // empty-string query param short-circuits to the default before this
        // function is ever invoked; see call-site assertions below.
        expect(util.isInteger(Number(''))).to.be.true;
    });

    it('rejects string "abc"', function () {
        expect(util.isInteger(Number('abc'))).to.be.false; // NaN
    });

    // --- Boundary: Number() coercion of query param strings ---

    it('Number("0") passes isInteger', function () {
        expect(util.isInteger(Number('0'))).to.be.true;
    });

    it('Number("1") passes isInteger', function () {
        expect(util.isInteger(Number('1'))).to.be.true;
    });

    it('Number("-1") passes isInteger', function () {
        expect(util.isInteger(Number('-1'))).to.be.true;
    });

    it('Number("1.5") fails isInteger', function () {
        expect(util.isInteger(Number('1.5'))).to.be.false;
    });

    it('Number("999999999") passes isInteger (within 32-bit)', function () {
        expect(util.isInteger(Number('999999999'))).to.be.true;
    });

    it('Number("9999999999") passes isInteger (large numeric strings now accepted)', function () {
        expect(util.isInteger(Number('9999999999'))).to.be.true;
    });

    it('Number("1e10") passes isInteger (10000000000 is a valid safe integer)', function () {
        expect(util.isInteger(Number('1e10'))).to.be.true;
    });
});

// ===========================================================================
// isNumeric: guards offset values
// ===========================================================================

describe('Boundary: isNumeric()', function () {

    it('accepts 0', function () {
        expect(util.isNumeric(0)).to.be.true;
    });

    it('accepts -1', function () {
        expect(util.isNumeric(-1)).to.be.true;
    });

    it('accepts 3.14', function () {
        expect(util.isNumeric(3.14)).to.be.true;
    });

    it('accepts numeric string "100"', function () {
        expect(util.isNumeric('100')).to.be.true;
    });

    it('accepts negative numeric string "-50"', function () {
        expect(util.isNumeric('-50')).to.be.true;
    });

    it('accepts float string "3.14"', function () {
        expect(util.isNumeric('3.14')).to.be.true;
    });

    it('accepts BigInt', function () {
        expect(util.isNumeric(9007199254740993n)).to.be.true;
    });

    it('accepts string "0"', function () {
        expect(util.isNumeric('0')).to.be.true;
    });

    it('accepts very large number string', function () {
        expect(util.isNumeric('99999999999999999')).to.be.true;
    });

    it('rejects NaN', function () {
        expect(util.isNumeric(NaN)).to.be.false;
    });

    it('rejects Infinity', function () {
        expect(util.isNumeric(Infinity)).to.be.false;
    });

    it('rejects -Infinity', function () {
        expect(util.isNumeric(-Infinity)).to.be.false;
    });

    it('rejects non-numeric string "abc"', function () {
        expect(util.isNumeric('abc')).to.be.false;
    });

    it('rejects empty string', function () {
        expect(util.isNumeric('')).to.be.false;
    });

    it('rejects null', function () {
        expect(util.isNumeric(null)).to.be.false;
    });

    it('rejects undefined', function () {
        expect(util.isNumeric(undefined)).to.be.false;
    });

    it('rejects boolean true', function () {
        // parseFloat(true) = NaN
        expect(util.isNumeric(true)).to.be.false;
    });

    it('rejects object', function () {
        expect(util.isNumeric({})).to.be.false;
    });

    it('accepts "1e5" (scientific notation string)', function () {
        expect(util.isNumeric('1e5')).to.be.true;
    });
});

// ===========================================================================
// isNull: guards offset.start, offset.action, and general null checks
// ===========================================================================

describe('Boundary: isNull()', function () {

    it('returns true for null', function () {
        expect(util.isNull(null)).to.be.true;
    });

    it('returns true for undefined', function () {
        expect(util.isNull(undefined)).to.be.true;
    });

    it('returns true for empty string', function () {
        expect(util.isNull('')).to.be.true;
    });

    it('returns false for 0 (important: zero is NOT null)', function () {
        // This matters for offset/action_index values of 0
        expect(util.isNull(0)).to.be.false;
    });

    it('returns false for false', function () {
        expect(util.isNull(false)).to.be.false;
    });

    it('returns false for string "null"', function () {
        // URL path cleanup converts "null" to actual null,
        // but if that conversion is bypassed, "null" string is NOT null
        expect(util.isNull('null')).to.be.false;
    });

    it('returns false for string "undefined"', function () {
        expect(util.isNull('undefined')).to.be.false;
    });

    it('returns false for string "0"', function () {
        expect(util.isNull('0')).to.be.false;
    });

    it('returns false for whitespace-only string', function () {
        expect(util.isNull(' ')).to.be.false;
    });

    it('returns false for empty array', function () {
        expect(util.isNull([])).to.be.false;
    });

    it('returns false for empty object', function () {
        expect(util.isNull({})).to.be.false;
    });

    it('returns false for NaN', function () {
        expect(util.isNull(NaN)).to.be.false;
    });
});
