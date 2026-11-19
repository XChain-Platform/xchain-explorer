// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseDeclarations } = require('./theme_token_literal_gate.test/support/declarations.js');
const { classifyViolation } = require('./theme_token_literal_gate.test/support/classifier.js');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function declaration(relative, selector, property) {
  const file = path.join(ROOT, relative);
  const found = parseDeclarations(fs.readFileSync(file, 'utf8'), relative)
    .find((d) => d.selector === selector && d.property === property);
  assert.ok(found, `${relative} has ${selector} ${property}`);
  return found;
}

describe('theme token-literal gate logical and Bootstrap spacing', () => {
  const direct = (property, value, file = 'xchain.css') => ({
    file, selector: '.xc-fixture', property, value, line: 1,
  });

  it('classifies logical spacing and narrow Bootstrap sizing properties', () => {
    for (const [property, value, file] of [
      ['padding-inline', '12px'], ['margin-block', '12px'], ['row-gap', '4px'],
      ['--bs-btn-padding-y', '12px', 'xchain-charts.css'],
      ['--bs-btn-font-size', '24px', 'xchain-charts.css'],
    ]) assert.equal(classifyViolation(direct(property, value, file)), 'spacing', property);
  });

  it('keeps full-bleed logical size, token references, and unrelated Bootstrap values clean', () => {
    assert.equal(classifyViolation(direct('inline-size', '100%')), null);
    assert.equal(classifyViolation(direct('--bs-btn-padding-y',
      'var(--xc-chart-btn-padding-y)', 'xchain-charts.css')), null);
    assert.equal(classifyViolation(direct('--bs-body-bg-rgb', '1,2,3')), null);
  });

  it('flags literal replacements of the five live token references', () => {
    const fixtures = [
      ['src/content/css/xchain-charts.css', '.xc-chart-btn', '--bs-btn-padding-y', '12px'],
      ['src/content/css/xchain-charts.css', '.xc-chart-btn', '--bs-btn-padding-x', '12px'],
      ['src/content/css/xchain-charts.css', '.xc-chart-btn', '--bs-btn-font-size', '24px'],
      ['src/content/themes/console/tokens.css', '.xc-console-stats', 'padding-inline', '12px'],
      ['src/content/themes/console/components/nav/component.css',
        'body > nav.navbar form', 'margin-block', '12px'],
    ];
    for (const [file, selector, property, literal] of fixtures) {
      const live = declaration(file, selector, property);
      assert.equal(classifyViolation(live), null, `${file} starts tokenized`);
      assert.equal(classifyViolation({ ...live, value: literal }), 'spacing', `${file} ${property}`);
    }
  });
});
