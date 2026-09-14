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
 * THE TWO PINS ARE ASSERTED DIFFERENTLY, WHICH IS THE POINT. The LIVE pin is
 * re-taken at every wave barrier, so a fresh derivation must equal it BYTE for
 * byte. The FROZEN base record at 8f251b6 is never re-taken, so once the test
 * renames land it can only hold THROUGH the declared rename map, and the
 * assertion that matters there is that the map explains every test-path
 * difference and fails the moment one is left over.
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
// The live pin, re-derived and committed at every wave barrier.
const PIN       = path.join(REPO_ROOT, 'bin', 'pins', 'at1-explorer-identity.json');
// The frozen base record, taken before any lane of this pass committed.
const BASE_PIN  = path.join(REPO_ROOT, 'bin', 'pins', 'at1-explorer-identity.8f251b6.json');
const BASE_REV  = '8f251b6';

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

    it('AT1: the live pin equals a fresh derivation at HEAD', function () {
        assert.ok(fs.existsSync(PIN), 'bin/pins/at1-explorer-identity.json is not committed');
        assert.ok(fs.readFileSync(PIN).equals(fs.readFileSync(runA)),
            'the committed live pin does not match a fresh derivation of this tree; '
            + 're-take it with --out bin/pins/at1-explorer-identity.json in this wave\'s commit');
    });

    it('the frozen base record is committed, stamped, and never re-taken', function () {
        assert.ok(fs.existsSync(BASE_PIN),
            'bin/pins/at1-explorer-identity.8f251b6.json is not committed');
        const base = JSON.parse(fs.readFileSync(BASE_PIN, 'utf8'));
        assert.strictEqual(base.rev, BASE_REV,
            'the base record does not name the tree it describes');
        // The live pin must NOT be stamped: a rev in it would differ from every
        // fresh derivation and the byte equality above could never hold.
        const live = JSON.parse(fs.readFileSync(PIN, 'utf8'));
        assert.strictEqual(live.rev, undefined, 'the live pin carries a rev stamp');
        for (const section of ['twins', 'routes', 'fixtures', 'coverage', 'prototype', 'suites']) {
            assert.ok(base[section], `the base record has no ${section} section`);
        }
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
        // Zero enumerable keys is the guarantee the db/index.js carve has to preserve:
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

    it('the base record holds through a rename map, and only when the map explains every move', function () {
        // A record is rewritten in a temp dir to hold OLD paths, the state a pin
        // is in once a wave renames test files. Nothing in the tree is touched:
        // the rename is simulated backwards, on a copy, so this cannot leave the
        // worktree dirty the way a real `git mv` and revert would. The copy is
        // taken from the LIVE pin, the one record that equals this tree; the
        // frozen base also differs by every later refactor, so a rename map alone
        // could never make it compare clean past the first barrier.
        const base = JSON.parse(fs.readFileSync(PIN, 'utf8'));
        const collected = Object.keys(base.suites.scripts)
            .filter((n) => base.suites.scripts[n].files)
            .sort();
        assert.ok(collected.length, 'the base record collected no script to rename a file in');
        const moved = Object.keys(base.suites.scripts[collected[0]].files).sort().slice(0, 2);
        assert.strictEqual(moved.length, 2, 'need two collected files to tell explained from unexplained');
        const oldNameOf = (rel) => path.join(path.dirname(rel), `renamed-away-${path.basename(rel)}`);

        for (const name of collected) {
            const files = base.suites.scripts[name].files;
            for (const rel of moved) {
                if (!(rel in files)) continue;
                files[oldNameOf(rel)] = files[rel];
                delete files[rel];
            }
        }
        const movedPin = path.join(tmpDir, 'base-pre-rename.json');
        fs.writeFileSync(movedPin, JSON.stringify(base, null, 2));

        // Without the map the renames have to READ as differences, or the map
        // proves nothing: a comparison that ignored file identity would pass both
        // ways and this test would be asserting on air.
        const bare = runTool(['--compare', movedPin]);
        assert.strictEqual(bare.status, 1, 'renamed test files did not fail the comparison');
        for (const rel of moved) {
            assert.ok(bare.stdout.includes(`file_dropped [${collected[0]}] ${oldNameOf(rel)}`)
                || bare.stdout.includes(`file_added [${collected[0]}] ${rel}`),
                `the bare comparison did not report ${rel}:\n${bare.stdout.slice(0, 800)}`);
        }

        // A map that explains only ONE of the two moves must still fail, or the
        // map would be a blanket amnesty on test paths rather than a declaration.
        const partialPath = path.join(tmpDir, 'rename-map-partial.json');
        fs.writeFileSync(partialPath, JSON.stringify({ [oldNameOf(moved[0])]: moved[0] }, null, 2));
        const partial = runTool(['--compare', movedPin, '--rename-map', partialPath]);
        assert.strictEqual(partial.status, 1, 'an incomplete rename map was accepted');
        assert.ok(partial.stdout.includes(oldNameOf(moved[1])) || partial.stdout.includes(moved[1]),
            `the unexplained move was not named:\n${partial.stdout.slice(0, 800)}`);

        const fullPath = path.join(tmpDir, 'rename-map-full.json');
        fs.writeFileSync(fullPath, JSON.stringify(
            Object.fromEntries(moved.map((rel) => [oldNameOf(rel), rel])), null, 2));
        const full = runTool(['--compare', movedPin, '--rename-map', fullPath]);
        assert.strictEqual(full.status, 0,
            `the complete rename map did not resolve the moves:\n${full.stdout.slice(0, 800)}`);
        assert.match(full.stdout, /through the declared rename map/);
    });

    it('a pin with no title map fails by default and passes only under --no-suites', function () {
        const pin = JSON.parse(fs.readFileSync(PIN, 'utf8'));
        delete pin.suites;
        const suiteless = path.join(tmpDir, 'no-suites.json');
        fs.writeFileSync(suiteless, JSON.stringify(pin, null, 2));

        const strict = runTool(['--compare', suiteless]);
        assert.strictEqual(strict.status, 1, 'a pin with no title map compared clean by default');
        assert.match(strict.stdout, /section_missing/);

        const relaxed = runTool(['--compare', suiteless, '--no-suites']);
        assert.strictEqual(relaxed.status, 0,
            `--no-suites did not accept the suiteless pin:\n${relaxed.stdout.slice(0, 800)}`);

        // The flag narrows a comparison; a pin written without the title map
        // could never fail on a dropped suite, so writing one is refused.
        const written = runTool(['--out', path.join(tmpDir, 'refused.json'), '--no-suites']);
        assert.strictEqual(written.status, 2, '--no-suites was accepted on a written pin');
        assert.match(written.stderr, /comparison flag/);
    });
});
