/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * AT1: the pin is re-derivable, and it still describes this tree.
 *
 * WHY THIS SUITE LIVES UNDER bin/test AND NOT test/unit. Every glob in
 * package.json collects test/**, so a suite placed there would appear inside the
 * very title map it is asserting about and make the pin depend on itself. It is
 * run by name instead: npx mocha --no-config bin/test/explorer-identity.test.js
 *
 * WHY IT DRIVES THE CLI RATHER THAN THE EXPORTS. The thing under test is the
 * committed artifact, which is bytes on disk produced by a process. Calling
 * buildIdentity() in-process would prove the functions agree with themselves and
 * would not notice a serializer that emits locale-ordered keys or a pin written
 * from a different tree.
 *
 * IT IS SLOW ON PURPOSE. Each full derivation spawns 22 mocha dry runs, about
 * 25 seconds. Sharing one derivation across the assertions that can honestly
 * share it keeps the suite near two minutes; the ones that must re-read the tree
 * (every --compare) pay for their own.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TOOL      = path.join(REPO_ROOT, 'bin', 'explorer-identity.js');
const PIN       = path.join(REPO_ROOT, 'bin', 'pins', 'at1-explorer-identity.json');

/** The tool as an operator runs it: a child process, from the repo root. */
function runTool(args) {
    const res = spawnSync(process.execPath, [TOOL, ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
    });
    assert.strictEqual(res.error, undefined, `spawn failed: ${res.error && res.error.message}`);
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('bin/explorer-identity.js (AT1)', function () {
    this.timeout(120000);

    let tmpDir;
    let runA;
    let runB;

    before(function () {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'explorer-identity-'));
        runA = path.join(tmpDir, 'run-a.json');
        runB = path.join(tmpDir, 'run-b.json');
        const a = runTool(['--out', runA]);
        assert.strictEqual(a.status, 0, `first derivation failed: ${a.stderr}`);
        const b = runTool(['--out', runB]);
        assert.strictEqual(b.status, 0, `second derivation failed: ${b.stderr}`);
    });

    after(function () {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('derives the same bytes twice from the same tree', function () {
        // Byte equality, not deep equality: a pin that only matched after a parse
        // would let key order drift and every later `git diff` on it would be
        // noise that hides the one line that matters.
        assert.ok(fs.readFileSync(runA).equals(fs.readFileSync(runB)),
            'two consecutive derivations of the same tree differ');
    });

    it('AT1: the committed pin equals a fresh derivation at HEAD', function () {
        assert.ok(fs.existsSync(PIN), 'bin/pins/at1-explorer-identity.json is not committed');
        assert.ok(fs.readFileSync(PIN).equals(fs.readFileSync(runA)),
            'the committed AT1 pin does not match a fresh derivation of this tree');
    });

    it('carries the values the wave 1 barrier reads', function () {
        const identity = JSON.parse(fs.readFileSync(PIN, 'utf8'));
        assert.strictEqual(identity.twins.length, 9, 'the frozen twin set is nine files');
        for (const twin of identity.twins) {
            assert.ok(!twin.missing, `${twin.path} is missing from the tree`);
            assert.match(twin.sha256, /^[0-9a-f]{64}$/);
        }
        assert.match(identity.routes.digest_sha256, /^[0-9a-f]{64}$/);
        assert.strictEqual(identity.routes.counts.total,
            identity.routes.counts.pages + identity.routes.counts.feeds + identity.routes.counts.apis);
        assert.strictEqual(identity.fixtures.length, 3);
        const golden = identity.fixtures.find((f) => f.path.endsWith('action-detail-golden.json'));
        assert.strictEqual(golden.bytes, 383433, 'the golden changed size, which AT2 owns');
        // Zero enumerable keys is the guarantee the db.js carve has to preserve:
        // methods installed by assignment instead of by descriptor copy would
        // show up here long before any behavioural test noticed.
        assert.strictEqual(identity.prototype.enumerable_keys, 0);
        assert.strictEqual(identity.prototype.count, identity.prototype.names.length);
        assert.deepStrictEqual(identity.prototype.names, identity.prototype.names.slice().sort(),
            'the prototype name list is not sorted, so a diff of it would be unreadable');
        for (const metric of ['lines', 'statements', 'branches', 'functions']) {
            assert.strictEqual(typeof identity.coverage.script_values[metric], 'number',
                `coverage:check does not declare --${metric}`);
        }
        assert.strictEqual(identity.suites.totals.errored, 0, 'a test script failed to collect');
        assert.ok(identity.suites.totals.collected > 0, 'no npm script collected any test file');
        assert.strictEqual(Object.keys(identity.suites.scripts).length, identity.suites.totals.scripts);
    });

    it('--compare against the committed pin exits 0', function () {
        const res = runTool(['--compare', PIN]);
        assert.strictEqual(res.status, 0, `compare reported differences:\n${res.stdout}`);
        assert.match(res.stdout, /explorer identity holds against bin\/pins\/at1-explorer-identity\.json/);
    });

    it('--compare exits 1 and names the twin when one twin sha256 is altered', function () {
        const pin = JSON.parse(fs.readFileSync(PIN, 'utf8'));
        const target = pin.twins.find((t) => t.path === 'src/merkle.js');
        assert.ok(target, 'src/merkle.js is not in the pinned twin set');
        target.sha256 = 'f'.repeat(64);
        const altered = path.join(tmpDir, 'altered-twin.json');
        fs.writeFileSync(altered, JSON.stringify(pin, null, 2));

        const res = runTool(['--compare', altered]);
        assert.strictEqual(res.status, 1, 'an altered twin sha256 did not fail the comparison');
        assert.match(res.stdout, /twin_sha256 src\/merkle\.js/);
        assert.ok(res.stdout.includes('f'.repeat(64)), 'the failing output does not show the pinned value');
    });

    it('a rename map lets --compare pass over a renamed test file, and only through the map', function () {
        // The pin is rewritten to hold an OLD path, which is the state a pin taken
        // before a rename is in. Nothing in the tree is touched: the rename is
        // simulated backwards, on a copy, so this assertion cannot leave the
        // worktree dirty the way an actual `git mv` and revert would.
        const pin = JSON.parse(fs.readFileSync(PIN, 'utf8'));
        const collected = Object.keys(pin.suites.scripts)
            .filter((n) => pin.suites.scripts[n].files)
            .sort();
        assert.ok(collected.length, 'the pin collected no script to rename a file in');
        const newPath = Object.keys(pin.suites.scripts[collected[0]].files).sort()[0];
        const oldPath = path.join(path.dirname(newPath), `renamed-away-${path.basename(newPath)}`);

        for (const name of collected) {
            const files = pin.suites.scripts[name].files;
            if (!(newPath in files)) continue;
            files[oldPath] = files[newPath];
            delete files[newPath];
        }
        const movedPin = path.join(tmpDir, 'pre-rename.json');
        fs.writeFileSync(movedPin, JSON.stringify(pin, null, 2));

        // Without the map the rename has to READ as a difference, or the map
        // proves nothing: a comparison that ignored file identity would pass both
        // ways and this test would be asserting on air.
        const bare = runTool(['--compare', movedPin]);
        assert.strictEqual(bare.status, 1, 'a renamed test file did not fail the comparison');
        assert.ok(bare.stdout.includes(`file_dropped [${collected[0]}] ${oldPath}`)
            || bare.stdout.includes(`file_added [${collected[0]}] ${newPath}`),
            `the bare comparison did not report the rename:\n${bare.stdout.slice(0, 800)}`);

        const mapPath = path.join(tmpDir, 'rename-map.json');
        fs.writeFileSync(mapPath, JSON.stringify({ [oldPath]: newPath }, null, 2));
        const mapped = runTool(['--compare', movedPin, '--rename-map', mapPath]);
        assert.strictEqual(mapped.status, 0,
            `the rename map did not resolve the rename:\n${mapped.stdout.slice(0, 800)}`);
        assert.match(mapped.stdout, /through the declared rename map/);
    });
});
