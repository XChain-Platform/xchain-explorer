'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers.js');

const ROOT = path.join(__dirname, '..', '..', '..', '..', '..', '..');
const THEME_DIR = path.join(ROOT, 'src', 'content', 'themes');
const PROBE_FILE = path.join(ROOT, 'tools', 'theme-parity', 'parity-probe.js');

describe('theme parity probe (static contract)', () => {
  const probe = fs.readFileSync(PROBE_FILE, 'utf8');

  it('admits every first-party stylesheet a theme @imports', () => {
    // A theme's tokens.css pulls sheets in by @import, which template.html never
    // links, so the template case cannot see them. Resolve each target the way the
    // browser does and hold SHEET to it, so a new import path cannot skip the probe.
    const VENDOR = /bootstrap|dataTables|swagger-ui|highlight-|fontawesome/;
    const targets = [];
    for (const name of fs.readdirSync(THEME_DIR).sort()) {
      const file = path.join(THEME_DIR, name, 'tokens.css');
      if (!fs.existsSync(file)) continue;
      const css = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of css.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/g))
        targets.push(new URL(m[1], `http://x/themes/${name}/tokens.css`).pathname);
    }
    // Guard against a parse that silently finds nothing: the console theme imports four.
    assert.ok(targets.filter((t) => t.startsWith('/themes/console/')).length >= 4,
      `only parsed these theme imports: ${targets.join(', ')}`);

    const m = probe.match(/const\s+SHEET\s*=\s*(\/(?:[^/\\\n]|\\.)+\/[a-z]*)/);
    assert.ok(m, 'the probe no longer declares a SHEET pattern in the expected form');
    const sheetRe = new RegExp(m[1].slice(1, m[1].lastIndexOf('/')));
    const skipped = targets.filter((t) => !VENDOR.test(t) && !sheetRe.test(t));
    assert.deepEqual(skipped, [],
      `a theme imports these first-party sheets and the probe reads none of them:\n${skipped.join('\n')}`);
  });
});
