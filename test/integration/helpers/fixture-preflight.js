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
 * Preflight for the integration MariaDB fixture on 127.0.0.1:3307.
 *
 * Why this exists: the fixture publishes a FIXED host port (3307), because the
 * DB tiers read that address from source and the GitHub CI service containers
 * publish the same one. On a host where something else already listens there
 * (measured 2026-09-02 against a native mariadbd on 127.0.0.1:3307), the
 * compose bring-up fails with "failed to bind host port ... address already in
 * use" and every DB-tier test then connects to the FOREIGN server, which
 * refuses the fixture's root password. The tiers therefore red-gate a healthy
 * commit with "Access denied for user 'root'@'127.0.0.1'", an error that names
 * neither the port nor the collision, and readers chase a credential bug that
 * does not exist.
 *
 * The discrimination here is by CREDENTIALS, not by container identity: on
 * GitHub the fixture is an Actions service container with no compose project
 * at all, so "is our compose container up" would be false there while the
 * fixture is perfectly healthy. A server that accepts the fixture credentials
 * IS the fixture for these tiers' purposes; one that answers and refuses them
 * is a foreign server holding the port.
 *
 * There is a third case, and it resolves the collision rather than reporting it.
 * A CI venue may run one shared MariaDB for gate runs and publish its
 * credentials in a 0600 env file; where that file is present the server on the
 * port is not foreign at all, it is the database to use. FIXTURE_DB then
 * resolves to it and the lifecycle wrapper skips docker entirely, which is why
 * the address is read from here and never written at a call site.
 */

const fs  = require('fs');
const net = require('net');

const FIXTURE_DATABASE = 'XChain_BTC_Regtest_Indexer';

// Presence of this file means the host provides a shared CI database and this
// repo must use it rather than publish its own on the same fixed port.
const VENUE_ENV_PATH = process.env.XCHAIN_VENUE_ENV || '/misc/ci/venue.env';

