'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect, sinon, proxyquire, Utility, log, makeUtil, makeStablePriceRows, stringifyBigInt, stringifyBigNumber, stringifySimpleValues, stringifyNestedBigNumber } = require('./helpers.js');

describe("Utility", function () {
    describe('constructor', function () {

        it('stores configInfo on the instance', function () {
            const cfg = { foo: 'bar' };
            const u   = new Utility(cfg);
            expect(u.configInfo).to.equal(cfg);
        });

        it('accepts null configInfo without throwing', function () {
            expect(() => new Utility(null)).to.not.throw();
        });

    });

    describe('isNull()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true for null', function ()      { expect(u.isNull(null)).to.be.true; });
        it('returns true for undefined', function () { expect(u.isNull(undefined)).to.be.true; });
        it('returns true for empty string', function () { expect(u.isNull('')).to.be.true; });

        it('returns false for 0', function ()        { expect(u.isNull(0)).to.be.false; });
        it('returns false for false', function ()    { expect(u.isNull(false)).to.be.false; });
        it('returns false for a non-empty string', function () { expect(u.isNull('hello')).to.be.false; });
        it('returns false for an object', function () { expect(u.isNull({})).to.be.false; });
        it('returns false for an array', function () { expect(u.isNull([])).to.be.false; });

    });

    describe('isNumeric()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true for an integer',       function () { expect(u.isNumeric(42)).to.be.true; });
        it('returns true for a float',          function () { expect(u.isNumeric(3.14)).to.be.true; });
        it('returns true for a numeric string', function () { expect(u.isNumeric('100')).to.be.true; });
        it('returns true for a float string',   function () { expect(u.isNumeric('3.14')).to.be.true; });
        it('returns true for a bigint',         function () { expect(u.isNumeric(9007199254740993n)).to.be.true; });
        it('returns true for 0',                function () { expect(u.isNumeric(0)).to.be.true; });
        it('returns true for negative number',  function () { expect(u.isNumeric(-5)).to.be.true; });

        it('returns false for a non-numeric string', function () { expect(u.isNumeric('abc')).to.be.false; });
        it('returns false for null',                 function () { expect(u.isNumeric(null)).to.be.false; });
        it('returns false for undefined',            function () { expect(u.isNumeric(undefined)).to.be.false; });
        it('returns false for Infinity',             function () { expect(u.isNumeric(Infinity)).to.be.false; });
        it('returns false for NaN',                  function () { expect(u.isNumeric(NaN)).to.be.false; });
        it('returns false for an empty string',      function () { expect(u.isNumeric('')).to.be.false; });

    });
});

describe("Utility", function () {
    describe('isFloat()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true for a JS float',       function () { expect(u.isFloat(1.5)).to.be.true; });
        it('returns true for a negative float', function () { expect(u.isFloat(-0.001)).to.be.true; });

        it('returns false for an integer',      function () { expect(u.isFloat(4)).to.be.false; });
        it('returns false for 0',               function () { expect(u.isFloat(0)).to.be.false; });
        it('returns false for a string',        function () { expect(u.isFloat('1.5')).to.be.false; });
        it('returns false for NaN',             function () { expect(u.isFloat(NaN)).to.be.false; });

    });

    describe('isInteger()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true for a positive integer', function () { expect(u.isInteger(10)).to.be.true; });
        it('returns true for 0',                  function () { expect(u.isInteger(0)).to.be.true; });
        it('returns true for a negative integer', function () { expect(u.isInteger(-3)).to.be.true; });

        it('returns false for a float',  function () { expect(u.isInteger(1.5)).to.be.false; });
        // isInteger matches the indexer's Number.isInteger(+value) exactly, so
        // numeric strings and coercible primitives count as integers, same as
        // on the consensus side.
        it('returns true for a numeric string (canonical parity)', function () { expect(u.isInteger('4')).to.be.true; });
        it('returns false for NaN',      function () { expect(u.isInteger(NaN)).to.be.false; });
        it('returns true for null (+null === 0, canonical parity)', function () { expect(u.isInteger(null)).to.be.true; });
        it('returns true for boolean true (+true === 1, canonical parity)', function () { expect(u.isInteger(true)).to.be.true; });

    });

    describe('bcnum()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('converts an integer string to a bignumber', function () {
            const bn = u.bcnum('12345');
            expect(bn.toString()).to.equal('12345');
        });

        it('converts a JS number to a bignumber', function () {
            const bn = u.bcnum(99);
            expect(bn.toString()).to.equal('99');
        });

        it('preserves precision beyond JS float limit', function () {
            const bn = u.bcnum('99999999999999999999');
            expect(bn.toString()).to.equal('99999999999999999999');
        });

    });
});

describe("Utility", function () {
    describe('bcformat()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('formats to 0 decimal places by default (null decimals)', function () {
            expect(u.bcformat('3.7', null)).to.equal('4');
        });

        it('formats to the specified number of decimal places', function () {
            expect(u.bcformat('3.14159', 2)).to.equal('3.14');
        });

        it('pads with zeros when precision exceeds significant digits', function () {
            expect(u.bcformat('1', 4)).to.equal('1.0000');
        });

        it('handles a zero value', function () {
            expect(u.bcformat('0', 2)).to.equal('0.00');
        });

    });
});

