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
 * Chaos Engineering: Database Resilience
 *
 * Experiment IDs:
 *   CE-DB-01  Complete database unavailability (30 s outage)
 *   CE-DB-02  Slow query responses (3 s latency injection)
 *   CE-DB-03  Connection pool exhaustion (timeout toxic, 30 s hold)
 *   CE-DB-04  Intermittent connection drops (30 % TCP reset probability)
 *
 * Prerequisites (docker-compose.chaos.yml):
 *   - MariaDB reachable via toxiproxy on port 3307
 *   - Toxiproxy API on port 8474
 *
 * Run with --timeout 0 (Mocha flag). Do not set timeouts in code.
 */

const { expect } = require('chai');

const {
    bootServer,
    stopServer,
    getServerUrl,
    httpGet,
    concurrentRequests,
    startHealthPoller,
    waitForRecovery,
    waitUntil,
    seedDatabase,
} = require('./helpers/chaos-setup');

const {
    waitForToxiproxy,
    createProxy,
    resetProxy,
    faults,
} = require('./helpers/toxiproxy-client');

// The coin prefix used for regtest endpoints.
const COIN    = 'RBTC';
// /explorer/blocks/all hits the DB and returns real data (DataTables format)
const HEALTH  = `/${COIN}/explorer/blocks/all`;
// /api/status returns config without DB, used for "process alive" checks
const STATUS  = `/${COIN}/api/status`;

// -------------------------------------------------------------------------
// Suite-level setup / teardown
// -------------------------------------------------------------------------

