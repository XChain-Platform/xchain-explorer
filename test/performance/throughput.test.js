/**
 * Throughput tests — measures maximum sustained requests/second using autocannon.
 *
 * Requires: MariaDB on port 3307 (docker compose -f test/integration/fixtures/docker-compose.test.yml up -d)
 */

'use strict';

const { expect } = require('chai');
const db         = require('../integration/helpers/db-setup');
const { bootServer, stopServer, runAutocannon, getServerUrl } = require('./helpers/perf-setup');

const DURATION    = 10; // seconds per scenario
const CONNECTIONS = 10; // concurrent connections

const SCENARIOS = [
    {
        name: 'GET /tokens',
        path: '/RBTC/api/tokens',
        minRps: 20,
        maxErrorRate: 0.05
    },
    {
        name: 'GET /sends (by block)',
        path: '/RBTC/api/sends/50/block',
        minRps: 20,
        maxErrorRate: 0.05
    },
    {
        name: 'GET /blocks',
        path: '/RBTC/api/blocks',
        minRps: 10,
        maxErrorRate: 0.05
    },
    {
        name: 'GET /balances (by address)',
        path: '/RBTC/api/balances/bc1qperf_addr_001_aaaaaaaaaaaaaaaaaaaaa/address',
        minRps: 20,
        maxErrorRate: 0.05
    },
    {
        name: 'GET /broadcasts',
        path: '/RBTC/api/broadcasts',
        minRps: 20,
        maxErrorRate: 0.05
    },
    {
        name: 'GET /orders',
        path: '/RBTC/api/orders',
        minRps: 10,
        maxErrorRate: 0.05
    },
];

describe('Throughput — sustained RPS under load', function () {

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

    for (const scenario of SCENARIOS) {
        it(`${scenario.name} sustains >= ${scenario.minRps} RPS with ${CONNECTIONS} connections`, async function () {
            this.timeout((DURATION + 15) * 1000);

            const result = await runAutocannon({
                url:         getServerUrl() + scenario.path,
                connections: CONNECTIONS,
                duration:    DURATION,
            });

            const rps       = result.requests.average;
            const totalReqs = result.requests.total;
            const errors    = result.errors || 0;
            const errorRate = totalReqs > 0 ? errors / totalReqs : 0;
            const p99       = result.latency.p99;

            expect(rps).to.be.at.least(scenario.minRps,
                `Expected >= ${scenario.minRps} RPS, got ${rps.toFixed(1)} (total: ${totalReqs}, errors: ${errors})`);
            expect(errorRate).to.be.below(scenario.maxErrorRate,
                `Error rate ${(errorRate * 100).toFixed(1)}% exceeds ${(scenario.maxErrorRate * 100)}% threshold`);

            // Log results for analysis
            console.log(`    ${scenario.name}: ${rps.toFixed(1)} RPS, p99=${p99}ms, errors=${errors}`);
        });
    }

    it('throughput does not collapse under pipelined requests', async function () {
        this.timeout(30000);

        const result = await runAutocannon({
            url:         getServerUrl() + '/RBTC/api/tokens',
            connections: CONNECTIONS,
            duration:    DURATION,
            pipelining:  5,
        });

        const rps = result.requests.average;
        expect(rps).to.be.at.least(10,
            `Pipelined throughput collapsed to ${rps.toFixed(1)} RPS`);
    });

});