describe("Utility", function () {
    describe('bcsub()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('subtracts two integers', function () {
            expect(u.bcsub(10, 3, 0).toString()).to.equal('7');
        });

        it('subtracts with decimal precision', function () {
            expect(u.bcsub('1.500', '0.375', 3).toString()).to.equal('1.125');
        });

        it('treats null numA as 0', function () {
            expect(u.bcsub(null, 3, 0).toString()).to.equal('-3');
        });

        it('treats null numB as 0', function () {
            expect(u.bcsub(5, null, 0).toString()).to.equal('5');
        });

        it('handles large numbers without precision loss', function () {
            expect(u.bcsub('100000000000000000000', '1', 0).toString())
                .to.equal('99999999999999999999');
        });

        it('respects decimal precision truncation', function () {
            // Repeating-decimal operand so truncation to 4 places is meaningfully tested:
            // 1 minus 0.666... has far more than 4 digits, so 0.3333 only comes back if
            // the result is really cut to the requested precision.
            const result = u.bcsub('1', '0.6666666666666666666', 4);
            expect(result.toString()).to.equal('0.3333');
        });

    });
});

describe("Utility", function () {
    describe('bcadd()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('adds two integers', function () {
            expect(u.bcadd(7, 3, 0).toString()).to.equal('10');
        });

        it('adds with decimal precision', function () {
            expect(u.bcadd('0.1', '0.2', 1).toString()).to.equal('0.3');
        });

        it('treats null inputs as 0', function () {
            expect(u.bcadd(null, null, 0).toString()).to.equal('0');
        });

        it('handles large number addition', function () {
            expect(u.bcadd('99999999999999999999', '1', 0).toString())
                .to.equal('100000000000000000000');
        });

        it('respects decimal precision truncation', function () {
            // 0.1 + 0.6666666666666666666 = 0.7666... truncated to 4 decimals
            const result = u.bcadd('0.1', '0.6666666666666666666', 4);
            expect(result.toString()).to.equal('0.7667');
        });

    });
});

describe("Utility", function () {
    describe('bcmul()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('multiplies two integers', function () {
            expect(u.bcmul(6, 7, 0).toString()).to.equal('42');
        });

        it('multiplies with decimal precision', function () {
            // mathjs trims trailing zeros on exact results; 2.5 * 4 = 10 exactly
            expect(u.bcmul('2.5', '4', 1).toString()).to.equal('10');
        });

        it('returns 0 when one operand is 0', function () {
            expect(u.bcmul(0, '9999', 0).toString()).to.equal('0');
        });

        it('treats null input as 0', function () {
            expect(u.bcmul(null, 5, 0).toString()).to.equal('0');
        });

        it('handles high-precision fractional result', function () {
            expect(u.bcmul('0.1', '0.1', 2).toString()).to.equal('0.01');
        });

        it('respects decimal precision truncation', function () {
            // 0.3333333333 * 3 = 0.9999999999, precision 4 should truncate
            const result = u.bcmul('0.3333333333333333333', '3', 4);
            expect(result.toString()).to.equal('1');
        });

    });
});

describe("Utility", function () {
    describe('bcdiv()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('divides two integers', function () {
            expect(u.bcdiv(10, 2, 0).toString()).to.equal('5');
        });

        it('divides with decimal precision', function () {
            expect(u.bcdiv(1, 3, 8).toString()).to.equal('0.33333333');
        });

        it('returns 0 for 0 numerator', function () {
            expect(u.bcdiv(0, 5, 0).toString()).to.equal('0');
        });

        it('treats null numerator as 0', function () {
            expect(u.bcdiv(null, 4, 0).toString()).to.equal('0');
        });

        it('handles large number division', function () {
            expect(u.bcdiv('1000000000000000000', '3', 0).toString())
                .to.equal('333333333333333333');
        });

    });

    // Comparison operators: amounts are compared as exact decimals, never as rounded floating-point numbers
    describe('bcgt()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true when numA > numB',  function () { expect(u.bcgt(5, 3)).to.be.true; });
        it('returns false when numA === numB', function () { expect(u.bcgt(3, 3)).to.be.false; });
        it('returns false when numA < numB', function () { expect(u.bcgt(1, 3)).to.be.false; });

    });

    describe('bclt()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true when numA < numB',    function () { expect(u.bclt(1, 3)).to.be.true; });
        it('returns false when numA === numB', function () { expect(u.bclt(3, 3)).to.be.false; });
        it('returns false when numA > numB',  function () { expect(u.bclt(5, 3)).to.be.false; });

    });
});

describe("Utility", function () {
    describe('bcgte()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true when numA > numB',   function () { expect(u.bcgte(5, 3)).to.be.true; });
        it('returns true when numA === numB', function () { expect(u.bcgte(3, 3)).to.be.true; });
        it('returns false when numA < numB',  function () { expect(u.bcgte(1, 3)).to.be.false; });

    });

    describe('bclte()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns true when numA < numB',   function () { expect(u.bclte(1, 3)).to.be.true; });
        it('returns true when numA === numB', function () { expect(u.bclte(3, 3)).to.be.true; });
        it('returns false when numA > numB',  function () { expect(u.bclte(5, 3)).to.be.false; });

    });

    describe('getPrice()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns numerator / denominator at default 64 decimal precision', function () {
            const price = u.getPrice(1, 3);
            // result should have 64 decimal places
            const str = price.toString();
            const decimals = str.split('.')[1];
            expect(decimals).to.have.lengthOf(64);
        });

        it('respects a custom precision parameter', function () {
            const price = u.getPrice(1, 3, 8);
            expect(price.toString()).to.equal('0.33333333');
        });

        it('returns 0 when numerator is 0', function () {
            const price = u.getPrice(0, 100, 4);
            // mathjs trims trailing zeros on exact zero results
            expect(price.toString()).to.equal('0');
        });

        it('handles string inputs', function () {
            const price = u.getPrice('10', '4', 2);
            // 10/4 = 2.5 exactly; mathjs trims trailing zero
            expect(price.toString()).to.equal('2.5');
        });

    });
});
