/**********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const WIDGET_REGISTRY = {
  widget: {
    mount() {},
    props: {
      id: { type: 'string', required: true },
      rows: { type: 'array' },
    },
  },
};

function withFixtureThemeChain(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-lint-'));
  const base = path.join(directory, 'base');
  const child = path.join(directory, 'child');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'theme.json'), '{"name":"base"}');
  fs.writeFileSync(
    path.join(base, 'tokens.css'),
    ':root { --xc-base: red; --xc-inherited-use: var(--xc-missing); }',
  );
  fs.mkdirSync(child);
  fs.writeFileSync(path.join(child, 'theme.json'), '{"name":"child","extends":"base"}');
  fs.writeFileSync(path.join(child, 'tokens.css'), ':root { --xc-child: var(--xc-base); }');
  try {
    return fn(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// A child theme whose tokens.css @imports override sheets, the way console does. The
// imported sheets carry two token typos (one through a nested import) and the tokens.css
// carries one import of a missing file and one that climbs out of the theme directory.
function withFixtureImportingTheme(fn) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-lint-'));
  const base = path.join(directory, 'base');
  const child = path.join(directory, 'child');
  const sheetDir = path.join(child, 'components', 'x');
  fs.mkdirSync(base);
  fs.writeFileSync(path.join(base, 'theme.json'), '{"name":"base"}');
  fs.writeFileSync(path.join(base, 'tokens.css'), ':root { --xc-base: red; }');
  fs.mkdirSync(sheetDir, { recursive: true });
  fs.writeFileSync(path.join(child, 'theme.json'), '{"name":"child","extends":"base"}');
  fs.writeFileSync(
    path.join(child, 'tokens.css'),
    [
      '@import url("./components/x/component.css");',
      '@import "./components/absent/component.css";',
      '@import url(../base/tokens.css);',
      '/* @import url("./components/commented/component.css"); */',
      ':root { --xc-child: var(--xc-base); }',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(sheetDir, 'component.css'),
    '@import url(./nested.css);\n.x { color: var(--xc-child); border-color: var(--xc-import-typo); --xc-x-local: 1px; }',
  );
  fs.writeFileSync(
    path.join(sheetDir, 'nested.css'),
    '.y { margin: var(--xc-x-local); padding: var(--xc-nested-typo); }',
  );
  try {
    return fn(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { WIDGET_REGISTRY, withFixtureThemeChain, withFixtureImportingTheme };
