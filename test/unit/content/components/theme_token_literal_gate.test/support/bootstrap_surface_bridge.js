'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { declarationsIn, stripComments } = require('./helpers.js');

const CSS_DIR = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'src', 'content', 'css');
const THEME_DIR = path.join(__dirname, '..', '..', '..', '..', '..', '..', 'src', 'content', 'themes');
const TOKENS_FILE = path.join(THEME_DIR, 'classic', 'tokens.css');
const SKIN_FILE = path.join(THEME_DIR, 'skin-demo', 'tokens.css');
const BOOTSTRAP_FILE = path.join(CSS_DIR, 'bootstrap.min.css');
const classic = fs.readFileSync(TOKENS_FILE, 'utf8');
const skin = fs.readFileSync(SKIN_FILE, 'utf8');
const bootstrap = fs.readFileSync(BOOTSTRAP_FILE, 'utf8');
const bridgeSelector = ':root,\n[data-bs-theme="light"],\n[data-bs-theme="dark"]';

function bridged() {
  const decls = declarationsIn(classic, bridgeSelector);
  assert.ok(decls, 'the --bs-* bridge block was not found in classic/tokens.css');
  return decls;
}

/*
 * Row 22a: the token layer extended over Bootstrap's own surface variables.
 *
 * Before this, a skin could move exactly the values xchain.css and
 * xchain-charts.css declared - footer, table borders, status tints, chart
 * chrome - and the page UNDER that chrome stayed Bootstrap-default, because
 * background, body text, links and borders come from --bs-* variables no
 * tokens.css could reach. The bridge re-points those at --xc-surface-* tokens.
 *
 * The bridge is only safe if classic's values are Bootstrap's values, so the
 * first test reads them back out of the vendored bootstrap.min.css rather than
 * restating them: a transcription slip here would repaint every page in the
 * explorer, and a hand-copied expectation would agree with the slip.
 *
 * The second test is the one that would otherwise be found by eye, weeks later,
 * in dark mode only. updateTheme() writes data-bs-theme onto BODY, so Bootstrap
 * redeclares its --bs-* surface variables ON body for both modes; a bridge
 * declared only on :root is inherited by body and immediately overridden there.
 * It has to be declared on the same elements Bootstrap uses.
 */
describe('Bootstrap surface bridge (row 22a)', () => {
  it('points every bridged --bs-* variable at an --xc-surface-* token', () => {
    const decls = bridged();
    const names = Object.keys(decls).filter((k) => k.startsWith('--bs-'));
    assert.ok(names.length >= 20, `only ${names.length} Bootstrap variables are bridged`);
    const direct = names.filter((n) => !/^var\(--xc-surface-[\w-]+\)$/.test(decls[n]));
    assert.deepEqual(direct, [],
      'bridged variables set to a literal rather than to a token; a skin cannot move these:\n'
      + direct.map((n) => `${n}: ${decls[n]}`).join('\n'));
  });

  it('gives classic exactly Bootstrap\'s own values, so the page renders unchanged', () => {
    const bsLight = declarationsIn(bootstrap, ':root,[data-bs-theme=light]');
    const bsDark  = declarationsIn(bootstrap, '[data-bs-theme=dark]');
    assert.ok(bsLight && bsDark, 'could not read Bootstrap\'s own surface defaults');

    const xcLight = declarationsIn(classic, ':root');
    const xcDark  = declarationsIn(classic, '[data-bs-theme="dark"]');

    const wrong = [];
    for (const bsName of Object.keys(bridged())) {
      if (!bsName.startsWith('--bs-')) continue;
      const token = '--xc-surface-' + bsName.slice('--bs-'.length);
      for (const [mode, xc, bs] of [['light', xcLight, bsLight], ['dark', xcDark, bsDark]]) {
        if (xc[token] === undefined) { wrong.push(`${token} is undefined in the ${mode} block`); continue; }
        if (xc[token] !== bs[bsName]) wrong.push(`${mode}: ${token} is ${xc[token]}, Bootstrap ships ${bs[bsName]}`);
      }
    }
    assert.deepEqual(wrong, [],
      'classic would repaint the page rather than reproduce it:\n  ' + wrong.join('\n  '));
  });
});

describe('Bootstrap surface bridge (row 22a)', () => {
  it('declares the bridge on every selector that can carry the mode', () => {
    // A bridge on :root alone works in light and silently fails in dark, because
    // body carries the theme attribute and Bootstrap redeclares there.
    assert.ok(classic.includes(bridgeSelector),
      'the bridge is not declared on :root, [data-bs-theme="light"] and [data-bs-theme="dark"] together');
  });

  it('reaches the surface a skin most needs: background, text, links and borders', () => {
    const decls = bridged();
    for (const name of ['--bs-body-bg', '--bs-body-color', '--bs-link-color', '--bs-border-color'])
      assert.ok(decls[name], `${name} is not bridged, so a skin cannot move it`);
  });

  it('carries the -rgb triples, without which every translucent overlay stays behind', () => {
    // Bootstrap composes overlays as rgba(var(--bs-body-bg-rgb), .5). A skin that
    // moved only the hex would leave those on the old palette - a half-recoloured
    // page, which is worse than one that did not move at all.
    const decls = bridged();
    for (const name of ['--bs-body-bg-rgb', '--bs-body-color-rgb', '--bs-link-color-rgb',
                        '--bs-secondary-bg-rgb', '--bs-tertiary-bg-rgb'])
      assert.ok(decls[name], `${name} is not bridged`);
  });
});

describe('Bootstrap surface bridge (row 22a)', () => {
  it('gives the demo skin the same token names as classic, so it is a drop-in', () => {
    const names = (css) => new Set([...stripComments(css).matchAll(/(--xc-[\w-]+)\s*:/g)].map((m) => m[1]));
    const c = names(classic);
    const s = names(skin);
    const missing = [...c].filter((n) => !s.has(n));
    const extra   = [...s].filter((n) => !c.has(n));
    // An omitted token falls back to nothing and invalidates its declaration, so
    // a partial skin breaks a rule rather than restyling it.
    assert.deepEqual(missing, [], 'tokens classic defines that the skin does not: ' + missing.join(', '));
    assert.deepEqual(extra, [], 'tokens the skin defines that classic does not: ' + extra.join(', '));
  });

  it('actually MOVES the surface in the demo skin, which is what row 22a was for', () => {
    const cLight = declarationsIn(classic, ':root');
    const sLight = declarationsIn(skin, ':root');
    const surface = Object.keys(cLight).filter((n) => n.startsWith('--xc-surface-'));
    const moved = surface.filter((n) => sLight[n] !== cLight[n]);
    assert.ok(moved.length >= 15,
      `the skin moves only ${moved.length} of ${surface.length} surface tokens; loading it would `
      + 'still leave the page on Bootstrap\'s palette, which is the finding row 22a recorded');
  });

  it('does not restate the bridge in the skin: a skin overrides values, not wiring', () => {
    assert.equal(declarationsIn(skin, bridgeSelector), null,
      'the skin redeclares the --bs-* bridge; two copies of the wiring will drift');
  });
});
