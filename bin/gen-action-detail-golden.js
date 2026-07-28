#!/usr/bin/env node
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
 * Regenerate test/fixtures/action-detail-golden.json, the byte-level pin on
 * every per-action detail branch (SQL issued + shaped output).
 *
 * Run this ONLY when a branch is intentionally changed, and review the diff:
 * an unexplained line in the diff is a rendering regression on a public
 * action page. Adding a new action type appends to the file and nothing else
 * should move.
 *
 *   node bin/gen-action-detail-golden.js
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { captureAll, serializeGolden } = require('../test/fixtures/action-detail-capture.js');
const { ACTION_TYPES } = require('../src/action-detail');

// A type with no registry entry must still render (baseline de-blank fallback);
// keep one in the golden so that path stays pinned too.
const TYPES = ACTION_TYPES.concat(['NOT_A_REAL_ACTION']);
const OUT   = path.join(__dirname, '..', 'test', 'fixtures', 'action-detail-golden.json');

(async () => {
    const golden = await captureAll(TYPES);
    fs.writeFileSync(OUT, serializeGolden(golden));
    console.log('wrote ' + TYPES.length + ' action types, ' + golden.statements.length + ' unique statements -> ' + OUT);
})().catch((e) => { console.error(e); process.exit(1); });