// Null unless all four keys parse, so a partial file falls back to the container
// fixture instead of connecting with undefined parts. Never throws: this runs at
// module load on every host, including ones with no venue.
function readVenueDb(envPath) {
    let raw;
    try {
        raw = fs.readFileSync(envPath || VENUE_ENV_PATH, 'utf8');
    } catch {
        return null;
    }
    const env = {};
    for (const line of raw.split('\n')) {
        const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
        if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    const port = Number(env.CI_DB_PORT);
    if (!env.CI_DB_HOST || !env.CI_DB_USER || !env.CI_DB_PASS || !Number.isInteger(port)) return null;
    return {
        host:     env.CI_DB_HOST,
        port,
        user:     env.CI_DB_USER,
        password: env.CI_DB_PASS,
        database: FIXTURE_DATABASE
    };
}

const VENUE_DB = readVenueDb();

// Tells the lifecycle wrapper not to run docker, and never to tear down a server
// it does not own.
const USING_VENUE = VENUE_DB !== null;

// What docker-compose.test.yml publishes and the Actions service containers map.
// Named so the guard can pin the compose file against it even on a venue, where
// FIXTURE_DB is a different address.
const CONTAINER_DB = {
    host:     '127.0.0.1',
    port:     3307,
    user:     'root',
    password: 'testpass',
    database: FIXTURE_DATABASE
};

// The one place the fixture address lives, and what helpers/db-setup.js builds
// its pool config from: the venue server where there is one, the container
// fixture everywhere else.
const FIXTURE_DB = VENUE_DB || CONTAINER_DB;

const COMPOSE_FILE = 'test/integration/fixtures/docker-compose.test.yml';

// Docker phrases a host-port bind collision differently per platform and per
// engine version; these are the ones seen in the wild (Linux engine, Docker
// Desktop on macOS, and the older "port is already allocated" wording).
const BIND_COLLISION_PATTERNS = [
    /failed to bind host port/i,
    /address already in use/i,
    /port is already allocated/i,
    /ports are not available/i,
    /bind for [\d.:]+ failed/i
];

// True when docker's output describes a host-port bind collision rather than
// any other bring-up failure (a pull failure, a bad compose file, no daemon).
function isBindCollisionOutput(text) {
    if (!text) return false;
    return BIND_COLLISION_PATTERNS.some((re) => re.test(String(text)));
}

// Walk an error and its `cause` chain. The mariadb pool wraps the real failure:
// the surface error is "pool failed to retrieve a connection from pool" and the
// handshake rejection hangs off `.cause`, so matching only the top error misses
// every pooled call site.
function errorChain(err) {
    const chain = [];
    let cur = err;
    while (cur && chain.length < 10) {
        chain.push(cur);
        cur = cur.cause;
    }
    return chain;
}

// MariaDB errnos that mean "the server answered and rejected us": access denied
// (1045), account/database privilege refusals, and host-not-allowed. Any of
// them against the fixture address means something other than the fixture is
// listening, because the fixture container is created with this exact root
// password and grants root from any host.
const REJECTION_ERRNOS = new Set([1044, 1045, 1130, 1698, 1862, 1820]);

// True when the error signature is "a MariaDB/MySQL server answered on the
// fixture port and refused these credentials".
function looksLikeForeignServerError(err) {
    return errorChain(err).some((e) =>
        REJECTION_ERRNOS.has(e.errno) ||
        /access denied/i.test(e.message || '') ||
        /not allowed to connect/i.test(e.message || ''));
}

// Best-effort identification of whatever holds the port, so the operator does
// not have to log in to find out. Every probe is optional: the commands may be
// absent, and ss/lsof only name the owning process when run as root, so a run
// that yields nothing is normal and must not turn into an error of its own.
function describeHolders(runner) {
    const run = runner || defaultRunner;
    const port   = String(FIXTURE_DB.port);
    const probes = [
        ['docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}} {{.Ports}}']],
        ['ss',     ['-ltnp']],
        ['lsof',   ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']]
    ];
    const lines = [];
    for (const [cmd, args] of probes) {
        let out;
        try { out = run(cmd, args); } catch { continue; }
        if (!out) continue;
        for (const line of String(out).split('\n')) {
            // ss and docker ps print every listener, so keep only the rows that
            // actually mention the fixture port.
            if (line.includes(port) && line.trim()) lines.push(`${cmd}: ${line.trim()}`);
        }
    }
    return lines;
}

function defaultRunner(cmd, args) {
    const { spawnSync } = require('child_process');
    const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
    if (res.error || res.status !== 0) return '';
    return res.stdout || '';
}

// Raw TCP reachability: is ANYTHING listening on the fixture address? Separated
// from the credential probe so "nothing there" (fixture not started) never gets
// misread as "a foreign server refused us".
function probeTcp(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        const done = (listening) => {
            sock.removeAllListeners();
            sock.destroy();
            resolve(listening);
        };
        sock.setTimeout(timeoutMs || 3000);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
        sock.connect(port, host);
    });
}

// Credential probe: connect as the fixture root user. Resolves on success and
// rejects with the server's error, which is what tells foreign from fixture.
async function probeAuth() {
    const mariadb = require('mariadb');
    const conn = await mariadb.createConnection({
        host:           FIXTURE_DB.host,
        port:           FIXTURE_DB.port,
        user:           FIXTURE_DB.user,
        password:       FIXTURE_DB.password,
        connectTimeout: 5000
    });
    await conn.end();
}

/**
 * Classify what is on 127.0.0.1:3307.
 *   absent  - nothing is listening; the fixture simply is not up
 *   fixture - a server that accepts the fixture credentials (compose container
 *             locally, Actions service container on GitHub)
 *   foreign - a server that answers and refuses them: a port collision, which
 *             an unguarded DB tier reports only as "Access denied"
 *
 * `tcp` and `auth` are injectable so the unit guard can exercise every branch
 * without a database.
 */
async function probeFixture(deps) {
    const tcp  = (deps && deps.tcp)  || (() => probeTcp(FIXTURE_DB.host, FIXTURE_DB.port));
    const auth = (deps && deps.auth) || probeAuth;

    if (!(await tcp())) return { state: 'absent', detail: null };
    try {
        await auth();
        return { state: 'fixture', detail: null };
    } catch (err) {
        return {
            state:  looksLikeForeignServerError(err) ? 'foreign' : 'unknown',
            detail: err && err.message ? err.message.split('\n')[0] : String(err)
        };
    }
}

