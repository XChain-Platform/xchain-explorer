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
            const data = makeStablePriceRows([[2, 'a'], [2, 'b'], [1, 'c']]);
            u.priceSort(data);
            // Equal price items should remain in original relative order
            expect(data[0].id).to.equal('c');
            expect(data[1].id).to.equal('a');
            expect(data[2].id).to.equal('b');
        });

        it('is stable for equal prices in DESC', function () {
            const data = makeStablePriceRows([[1, 'a'], [2, 'b'], [2, 'c']]);
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
});

describe("Utility", function () {
    describe('jsonStringify()', function () {
        let u;
        before(function () { u = makeUtil(); });
        it('serializes a plain object normally', function () {
            const obj = { a: 1, b: 'hello' };
            expect(u.jsonStringify(obj)).to.equal(JSON.stringify(obj));
        });

        it('converts BigInt values to strings', function () {
            const result = stringifyBigInt(u);
            expect(result.amount).to.equal('9007199254740993');
        });

        it('converts a mathjs BigNumber to its value string', function () {
            const result = stringifyBigNumber(u);
            expect(result.price).to.equal('123456789.987654321');
        });

        it('handles null values without throwing', function () {
            expect(u.jsonStringify({ x: null })).to.equal('{"x":null}');
        });

        it('does not convert non-object values even if they have mathjs property', function () {
            // Strings, numbers, booleans should pass through unchanged
            const result = stringifySimpleValues(u);
            expect(result.a).to.equal('text');
            expect(result.b).to.equal(42);
            expect(result.c).to.equal(true);
        });

        it('converts nested mathjs BigNumbers', function () {
            const result = stringifyNestedBigNumber(u);
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
});

describe("Utility", function () {
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
});

describe("Utility", function () {
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
});

describe("Utility", function () {
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
});
