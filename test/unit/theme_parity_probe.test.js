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
 * BEHAVIOURAL cover for tools/theme-parity/parity-probe.js.
 *
 * theme-token-literal-gate.test.js already proves the probe PARSES and still
 * exports __XC. That is a static contract and it cannot see what the probe
 * measures, which is where both of this file's regressions lived: the probe
 * flipped data-bs-theme on documentElement while updateTheme() writes it on
 * body, so on a page initialised in dark BOTH captures read dark surfaces; and
 * capture() fingerprinted whatever it found, so a run that matched no
 * stylesheet and no element still returned stable hashes that a before/after
 * comparison reads as a parity pass.
 *
 * The probe is pasted into a devtools console, never required, so it is loaded
 * here the same way: as source text, evaluated into a jsdom window. The render
 * census runs against jsdom's real cascade (which does resolve an attribute
 * selector on body), so the mode-flip assertions below fail against a probe
 * that marks the wrong element rather than passing vacuously. The rule layer
 * walks stub sheets, because the walk is what is under test and Chrome's
 * empty-.cssRules behaviour has no jsdom equivalent to reproduce.
 *
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PROBE_FILE = path.join(__dirname, '..', '..', 'tools/theme-parity/parity-probe.js');
const PROBE_SRC = fs.readFileSync(PROBE_FILE, 'utf8');

// An href the probe's SHEET pattern admits, and one it must skip.
const FIRST_PARTY = 'http://localhost:18080/css/xchain.css';
const VENDOR = 'http://localhost:18080/css/bootstrap.min.css';

// themes/classic/tokens.css declares the --xc-* surface tokens on whatever
// element carries data-bs-theme, and Bootstrap re-declares its own --bs-*
// surface variables the same way, so the element the attribute sits on is the
// element whose declarations win. This fixture reproduces exactly that much:
// two mode-dependent declarations that move only when the marked element does.
const MODE_CSS = `
  [data-bs-theme="light"] { background-color: rgb(255, 255, 255); color: rgb(17, 17, 17); }
  [data-bs-theme="dark"]  { background-color: rgb(0, 0, 0); color: rgb(238, 238, 238); }
`;

// A CSSStyleDeclaration is array-like over its declared property names, which
// is all `Array.from(r.style)` and `getPropertyValue` need from a stub.
function declaration(props) {
  const names = Object.keys(props);
  const decl = { length: names.length, getPropertyValue: (p) => (p in props ? props[p] : '') };
  names.forEach((n, i) => { decl[i] = n; });
  return decl;
}

function rule(selectorText, props, children = []) {
  return { selectorText, style: declaration(props), cssRules: children };
}

function sheet(href, rules) {
  return { href, cssRules: rules };
}

function unreadableSheet(href) {
  return { href, get cssRules() { throw new Error('SecurityError: cannot access rules'); } };
}

const HEALTHY_SHEETS = [sheet(FIRST_PARTY, [rule('body', { 'background-color': 'var(--xc-surface-body-bg)' })])];

// Builds a page, shadows document.styleSheets with the given stub list (jsdom's
// own cascade is untouched, so getComputedStyle still resolves MODE_CSS), and
// evaluates the probe into it.
function page({ bodyMode = 'dark', sheets = HEALTHY_SHEETS, markup = '<div class="card">c</div>' } = {}) {
  const bodyAttr = bodyMode === null ? '' : ` data-bs-theme="${bodyMode}"`;
  const dom = new JSDOM(
    `<!doctype html><html data-bs-theme="light"><head><style>${MODE_CSS}</style></head>` +
    `<body${bodyAttr}>${markup}</body></html>`,
    { url: 'http://localhost:18080/RDOGE', runScripts: 'outside-only' },
  );
  Object.defineProperty(dom.window.document, 'styleSheets', {
    get() { return sheets; }, configurable: true,
  });
  vm.runInContext(PROBE_SRC, dom.getInternalVMContext(), { filename: PROBE_FILE });
  return dom.window;
}

const xcKeys = (win) => Object.keys(win.localStorage).filter((k) => k.startsWith('__xc'));
const rendOf = (win, phase, tag, mode) =>
  JSON.parse(win.localStorage[`__xc:${phase}:${tag}|${mode}|rend`]);

