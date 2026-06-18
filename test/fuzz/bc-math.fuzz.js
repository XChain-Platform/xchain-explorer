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

// ─── Fuzz: Utility big-number math (mathjs bignumber) ─────────────────────────
//
// The explorer does ALL amount/fee/price math through Utility's bc* helpers, so
// an arithmetic or comparison regression silently corrupts balances and order
// books. The unit suite checks fixed examples; this hammers the same helpers
// with thousands of random-magnitude decimals and asserts algebraic INVARIANTS
// that must hold for every input: commutativity, self-cancellation, comparison
// trichotomy, and the sub-1e-12 comparison fix (decimal.js-native .gt/.lt, not
// mathjs.larger's ~1e-12 epsilon, which once made bcgt('0.000000000000001','0')
// wrongly return false).

const { expect } = require('chai');
const Utility = require('../../src/utility');
const { ITERATIONS, randDecimalString, randTinyPositive } = require('./helpers');

const u = new Utility(null);

describe('Fuzz: Utility BC math', function () {
  this.timeout(60000);

  it(`addition & multiplication are commutative across ${ITERATIONS} random pairs`, function () {
    for (let i = 0; i < ITERATIONS; i++) {
      const a = randDecimalString();
      const b = randDecimalString();
      const d = i % 19; // vary the precision 0..18
      const addAB = u.bcadd(a, b, d).toString();
      const addBA = u.bcadd(b, a, d).toString();
      expect(addAB, `bcadd not commutative for a=${a} b=${b} d=${d}`).to.equal(addBA);

      const mulAB = u.bcmul(a, b, d).toString();
      const mulBA = u.bcmul(b, a, d).toString();
      expect(mulAB, `bcmul not commutative for a=${a} b=${b} d=${d}`).to.equal(mulBA);
    }
  });

  it(`subtraction self-cancels and add/sub round-trips across ${ITERATIONS} values`, function () {
    for (let i = 0; i < ITERATIONS; i++) {
      const a = randDecimalString();
      const b = randDecimalString();

      // a - a === 0 exactly, at any precision.
      expect(u.bcsub(a, a, 18).toString(), `bcsub self-cancel failed for a=${a}`).to.equal('0');

      // (a + b) - b === a, exact at precision 30 (inputs have ≤18 fractional digits).
      const sum = u.bcadd(a, b, 30).toString();
      const back = u.bcsub(sum, b, 30).toString();
      expect(back, `add/sub round-trip failed for a=${a} b=${b}`).to.equal(u.bcnum(a).toString());
    }
  });

  it(`comparison helpers obey trichotomy + reflexivity across ${ITERATIONS} pairs`, function () {
    for (let i = 0; i < ITERATIONS; i++) {
      const a = randDecimalString();
      const b = randDecimalString();
      const gt = u.bcgt(a, b);
      const lt = u.bclt(a, b);
      const gte = u.bcgte(a, b);
      const lte = u.bclte(a, b);

      // Never both strictly greater and strictly less.
      expect(gt && lt, `bcgt & bclt both true for a=${a} b=${b}`).to.equal(false);
      // a >= b  iff  not (a < b)   and   a <= b  iff  not (a > b)
      expect(gte, `bcgte != !bclt for a=${a} b=${b}`).to.equal(!lt);
      expect(lte, `bclte != !bcgt for a=${a} b=${b}`).to.equal(!gt);
      // Mirror symmetry: a > b  iff  b < a.
      expect(gt, `bcgt(a,b) != bclt(b,a) for a=${a} b=${b}`).to.equal(u.bclt(b, a));

      // Reflexivity.
      expect(u.bcgt(a, a), `bcgt reflexive a=${a}`).to.equal(false);
      expect(u.bcgte(a, a), `bcgte reflexive a=${a}`).to.equal(true);
      expect(u.bclte(a, a), `bclte reflexive a=${a}`).to.equal(true);
    }
  });

  it(`sub-1e-12 values compare exactly (epsilon-bug guard) across ${ITERATIONS} values`, function () {
    // Explicit anchor for the documented regression.
    expect(u.bcgt('0.000000000000001', '0')).to.equal(true);
    expect(u.bclt('0', '0.000000000000001')).to.equal(true);

    for (let i = 0; i < ITERATIONS; i++) {
      const t = randTinyPositive(); // a tiny POSITIVE value, often below ~1e-12
      expect(u.bcgt(t, '0'), `tiny ${t} not > 0`).to.equal(true);
      expect(u.bclt('0', t), `0 not < tiny ${t}`).to.equal(true);
      expect(u.bcgt('0', t), `0 wrongly > tiny ${t}`).to.equal(false);
      expect(u.bcgte(t, t), `tiny ${t} not >= itself`).to.equal(true);
    }
  });

  it(`bcformat always yields a well-formed fixed-decimal string across ${ITERATIONS} values`, function () {
    for (let i = 0; i < ITERATIONS; i++) {
      const a = randDecimalString();
      const d = i % 19;
      const out = u.bcformat(a, d);
      expect(out, `bcformat returned non-string for a=${a} d=${d}`).to.be.a('string');
      expect(out, `bcformat produced a non-numeric string "${out}" for a=${a} d=${d}`)
        .to.match(/^-?[0-9]+(\.[0-9]+)?$/);
    }
  });
});
