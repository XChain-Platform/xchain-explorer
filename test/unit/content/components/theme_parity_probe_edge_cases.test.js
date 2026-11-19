/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const PROBE_FILE = path.join(ROOT, 'tools/theme-parity/parity-probe.js');
const PROBE_SRC = fs.readFileSync(PROBE_FILE, 'utf8');
const FIRST_PARTY = 'http://localhost:18080/css/xchain.css';
const MODE_CSS = `
  [data-bs-theme="light"] { --bs-primary-text-emphasis: #052c65; background-color: white; color: black; }
  [data-bs-theme="dark"] { --bs-primary-text-emphasis: #6ea8fe; background-color: black; color: white; }
`;

function declaration(names, values) {
  const style = { length: names.length, getPropertyValue: (name) => values[name] || '' };
  names.forEach((name, index) => { style[index] = name; });
  return style;
}

function stubRule(selectorText, names, values) {
  return { selectorText, style: declaration(names, values), cssRules: [] };
}

function makePage({ css = MODE_CSS, bodyMode = 'dark', rules, markup = '<div class="x"></div>', source } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html data-bs-theme="light"><head><style>${css}</style></head>`
      + `<body data-bs-theme="${bodyMode}">${markup}</body></html>`,
    { url: 'http://localhost:18080/RDOGE', runScripts: 'outside-only' },
  );
  const win = dom.window;
  const healthyRules = rules || [stubRule('body', ['background-color'], { 'background-color': 'red' })];
  Object.defineProperty(win.document, 'styleSheets', {
    get() { return [{ href: FIRST_PARTY, cssRules: healthyRules }]; }, configurable: true,
  });
  win.Element.prototype.computedStyleMap = function computedStyleMap() {
    const computed = win.getComputedStyle(this);
    return { get: (name) => computed.getPropertyValue(name) };
  };
  vm.runInContext(source || PROBE_SRC, dom.getInternalVMContext(), { filename: PROBE_FILE });
  return win;
}

function captureDeclared(names, values, token = '7px', selector = '.x') {
  const win = makePage({
    markup: `<div class="x" style="--xc-set: ${token}"></div>`,
    rules: [stubRule(selector, names, values)],
  });
  const res = win.__XC('edge', 'before');
  const stored = win.localStorage['__xc:before:edge|light|rule'];
  return { win, res, snap: stored ? JSON.parse(stored) : null };
}

function cssFiles(directory) {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...cssFiles(target));
    else if (entry.name.endsWith('.css')) out.push(target);
  }
  return out;
}

describe('theme parity probe mode witness', () => {
  it('gets a custom property from a stylesheet through jsdom computed style', () => {
    const win = makePage();
    assert.equal(win.getComputedStyle(win.document.body)
      .getPropertyValue('--bs-primary-text-emphasis').trim(), '#6ea8fe');
  });

  it('accepts a theme whose rendered surfaces are intentionally mode-flat', () => {
    const flat = MODE_CSS + `
      body[data-bs-theme="light"], body[data-bs-theme="dark"] {
        background-color: rgb(12, 19, 25); color: rgb(217, 231, 229);
      }
    `;
    const win = makePage({ css: flat });
    const res = win.__XC('flat', 'before');
    assert.ok(!res.invalid, JSON.stringify(res.invalid));
    assert.equal(res.light.rendered, res.dark.rendered);
    assert.ok(win.localStorage['__xcResult:before:flat']);
  });

  for (const bodyMode of ['light', 'dark']) {
    it(`rejects a switch applied to the wrong element from ${bodyMode}`, () => {
      const needle = "document.body.setAttribute('data-bs-theme', mode);";
      const source = PROBE_SRC.replace(needle,
        "document.documentElement.setAttribute('data-bs-theme', mode);");
      assert.notEqual(source, PROBE_SRC, 'probe mutation did not apply');
      const win = makePage({ bodyMode, source });
      const res = win.__XC('wrong', 'before');
      assert.match(res.invalid.join(' '), /switch/i);
      assert.equal(Object.keys(win.localStorage).length, 0);
    });
  }

  it('keeps the witness variable owned by the vendor stylesheet', () => {
    const files = [
      ...cssFiles(path.join(ROOT, 'src/content/themes')),
      ...cssFiles(path.join(ROOT, 'src/content/components')),
      path.join(ROOT, 'src/content/css/xchain.css'),
      path.join(ROOT, 'src/content/css/xchain-charts.css'),
    ];
    const declarations = files.filter((file) =>
      /--bs-primary-text-emphasis\s*:/.test(fs.readFileSync(file, 'utf8')));
    assert.deepEqual(declarations, []);
  });
});

describe('theme parity probe shorthand recovery', () => {
  it('records a resolved margin shorthand and moves its rule hash', () => {
    const values = { 'margin-top': '', margin: 'var(--xc-set) auto' };
    const first = captureDeclared(['margin-top'], values, '7px');
    const second = captureDeclared(['margin-top'], values, '9px');
    assert.equal(first.snap['.x | margin-top'], 'margin: 7px auto');
    assert.notEqual(first.res.light.rule.hash, second.res.light.rule.hash);
  });

  it('records a resolved state-rule background shorthand', () => {
    const values = { 'background-color': '', background: 'var(--xc-set)' };
    const first = captureDeclared(['background-color'], values, 'red', '.x:hover');
    const second = captureDeclared(['background-color'], values, 'blue', '.x:hover');
    assert.equal(first.snap['.x:hover | background-color'], 'background: red');
    assert.notEqual(first.res.light.rule.hash, second.res.light.rule.hash);
  });

  it('refuses an empty declared read with no owning shorthand', () => {
    const { win, res } = captureDeclared(['margin-top'], { 'margin-top': '' });
    assert.match(res.invalid.join(' '), /declared-path keys read empty/);
    assert.equal(Object.keys(win.localStorage).length, 0);
  });
});
