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
 *
 * Declared-path keys of tools/theme-parity/parity-probe.js.
 *
 * State rules and layout-derived properties store the DECLARED text of a rule,
 * keyed by selector and property. A theme restating a base selector, or one rule
 * repeated inside an @media group, collides on that key, and a probe that kept
 * only the last declaration walked could not see an edit to any earlier one.
 * Grid track templates are layout-derived too: their computed readback is the
 * used track list in pixels, which moves with the viewport and the cell content.
 * The sheets are stubs because the walk is under test, as in the behavioural
 * probe suite.
 *
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PROBE_FILE = path.join(__dirname, '..', '..', '..', '..', 'tools/theme-parity/parity-probe.js');
const PROBE_SRC = fs.readFileSync(PROBE_FILE, 'utf8');
const BASE = 'http://localhost:18080/css/xchain.css';
const THEME = 'http://localhost:18080/themes/console/components/nav/component.css';
const MODE_CSS = `
  [data-bs-theme="light"] { background-color: rgb(255, 255, 255); }
  [data-bs-theme="dark"]  { background-color: rgb(0, 0, 0); }
`;
const TAG = 'coin_home';

function rule(selectorText, props, children = []) {
  const names = Object.keys(props);
  const style = { length: names.length, getPropertyValue: (p) => (p in props ? props[p] : '') };
  names.forEach((n, i) => { style[i] = n; });
  return { selectorText, style, cssRules: children };
}

// A grouping rule such as an @media block: no selector, children only.
const group = (...children) => rule('', {}, children);
const sheet = (href, rules) => ({ href, cssRules: rules });

