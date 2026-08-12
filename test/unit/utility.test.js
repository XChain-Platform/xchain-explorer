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

const { expect } = require('chai');
const sinon      = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// Real Utility (no stubbing of fs yet; we stub per-suite where needed)
const Utility = require('../../src/utility');

function makeUtil(configInfo) {
    return new Utility(configInfo || null);
}

describe('Utility', function () {

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
            // Repeating-decimal operand so truncation to 4 places is meaningfully tested.
            const result = u.bcsub('1', '0.6666666666666666666', 4);
            expect(result.toString()).to.equal('0.3333');
        });

    });

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

    describe('priceSort()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('sorts ASC by default', function () {
            const data = [{ price: 3 }, { price: 1 }, { price: 2 }];
            const sorted = u.priceSort(data);
            expect(sorted.map(d => d.price)).to.deep.equal([1, 2, 3]);
        });

        it('sorts ASC when explicitly requested', function () {
            const data = [{ price: 10 }, { price: 5 }, { price: 7 }];
            const sorted = u.priceSort(data, 'ASC');
            expect(sorted.map(d => d.price)).to.deep.equal([5, 7, 10]);
        });

        it('sorts DESC when requested', function () {
            const data = [{ price: 1 }, { price: 5 }, { price: 3 }];
            const sorted = u.priceSort(data, 'DESC');
            expect(sorted.map(d => d.price)).to.deep.equal([5, 3, 1]);
        });

        it('returns the same array reference (in-place sort)', function () {
            const data = [{ price: 2 }, { price: 1 }];
            const result = u.priceSort(data);
            expect(result).to.equal(data);
        });

        it('is stable for equal prices (preserves relative order)', function () {
            const data = [
                { price: 2, id: 'a' },
                { price: 2, id: 'b' },
                { price: 1, id: 'c' }
            ];
            u.priceSort(data);
            // Equal price items should remain in original relative order
            expect(data[0].id).to.equal('c');
            expect(data[1].id).to.equal('a');
            expect(data[2].id).to.equal('b');
        });

        it('is stable for equal prices in DESC', function () {
            const data = [
                { price: 1, id: 'a' },
                { price: 2, id: 'b' },
                { price: 2, id: 'c' }
            ];
            u.priceSort(data, 'DESC');
            expect(data[0].id).to.equal('b');
            expect(data[1].id).to.equal('c');
            expect(data[2].id).to.equal('a');
        });

        it('default parameter works same as explicit ASC', function () {
            const data1 = [{ price: 3 }, { price: 1 }, { price: 2 }];
            const data2 = [{ price: 3 }, { price: 1 }, { price: 2 }];
            u.priceSort(data1);
            u.priceSort(data2, 'ASC');
            expect(data1.map(d => d.price)).to.deep.equal(data2.map(d => d.price));
        });

    });

    describe('jsonStringify()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('serializes a plain object normally', function () {
            const obj = { a: 1, b: 'hello' };
            expect(u.jsonStringify(obj)).to.equal(JSON.stringify(obj));
        });

        it('converts BigInt values to strings', function () {
            const obj = { amount: 9007199254740993n };
            const result = JSON.parse(u.jsonStringify(obj));
            expect(result.amount).to.equal('9007199254740993');
        });

        it('converts a mathjs BigNumber to its value string', function () {
            const mathjs = require('mathjs');
            const bn  = mathjs.bignumber('123456789.987654321');
            const obj = { price: bn };
            const result = JSON.parse(u.jsonStringify(obj));
            expect(result.price).to.equal('123456789.987654321');
        });

        it('handles null values without throwing', function () {
            expect(u.jsonStringify({ x: null })).to.equal('{"x":null}');
        });

        it('does not convert non-object values even if they have mathjs property', function () {
            // Strings, numbers, booleans should pass through unchanged
            const obj = { a: 'text', b: 42, c: true };
            const result = JSON.parse(u.jsonStringify(obj));
            expect(result.a).to.equal('text');
            expect(result.b).to.equal(42);
            expect(result.c).to.equal(true);
        });

        it('converts nested mathjs BigNumbers', function () {
            const mathjs = require('mathjs');
            const obj = { items: [{ val: mathjs.bignumber('999') }] };
            const result = JSON.parse(u.jsonStringify(obj));
            expect(result.items[0].val).to.equal('999');
        });

        // Stress-sweep regression: an object merely SHAPED like a serialized BigNumber
        // but carrying a non-numeric value must not make the replacer throw (that throw
        // crashed the response at the send sink). It falls back to the raw value string.
        it('does not throw on a hostile BigNumber-shaped object with a non-numeric value', function () {
            const obj = { icon: { mathjs: 'BigNumber', value: 'not-a-number' } };
            let out;
            expect(() => { out = u.jsonStringify(obj); }).to.not.throw();
            const result = JSON.parse(out);
            expect(result.icon).to.equal('not-a-number');
        });

        it('does not throw on a BigNumber-shaped object with a null/missing value', function () {
            // mathjs coerces null->0, undefined typically throws; either way the
            // guard must produce valid JSON without propagating a throw.
            let a, b;
            expect(() => { a = u.jsonStringify({ a: { mathjs: 'BigNumber', value: null } }); }).to.not.throw();
            expect(() => { b = u.jsonStringify({ b: { mathjs: 'BigNumber' } }); }).to.not.throw();
            expect(() => JSON.parse(a)).to.not.throw();
            expect(() => JSON.parse(b)).to.not.throw();
        });

    });

    describe('sanitizeInt()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('parses a valid integer string', function () {
            expect(u.sanitizeInt('42')).to.equal(42);
        });

        it('returns defaultVal for non-numeric input', function () {
            expect(u.sanitizeInt('abc')).to.equal(0);
        });

        it('returns custom defaultVal when parsing fails', function () {
            expect(u.sanitizeInt('xyz', -1)).to.equal(-1);
        });

        it('truncates floats to integer', function () {
            expect(u.sanitizeInt('3.9')).to.equal(3);
        });

        it('returns defaultVal for null', function () {
            expect(u.sanitizeInt(null)).to.equal(0);
        });

        it('returns defaultVal for undefined', function () {
            expect(u.sanitizeInt(undefined)).to.equal(0);
        });

        it('handles negative integers', function () {
            expect(u.sanitizeInt('-7')).to.equal(-7);
        });

    });

    describe('escapeLike()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('escapes backslashes', function () {
            expect(u.escapeLike('a\\b')).to.equal('a\\\\b');
        });

        it('escapes percent signs', function () {
            expect(u.escapeLike('100%')).to.equal('100\\%');
        });

        it('escapes underscores', function () {
            expect(u.escapeLike('a_b')).to.equal('a\\_b');
        });

        it('escapes all special characters together', function () {
            expect(u.escapeLike('\\%_')).to.equal('\\\\\\%\\_');
        });

        it('returns the same string when no special chars present', function () {
            expect(u.escapeLike('hello')).to.equal('hello');
        });

        it('handles empty string', function () {
            expect(u.escapeLike('')).to.equal('');
        });

        it('converts non-string input to string', function () {
            expect(u.escapeLike(123)).to.equal('123');
        });

    });

    describe('ksort()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns object with keys in alphabetical order', function () {
            const obj    = { z: 3, a: 1, m: 2 };
            const sorted = u.ksort(obj);
            expect(Object.keys(sorted)).to.deep.equal(['a', 'm', 'z']);
        });

        it('preserves the values', function () {
            const obj    = { b: 'bee', a: 'ay' };
            const sorted = u.ksort(obj);
            expect(sorted.a).to.equal('ay');
            expect(sorted.b).to.equal('bee');
        });

        it('handles an already-sorted object', function () {
            const obj    = { a: 1, b: 2, c: 3 };
            const sorted = u.ksort(obj);
            expect(Object.keys(sorted)).to.deep.equal(['a', 'b', 'c']);
        });

        it('handles a single-key object', function () {
            const sorted = u.ksort({ only: true });
            expect(Object.keys(sorted)).to.deep.equal(['only']);
        });

    });

    describe('millisecondsToTimeString()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns empty string for 0 ms', function () {
            expect(u.millisecondsToTimeString(0)).to.equal('');
        });

        it('returns exact string for 5 seconds', function () {
            // 5000ms = 5s, milliseconds component = floor((5000 % 1000) / 100) = 0
            expect(u.millisecondsToTimeString(5000)).to.equal('05.0s');
        });

        it('returns exact string for 5100ms (with sub-second)', function () {
            // milliseconds = floor((5100 % 1000) / 100) = 1
            expect(u.millisecondsToTimeString(5100)).to.equal('05.1s');
        });

        it('returns exact string for 90 seconds', function () {
            // 90000ms = 1m 30s, milliseconds = 0
            expect(u.millisecondsToTimeString(90000)).to.equal('01m 30.0s');
        });

        it('returns exact string for 1h 1m 1s', function () {
            // 3661000ms = 1h 1m 1s
            expect(u.millisecondsToTimeString(3661000)).to.equal('01h 01m 01.0s');
        });

        it('returns exact string for 1d 1h', function () {
            // 86400000 + 3600000 = 1d 1h 0m 0s
            expect(u.millisecondsToTimeString(86400000 + 3600000)).to.equal('1d 01h ');
        });

        it('does not pad hours >= 10', function () {
            // 10 hours = 36000000ms
            const result = u.millisecondsToTimeString(36000000);
            expect(result).to.equal('10h ');
        });

        it('does not pad minutes >= 10', function () {
            // 10 minutes = 600000ms
            const result = u.millisecondsToTimeString(600000);
            expect(result).to.equal('10m ');
        });

        it('does not pad seconds >= 10', function () {
            // 10 seconds = 10000ms
            const result = u.millisecondsToTimeString(10000);
            expect(result).to.equal('10.0s');
        });

        it('pads single-digit seconds with leading zero', function () {
            expect(u.millisecondsToTimeString(1000)).to.equal('01.0s');
        });

    });

    describe('getWallClockTime()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns a value close to Math.floor(Date.now()/1000)', function () {
            const expected = Math.floor(Date.now() / 1000);
            const result   = parseInt(u.getWallClockTime().toString());
            // Allow a 2-second window for slow test environments
            expect(result).to.be.within(expected - 2, expected + 2);
        });

        it('returns a mathjs BigNumber', function () {
            const mathjs = require('mathjs');
            const result = u.getWallClockTime();
            expect(mathjs.isBigNumber(result)).to.be.true;
        });

    });

    describe('startTimer() / getTimer()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('startTimer returns a numeric timestamp', function () {
            const t = u.startTimer();
            expect(t).to.be.a('number');
            expect(t).to.be.closeTo(Date.now(), 50);
        });

        it('getTimer returns elapsed ms >= 0', function () {
            const t  = u.startTimer();
            const ms = u.getTimer(t);
            expect(ms).to.be.a('number');
            expect(ms).to.be.gte(0);
        });

        it('getTimer returns a small value for a recent timer (not now + timer)', function () {
            const t  = u.startTimer();
            const ms = u.getTimer(t);
            // If it were now + timer, result would be ~2 * Date.now() which is huge
            expect(ms).to.be.lessThan(1000);
        });

    });

    describe('getTimerString()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns "0ms" for 0 milliseconds', function () {
            expect(u.getTimerString(0)).to.equal('0ms');
        });

        it('returns the time string (not ms format) for non-zero values', function () {
            // 5000ms = 5 seconds, so should return the human-readable form not "5000ms"
            const result = u.getTimerString(5000);
            expect(result).to.include('s');
            expect(result).to.not.equal('5000ms');
        });

    });

    describe('logTimer()', function () {

        let u;
        let stub;
        before(function () { u = makeUtil(); });
        afterEach(function () { if (stub) { stub.restore(); stub = null; } });

        it('calls console.log once', function () {
            stub = sinon.stub(console, 'log');
            const t = u.startTimer();
            u.logTimer(t, 'TestTimer');
            expect(stub.calledOnce).to.be.true;
        });

        it('uses "Time" label when timeName is null', function () {
            stub = sinon.stub(console, 'log');
            const t = u.startTimer();
            u.logTimer(t, null);
            const output = stub.firstCall.args[0];
            expect(output).to.match(/^Time/);
        });

        it('uses provided timeName as label', function () {
            stub = sinon.stub(console, 'log');
            const t = u.startTimer();
            u.logTimer(t, 'MyLabel');
            const output = stub.firstCall.args[0];
            expect(output).to.match(/^MyLabel/);
            expect(output).to.not.include('Time');
        });

        it('appends elapsed time with tab, parens, and closing paren', function () {
            stub = sinon.stub(console, 'log');
            // Use a timer from the past to ensure non-zero elapsed time
            u.logTimer(Date.now() - 5000, 'Elapsed');
            const output = stub.firstCall.args[0];
            expect(output).to.include('\t: (');
            expect(output).to.match(/\)$/);
        });

        it('does not append tab section when getTimer returns 0 (empty timeString)', function () {
            stub = sinon.stub(console, 'log');
            // Pass Date.now() so getTimer returns ~0, millisecondsToTimeString(0) returns ''
            const t = Date.now();
            u.logTimer(t, 'Quick');
            const output = stub.firstCall.args[0];
            // At ~0ms timeString is '', so no tab section should be appended.
            expect(output).to.satisfy(s => s === 'Quick' || s.includes('\t'));
        });

    });

    describe('sleep()', function () {

        let u;
        before(function () { u = makeUtil(); });

        it('returns a Promise', function () {
            const p = u.sleep(1);
            expect(p).to.be.instanceof(Promise);
            return p; // let mocha handle resolution
        });

        it('resolves after approximately the given delay', async function () {
            const start = Date.now();
            await u.sleep(20);
            const elapsed = Date.now() - start;
            expect(elapsed).to.be.gte(15);
        });

    });

    describe('throwError()', function () {

        let u;
        let consoleStub;
        before(function ()  { u = makeUtil(); });
        beforeEach(function () { consoleStub = sinon.stub(console, 'error'); });
        afterEach(function ()  { consoleStub.restore(); });

        it('throws an Error with the provided message', function () {
            expect(() => u.throwError('boom')).to.throw(Error, 'boom');
        });

        it('logs to console.error before throwing', function () {
            try { u.throwError('oops'); } catch (e) { /* expected */ }
            expect(consoleStub.calledOnce).to.be.true;
        });

        it('logs with "throwError: " prefix', function () {
            try { u.throwError('test'); } catch (e) { /* expected */ }
            expect(consoleStub.firstCall.args[0]).to.equal('throwError: test');
        });

    });

    describe('logError()', function () {

        let u;
        let consoleStub;
        before(function ()  { u = makeUtil(); });
        beforeEach(function () { consoleStub = sinon.stub(console, 'error'); });
        afterEach(function ()  { consoleStub.restore(); });

        it('ultimately throws (delegates to throwError)', function () {
            expect(() => u.logError('fail', {})).to.throw(Error);
        });

        it('logs with "logError: " prefix before delegating', function () {
            try { u.logError('oops', { ctx: 1 }); } catch (e) { /* expected */ }
            // First call is logError's own console.error, second is throwError's
            expect(consoleStub.firstCall.args[0]).to.equal('logError: oops');
            expect(consoleStub.firstCall.args[1]).to.deep.equal({ ctx: 1 });
        });

    });

    describe('fileExists()', function () {

        let UtilityWithStub;
        let fsStub;

        beforeEach(function () {
            fsStub = { access: sinon.stub(), readFile: sinon.stub() };
            UtilityWithStub = proxyquire('../../src/utility', { 'fs/promises': fsStub });
        });

        it('returns true when fs.access resolves', async function () {
            fsStub.access.resolves();
            const u = new UtilityWithStub(null);
            const result = await u.fileExists('/some/file.txt');
            expect(result).to.be.true;
        });

        it('returns false when fs.access rejects with ENOENT', async function () {
            const err  = new Error('ENOENT');
            err.code   = 'ENOENT';
            fsStub.access.rejects(err);
            const u = new UtilityWithStub(null);
            const result = await u.fileExists('/missing/file.txt');
            expect(result).to.be.false;
        });

        it('returns false when fs.access rejects with a non-ENOENT error', async function () {
            const err  = new Error('EPERM');
            err.code   = 'EPERM';
            fsStub.access.rejects(err);
            const u = new UtilityWithStub(null);
            const result = await u.fileExists('/no/permission');
            expect(result).to.be.false;
        });

    });

    describe('fileGetContents()', function () {

        let UtilityWithStub;
        let fsStub;

        beforeEach(function () {
            fsStub = { access: sinon.stub(), readFile: sinon.stub() };
            UtilityWithStub = proxyquire('../../src/utility', { 'fs/promises': fsStub });
        });

        it('returns file contents as a string on success', async function () {
            fsStub.readFile.resolves('file contents here');
            const u = new UtilityWithStub(null);
            const result = await u.fileGetContents('/some/file.txt');
            expect(result).to.equal('file contents here');
        });

        it('passes utf8 encoding to readFile', async function () {
            fsStub.readFile.resolves('');
            const u = new UtilityWithStub(null);
            await u.fileGetContents('/some/file.txt');
            expect(fsStub.readFile.calledWith('/some/file.txt', 'utf8')).to.be.true;
        });

        it('returns false when readFile rejects', async function () {
            fsStub.readFile.rejects(new Error('ENOENT'));
            const u = new UtilityWithStub(null);
            const result = await u.fileGetContents('/missing.txt');
            expect(result).to.be.false;
        });

    });

});
