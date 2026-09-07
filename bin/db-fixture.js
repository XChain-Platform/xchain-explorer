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
 * Lifecycle wrapper for the integration MariaDB fixture (port 3307).
 *
 *   up    - refuse to start when a foreign server already holds 3307, then
 *           `docker compose up -d --wait`, translating a bind failure into a
 *           port-collision report instead of leaving docker's endpoint-
 *           programming stack trace as the only clue
 *   down  - `docker compose down -v`
 *   check - assert the thing answering on 3307 IS the fixture; used by
 *           bin/run-integration.sh so a collision fails ONCE, loudly, up front
 *           rather than 18 times as "Access denied for user 'root'"
 *
 * The npm scripts test:integration:up / :down route through here, so both the
 * local venue gate (bin/ci-full.sh) and a hand run get the same diagnosis.
 * GitHub CI supplies the fixture as an Actions service container and never runs
 * `up`, but `check` still passes there because the discrimination is by
 * credentials, not by container identity.
 */

const { spawnSync } = require('child_process');
const path          = require('path');

const pre = require('../test/integration/helpers/fixture-preflight.js');

const REPO = path.join(__dirname, '..');

function compose(args, opts) {
    return spawnSync('docker', ['compose', '-f', pre.COMPOSE_FILE, ...args], {
        cwd:      REPO,
        encoding: 'utf8',
        ...(opts || {})
    });
}

function fail(message) {
    console.error(message);
    process.exit(1);
}

// Report a foreign holder once, with whatever the host can tell us about it.
function reportCollision(detail) {
    fail(pre.collisionMessage(detail, pre.describeHolders()));
}

async function up() {
    // Preflight BEFORE docker: when the port is already held, compose's own
    // failure is a networking-driver stack trace, and worse, a stale fixture
    // container from a previous run may still satisfy `--wait` while the
    // foreign server is the one actually reachable on 3307.
    const probe = await pre.probeFixture();
    if (probe.state === 'foreign') reportCollision(probe.detail);
    if (probe.state === 'unknown') {
        fail(`explorer integration fixture: 127.0.0.1:${pre.FIXTURE_DB.port} answered but the probe ` +
             `failed in a way this script does not recognise: ${probe.detail}`);
    }

    const res = compose(['up', '-d', '--wait'], { stdio: ['inherit', 'inherit', 'pipe'] });
    const stderr = res.stderr || '';
    if (stderr) process.stderr.write(stderr);
    if (res.status === 0) return;

    if (pre.isBindCollisionOutput(stderr)) {
        console.error('');
        reportCollision('docker could not bind the host port: ' + stderr.trim().split('\n').pop());
    }
    process.exit(res.status === null ? 1 : res.status);
}

function down() {
    const res = compose(['down', '-v'], { stdio: 'inherit' });
    process.exit(res.status === null ? 1 : res.status);
}

async function check() {
    const probe = await pre.probeFixture();
    if (probe.state === 'fixture') return;
    if (probe.state === 'absent')  fail(pre.absentMessage());
    if (probe.state === 'foreign') reportCollision(probe.detail);
    fail(`explorer integration fixture: unusable server on 127.0.0.1:${pre.FIXTURE_DB.port}: ${probe.detail}`);
}

async function main() {
    const cmd = process.argv[2];
    if (cmd === 'up')    return up();
    if (cmd === 'down')  return down();
    if (cmd === 'check') return check();
    fail('usage: node bin/db-fixture.js <up|down|check>');
}

if (require.main === module) {
    main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
}

module.exports = { up, down, check };