const RULE = '='.repeat(66);

// The loud report. It names the port, says the fixture cannot bind, quotes what
// the foreign server said, lists whatever holds the port, and gives the two
// ways out. This is the message that replaces a bare "Access denied".
function collisionMessage(detail, holders) {
    const lines = [
        RULE,
        `  PORT COLLISION: 127.0.0.1:${FIXTURE_DB.port} IS HELD BY A FOREIGN SERVER`,
        RULE,
        `Something is already listening on 127.0.0.1:${FIXTURE_DB.port} and it is NOT this repo's`,
        'MariaDB test fixture: it answered and refused the fixture root password.',
        '',
        `The fixture (${COMPOSE_FILE}) publishes`,
        `${FIXTURE_DB.port} as a fixed host port, so it cannot bind while that server holds it,`,
        'and every DB-tier test would then run against the foreign server and fail',
        'with a misleading access-denied error instead of this one.'
    ];
    if (detail) lines.push('', `The server on ${FIXTURE_DB.port} said: ${detail}`);
    if (holders && holders.length) {
        lines.push('', 'What holds the port (best effort; process names need root):');
        for (const h of holders) lines.push(`  ${h}`);
    } else {
        lines.push('', `Nothing identified the holder here. On the venue run: sudo ss -ltnp | grep :${FIXTURE_DB.port}`);
    }
    lines.push(
        '',
        'Fix one of these, then re-run:',
        `  - if that server IS a shared CI database, point this repo at it instead of`,
        `    starting our own: write ${VENUE_ENV_PATH} (0600) with CI_DB_HOST,`,
        '    CI_DB_PORT, CI_DB_USER and CI_DB_PASS, and the fixture will use it and',
        '    never try to bind the port at all,',
        `  - or stop whatever holds ${FIXTURE_DB.host}:${FIXTURE_DB.port} on this host,`,
        `  - or move that service off ${FIXTURE_DB.port} (this port is fixed by the committed`,
        '    compose file and by the GitHub CI service containers, so the fixture itself',
        '    cannot simply be repointed).',
        RULE
    );
    return lines.join('\n');
}

// Message for "the fixture is not running at all", which is a different fault
// with a different fix and must not be dressed up as a collision.
function absentMessage() {
    return [
        RULE,
        `  INTEGRATION FIXTURE NOT RUNNING: nothing listens on 127.0.0.1:${FIXTURE_DB.port}`,
        RULE,
        'Start it first:  npm run test:integration:up',
        RULE
    ].join('\n');
}

/**
 * Turn a fixture connection failure into an error that names the port
 * collision. Used at the DB-tier call sites so a suite run by hand (mocha
 * directly, no preflight) still reports the real fault. An error that is not a
 * credential rejection is returned untouched: a genuine credential bug in a
 * future fixture change must not be relabelled as a collision.
 */
function decorateFixtureError(err, holders) {
    if (!looksLikeForeignServerError(err)) return err;
    const detail = errorChain(err)
        .map((e) => e.message && e.message.split('\n')[0])
        .find((m) => m && /access denied|not allowed to connect/i.test(m));
    const decorated = new Error(
        `explorer integration fixture: connection to 127.0.0.1:${FIXTURE_DB.port} was REFUSED by the ` +
        'server answering there, which means the fixture container never bound the port.\n' +
        collisionMessage(detail, holders || describeHolders()),
        { cause: err }
    );
    decorated.fixtureCollision = true;
    return decorated;
}

module.exports = {
    FIXTURE_DB,
    FIXTURE_DATABASE,
    CONTAINER_DB,
    COMPOSE_FILE,
    USING_VENUE,
    VENUE_ENV_PATH,
    readVenueDb,
    isBindCollisionOutput,
    looksLikeForeignServerError,
    describeHolders,
    probeTcp,
    probeFixture,
    collisionMessage,
    absentMessage,
    decorateFixtureError
};
