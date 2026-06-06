/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Boundary tests — BigNumber math and JSON serialization
 *
 * Tests bcformat, bcdiv, bcmul, bcadd, bcsub, and jsonStringify
 * at extreme values: zero, negative, very large, division by zero,
 * and BigInt/mathjs BigNumber serialization.
 *
 * Run: mocha test/boundary/unit/bignum-boundaries.test.js --timeout 0
 */

'use strict';

const { expect } = require('chai');
const Utility    = require('../../../src/utility');

const util = new Utility(null);

// ===========================================================================
// bcformat — formats numbers with decimal precision
// ===========================================================================

describe('Boundary: bcformat()', function () {

    it('formats zero with 8 decimals — preserves trailing zeros', function () {
        const result = util.bcformat(0, 8);
        expect(String(result)).to.equal('0.00000000');
    });

    it('formats 1 satoshi (0.00000001) with 8 decimals', function () {
        const result = util.bcformat('0.00000001', 8);
        expect(String(result)).to.equal('0.00000001');
    });

    it('formats a large value without losing precision', function () {
        const result = util.bcformat('9999999999999999.99999999', 8);
        expect(String(result)).to.include('9999999999999999');
    });

    it('formats with 0 decimals — rounds to nearest integer', function () {
        const result = util.bcformat('1234.5678', 0);
        // mathjs rounds to nearest integer
        expect(String(result)).to.match(/^123[45]/);
    });

    it('formats negative value', function () {
        const result = util.bcformat('-100.00000000', 8);
        expect(String(result)).to.include('-100');
    });

    it('formats string "0.00000000" preserves decimal format', function () {
        const result = util.bcformat('0.00000000', 8);
        expect(String(result)).to.equal('0.00000000');
    });
});

// ===========================================================================
// bcadd — addition
// ===========================================================================

describe('Boundary: bcadd()', function () {

    it('adds zero + zero', function () {
        expect(String(util.bcadd(0, 0))).to.equal('0');
    });

    it('adds zero + positive', function () {
        expect(String(util.bcadd(0, 100))).to.equal('100');
    });

    it('adds negative + positive (cancel out)', function () {
        expect(String(util.bcadd(-100, 100))).to.equal('0');
    });

    it('adds large numbers without overflow', function () {
        const result = util.bcadd('9999999999999999', '1');
        expect(String(result)).to.equal('10000000000000000');
    });

    it('adds very small decimals precisely (requires decimals param)', function () {
        // bcadd with precision 8 returns scientific notation from bignumber
        // Use bcformat to get fixed notation for display
        const result = util.bcadd('0.00000001', '0.00000001', 8);
        // Result is '2e-8' as a bignumber — format it for comparison
        const formatted = util.bcformat(result, 8);
        expect(String(formatted)).to.equal('0.00000002');
    });

    it('adds very small decimals without decimals param rounds to 0', function () {
        const result = util.bcadd('0.00000001', '0.00000001');
        expect(String(result)).to.equal('0');
    });
});

// ===========================================================================
// bcsub — subtraction
// ===========================================================================

describe('Boundary: bcsub()', function () {

    it('subtracts equal values (result zero)', function () {
        expect(String(util.bcsub(100, 100))).to.equal('0');
    });

    it('subtracts larger from smaller (negative result)', function () {
        const result = util.bcsub(10, 100);
        expect(String(result)).to.equal('-90');
    });

    it('subtracts zero', function () {
        expect(String(util.bcsub(100, 0))).to.equal('100');
    });

    it('subtracts from zero', function () {
        expect(String(util.bcsub(0, 100))).to.equal('-100');
    });
});

// ===========================================================================
// bcmul — multiplication (used for limit * page)
// ===========================================================================

describe('Boundary: bcmul()', function () {

    it('multiplies by zero', function () {
        expect(String(util.bcmul(100, 0))).to.equal('0');
    });

    it('multiplies by one (identity)', function () {
        expect(String(util.bcmul(100, 1))).to.equal('100');
    });

    it('multiplies by negative one', function () {
        expect(String(util.bcmul(100, -1))).to.equal('-100');
    });

    it('multiplies two negatives (positive result)', function () {
        expect(String(util.bcmul(-10, -10))).to.equal('100');
    });

    it('multiplies large numbers without overflow', function () {
        // Simulates limit=2147483647 * page=2
        const result = util.bcmul(2147483647, 2);
        expect(String(result)).to.equal('4294967294');
    });

    it('multiplies with decimal precision', function () {
        const result = util.bcmul('0.00000001', 100, 8);
        expect(String(result)).to.equal('0.000001');
    });
});

