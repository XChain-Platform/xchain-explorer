/**
 * Performance baseline tests — single-request latency for all endpoint categories.
 *
 * Measures handler + MariaDB round-trip time for individual requests.
 * Requires: MariaDB on port 3307 (docker compose -f test/integration/fixtures/docker-compose.test.yml up -d)
 */

'use strict';

const { expect }  = require('chai');
const http        = require('http');
const db          = require('../integration/helpers/db-setup');
const { bootServer, stopServer, getServerUrl } = require('./helpers/perf-setup');

const LATENCY_THRESHOLD_MS = 500;

const ENDPOINTS = [
    { name: 'token list',          path: '/RBTC/api/tokens' },
    { name: 'token detail',        path: '/RBTC/api/token/XCHAIN' },
    { name: 'sends by block',      path: '/RBTC/api/sends/50/block' },
    { name: 'address balances',    path: '/RBTC/api/balances/bc1qperf_addr_001_aaaaaaaaaaaaaaaaaaaaa/address' },
    { name: 'block detail',        path: '/RBTC/api/block/50' },
    { name: 'blocks list',         path: '/RBTC/api/blocks' },
    { name: 'broadcasts',          path: '/RBTC/api/broadcasts' },
    { name: 'issues list',         path: '/RBTC/api/issues' },
    { name: 'orders list',         path: '/RBTC/api/orders' },
    { name: 'history (address)',   path: '/RBTC/api/history/bc1qperf_addr_001_aaaaaaaaaaaaaaaaaaaaa/address' },
    { name: 'network status',      path: '/RBTC/api/network' },
];

// Simple HTTP GET that returns { status, elapsed }
function timedGet(url) {
    return new Promise((resolve) => {
        const start = Date.now();
        http.get(url, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, elapsed: Date.now() - start, body }));
        }).on('error', () => resolve({ status: 0, elapsed: Date.now() - start, body: '' }));
    });
}

describe('Performance baseline — single-request latency', function () {

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

    for (const endpoint of ENDPOINTS) {
        it(`${endpoint.name} (${endpoint.path}) responds in < ${LATENCY_THRESHOLD_MS}ms`, async function () {
            this.timeout(10000);
            const url = getServerUrl() + endpoint.path;

            // Warm-up request (JIT, connection pool init)
            await timedGet(url);

            // Measure over 5 iterations, take the median
            const times = [];
            for (let i = 0; i < 5; i++) {
                const result = await timedGet(url);
                times.push(result.elapsed);
            }
            times.sort((a, b) => a - b);
            const median = times[Math.floor(times.length / 2)];

            expect(median).to.be.below(LATENCY_THRESHOLD_MS,
                `Median latency ${median}ms exceeds ${LATENCY_THRESHOLD_MS}ms threshold (samples: ${times.join(', ')})`);
        });
    }

    it('paginated API request (page=2) responds in < ' + LATENCY_THRESHOLD_MS + 'ms', async function () {
        this.timeout(10000);
        const url = getServerUrl() + '/RBTC/api/sends/50/block?page=2&limit=10';

        await timedGet(url);
        const result = await timedGet(url);

        expect(result.elapsed).to.be.below(LATENCY_THRESHOLD_MS,
            `Page 2 latency ${result.elapsed}ms exceeds threshold`);
    });

    it('multiple sequential requests show consistent latency (no degradation)', async function () {
        this.timeout(30000);
        const url = getServerUrl() + '/RBTC/api/tokens';
        const times = [];

        for (let i = 0; i < 20; i++) {
            const result = await timedGet(url);
            times.push(result.elapsed);
        }

        // Compare first 5 vs last 5 — last 5 should not be > 2x the first 5
        const firstAvg = times.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
        const lastAvg  = times.slice(-5).reduce((a, b) => a + b, 0) / 5;

        expect(lastAvg).to.be.below(firstAvg * 2 + 50,
            `Latency degraded: first 5 avg=${firstAvg.toFixed(0)}ms, last 5 avg=${lastAvg.toFixed(0)}ms`);
    });

});
