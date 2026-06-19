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

// Fuzz: Utility input sanitization / serialization
//
// escapeLike feeds straight into MariaDB LIKE patterns, sanitizeInt guards
// query offsets/limits, and jsonStringify renders every API response. All sit
// directly on the untrusted-input path. These fuzz the helpers with thousands of
// hostile/random inputs (SQL metacharacters, control bytes, unicode, BigInt /
// BigNumber values) and assert their safety invariants hold for EVERY input.

const { expect } = require('chai');
const Utility = require('../../src/utility');
const {
  ITERATIONS,
  randInt,
  randLikeString,
  randJsonableValue,
} = require('./helpers');

const u = new Utility(null);

describe('Fuzz: Utility input sanitization', function () {
  this.timeout(60000);

  it(`escapeLike leaves no unescaped % or _ wildcard across ${ITERATIONS} hostile strings`, function () {
    // Explicit anchors.
    expect(u.escapeLike('100%_off')).to.equal('100\\%\\_off');
    expect(u.escapeLike('a\\b')).to.equal('a\\\\b');

    for (let i = 0; i < ITERATIONS; i++) {
      const s = randLikeString();
      const escaped = u.escapeLike(s);
      expect(escaped, `escapeLike returned non-string for ${JSON.stringify(s)}`).to.be.a('string');

      // Remove every backslash-escaped pair; nothing that could act as a LIKE
      // wildcard (% or _) may remain.
      const stripped = escaped.replace(/\\[\s\S]/g, '');
      expect(stripped.includes('%'), `unescaped % survives for ${JSON.stringify(s)} -> ${escaped}`).to.equal(false);
      expect(stripped.includes('_'), `unescaped _ survives for ${JSON.stringify(s)} -> ${escaped}`).to.equal(false);
    }
  });

  it(`sanitizeInt always returns a finite integer across ${ITERATIONS} garbage inputs`, function () {
    // The realistic untrusted domain: anything that can arrive via an HTTP query
    // string (always strings) or a JSON body (string/number/boolean/null/array/
    // object). Symbols and functions cannot cross either boundary, so they are
    // out of scope (parseInt(Symbol) would throw, a non-reachable edge).
    const garbage = [
      undefined, null, '', NaN, Infinity, -Infinity, {}, [], [1, 2], { a: 1 },
      'abc', '12abc', '  7  ', '0x1F', '1e500', '٤٢', '\n5', true, false,
      '99999999999999999999999999', '-0', '+-3', '.',
    ];
    for (let i = 0; i < ITERATIONS; i++) {
      // Mix curated garbage with random strings/numbers.
      const v = (i % 3 === 0)
        ? garbage[randInt(garbage.length)]
        : (randInt(2) ? randLikeString() : (randInt(1e9) - 5e8) / (randInt(7) + 1));
      let out;
      try {
        out = u.sanitizeInt(v, 0);
      } catch (e) {
        throw new Error(`sanitizeInt threw on ${String(v)}: ${e.message}`);
      }
      expect(Number.isInteger(out), `sanitizeInt(${String(v)}) = ${out} is not an integer`).to.equal(true);
      expect(Number.isFinite(out), `sanitizeInt(${String(v)}) = ${out} is not finite`).to.equal(true);
    }
  });

  it(`jsonStringify never throws and always emits parseable JSON across ${ITERATIONS} objects`, function () {
    for (let i = 0; i < ITERATIONS; i++) {
      const obj = randJsonableValue(0);
      let json;
      try {
        json = u.jsonStringify(obj);
      } catch (e) {
        throw new Error(`jsonStringify threw on a BigInt/BigNumber-bearing value: ${e.message}`);
      }
      expect(json, 'jsonStringify returned non-string').to.be.a('string');
      expect(() => JSON.parse(json), `jsonStringify produced invalid JSON: ${json.slice(0, 120)}`).to.not.throw();
    }
  });

  it(`jsonStringify unwraps BigInt and BigNumber to their value across ${ITERATIONS} values`, function () {
    for (let i = 0; i < ITERATIONS; i++) {
      // A BigNumber-shaped node must serialize to its .value string, not the
      // wrapper object (guards the replacer's `value.mathjs === 'BigNumber'` branch).
      const dec = (randInt(2) ? '-' : '') + randInt(1e9) + '.' + randInt(1e8);
      const bn = { mathjs: 'BigNumber', value: dec };
      expect(JSON.parse(u.jsonStringify(bn)), `BigNumber not unwrapped for ${dec}`).to.equal(dec);
      expect(JSON.parse(u.jsonStringify({ amount: bn })).amount).to.equal(dec);

      // A BigInt must serialize to its decimal string form (guards the bigint branch).
      const big = BigInt(randInt(1e9)) * 1000000000n + BigInt(randInt(1e9));
      expect(JSON.parse(u.jsonStringify(big)), `BigInt not stringified for ${big}`).to.equal(big.toString());
    }
  });

  it(`isInteger and isFloat are mutually exclusive for every finite number (${ITERATIONS})`, function () {
    for (let i = 0; i < ITERATIONS; i++) {
      // A spread of finite numbers: small ints, large ints (past 32-bit), floats,
      // negatives, zero, -0.
      const kinds = [
        randInt(256) - 128,
        (randInt(1e6) - 5e5) / (randInt(99) + 1),
        2 ** (randInt(50)) * (randInt(2) ? 1 : -1),
        randInt(2) ? 0 : -0,
      ];
      const n = kinds[randInt(kinds.length)];
      // For any finite number, exactly one of isInteger / isFloat holds.
      expect(u.isInteger(n), `isInteger/isFloat both ${u.isInteger(n)} for n=${n}`).to.equal(!u.isFloat(n));
      // A finite number is never "null" and is always numeric.
      expect(u.isNull(n), `isNull true for number ${n}`).to.equal(false);
      expect(u.isNumeric(n), `isNumeric false for finite number ${n}`).to.equal(true);
    }
  });
});