describe('theme parity probe (behavioural)', () => {
  describe('the mode switch reaches the element the application marks', () => {
    it('renders the two captures differently on a page initialised in dark', () => {
      const win = page({ bodyMode: 'dark' });
      const res = win.__XC('coin_home', 'before');

      assert.ok(!res.invalid, `capture rejected a healthy page: ${JSON.stringify(res.invalid)}`);
      // The regression: with the attribute flipped on documentElement, body
      // keeps its own dark declaration for both iterations and these two are
      // the same colour, so the light/dark comparison compares dark to dark.
      const light = rendOf(win, 'before', 'coin_home', 'light');
      const dark = rendOf(win, 'before', 'coin_home', 'dark');
      assert.equal(light['body | background-color'], 'rgb(255, 255, 255)');
      assert.equal(dark['body | background-color'], 'rgb(0, 0, 0)');
      assert.notEqual(res.light.rend.hash, res.dark.rend.hash);
    });

    it('renders the same pair whichever mode the page arrived in', () => {
      const fromDark = page({ bodyMode: 'dark' }).__XC('coin_home', 'before');
      const fromLight = page({ bodyMode: 'light' }).__XC('coin_home', 'before');

      // The acceptance property: the recorded evidence is a fact about the
      // page, not about the mode the operator happened to leave it in.
      assert.equal(fromLight.light.rend.hash, fromDark.light.rend.hash);
      assert.equal(fromLight.dark.rend.hash, fromDark.dark.rend.hash);
    });

    it('rejects a capture whose two modes rendered identically', () => {
      // No mode-dependent declaration reaches this page, so nothing the probe
      // does can make the two captures differ. That is the shape a wrong-element
      // flip produces, and it must not be recorded as evidence.
      const win = page({ bodyMode: 'dark' });
      win.document.querySelector('style').textContent = '';
      const res = win.__XC('coin_home', 'before');

      assert.ok(Array.isArray(res.invalid), 'an unflipped capture returned hashes');
      assert.match(res.invalid.join(' '), /switch/i);
      assert.deepEqual(xcKeys(win), []);
    });

    it('leaves documentElement alone and restores the body attribute it found', () => {
      const win = page({ bodyMode: 'dark' });
      win.__XC('coin_home', 'before');
      assert.equal(win.document.documentElement.getAttribute('data-bs-theme'), 'light');
      assert.equal(win.document.body.getAttribute('data-bs-theme'), 'dark');
    });

    it('restores an absent body attribute as absent, not as light', () => {
      const win = page({ bodyMode: null });
      win.__XC('coin_home', 'before');
      assert.equal(win.document.body.hasAttribute('data-bs-theme'), false);
    });
  });

  describe('a degenerate capture is an explicit invalid result, not a hash', () => {
    it('refuses a page where no first-party stylesheet matched', () => {
      const win = page({ sheets: [sheet(VENDOR, [rule('body', { color: 'red' })])] });
      const res = win.__XC('coin_home', 'before');

      assert.ok(Array.isArray(res.invalid), 'an empty rule layer returned hashes');
      assert.equal(res.light, undefined);
      assert.deepEqual(xcKeys(win), [], 'a rejected capture wrote snapshots anyway');
    });

    it('refuses a page whose first-party stylesheet is unreadable', () => {
      const win = page({ sheets: [unreadableSheet(FIRST_PARTY)] });
      const res = win.__XC('coin_home', 'before');

      assert.ok(Array.isArray(res.invalid), 'an unreadable sheet was fingerprinted as evidence');
      assert.match(res.invalid.join(' '), /unreadable/i);
      assert.deepEqual(xcKeys(win), []);
    });

    it('refuses a first-party stylesheet that declared nothing the page matches', () => {
      const win = page({ sheets: [sheet(FIRST_PARTY, [rule('#nothing-here', { color: 'red' })])] });
      const res = win.__XC('coin_home', 'before');

      assert.ok(Array.isArray(res.invalid), 'an empty rule snapshot returned hashes');
      assert.deepEqual(xcKeys(win), []);
    });

    it('does not let a degenerate capture overwrite a good stored snapshot', () => {
      const win = page({ bodyMode: 'dark' });
      win.__XC('coin_home', 'before');
      const good = { ...win.localStorage };

      Object.defineProperty(win.document, 'styleSheets', {
        get() { return [sheet(VENDOR, [rule('body', { color: 'red' })])]; }, configurable: true,
      });
      const res = win.__XC('coin_home', 'before');

      assert.ok(Array.isArray(res.invalid));
      for (const k of xcKeys(win)) assert.equal(win.localStorage[k], good[k], `${k} was overwritten`);
    });
  });

  describe('the Chrome CSS-nesting regression stays fixed', () => {
    it('captures a plain rule whose .cssRules list is empty', () => {
      // Chrome gives EVERY CSSStyleRule an empty .cssRules list, so a naive
      // container check treats every plain rule as a group, walks its zero
      // children, and reports a clean 0-key parity proof. The first cut of the
      // probe did exactly that; this is that failure as an executable assertion.
      const win = page({
        sheets: [sheet(FIRST_PARTY, [rule('body', { 'background-color': '#123456' }, [])])],
      });
      const res = win.__XC('coin_home', 'before');

      assert.ok(!res.invalid, `capture rejected: ${JSON.stringify(res.invalid)}`);
      assert.equal(res.light.cssRules, 1);
      assert.ok(res.light.rule.keys >= 1, 'the plain rule was walked as a group and captured nothing');
      const snap = JSON.parse(win.localStorage['__xc:before:coin_home|light|rule']);
      assert.ok('body | background-color' in snap, Object.keys(snap).join(','));
    });

    it('still recurses into a rule that really does carry children', () => {
      const win = page({
        sheets: [sheet(FIRST_PARTY, [
          rule('', {}, [rule('body', { 'background-color': '#123456' })]),
        ])],
      });
      const res = win.__XC('coin_home', 'before');

      assert.ok(!res.invalid, `capture rejected: ${JSON.stringify(res.invalid)}`);
      const snap = JSON.parse(win.localStorage['__xc:before:coin_home|light|rule']);
      assert.ok('body | background-color' in snap, Object.keys(snap).join(','));
    });
  });
});
