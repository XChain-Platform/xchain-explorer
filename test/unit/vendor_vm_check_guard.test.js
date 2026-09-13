'use strict';

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
 * Unit tests for the write boundary of `bin/vendor-vm.sh check`.
 *
 * The vendored xchain-vm copy is the one artifact in this repo that executes
 * at consensus time, and drift in it once shipped copies missing two consensus
 * gates under an unchanged CONSENSUS_VERSION. `check` therefore has exactly one
 * licence to write: staging an ABSENT copy, which every isolated checkout needs
 * because the copy is gitignored. Writing over a copy that is present repairs
 * the tree and then reports the repaired tree as in sync, which is the guard
 * concealing the drift it exists to name.
 */

const assert  = require('assert');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'bin', 'vendor-vm.sh');

const CANONICAL_RUNTIME =
    "const CONSENSUS_VERSION = '3';\n"
    + "const GATES = ['STATE_KEY_NUL', 'METERING_EVAL_ORDER'];\n"
    + 'module.exports = { CONSENSUS_VERSION, GATES };\n';

// A tree that is present and wrong in the way the version string cannot see:
// one consensus gate short, and no parseable CONSENSUS_VERSION to compare on.
const DRIFTED_RUNTIME =
    "const GATES = ['STATE_KEY_NUL'];\n"
    + 'module.exports = { GATES };\n';

describe('vendored-VM check mode write boundary @regression', function () {
    const roots = [];

    function haveRsync() {
        return spawnSync('sh', ['-c', 'command -v rsync'], { encoding: 'utf8' }).status === 0;
    }

    // A fake repo root carrying only bin/vendor-vm.sh, because DEST is derived
    // from the script's own location and must never be this checkout's copy.
    function stageRoot() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-vm-guard-'));
        roots.push(root);
        fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
        fs.copyFileSync(SCRIPT, path.join(root, 'bin', 'vendor-vm.sh'));

        const src = path.join(root, 'canonical-vm');
        fs.mkdirSync(path.join(src, 'src'), { recursive: true });
        fs.writeFileSync(path.join(src, 'src', 'consensus-runtime.js'), CANONICAL_RUNTIME);
        fs.writeFileSync(path.join(src, 'package.json'), '{ "name": "xchain-vm", "version": "1.2.3" }\n');

        return { root, src, dest: path.join(root, 'xchain-vm') };
    }

    function runCheck(fixture) {
        return spawnSync('bash', [path.join(fixture.root, 'bin', 'vendor-vm.sh'), 'check'], {
            encoding: 'utf8',
            env: Object.assign({}, process.env, { XCHAIN_VM_SOURCE: fixture.src })
        });
    }

    after(function () {
        for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    });

    it('VMCHK-1: refuses a vendored tree that is present with an unreadable CONSENSUS_VERSION', function () {
        if (!haveRsync()) return this.skip();
        const fixture = stageRoot();
        fs.mkdirSync(path.join(fixture.dest, 'src'), { recursive: true });
        fs.writeFileSync(path.join(fixture.dest, 'src', 'consensus-runtime.js'), DRIFTED_RUNTIME);
        fs.copyFileSync(path.join(fixture.src, 'package.json'), path.join(fixture.dest, 'package.json'));

        const run = runCheck(fixture);
        const out = `${run.stdout}${run.stderr}`;

        assert.notStrictEqual(run.status, 0,
            `check reported a drifted vendored tree as acceptable (exit ${run.status}):\n${out}`);
        assert.match(out, /DRIFT/,
            `check exited non-zero without naming drift:\n${out}`);
        assert.strictEqual(
            fs.readFileSync(path.join(fixture.dest, 'src', 'consensus-runtime.js'), 'utf8'),
            DRIFTED_RUNTIME,
            'check overwrote a vendored tree that was present, which repairs the drift it is meant to report');
    });

    it('VMCHK-2: stages an absent vendored copy and reports in sync', function () {
        if (!haveRsync()) return this.skip();
        const fixture = stageRoot();

        const run = runCheck(fixture);
        const out = `${run.stdout}${run.stderr}`;

        assert.strictEqual(run.status, 0,
            `check failed a state no commit can satisfy: the copy is gitignored, so an isolated `
            + `checkout never carries one (exit ${run.status}):\n${out}`);
        assert.strictEqual(
            fs.readFileSync(path.join(fixture.dest, 'src', 'consensus-runtime.js'), 'utf8'),
            CANONICAL_RUNTIME,
            'check reported in sync without staging the canonical source files');
    });

    it('VMCHK-3: reports drift when a present vendored tree carries an older version', function () {
        if (!haveRsync()) return this.skip();
        const fixture = stageRoot();
        fs.mkdirSync(path.join(fixture.dest, 'src'), { recursive: true });
        fs.writeFileSync(path.join(fixture.dest, 'src', 'consensus-runtime.js'),
            CANONICAL_RUNTIME.replace("'3'", "'2'"));
        fs.copyFileSync(path.join(fixture.src, 'package.json'), path.join(fixture.dest, 'package.json'));

        const run = runCheck(fixture);
        const out = `${run.stdout}${run.stderr}`;

        assert.notStrictEqual(run.status, 0, `check accepted a version mismatch:\n${out}`);
        assert.match(out, /DRIFT/, out);
    });
});
