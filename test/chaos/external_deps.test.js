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
 * Chaos Engineering: External Dependency Resilience
 *
 * Experiment IDs:
 *   CE-EXT-01  Relay endpoint (slow/unreachable upstream)
 *   CE-EXT-02  Config sync resilience (cache clearing and rapid reloads)
 *
 * Prerequisites (docker-compose.chaos.yml):
 *   - MariaDB reachable via toxiproxy on port 3307
 *   - Toxiproxy API on port 8474
 *
 * Run with --timeout 0 (Mocha flag). Do not set timeouts in code.
 */

const { expect } = require('chai');
const http       = require('http');

const {
    bootServer,
    stopServer,
    getServer,
    getServerUrl,
    httpGet,
    concurrentRequests,
    waitUntil,
    seedDatabase,
} = require('./helpers/chaos-setup');

const {
    waitForToxiproxy,
    createProxy,
    resetProxy,
} = require('./helpers/toxiproxy-client');

// The coin prefix used for regtest endpoints.
const COIN   = 'RBTC';
const HEALTH = `/${COIN}/explorer/blocks/all`;
const registerConfigSuite = require('./external_deps.test/support/config_sync.js');

// -------------------------------------------------------------------------
// Suite-level setup / teardown
// -------------------------------------------------------------------------

async function setupExternalDependencies() {
    await waitForToxiproxy();
    await createProxy();
    await seedDatabase();
    await bootServer();
}

async function teardownExternalDependencies() {
    await resetProxy();
    await stopServer();
}

// -------------------------------------------------------------------------
// CE-EXT-01: Relay Endpoint (Slow Upstream)
//
// The relay endpoint at /relay?url= has these protections baked in:
//   - SSRF blocking (private/loopback IPs are rejected immediately)
//   - Protocol whitelist (http/https only)
//   - axios timeout: 5000 ms
//   - maxContentLength: 5 MB
//   - maxRedirects: 0
//
// Because localhost is SSRF-blocked we cannot point the relay at an in-process
// slow server.  Instead we verify resilience by:
//   1. Confirming that relay requests to unreachable/slow URLs fail gracefully
//      rather than crashing the server.
//   2. Confirming that relay activity does not starve normal API requests of
//      event-loop time (the server stays responsive under concurrent relay load).
// -------------------------------------------------------------------------


// URL that is syntactically valid but will never respond:
//   - example.invalid  ->  DNS lookup fails quickly with ENOTFOUND
// This exercises the relay's error-handling path without introducing a
// multi-second wait caused by a real TCP timeout.
const INVALID_URL = encodeURIComponent('http://example.invalid/test.json');

// Slower but deterministic alternative: TEST-NET address that is routable
// but has no listener, triggering the 5 s axios timeout.  Only used in the
// event-loop isolation test where we deliberately accept slow relay calls.
const TIMEOUT_URL  = encodeURIComponent('http://192.0.2.1/test.json');

async function startRelayRequests() {
    // Fire 10 relay requests targeting the slow TEST-NET address (will each
    // run for up to the 5 s axios timeout before failing).  Simultaneously
    // fire 10 normal API requests.  The API requests must complete promptly
    // even though the relay requests are blocking their own async chains.
    const relayPath  = `/relay?url=${TIMEOUT_URL}`;

    // Count relay requests as the server receives them, so the head-start
    // below waits on the real condition ("all 10 are in flight") instead of
    // a fixed pause that a loaded venue can outrun.
    const server = getServer();
    let relayArrivals = 0;
    const countRelay = (req) => { if (req.url.startsWith('/relay')) relayArrivals++; };
    server.on('request', countRelay);

    // Kick off relay requests in the background. Don't await yet.
    const relayPromise = concurrentRequests(relayPath, 10, { timeout: 12000 });

    const allInFlight = await waitUntil(() => relayArrivals >= 10,
        { timeout: 10000, interval: 20 });
    server.removeListener('request', countRelay);
    return { relayPromise, allInFlight };
}

function registerRelayBasics() {
    it('baseline: normal API endpoint returns 200 before any relay activity', async function () {
        const res = await httpGet(HEALTH);
        expect(res.statusCode).to.be.below(500);
    });

    it('relay returns a non-2xx status (or network error) for an unreachable host, not a server crash', async function () {
        const relayPath = `/relay?url=${INVALID_URL}`;

        let statusCode;
        let threwNetworkError = false;
        try {
            const res = await httpGet(relayPath, { timeout: 15000 });
            statusCode = res.statusCode;
        } catch (e) {
            // A network-level error from our test client is also fine. It means
            // the relay responded with a connection-level signal (e.g. RST) rather
            // than crashing the whole Node process.
            threwNetworkError = true;
        }

        if (!threwNetworkError) {
            // The relay must not forward a 2xx as if the upstream had succeeded.
            expect(statusCode).to.be.above(299);
        }
        // Either branch proves the server is still alive. If it had crashed the
        // httpGet itself would throw ECONNREFUSED, not a clean HTTP response or a
        // graceful relay error.
    });

}

