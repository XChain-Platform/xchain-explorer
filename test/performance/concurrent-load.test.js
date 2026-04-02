/**
 * Concurrent load tests — measures p95/p99 latency at increasing connection counts.
 *
 * Validates that response times stay within bounds as concurrency scales.
 * Requires: MariaDB on port 3307 (docker compose -f test/integration/fixtures/docker-compose.test.yml up -d)
 */

'use strict';

const { expect } = require('chai');
const db         = require('../integration/helpers/db-setup');
const { bootServer, stopServer, runAutocannon, getServerUrl } = require('./helpers/perf-setup');

const DURATION = 10; // seconds per ramp level

const RAMP_LEVELS = [
    { connections: 10,  p99ThresholdMs: 500  },
    { connections: 25,  p99ThresholdMs: 1000 },
    { connections: 50,  p99ThresholdMs: 2000 },
    { connections: 100, p99ThresholdMs: 5000 },
];

const TARGET_PATH = '/RBTC/api/tokens';

describe('Concurrent load — ramping connections', function () {

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

    for (const level of RAMP_LEVELS) {
        it(`${level.connections} concurrent connections: p99 < ${level.p99ThresholdMs}ms`, async function () {
            this.timeout((DURATION + 15) * 1000);

            const result = await runAutocannon({
                url:         getServerUrl() + TARGET_PATH,
                connections: level.connections,
                duration:    DURATION,
            });

            const p99     = result.latency.p99;
            const avg     = result.latency.average;
            const rps     = result.requests.average;
            const errors  = result.errors || 0;

            expect(p99).to.be.below(level.p99ThresholdMs,
                `p99 latency ${p99}ms exceeds ${level.p99ThresholdMs}ms at ${level.connections} connections`);

            // Log for analysis
            console.log(`    ${level.connections} conns: avg=${avg}ms, p99=${p99}ms, ${rps.toFixed(1)} RPS, errors=${errors}`);
        });
    }

    it('error rate stays below 5% at 50 concurrent connections', async function () {
        this.timeout(30000);

        const result = await runAutocannon({
            url:         getServerUrl() + TARGET_PATH,
            connections: 50,
            duration:    DURATION,
        });

        const totalReqs = result.requests.total;
        const errors    = result.errors || 0;
        const errorRate = totalReqs > 0 ? errors / totalReqs : 0;

        expect(errorRate).to.be.below(0.05,
            `Error rate ${(errorRate * 100).toFixed(1)}% at 50 connections exceeds 5% threshold`);
    });

    it('latency distribution is consistent (not bimodal) at moderate load', async function () {
        this.timeout(30000);

        const result = await runAutocannon({
            url:         getServerUrl() + TARGET_PATH,
            connections: 25,
            duration:    DURATION,
        });

        const avg = result.latency.average;
        const p99 = result.latency.p99;

        // p99 should not be more than 10x the average (indicates bimodal distribution)
        expect(p99).to.be.below(avg * 10 + 100,
            `Bimodal latency detected: avg=${avg}ms but p99=${p99}ms (${(p99/avg).toFixed(1)}x)`);
    });

});
