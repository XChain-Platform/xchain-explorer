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

module.exports = { WIDGET_REGISTRY, withFixtureThemeChain };
