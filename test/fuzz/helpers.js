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

// Iterative-loop fuzz helpers (NOT fast-check; not a dep in this monorepo)
// Random input generators + an ITERATIONS budget, mirroring the decoder fuzz
// harness idiom (crypto-seeded random values, loop, invariant assertions).

const crypto = require('crypto');

const ITERATIONS = parseInt(process.env.FUZZ_ITERATIONS, 10) || 2000;

function randInt(maxExclusive) {
  if (maxExclusive <= 0) return 0;
  return crypto.randomInt(maxExclusive);
}

function randDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += String(randInt(10));
  return s;
}

// A valid decimal string for mathjs.bignumber: optional '-', ≥1 integer digit,
// optional fractional part with ≥1 digit. Magnitude/precision vary widely so the
// fuzzer hits both tiny sub-1e-12 values and huge 20+ digit integers.
function randDecimalString() {
  const sign = randInt(2) ? '-' : '';
  const intLen = 1 + randInt(22);          // 1..22 integer digits
  let intPart = randDigits(intLen);
  // avoid a pure "-0" style sign with all-zero magnitude collapsing oddly: fine
  let s = sign + intPart;
  if (randInt(2)) {
    const fracLen = 1 + randInt(18);       // 1..18 fractional digits
    s += '.' + randDigits(fracLen);
  }
  return s;
}

// A tiny positive value below mathjs's ~1e-12 comparison epsilon, used to guard
// the bcgt/bclt fix (decimal.js-native compare, not mathjs.larger's epsilon).
function randTinyPositive() {
  const zeros = randInt(16);               // 0..15 leading fractional zeros
  return '0.' + '0'.repeat(zeros) + (1 + randInt(9)) + randDigits(randInt(6));
}

// A random string biased toward SQL LIKE metacharacters + control/unicode bytes,
// for escapeLike fuzzing.
function randLikeString() {
  const mode = randInt(4);
  if (mode === 0) {
    // raw random bytes → latin1 string (includes control chars, high bytes)
    return crypto.randomBytes(randInt(64)).toString('latin1');
  }
  const alphabet = ['%', '_', '\\', 'a', 'Z', '0', '9', ' ', "'", '"', ';', '\n', '\t', 'é', '中', '\u{1f600}'];
  let s = '';
  const len = randInt(40);
  for (let i = 0; i < len; i++) s += alphabet[randInt(alphabet.length)];
  return s;
}

// A random JSON-able object that may contain BigInt and mathjs-BigNumber-shaped
// values, for jsonStringify fuzzing (never circular).
function randJsonableValue(depth) {
  const pick = randInt(depth > 2 ? 6 : 9);
  switch (pick) {
    case 0: return null;
    case 1: return randInt(2) === 0;
    case 2: return randInt(1e6) - 5e5;
    case 3: return randLikeString();
    case 4: return BigInt(randInt(1e9)) * BigInt(randInt(1e9));
    case 5: return { mathjs: 'BigNumber', value: randDecimalString() }; // BigNumber-shaped
    case 6: {
      const arr = [];
      const n = randInt(5);
      for (let i = 0; i < n; i++) arr.push(randJsonableValue(depth + 1));
      return arr;
    }
    default: {
      const obj = {};
      const n = randInt(5);
      for (let i = 0; i < n; i++) obj['k' + i] = randJsonableValue(depth + 1);
      return obj;
    }
  }
}

module.exports = {
  ITERATIONS,
  randInt,
  randDigits,
  randDecimalString,
  randTinyPositive,
  randLikeString,
  randJsonableValue,
};
