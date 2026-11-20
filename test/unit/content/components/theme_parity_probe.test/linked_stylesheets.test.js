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
const CSS = 'http://localhost:18080/css/xchain.css';
const TOKENS = 'http://localhost:18080/themes/classic/tokens.css';

function declaration(props) {
  const names = Object.keys(props);
  const out = { length: names.length, getPropertyValue: (name) => props[name] || '' };
  names.forEach((name, index) => { out[index] = name; });
  return out;
}

const rule = (selectorText, props) => ({ selectorText, style: declaration(props), cssRules: [] });
const sheet = (href, rules) => ({ href, cssRules: rules });

function capture({ links, sheets }) {
  const modeCss = '[data-bs-theme="light"] { --bs-primary-text-emphasis: #052c65; } '
    + '[data-bs-theme="dark"] { --bs-primary-text-emphasis: #6ea8fe; }';
  const dom = new JSDOM(`<!doctype html><html><head><style>${modeCss}</style></head>`
    + '<body data-bs-theme="light"></body></html>', {
    url: 'http://localhost:18080/RDOGE', runScripts: 'outside-only',
  });
  for (const entry of links) {
    const link = dom.window.document.createElement('link');
    link.rel = entry.rel || 'stylesheet';
    link.href = entry.href;
    link.disabled = Boolean(entry.disabled);
    Object.defineProperty(link, 'sheet', { get: () => entry.sheet });
    dom.window.document.head.appendChild(link);
  }
  Object.defineProperty(dom.window.document, 'styleSheets', { get: () => sheets });
  dom.window.Element.prototype.computedStyleMap = function computedStyleMap() {
    const cs = dom.window.getComputedStyle(this);
    return { get: (property) => cs.getPropertyValue(property) };
  };
  vm.runInContext(PROBE_SRC, dom.getInternalVMContext(), { filename: PROBE_FILE });
  const result = dom.window.__XC('coin_home', 'before');
  return { result, keys: Object.keys(dom.window.localStorage).filter((key) => key.startsWith('__xc')) };
}

describe('theme parity probe linked stylesheet health', () => {
  const healthy = sheet(CSS, [rule('body', { color: 'red' })]);

  it('refuses missing, unlisted, and empty first-party linked stylesheets', () => {
    for (const failed of [null, sheet(TOKENS, [rule('body', { color: 'blue' })]), sheet(TOKENS, [])]) {
      const sheets = failed && failed.cssRules.length === 0 ? [healthy, failed] : [healthy];
      const page = capture({ links: [{ href: CSS, sheet: healthy }, { href: TOKENS, sheet: failed }], sheets });
      assert.ok(Array.isArray(page.result.invalid), 'a partial stylesheet load returned hashes');
      assert.match(page.result.invalid.join(' '), /themes\/classic\/tokens\.css/);
      assert.deepEqual(page.keys, []);
    }
  });

  it('accepts loaded links and ignores disabled, alternate, and vendor links', () => {
    const links = [
      { href: CSS, sheet: healthy },
      { href: TOKENS, sheet: null, disabled: true },
      { href: TOKENS, sheet: null, rel: 'alternate stylesheet' },
      { href: 'http://localhost:18080/css/bootstrap.min.css', sheet: null },
    ];
    const page = capture({ links, sheets: [healthy] });
    assert.equal(page.result.invalid, undefined);
    assert.ok(page.keys.length > 0);
  });
});
