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
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PROBE_FILE = path.resolve(__dirname, '..', '..', '..', '..', '..',
  'tools/theme-parity/parity-probe.js');
const PROBE_SRC = fs.readFileSync(PROBE_FILE, 'utf8');
const CHARTS = 'http://localhost:18080/css/xchain-charts.css';
const TOKENS = 'http://localhost:18080/themes/classic/tokens.css';
const MODE_CSS = `
  [data-bs-theme="light"] { --bs-primary-text-emphasis: #052c65; background-color: white; color: black; }
  [data-bs-theme="dark"] { --bs-primary-text-emphasis: #6ea8fe; background-color: black; color: white; }
`;

function declaration(props) {
  const names = Object.keys(props);
  const out = { length: names.length, getPropertyValue: (p) => props[p] || '' };
  names.forEach((name, index) => { out[index] = name; });
  return out;
}

const rule = (selectorText, props) => ({ selectorText, style: declaration(props), cssRules: [] });
const sheet = (href, rules) => ({ href, cssRules: rules });

function page(padding) {
  const markup = '<button class="btn" id="button-search">Search</button>'
    + '<button class="btn xc-chart-btn">Chart</button>';
  const css = MODE_CSS + `#button-search { padding-top: 6px; }
    .xc-chart-btn { padding-top: ${padding}; }`;
  const dom = new JSDOM(`<!doctype html><html><head><style>${css}</style></head>`
    + `<body data-bs-theme="light">${markup}</body></html>`, {
    url: 'http://localhost:18080/RDOGE', runScripts: 'outside-only',
  });
  const sheets = [
    sheet(CHARTS, [
      rule('body', { color: 'var(--xc-body-color)' }),
      rule('.xc-chart-btn', {
        '--bs-btn-padding-y': 'var(--xc-chart-btn-padding-y)',
        '--bs-btn-padding-x': 'var(--xc-chart-btn-padding-x)',
        '--bs-btn-font-size': 'var(--xc-chart-btn-font-size)',
      }),
    ]),
    sheet(TOKENS, [rule('[data-bs-theme="dark"]', { '--xc-body-color': '#fff' })]),
  ];
  Object.defineProperty(dom.window.document, 'styleSheets', { get: () => sheets });
  dom.window.Element.prototype.computedStyleMap = function computedStyleMap() {
    const cs = dom.window.getComputedStyle(this);
    return { get: (property) => cs.getPropertyValue(property) };
  };
  vm.runInContext(PROBE_SRC, dom.getInternalVMContext(), { filename: PROBE_FILE });
  return dom.window;
}

function capture(padding) {
  const win = page(padding);
  const result = win.__XC('coin_home', 'before');
  assert.ok(!result.invalid, JSON.stringify(result.invalid));
  const snap = JSON.parse(win.localStorage['__xc:before:coin_home|light|rule']);
  return { result, snap };
}

describe('theme parity probe custom-property-only rules', () => {
  it('covers chart bindings and snapshots the chart button rendered values', () => {
    const small = capture('2px');
    const large = capture('40px');
    const coverage = small.result.coverage.sheets['/css/xchain-charts.css'];
    assert.ok(coverage.selectors.includes('.xc-chart-btn'));
    assert.ok(coverage.matched.includes('.xc-chart-btn'));
    assert.equal(small.snap['.xc-chart-btn | ~padding-top'], '2px');
    assert.equal(large.snap['.xc-chart-btn | ~padding-top'], '40px');
    assert.notEqual(small.result.light.rule.hash, large.result.light.rule.hash);
    assert.notEqual(small.result.dark.rule.hash, large.result.dark.rule.hash);
    assert.equal(small.result.light.rule.keys, small.result.dark.rule.keys);
  });

  it('covers theme token rules without adding rendered snapshot keys', () => {
    const { result, snap } = capture('2px');
    const coverage = result.coverage.sheets['/themes/classic/tokens.css'];
    assert.ok(coverage.selectors.includes('[data-bs-theme="dark"]'));
    assert.ok(coverage.matched.includes('[data-bs-theme="dark"]'));
    assert.ok(!Object.keys(snap).some((key) => key.startsWith('[data-bs-theme="dark"] | ~')));
  });
});
