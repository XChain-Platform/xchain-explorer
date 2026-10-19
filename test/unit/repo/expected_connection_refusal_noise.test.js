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
 **********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..', '..', '..');
const MOCHA = require.resolve('mocha/bin/mocha.js');
const TARGETS = [
    'test/unit/connectors/hub_connector.test.js',
    'test/unit/mirror/hub_operational_cache_concurrency.test.js',
    'test/unit/mirror/hub_operational_cache_mixed_fleet.test.js'
];

describe('expected connection-refusal output', function () {
    it('keeps passing connector and mirror tests free of refusal stacks', function () {
        const run = spawnSync(process.execPath, [
            MOCHA,
            ...TARGETS,
            '--reporter', 'dot',
            '--timeout', '10000',
            '--recursive',
            '--exit'
        ], {
            cwd: REPO,
            encoding: 'utf8',
            timeout: 30000
        });
        const output = `${run.stdout || ''}${run.stderr || ''}`;

        assert.equal(run.status, 0, output || run.error?.message);
        assert.doesNotMatch(output, /ECONNREFUSED/, output);
    });
});
