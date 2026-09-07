// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Guard for the integration-fixture preflight
// (test/integration/helpers/fixture-preflight.js).
//
// It runs in the DB-free unit suite because the fault it guards is precisely
// the one that makes every DB tier unrunnable: when a foreign server holds
// 127.0.0.1:3307 the fixture container cannot bind, and an unguarded tier
// reports only "Access denied for user 'root'@'127.0.0.1'" (measured
// 2026-09-02, against a native mariadbd holding the port). A guard living in a
// DB tier could never run on the host where that happens.

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const pre = require('../integration/helpers/fixture-preflight.js');

const REPO = path.join(__dirname, '..', '..');

// The real docker failure captured 2026-09-02.
const DOCKER_BIND_FAILURE =
    'Error response from daemon: failed to set up container networking: driver failed programming ' +
    'external connectivity on endpoint xchain-explorer-it-mariadb-test-1 (7ea9773b0ba4): ' +
    'failed to bind host port 0.0.0.0:3307/tcp: address already in use';

// The pooled error shape the DB tiers actually produced: the surface message
// says nothing about credentials, and the handshake rejection is the cause.
function pooledAccessDenied() {
    const cause = new Error(
        "(conn:4, no: 1045, SQLState: 28000) Access denied for user 'root'@'127.0.0.1' (using password: YES)");
    cause.errno = 1045;
    return new Error(
        '(conn:-1, no: 45028, SQLState: HY000) pool failed to retrieve a connection from pool',
        { cause });
}

