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

const { expect } = require('chai');
const {
    bootServer,
    stopServer,
    getServerUrl,
    httpGet,
    concurrentRequests,
    runAutocannon,
    seedDatabase,
    startHealthPoller
} = require('./helpers/chaos-setup');
const {
    waitForToxiproxy,
    createProxy,
    resetProxy
} = require('./helpers/toxiproxy-client');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function measureEventLoopLag() {
    return new Promise(resolve => {
        const start = Date.now();
        setTimeout(() => resolve(Date.now() - start), 0);
    });
}

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

describe('Chaos: Resource Saturation', function () {

before(async function () {
    this.timeout(60000);
    await waitForToxiproxy();
    await createProxy();
    await seedDatabase();
    await bootServer();
});

after(async function () {
    this.timeout(15000);
    await resetProxy();
    await stopServer();
});

// ---------------------------------------------------------------------------
// CE-RES-01: Memory Pressure Under Sustained Load
// ---------------------------------------------------------------------------

describe('CE-RES-01: Memory Pressure Under Sustained Load', function () {
    this.timeout(60000);

    it('heap should not grow by more than 50MB under a 15-second autocannon burst', async function () {
        // Optionally force GC before baseline measurement (requires --expose-gc)
        if (typeof global.gc === 'function') {
            global.gc();
        }

        const heapBefore = process.memoryUsage().heapUsed;

        await runAutocannon({
            url:         `${getServerUrl()}/RBTC/explorer/blocks/all`,
            connections: 20,
            duration:    15,
            requests:    [{ method: 'GET' }]
        });

        // Optionally force GC after load so we measure retained heap, not GC debt
        if (typeof global.gc === 'function') {
            global.gc();
        }

        const heapAfter = process.memoryUsage().heapUsed;
        const growthMB  = (heapAfter - heapBefore) / (1024 * 1024);

        // eslint-disable-next-line no-console -- chaos tests log diagnostic output intentionally
        console.log(`CE-RES-01: heap before=${(heapBefore / 1024 / 1024).toFixed(1)}MB, after=${(heapAfter / 1024 / 1024).toFixed(1)}MB, growth=${growthMB.toFixed(1)}MB`);

        expect(growthMB, 'heap growth should be less than 50MB (no unbounded memory leak)')
            .to.be.below(50);
    });

    it('server should still respond after the load burst', async function () {
        const res = await httpGet('/RBTC/explorer/blocks/all');
        expect(
            res.statusCode,
            'server should be reachable after sustained load (200 or 429 both acceptable)'
        ).to.be.oneOf([200, 429]);
    });
});

// ---------------------------------------------------------------------------
// CE-RES-02: Cache Behavior Under Load
// ---------------------------------------------------------------------------

describe('CE-RES-02: Cache Behavior Under Load', function () {
    this.timeout(60000);

    it('should complete all 200 concurrent cache-exercising requests without crashing', async function () {
        // Fire three batches concurrently to exercise different LRU caches:
        //   addressId cache  → /RBTC/api/balances/bcrt1qchaosaddr1aaaaaaaaaaaaaaaaaaaaaa/address
        //   tickId cache     → /RBTC/api/sends/100/block
        //   general query    → /RBTC/explorer/blocks/all
        const [blocksResult, sendsResult, balancesResult] = await Promise.all([
            concurrentRequests('/RBTC/explorer/blocks/all',   100, { timeout: 30000 }),
            concurrentRequests('/RBTC/api/sends/100/block',     50, { timeout: 30000 }),
            concurrentRequests('/RBTC/api/balances/bcrt1qchaosaddr1aaaaaaaaaaaaaaaaaaaaaa/address',  50, { timeout: 30000 })
        ]);

        const totalCompleted = blocksResult.responses.length
            + sendsResult.responses.length
            + balancesResult.responses.length;

        const totalErrors = blocksResult.errors.length
            + sendsResult.errors.length
            + balancesResult.errors.length;

        // eslint-disable-next-line no-console -- chaos tests log diagnostic output intentionally
        console.log(`CE-RES-02: completed=${totalCompleted}/200, errors=${totalErrors}`);

        // All 200 requests must complete (fulfilled or rejected — no process crash)
        expect(totalCompleted + totalErrors, 'all 200 requests should have settled')
            .to.equal(200);

        // Completed responses (not TCP errors) should be the majority
        expect(totalCompleted, 'the majority of requests should complete without TCP error')
            .to.be.at.least(150);
    });

    it('heap should remain below 200MB after concurrent cache load', function () {
        const heapMB = process.memoryUsage().heapUsed / (1024 * 1024);
        // eslint-disable-next-line no-console -- chaos test reports the measured heap figure to stdout
        console.log(`CE-RES-02: heap after cache load=${heapMB.toFixed(1)}MB`);
        expect(heapMB, 'server heap should stay below 200MB').to.be.below(200);
    });

    it('subsequent single request should still work correctly', async function () {
        const res = await httpGet('/RBTC/explorer/blocks/all');
        expect(
            res.statusCode,
            'single request after cache load should succeed'
        ).to.be.oneOf([200, 429]);
    });
});

// ---------------------------------------------------------------------------
// CE-RES-03: Event Loop Saturation
// ---------------------------------------------------------------------------

describe('CE-RES-03: Event Loop Saturation', function () {
    this.timeout(60000);

    it('event loop should recover to near-baseline latency after a 10-second burst', async function () {
        // Baseline: measure event loop lag before any load
        const baselineLag = await measureEventLoopLag();
        // eslint-disable-next-line no-console -- chaos tests log diagnostic output intentionally
        console.log(`CE-RES-03: baseline event loop lag=${baselineLag}ms`);

        // Run the autocannon burst and sample lag mid-flight
        let duringLag = null;

        const bursting = runAutocannon({
            url:         `${getServerUrl()}/RBTC/explorer/blocks/all`,
            connections: 50,
            duration:    10,
            requests:    [{ method: 'GET' }]
        });

        // Sample event loop lag roughly mid-burst (5 s into a 10 s burst)
        await new Promise(resolve => setTimeout(resolve, 5000));
        duringLag = await measureEventLoopLag();
        // eslint-disable-next-line no-console -- chaos tests log diagnostic output intentionally
        console.log(`CE-RES-03: event loop lag during burst=${duringLag}ms`);

        // Wait for autocannon to finish
        await bursting;

        // Post-burst: allow a short settle period then measure again
        await new Promise(resolve => setTimeout(resolve, 500));
        const afterLag = await measureEventLoopLag();
        // eslint-disable-next-line no-console -- chaos tests log diagnostic output intentionally
        console.log(`CE-RES-03: event loop lag after burst=${afterLag}ms`);

        // Event loop lag is expected to be elevated during the burst — this is
        // informational rather than a hard assertion, but we log it for review.
        expect(duringLag, 'event loop lag should be measurable during burst').to.be.at.least(0);

        // After the burst ends, latency must return to near-baseline (< 100ms).
        // We use a generous threshold to avoid flakiness — we only care about
        // catastrophic freezes, not precise scheduling jitter.
        expect(afterLag, 'event loop lag should recover to under 100ms after burst ends')
            .to.be.below(100);
    });

    it('server should still respond after the burst', async function () {
        const res = await httpGet('/RBTC/explorer/blocks/all');
        expect(
            res.statusCode,
            'server should be reachable after event loop saturation test'
        ).to.be.oneOf([200, 429]);
    });
});

}); // describe('Chaos: Resource Saturation')