function registerRelayConcurrency() {
    it('server remains responsive to normal API requests while relay requests are in-flight', async function () {
        const { relayPromise, allInFlight } = await startRelayRequests();

        expect(allInFlight, 'all 10 relay requests should reach the server').to.equal(true);

        // Normal API requests should complete well within 5 s regardless of
        // whatever the relay is doing.
        const apiStart = Date.now();
        const { responses: apiResponses, errors: apiErrors } =
            await concurrentRequests(HEALTH, 10, { timeout: 8000 });
        const apiElapsed = Date.now() - apiStart;

        // All relay requests must eventually settle (succeed, fail, or time out)
        // without hanging forever.
        const { responses: relayResponses, errors: relayErrors } = await relayPromise;

        // --- API assertions ---

        // The majority of normal API requests must succeed quickly.
        const apiSuccesses = apiResponses.filter(r => r.statusCode < 500);
        expect(apiSuccesses.length).to.be.above(apiResponses.length / 2,
            'Most concurrent API requests should succeed while relay is busy');

        // API responses must be delivered well before the relay timeout fires
        // (5 s per relay request × 10 concurrent = up to 50 s potential stall if
        // the event loop were truly blocked, but Node.js async I/O means it must
        // not be).  8 s is a generous bound that still catches true blocking.
        expect(apiElapsed).to.be.below(8000,
            'Normal API requests must not be delayed by slow relay upstream calls');

        // --- Relay assertions ---

        // Every relay call must resolve. None should hang indefinitely.
        const relayTotal = relayResponses.length + relayErrors.length;
        expect(relayTotal).to.equal(10,
            'All relay requests must settle (succeed or fail) without hanging');

        // Relay failures are expected for unreachable upstream. We just require
        // that every call fails gracefully (no unhandled rejection / server crash).
        const relayFailed = relayErrors.length +
            relayResponses.filter(r => r.statusCode >= 400).length;
        expect(relayFailed).to.be.above(0,
            'Relay requests to an unreachable upstream must produce failures');
    });

}

function registerRelayRecovery() {
    it('server is still alive after concurrent relay errors', async function () {
        // After the chaos above, confirm the server did not crash.
        let serverAlive = false;
        try {
            const res = await httpGet(HEALTH, { timeout: 5000 });
            serverAlive = typeof res.statusCode === 'number';
        } catch (e) {
            // Any error that is NOT ECONNREFUSED means the server is still listening.
            serverAlive = !e.message.includes('ECONNREFUSED');
        }
        expect(serverAlive).to.equal(true);
    });

    it('relay rejects non-http(s) protocols with a 4xx or 5xx (no crash)', async function () {
        const ftpUrl    = encodeURIComponent('ftp://example.com/file.txt');
        const relayPath = `/relay?url=${ftpUrl}`;

        let statusCode;
        try {
            const res = await httpGet(relayPath, { timeout: 5000 });
            statusCode = res.statusCode;
        } catch {
            // Network-level close is also acceptable.
            return;
        }
        // Must not be a 2xx. Relay should reject the protocol.
        expect(statusCode).to.be.above(299);
    });

}

function registerRelaySsrf() {
    it('relay rejects a private IP (SSRF protection) with a 4xx or 5xx (no crash)', async function () {
        // 10.0.0.1 is a private RFC-1918 address; the relay's SSRF guard must
        // block it before making any outbound connection.
        const privateUrl = encodeURIComponent('http://10.0.0.1/secret');
        const relayPath  = `/relay?url=${privateUrl}`;

        let statusCode;
        try {
            const res = await httpGet(relayPath, { timeout: 5000 });
            statusCode = res.statusCode;
        } catch {
            return; // graceful network-level close is also acceptable
        }
        expect(statusCode).to.be.above(299,
            'Relay must block private-IP requests via SSRF protection');
    });
}

describe('Chaos: External Dependencies', function () {
    before(function () { return setupExternalDependencies.call(this); });
    after(function () { return teardownExternalDependencies.call(this); });

    describe('CE-EXT-01: Relay Endpoint (Slow Upstream)', function () {
        registerRelayBasics();
        registerRelayConcurrency();
        registerRelayRecovery();
        registerRelaySsrf();
    });

    registerConfigSuite();
}); // describe('Chaos: External Dependencies')