describe('integration fixture preflight', function () {

    describe('bind-collision detection', function () {
        it('recognises the docker bind failure the venue produced', function () {
            assert.ok(pre.isBindCollisionOutput(DOCKER_BIND_FAILURE));
        });

        it('recognises the other engine wordings for the same fault', function () {
            assert.ok(pre.isBindCollisionOutput(
                'Error starting userland proxy: listen tcp4 0.0.0.0:3307: bind: address already in use'));
            assert.ok(pre.isBindCollisionOutput(
                'Bind for 0.0.0.0:3307 failed: port is already allocated'));
            assert.ok(pre.isBindCollisionOutput(
                'Ports are not available: exposing port TCP 0.0.0.0:3307 -> 127.0.0.1:0'));
        });

        it('does not call an unrelated bring-up failure a collision', function () {
            assert.ok(!pre.isBindCollisionOutput(
                'Error response from daemon: pull access denied for mariadb, repository does not exist'));
            assert.ok(!pre.isBindCollisionOutput('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'));
            assert.ok(!pre.isBindCollisionOutput(''));
            assert.ok(!pre.isBindCollisionOutput(undefined));
        });
    });

    describe('foreign-server error recognition', function () {
        it('sees through the pool wrapper to the handshake rejection', function () {
            assert.ok(pre.looksLikeForeignServerError(pooledAccessDenied()));
        });

        it('recognises a host-not-allowed refusal', function () {
            const err = new Error("Host '10.0.0.9' is not allowed to connect to this MariaDB server");
            err.errno = 1130;
            assert.ok(pre.looksLikeForeignServerError(err));
        });

        it('leaves a genuine connection failure alone', function () {
            const err = new Error('connect ECONNREFUSED 127.0.0.1:3307');
            err.code = 'ECONNREFUSED';
            assert.ok(!pre.looksLikeForeignServerError(err));
        });

        it('leaves an unrelated SQL error alone', function () {
            const err = new Error("Table 'XChain_BTC_Regtest_Indexer.actions' doesn't exist");
            err.errno = 1146;
            assert.ok(!pre.looksLikeForeignServerError(err));
        });
    });

    describe('probeFixture classification', function () {
        const never = async () => { throw new Error('auth must not be attempted'); };

        it('calls a silent port absent, not foreign', async function () {
            const res = await pre.probeFixture({ tcp: async () => false, auth: never });
            assert.strictEqual(res.state, 'absent');
        });

        it('calls a server that accepts the fixture credentials the fixture', async function () {
            const res = await pre.probeFixture({ tcp: async () => true, auth: async () => {} });
            assert.strictEqual(res.state, 'fixture');
        });

        it('calls a server that refuses them foreign, and keeps what it said', async function () {
            const res = await pre.probeFixture({
                tcp:  async () => true,
                auth: async () => { throw pooledAccessDenied(); }
            });
            assert.strictEqual(res.state, 'foreign');
            assert.match(res.detail, /pool failed to retrieve a connection/);
        });

        it('does not claim a collision for an unrecognised failure', async function () {
            const res = await pre.probeFixture({
                tcp:  async () => true,
                auth: async () => { throw new Error('handshake timed out'); }
            });
            assert.strictEqual(res.state, 'unknown');
        });
    });

    describe('the report', function () {
        it('names the port, the fixture file, and both ways out', function () {
            const msg = pre.collisionMessage("Access denied for user 'root'@'127.0.0.1'", []);
            assert.match(msg, /3307/);
            assert.match(msg, /PORT COLLISION/);
            assert.match(msg, /docker-compose\.test\.yml/);
            assert.match(msg, /stop whatever holds/);
            assert.match(msg, /move that service off/);
        });

        it('quotes the holder when the host could identify one', function () {
            const msg = pre.collisionMessage('Access denied', ['ss: LISTEN 127.0.0.1:3307 users:(("mariadbd",pid=3506253))']);
            assert.match(msg, /mariadbd/);
            assert.match(msg, /pid=3506253/);
        });

        it('tells the operator how to look when nothing identified the holder', function () {
            assert.match(pre.collisionMessage('Access denied', []), /ss -ltnp/);
        });

        it('says NOT RUNNING, not COLLISION, when the port is silent', function () {
            const msg = pre.absentMessage();
            assert.match(msg, /NOT RUNNING/);
            assert.match(msg, /test:integration:up/);
            assert.ok(!/COLLISION/.test(msg));
        });
    });

    describe('describeHolders', function () {
        it('keeps only the lines that mention the fixture port', function () {
            const runner = (cmd) => cmd === 'ss'
                ? 'LISTEN 0 80 127.0.0.1:3306 0.0.0.0:*\nLISTEN 0 250 127.0.0.1:3307 0.0.0.0:* users:(("mariadbd",pid=1))\n'
                : '';
            const holders = pre.describeHolders(runner);
            assert.strictEqual(holders.length, 1);
            assert.match(holders[0], /^ss: LISTEN .*3307/);
        });

        it('survives a host where none of the probe commands exist', function () {
            const holders = pre.describeHolders(() => { throw new Error('ENOENT'); });
            assert.deepStrictEqual(holders, []);
        });
    });

    describe('decorateFixtureError', function () {
        it('replaces the misleading access-denied with the collision report', function () {
            const decorated = pre.decorateFixtureError(pooledAccessDenied(), []);
            assert.ok(decorated.fixtureCollision);
            assert.match(decorated.message, /PORT COLLISION/);
            assert.match(decorated.message, /3307/);
            assert.match(decorated.message, /Access denied for user 'root'/);
        });

        it('keeps the original error as the cause, so nothing is hidden', function () {
            const original = pooledAccessDenied();
            assert.strictEqual(pre.decorateFixtureError(original, []).cause, original);
        });

        it('passes any other error through untouched', function () {
            const err = new Error('connect ECONNREFUSED 127.0.0.1:3307');
            assert.strictEqual(pre.decorateFixtureError(err, []), err);
        });
    });

    describe('wiring', function () {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));

        it('routes the fixture lifecycle scripts through the preflighting wrapper', function () {
            // A revert to a bare `docker compose up` reinstates the fault: the
            // bind failure becomes a networking stack trace and the tiers run on
            // whatever else answers.
            for (const name of ['test:integration:up', 'test:integration:down', 'test:integration:check']) {
                assert.match(pkg.scripts[name], /bin\/db-fixture\.js/, `${name} must go through the wrapper`);
            }
        });

        it('preflights before the integration files run', function () {
            const runner = fs.readFileSync(path.join(REPO, 'bin', 'run-integration.sh'), 'utf8');
            const check = runner.indexOf('db-fixture.js check');
            const loop  = runner.indexOf('for f in test/integration');
            assert.ok(check > -1, 'run-integration.sh must preflight the fixture');
            assert.ok(check < loop, 'the preflight must run before the per-file loop');
        });

        it('stops the venue gate from running a DB tier without a fixture', function () {
            const ciFull = fs.readFileSync(path.join(REPO, 'bin', 'ci-full.sh'), 'utf8');
            // perf and integration read the fixture address from source, so a
            // failed bring-up leaves them talking to whatever holds the port.
            assert.match(ciFull, /db_tier\s+"perf/);
            assert.match(ciFull, /db_tier\s+"integration/);
            assert.match(ciFull, /FIXTURE_OK=0/);
        });

        it('keeps the fixture address in one place', function () {
            const compose = fs.readFileSync(
                path.join(REPO, 'test', 'integration', 'fixtures', 'docker-compose.test.yml'), 'utf8');
            assert.match(compose, new RegExp(`"${pre.FIXTURE_DB.port}:3306"`),
                'the compose file must publish the port the preflight probes');
            const dbSetup = require('../integration/helpers/db-setup.js');
            assert.strictEqual(dbSetup.DB_CONFIG.port, pre.FIXTURE_DB.port);
            assert.strictEqual(dbSetup.DB_CONFIG.host, pre.FIXTURE_DB.host);
            assert.strictEqual(dbSetup.DB_CONFIG.database, pre.FIXTURE_DB.database);
        });
    });
});
