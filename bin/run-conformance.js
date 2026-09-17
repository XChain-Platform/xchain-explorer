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
 * Launch conformance with the identity selected by fixture preflight.
 * The password is carried only in the child environment.
 */

'use strict';

const { spawnSync } = require('child_process');
const path          = require('path');

const pre = require('../test/integration/helpers/fixture-preflight.js');

const REPO = path.join(__dirname, '..');

function run() {
    const result = spawnSync(process.execPath, [
        require.resolve('mocha/bin/mocha.js'),
        'test/conformance/**/*.test.js',
        '--timeout', '120000',
        '--exit',
        '--recursive'
    ], {
        cwd:   REPO,
        env:   pre.conformanceEnvironment(),
        stdio: 'inherit'
    });
    if (result.error) throw result.error;
    return result.status === null ? 1 : result.status;
}

if (require.main === module) process.exit(run());

module.exports = { run };