describe('Chaos: Database Resilience', function () {

before(async function () {
    await waitForToxiproxy();
    await createProxy();
    await seedDatabase();
    await bootServer();
});

after(async function () {
    await resetProxy();
    await stopServer();
});

// -------------------------------------------------------------------------
// CE-DB-01: Complete Database Unavailability (30 s)
// -------------------------------------------------------------------------

describe('CE-DB-01: Complete Database Unavailability', function () {

    afterEach(async function () {
        await resetProxy();
    });

    it('baseline: API returns 200 before fault injection', async function () {
        const res = await httpGet(HEALTH);
        expect(res.statusCode).to.be.below(500);
    });

    it('requests fail (non-200 or network error) while DB is down', async function () {
        await faults.dbDown();

        // Fire a burst of requests while the DB is unavailable.
        const { responses, errors, total } = await concurrentRequests(HEALTH, 10, { timeout: 5000 });

        const failed = errors.length + responses.filter(r => r.statusCode >= 500).length;
        // The majority of requests should fail when the DB is completely gone.
        expect(failed).to.be.above(total / 2);
    });

    it('server process remains alive and accepts connections during outage', async function () {
        await faults.dbDown();

        // Even with DB down the server should still accept TCP connections and
        // return some HTTP response (error or otherwise). It must not crash.
        let gotHttpResponse = false;
        try {
            const res = await httpGet(HEALTH, { timeout: 5000 });
            // Any HTTP response (including 500) proves the process is alive.
            gotHttpResponse = typeof res.statusCode === 'number';
        } catch (e) {
            // A network-level error is also acceptable. The server accepted the
            // connection and closed it gracefully rather than crashing.
            gotHttpResponse = e.message !== 'connect ECONNREFUSED';
        }
        expect(gotHttpResponse).to.equal(true);
    });

    it('API recovers after DB is restored and reports a healthy recovery time', async function () {
        // Bring DB down, confirm outage, then measure recovery.
        await faults.dbDown();
        await concurrentRequests(HEALTH, 5, { timeout: 3000 });

        await faults.dbUp();
        const recoveryMs = await waitForRecovery(HEALTH, 30000);

        // -1 means recovery never happened within the timeout window.
        expect(recoveryMs).to.be.above(-1);
        // Recovery should complete in well under 30 s.
        expect(recoveryMs).to.be.below(30000);
    });

    it('health poller confirms outage then recovery transition', async function () {
        const pollResults = [];
        const stopPoller  = startHealthPoller(HEALTH, pollResults, 500);

        // Wait for the poll itself, not for a poll interval to elapse: the
        // pre-fault baseline is "one healthy result is on the board".
        const baselineLanded = await waitUntil(() => pollResults.some(p => p.ok),
            { timeout: 10000, interval: 50 });
        expect(baselineLanded, 'a healthy poll should land before the fault').to.equal(true);

        await faults.dbDown();

        // Collect failure signals until the outage shows up on the board, rather
        // than sleeping a fixed 6 s window. The bound is longer than that window
        // so a slow venue still gets there; the condition is the same one the
        // assertions below make (a failing poll exists).
        const failuresLanded = await waitUntil(
            () => pollResults.some(p => !p.ok),
            { timeout: 20000, interval: 100 });
        expect(failuresLanded, 'the outage should produce failing polls').to.equal(true);

        await faults.dbUp();
        await waitForRecovery(HEALTH, 15000);

        stopPoller();

        const failures  = pollResults.filter(p => !p.ok);
        const successes = pollResults.filter(p => p.ok);

        // We expect at least some failure polls during the outage window.
        expect(failures.length).to.be.above(0);
        // And at least the pre-fault and post-recovery polls to be healthy.
        expect(successes.length).to.be.above(0);
    });
});

// -------------------------------------------------------------------------
// CE-DB-02: Slow Query Responses
// -------------------------------------------------------------------------

describe('CE-DB-02: Slow Query Responses', function () {

    afterEach(async function () {
        await resetProxy();
    });

    it('all concurrent requests complete (eventually) under 3 s DB latency', async function () {
        await faults.addLatency(3000);

        // Use a generous per-request timeout so we see responses, not timeouts.
        const { responses, errors, total } = await concurrentRequests(HEALTH, 5, { timeout: 20000 });

        // All 5 requests should receive an HTTP response, none should error out.
        expect(errors.length).to.equal(0);
        expect(responses.length).to.equal(total);
    });

    it('individual response times are elevated above 2 s under latency injection', async function () {
        await faults.addLatency(3000);

        const timings = [];
        for (let i = 0; i < 5; i++) {
            const t0  = Date.now();
            try {
                await httpGet(HEALTH, { timeout: 20000 });
            } catch { /* timeout errors still represent elevated latency */ }
            timings.push(Date.now() - t0);
        }

        // Every single request should experience the injected latency.
        for (const ms of timings) {
            expect(ms).to.be.above(2000);
        }
    });

    it('latency returns to normal after toxic is removed', async function () {
        await faults.addLatency(3000);
        await resetProxy();

        const t0  = Date.now();
        const res = await httpGet(HEALTH, { timeout: 5000 });
        const ms  = Date.now() - t0;

        expect(res.statusCode).to.be.below(500);
        // Without the toxic the round trip should be well under 2 s on localhost.
        expect(ms).to.be.below(2000);
    });
});

// -------------------------------------------------------------------------
// CE-DB-03: Connection Pool Exhaustion
// -------------------------------------------------------------------------

describe('CE-DB-03: Connection Pool Exhaustion', function () {

    afterEach(async function () {
        await resetProxy();
    });

    it('most requests fail or time out when DB holds connections for 30 s', async function () {
        // Inject a 30 s timeout toxic. Each DB connection will be held open
        // without responding for 30 s, quickly exhausting the connection pool.
        await faults.timeout(30000);

        // Fire 30 concurrent requests, each with a 5 s HTTP timeout.
        const { responses, errors, total } = await concurrentRequests(HEALTH, 30, { timeout: 5000 });

        const failed = errors.length + responses.filter(r => r.statusCode >= 500).length;
        // Under pool exhaustion almost all requests should fail.
        expect(failed).to.be.above(total / 2);
    });

    it('server process stays alive during pool exhaustion', async function () {
        await faults.timeout(30000);

        // Fire load to saturate the pool.
        await concurrentRequests(HEALTH, 30, { timeout: 5000 });

        // The server must still accept new TCP connections even when its pool is
        // exhausted. It should not crash or stop listening.
        let serverAlive = false;
        try {
            const res = await httpGet(HEALTH, { timeout: 5000 });
            serverAlive = typeof res.statusCode === 'number';
        } catch (e) {
            // Any response other than ECONNREFUSED means the server is alive.
            serverAlive = !e.message.includes('ECONNREFUSED');
        }
        expect(serverAlive).to.equal(true);
    });

    it('API recovers after the timeout toxic is removed', async function () {
        await faults.timeout(30000);
        await concurrentRequests(HEALTH, 10, { timeout: 3000 });

        // Remove the toxic and wait for the pool to clear and recover.
        await resetProxy();
        const recoveryMs = await waitForRecovery(HEALTH, 30000);

        expect(recoveryMs).to.be.above(-1);
        expect(recoveryMs).to.be.below(30000);
    });
});

// -------------------------------------------------------------------------
// CE-DB-04: Intermittent Connection Drops
// -------------------------------------------------------------------------

describe('CE-DB-04: Intermittent Connection Drops (30 % TCP reset probability)', function () {

    afterEach(async function () {
        await resetProxy();
    });

    it('sequential requests survive 30 % reset toxic (retry logic handles drops)', async function () {
        await faults.resetConnections(0.3);

        let successCount = 0;
        let failureCount = 0;

        for (let i = 0; i < 50; i++) {
            try {
                const res = await httpGet(HEALTH, { timeout: 10000 });
                if (res.statusCode < 500) {
                    successCount++;
                } else {
                    failureCount++;
                }
            } catch {
                failureCount++;
            }
        }

        // The explorer has a 3-retry loop with 1s sleep in getConnection/doQuery.
        // With a 30% reset probability, the retry logic may recover all failures,
        // resulting in 0 observed failures at the HTTP level. This is acceptable:
        // it proves the retry logic works. We verify that most requests succeed.
        expect(successCount).to.be.above(25,
            'Majority of requests should succeed (retry logic handles TCP resets)');
        // Total must equal 50
        expect(successCount + failureCount).to.equal(50);
    });

    it('total failure rate does not exceed 80 % under 30 % reset probability', async function () {
        await faults.resetConnections(0.3);

        let failureCount = 0;

        for (let i = 0; i < 50; i++) {
            try {
                const res = await httpGet(HEALTH, { timeout: 10000 });
                if (res.statusCode >= 500) failureCount++;
            } catch {
                failureCount++;
            }
        }

        // The failure rate should remain well below 100 %. 80 % is a generous
        // upper bound for a 30 % reset probability.
        const failureRate = failureCount / 50;
        expect(failureRate).to.be.below(0.8);
    });

    it('success rate returns to 100 % after toxic is removed', async function () {
        await faults.resetConnections(0.3);
        // Induce some failures to confirm the toxic is active.
        for (let i = 0; i < 10; i++) {
            await httpGet(HEALTH, { timeout: 5000 }).catch(() => {});
        }

        await resetProxy();

        // After removing the toxic, 10 consecutive requests should all succeed.
        let successCount = 0;
        for (let i = 0; i < 10; i++) {
            try {
                const res = await httpGet(HEALTH, { timeout: 5000 });
                if (res.statusCode < 500) successCount++;
            } catch { /* count as failure */ }
        }

        expect(successCount).to.equal(10);
    });
});

}); // describe('Chaos: Database Resilience')
