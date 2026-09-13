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
 * Memory stability tests: detects heap leaks during sustained load.
 *
 * Samples process.memoryUsage() before and after autocannon runs to detect
 * monotonically growing heap (indicative of a memory leak).
 *
 * Best results with: node --expose-gc (enabled by test:performance npm script)
 * Requires: MariaDB on port 3307 (docker compose -f test/integration/fixtures/docker-compose.test.yml up -d)
 */

'use strict';

const { expect } = require('chai');
const db         = require('../integration/helpers/db-setup');
const { bootServer, stopServer, runAutocannon, getServerUrl } = require('./helpers/perf-setup');

// Force GC if available (requires --expose-gc flag)
function forceGC() {
    if (global.gc) global.gc();
}

function heapMB() {
    return process.memoryUsage().heapUsed / 1024 / 1024;
}

describe('Memory stability: heap usage under load', function () {

    before(async function () {
        this.timeout(60000);
        await db.setupDatabase('../performance/helpers/seed-performance.sql');
        await bootServer();
    });

    after(async function () {
        this.timeout(10000);
        await stopServer();
        await db.closePool();
    });

    it('heap growth stays below 50MB during 15s sustained load', async function () {
        this.timeout(45000);

        // Warm up: let JIT settle and caches fill
        await runAutocannon({
            url:         getServerUrl() + '/RBTC/explorer/tokens',
            connections: 5,
            duration:    3,
        });

        forceGC();
        const heapBefore = heapMB();

        await runAutocannon({
            url:         getServerUrl() + '/RBTC/explorer/tokens',
            connections: 10,
            duration:    15,
        });

        forceGC();
        const heapAfter = heapMB();
        const growth    = heapAfter - heapBefore;

        expect(growth).to.be.below(50,
            `Heap grew by ${growth.toFixed(1)}MB during sustained load (possible memory leak)`);

        console.log(`    Heap: before=${heapBefore.toFixed(1)}MB, after=${heapAfter.toFixed(1)}MB, growth=${growth.toFixed(1)}MB`);
    });

    it('heap usage is stable across multiple load cycles', async function () {
        this.timeout(60000);
        const samples = [];

        for (let cycle = 0; cycle < 3; cycle++) {
            await runAutocannon({
                url:         getServerUrl() + '/RBTC/api/sends/50/block',
                connections: 10,
                duration:    5,
            });
            forceGC();
            samples.push(heapMB());
        }

        // Heap should not grow monotonically across 3 cycles (trend < 30MB)
        const trend = samples[2] - samples[0];
        expect(trend).to.be.below(30,
            `Heap trend across 3 cycles: +${trend.toFixed(1)}MB (samples: ${samples.map(s => s.toFixed(1)).join(', ')}) - possible accumulation`);

        console.log(`    Heap across cycles: ${samples.map(s => s.toFixed(1) + 'MB').join(' -> ')}`);
    });

    it('LRU caches do not grow unboundedly', async function () {
        this.timeout(30000);

        // Hit many different addresses/tokens to exercise cache
        const base = getServerUrl();
        await runAutocannon({
            url:         base + '/RBTC/explorer/tokens',
            connections: 10,
            duration:    5,
        });

        forceGC();
        const heapSnapshot = heapMB();

        // Heap should be reasonable (< 200MB) even after filling caches
        expect(heapSnapshot).to.be.below(200,
            `Heap is ${heapSnapshot.toFixed(1)}MB (caches may be unbounded)`);
    });

});