// Capture one page over the given stub sheets. usedValues stands in for what a
// browser's getComputedStyle reports for a property it resolves by layout.
function capture(sheets, { markup = '<footer class="footer"><a href="#">x</a></footer>', usedValues = {} } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html data-bs-theme="light"><head><style>${MODE_CSS}</style></head>` +
    `<body data-bs-theme="dark">${markup}</body></html>`,
    { url: 'http://localhost:18080/RDOGE', runScripts: 'outside-only' },
  );
  const win = dom.window;
  Object.defineProperty(win.document, 'styleSheets', { get() { return sheets; }, configurable: true });
  win.Element.prototype.computedStyleMap = function computedStyleMap() {
    const cs = win.getComputedStyle(this);
    return { get: (p) => cs.getPropertyValue(p) };
  };
  const nativeComputed = win.getComputedStyle.bind(win);
  win.getComputedStyle = (el, pe) => {
    const cs = nativeComputed(el, pe);
    return { getPropertyValue: (p) => (p in usedValues ? usedValues[p] : cs.getPropertyValue(p)) };
  };
  vm.runInContext(PROBE_SRC, dom.getInternalVMContext(), { filename: PROBE_FILE });
  const res = win.__XC(TAG, 'before');
  assert.ok(!res.invalid, `capture rejected: ${JSON.stringify(res.invalid)}`);
  return { res, snap: JSON.parse(win.localStorage[`__xc:before:${TAG}|light|rule`]) };
}

describe('theme parity probe declared-path keys', () => {
  const footerSheets = (first, second) => [
    sheet(THEME, [group(rule('.footer', { width: first }))]),
    sheet(BASE, [rule('.footer', { width: second })]),
  ];

  it('keeps both declarations of a layout key two sheets restate, in walk order', () => {
    const { snap } = capture(footerSheets('100%', 'var(--xc-footer-width, 80%)'));
    assert.equal(snap['.footer | width'], '100% || 80%');
  });

  it('moves the rule hash when only the first declaration changes', () => {
    const a = capture(footerSheets('100%', '80%')).res;
    const b = capture(footerSheets('90%', '80%')).res;
    assert.notEqual(a.light.rule.hash, b.light.rule.hash);
    assert.notEqual(a.dark.rule.hash, b.dark.rule.hash);
  });

  it('moves the rule hash when only the last declaration changes', () => {
    const a = capture(footerSheets('100%', '80%')).res;
    const b = capture(footerSheets('100%', '70%')).res;
    assert.notEqual(a.light.rule.hash, b.light.rule.hash);
  });

  it('keeps every declaration of a state rule restated in a second sheet', () => {
    const sheets = (first) => [
      sheet(THEME, [rule('.footer a:hover', { color: first })]),
      sheet(BASE, [rule('.footer a:hover', { color: 'rgb(1, 2, 3)' })]),
    ];
    const a = capture(sheets('red'));
    assert.equal(a.snap['.footer a:hover | color'], 'red || rgb(1, 2, 3)');
    assert.notEqual(a.res.light.rule.hash, capture(sheets('blue')).res.light.rule.hash);
  });

  it('keeps a single value for a computed-path key two sheets restate', () => {
    const { snap } = capture([
      sheet(THEME, [rule('.footer', { color: 'red' })]),
      sheet(BASE, [rule('.footer', { color: 'blue' })]),
    ]);
    assert.ok(!snap['.footer | color'].includes(' || '), snap['.footer | color']);
  });

  it('is unchanged for a page whose declared-path keys do not collide', () => {
    const { snap } = capture([sheet(BASE, [rule('.footer', { width: '80%' })])]);
    assert.equal(snap['.footer | width'], '80%');
  });
});

describe('theme parity probe grid track templates', () => {
  const GRID = '<div class="xc-console-stats"></div>';
  const USED = { 'grid-template-columns': '312px 312px 312px 312px' };
  const gridSheets = (cols) => [sheet(BASE, [rule('.xc-console-stats', { 'grid-template-columns': cols })])];

  it('records the declared template, not the used track list', () => {
    const { snap } = capture(gridSheets('repeat(4, minmax(0, 1fr))'), { markup: GRID, usedValues: USED });
    assert.equal(snap['.xc-console-stats | grid-template-columns'], 'repeat(4, minmax(0, 1fr))');
  });

  it('keeps the hash across used-track drift and moves it on a declared change', () => {
    const decl = 'repeat(4, minmax(0, 1fr))';
    const a = capture(gridSheets(decl), { markup: GRID, usedValues: USED }).res;
    const drift = capture(gridSheets(decl), { markup: GRID, usedValues: { 'grid-template-columns': '301px 301px' } }).res;
    const edit = capture(gridSheets('repeat(3, minmax(0, 1fr))'), { markup: GRID, usedValues: USED }).res;
    assert.equal(a.light.rule.hash, drift.light.rule.hash);
    assert.notEqual(a.light.rule.hash, edit.light.rule.hash);
  });

  it('keeps the base template and its @media variant, so an edit to either moves the hash', () => {
    const sheets = (base) => [sheet(BASE, [
      rule('.xc-console-stats', { 'grid-template-columns': base }),
      group(rule('.xc-console-stats', { 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' })),
    ])];
    const a = capture(sheets('repeat(4, minmax(0, 1fr))'), { markup: GRID });
    assert.equal(a.snap['.xc-console-stats | grid-template-columns'],
      'repeat(4, minmax(0, 1fr)) || repeat(2, minmax(0, 1fr))');
    assert.notEqual(a.res.light.rule.hash,
      capture(sheets('repeat(5, minmax(0, 1fr))'), { markup: GRID }).res.light.rule.hash);
  });

  it('resolves custom properties in a column and a row template', () => {
    const markup = '<table class="table-stats"><tbody>'
      + '<tr style="--xc-label-min: 10rem; --xc-row-min: 3rem"><td>x</td></tr></tbody></table>';
    const { snap } = capture([sheet(THEME, [rule('.table-stats tr', {
      'grid-template-columns': 'minmax(var(--xc-label-min), 1fr) auto',
      'grid-template-rows': 'minmax(var(--xc-row-min), auto)',
    })])], { markup, usedValues: { 'grid-template-rows': '48px' } });
    assert.equal(snap['.table-stats tr | grid-template-columns'], 'minmax(10rem, 1fr) auto');
    assert.equal(snap['.table-stats tr | grid-template-rows'], 'minmax(3rem, auto)');
  });
});
