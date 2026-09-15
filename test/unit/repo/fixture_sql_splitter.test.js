// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Guard for the fixture SQL splitter in test/integration/helpers/db-setup.js.
// It runs here, in the DB-free unit suite, because the suites that exercise the
// splitter for real (perf, integration) need a database and therefore only ever
// ran in a job nobody watched: the license header added to every fixture
// contains "...v3.0 or later; see LICENSE.md...", and that semicolon tore each
// DELIMITER-bearing fixture into a fragment the server rejected. The whole perf
// suite was red for weeks on a comment.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { splitSqlStatements } = require('../integration/helpers/db-setup.js');

const SEED = path.join(__dirname, '..', 'performance', 'helpers', 'seed-performance.sql');

describe('fixture SQL splitter', function () {
    it('never emits a fragment of a comment as a statement', function () {
        for (const stmt of splitSqlStatements(fs.readFileSync(SEED, 'utf8'))) {
            assert.ok(!/LICENSE\.md/.test(stmt),
                'license prose reached the server as SQL: ' + stmt.slice(0, 60));
            assert.ok(/^[A-Za-z(]/.test(stmt),
                'statement does not begin with a keyword: ' + stmt.slice(0, 60));
        }
    });

    it('keeps a DELIMITER-quoted procedure body whole', function () {
        const stmts = splitSqlStatements(fs.readFileSync(SEED, 'utf8'));
        const proc  = stmts.filter((s) => /CREATE PROCEDURE/i.test(s));
        assert.strictEqual(proc.length, 1, 'the procedure was split into pieces');
        assert.ok(/END\s*$/.test(proc[0]), 'the procedure body was truncated');
        assert.ok(stmts.some((s) => /^CALL seed_perf_data\(\)$/.test(s)),
            'statements after the DELIMITER reset were lost');
    });

    it('splits on a real terminator but not on one inside comment prose', function () {
        const stmts = splitSqlStatements(
            '-- a note; with a semicolon\nSELECT 1;\nSELECT 2;\n');
        assert.deepStrictEqual(stmts, ['SELECT 1', 'SELECT 2']);
    });

    it('leaves a semicolon inside a string literal alone', function () {
        const stmts = splitSqlStatements("INSERT INTO t VALUES ('a;b');\n");
        assert.deepStrictEqual(stmts, ["INSERT INTO t VALUES ('a;b')"]);
    });
});
