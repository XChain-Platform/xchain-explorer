/********************************************************************
 *
 * Declared-value var() resolution in tools/theme-parity/parity-probe.js.
 *
 * The rule layer reads the DECLARED text of state rules and layout-derived
 * keys and resolves each var() through the element's custom properties. A
 * fallback that itself holds parentheses (rgba(), calc(), a nested var())
 * must come out whole: a resolver that stops at the first closing paren
 * leaves a stray ')' or a truncated colour in the snapshot, which skews the
 * rule hash without any stylesheet having changed.
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
const FIRST_PARTY = 'http://localhost:18080/css/xchain.css';
const MODE_CSS = `
  [data-bs-theme="light"] { --bs-primary-text-emphasis: #052c65; background-color: rgb(255, 255, 255); }
  [data-bs-theme="dark"]  { --bs-primary-text-emphasis: #6ea8fe; background-color: rgb(0, 0, 0); }
`;
const KEY = '.card | margin-top';

// Capture one layout-key declaration and return the resolved text the rule layer stored
function resolved(declared, cardStyle = '') {
  const dom = new JSDOM(
    `<!doctype html><html data-bs-theme="light"><head><style>${MODE_CSS}</style></head>` +
    `<body data-bs-theme="dark"><div class="card" style="${cardStyle}">c</div></body></html>`,
    { url: 'http://localhost:18080/RDOGE', runScripts: 'outside-only' },
  );
  const decl = { length: 1, 0: 'margin-top', getPropertyValue: (p) => (p === 'margin-top' ? declared : '') };
  const sheets = [{ href: FIRST_PARTY, cssRules: [{ selectorText: '.card', style: decl, cssRules: [] }] }];
  Object.defineProperty(dom.window.document, 'styleSheets', { get() { return sheets; }, configurable: true });
  dom.window.Element.prototype.computedStyleMap = function computedStyleMap() {
    const cs = dom.window.getComputedStyle(this);
    return { get: (p) => cs.getPropertyValue(p) };
  };
  vm.runInContext(PROBE_SRC, dom.getInternalVMContext(), { filename: PROBE_FILE });
  const res = dom.window.__XC('coin_home', 'before');
  assert.ok(!res.invalid, `capture rejected: ${JSON.stringify(res.invalid)}`);
  return JSON.parse(dom.window.localStorage['__xc:before:coin_home|light|rule'])[KEY];
}

describe('theme parity probe var() fallback resolution', () => {
  it('keeps a fallback that holds a function call whole', () => {
    assert.equal(resolved('var(--xc-missing, rgba(0,0,0,0.5))'), 'rgba(0,0,0,0.5)');
    assert.equal(resolved('var(--xc-missing, calc(1px + 2px))'), 'calc(1px + 2px)');
  });

  it('drops a function-call fallback when the custom property resolves, leaving no stray paren', () => {
    assert.equal(resolved('var(--xc-set, rgba(0,0,0,0.5))', '--xc-set: 7px'), '7px');
    assert.equal(resolved('0 0 var(--xc-set, calc(1px + 2px)) 1px', '--xc-set: 7px'), '0 0 7px 1px');
  });

  it('resolves a nested var() inside a fallback', () => {
    assert.equal(resolved('var(--xc-a, var(--xc-b, 4px))'), '4px');
    assert.equal(resolved('var(--xc-a, var(--xc-set))', '--xc-set: 7px'), '7px');
  });

  it('resolves each var() in a multi-value declaration and keeps the text around them', () => {
    assert.equal(resolved('0 0 var(--xc-a, 1px) var(--xc-b, rgba(0,0,0,.1))'), '0 0 1px rgba(0,0,0,.1)');
    assert.equal(resolved('1px solid var(--xc-a, red)'), '1px solid red');
  });

  it('keeps the plain-fallback results the existing baselines depend on', () => {
    assert.equal(resolved('var( --xc-a , 5px )'), '5px');
    assert.equal(resolved('var(--xc-a)'), '');
    assert.equal(resolved('var(--xc-a,)'), '');
    assert.equal(resolved('12px'), '12px');
  });

  it('leaves text that is not a well-formed var() call as written', () => {
    assert.equal(resolved('var(notacustomprop)'), 'var(notacustomprop)');
    assert.equal(resolved('var(--xc-a, 1px'), 'var(--xc-a, 1px');
  });
});
