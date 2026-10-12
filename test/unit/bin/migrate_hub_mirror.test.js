'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, '../../../bin/migrate-hub-mirror.js');

function runCli(args) {
    return spawnSync(process.execPath, [script, ...args], {
        env: { PATH: process.env.PATH },
        encoding: 'utf8'
    });
}

describe('migrate-hub-mirror CLI', function () {
    it('prints usage and exits successfully for --help', function () {
        const result = runCli(['--help']);

        assert.strictEqual(result.status, 0);
        assert.match(result.stdout, /Usage:/);
    });

    it('rejects unknown arguments', function () {
        const result = runCli(['--bogus']);

        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /migrate-hub-mirror: unknown argument: --bogus/);
    });

    it('requires a user and schema when no arguments are given', function () {
        const result = runCli([]);

        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /--user and --schema are required/);
        assert.match(result.stdout, /Usage:/);
    });

    it('requires the database password after required arguments', function () {
        const result = runCli(['--user', 'u', '--schema', 's']);

        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /MIRROR_DB_PASS is not set/);
    });

    it('requires a schema when only a user is given', function () {
        const result = runCli(['--user', 'u']);

        assert.strictEqual(result.status, 1);
        assert.match(result.stderr, /--user and --schema are required/);
    });
});
