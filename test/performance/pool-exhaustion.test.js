/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Pool exhaustion tests — verifies behavior when concurrent requests exceed the DB pool limit.
 *
 * With connectionLimit=25, these tests fire 30+ simultaneous requests to verify
 * the server handles pool saturation gracefully without crashes or hangs.
 *
 * Requires: MariaDB on port 3307 (docker compose -f test/integration/fixtures/docker-compose.test.yml up -d)
 */

'use strict';

const { expect } = require('chai');
const http       = require('http');
const db         = require('../integration/helpers/db-setup');
const { bootServer, stopServer, getServerUrl } = require('./helpers/perf-setup');

// Simple HTTP GET returning a promise with { status, elapsed }
function httpGet(url) {
    return new Promise((resolve) => {
        const start = Date.now();
        const req = http.get(url, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, elapsed: Date.now() - start }));
        });
        req.on('error', () => resolve({ status: 0, elapsed: Date.now() - start }));
        req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, elapsed: Date.now() - start }); });
    });
}

describe('Pool exhaustion — concurrent requests beyond pool limit', function () {

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

    it('handles 30 simultaneous requests with < 10% errors (pool limit = 25)', async function () {
        this.timeout(30000);
        const url      = getServerUrl() + '/RBTC/api/tokens';
        const promises = Array.from({ length: 30 }, () => httpGet(url));
        const results  = await Promise.all(promises);

        const errors    = results.filter(r => r.status !== 200).length;
        const errorRate = errors / results.length;

        expect(errorRate).to.be.below(0.10,
            `${errors}/30 requests failed (${(errorRate * 100).toFixed(0)}%) — expected < 10% error rate`);
    });

    it('handles 50 simultaneous requests without hanging (timeout < 20s)', async function () {
        this.timeout(30000);
        const url   = getServerUrl() + '/RBTC/api/sends/50/block';
        const start = Date.now();
        const promises = Array.from({ length: 50 }, () => httpGet(url));
        await Promise.all(promises);
        const elapsed = Date.now() - start;

        expect(elapsed).to.be.below(20000,
            `Requests took ${elapsed}ms — possible pool deadlock`);
    });

    it('recovers to normal latency after pool saturation burst', async function () {
        this.timeout(30000);
        const url = getServerUrl() + '/RBTC/api/tokens';

        // Burst: saturate the pool
        const burst = Array.from({ length: 40 }, () => httpGet(url));
        await Promise.all(burst);

        // Recovery: single requests should be fast again
        const recovery = await httpGet(url);
        expect(recovery.elapsed).to.be.below(1000,
            `Post-saturation recovery took ${recovery.elapsed}ms — pool may not be releasing connections`);
        expect(recovery.status).to.equal(200);
    });

    it('concurrent requests to different endpoints share pool gracefully', async function () {
        this.timeout(30000);
        const base = getServerUrl();
        const endpoints = [
            '/RBTC/api/tokens',
            '/RBTC/api/sends/50/block',
            '/RBTC/api/blocks',
            '/RBTC/api/broadcasts',
            '/RBTC/api/issues',
        ];

        // 5 requests to each endpoint simultaneously (25 total)
        const promises = [];
        for (const ep of endpoints) {
            for (let i = 0; i < 5; i++) {
                promises.push(httpGet(base + ep));
            }
        }
        const results = await Promise.all(promises);

        const errors = results.filter(r => r.status !== 200).length;
        expect(errors).to.be.below(5,
            `${errors}/25 mixed-endpoint requests failed`);
    });

});