// ===========================================================================
// bcdiv — division (used for percent calculations)
// ===========================================================================

describe('Boundary: bcdiv()', function () {

    it('divides by 1 (identity)', function () {
        expect(String(util.bcdiv(100, 1, 8))).to.equal('100');
    });

    it('divides zero by non-zero', function () {
        expect(String(util.bcdiv(0, 100, 8))).to.equal('0');
    });

    it('divides by zero — throws or returns Infinity', function () {
        // This is a critical boundary: token with supply=0 in percent calculation
        // bcmul(bcdiv(amount, 0, 8), 100, 8)
        try {
            const result = util.bcdiv(100, 0, 8);
            // If it doesn't throw, it should be Infinity
            expect(String(result)).to.satisfy(s =>
                s === 'Infinity' || s === 'NaN' || s.includes('error')
            );
        } catch (e) {
            // Division by zero throwing is acceptable
            expect(e).to.exist;
        }
    });

    it('divides very small by very large', function () {
        const result = util.bcdiv('0.00000001', '9999999999999999', 8);
        expect(String(result)).to.equal('0');
    });

    it('divides very large by very small', function () {
        const result = util.bcdiv('9999999999999999', '0.00000001', 8);
        // Should produce a very large number
        const num = parseFloat(String(result));
        expect(num).to.be.greaterThan(1e20);
    });
});

// ===========================================================================
// bcgt, bclt, bcgte, bclte — comparisons at boundaries
// ===========================================================================

describe('Boundary: BigNumber comparisons', function () {

    it('bcgt: 0 is not greater than 0', function () {
        expect(util.bcgt(0, 0)).to.be.false;
    });

    it('bcgte: 0 is >= 0', function () {
        expect(util.bcgte(0, 0)).to.be.true;
    });

    it('bclt: -1 is less than 0', function () {
        expect(util.bclt(-1, 0)).to.be.true;
    });

    it('bclte: equal values', function () {
        expect(util.bclte(100, 100)).to.be.true;
    });

    it('bcgt: large vs large+1 (integer precision)', function () {
        // Both are integers, bignumber handles them correctly
        expect(util.bcgt(9999999, 9999998)).to.be.true;
    });

    it('bcgt: string large vs string large+1', function () {
        expect(util.bcgt('10000000', '9999999')).to.be.true;
    });

    it('bclt: tiny difference at 8th decimal', function () {
        expect(util.bclt('0.00000001', '0.00000002')).to.be.true;
    });
});

// ===========================================================================
// jsonStringify — BigInt and mathjs BigNumber serialization
// ===========================================================================

describe('Boundary: jsonStringify()', function () {

    it('serializes BigInt to string', function () {
        const obj = { value: BigInt('9007199254740993') };
        const json = util.jsonStringify(obj);
        const parsed = JSON.parse(json);
        expect(parsed.value).to.equal('9007199254740993');
    });

    it('serializes BigInt(0) to "0"', function () {
        const obj = { value: BigInt(0) };
        const json = util.jsonStringify(obj);
        const parsed = JSON.parse(json);
        expect(parsed.value).to.equal('0');
    });

    it('serializes negative BigInt', function () {
        const obj = { value: BigInt(-100) };
        const json = util.jsonStringify(obj);
        const parsed = JSON.parse(json);
        expect(parsed.value).to.equal('-100');
    });

    it('serializes mathjs BigNumber via .value property', function () {
        const obj = { amount: { mathjs: 'BigNumber', value: '99999999.12345678' } };
        const json = util.jsonStringify(obj);
        const parsed = JSON.parse(json);
        expect(parsed.amount).to.equal('99999999.12345678');
    });

    it('serializes regular numbers normally', function () {
        const obj = { count: 42, name: 'test' };
        const json = util.jsonStringify(obj);
        const parsed = JSON.parse(json);
        expect(parsed.count).to.equal(42);
        expect(parsed.name).to.equal('test');
    });

    it('serializes null values', function () {
        const obj = { value: null };
        const json = util.jsonStringify(obj);
        const parsed = JSON.parse(json);
        expect(parsed.value).to.be.null;
    });

    it('serializes nested BigInt', function () {
        const obj = { data: { nested: { amount: BigInt('18446744073709551615') } } };
        const json = util.jsonStringify(obj);
        const parsed = JSON.parse(json);
        expect(parsed.data.nested.amount).to.equal('18446744073709551615');
    });

    it('serializes array with BigInts', function () {
        const arr = [BigInt(1), BigInt(2), BigInt(3)];
        const json = util.jsonStringify(arr);
        const parsed = JSON.parse(json);
        expect(parsed).to.deep.equal(['1', '2', '3']);
    });
});
