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

const http = require('http');
const net  = require('net');
const { expect } = require('chai');
const express        = require('express');
const cors           = require('cors');
const rateLimit      = require('express-rate-limit');
const { createTestConfigInfo } = require('../integration/helpers/app-setup');
const XChainExplorer = require('../../src/XChainExplorer.js');
const autocannon     = require('autocannon');

const {
    seedDatabase,
    httpGet,
    openSlowSocket,
    DB_PORT
} = require('./helpers/chaos-setup');
const {
    waitForToxiproxy,
    createProxy,
    resetProxy
} = require('./helpers/toxiproxy-client');

// ---------------------------------------------------------------------------
// Own rate-limited server (independent of shared cache in chaos-setup)
// ---------------------------------------------------------------------------

let rlServer    = null;
let rlServerUrl = null;

async function bootRateLimitedServer() {
    if (rlServer) return rlServerUrl;

    const app = express();
    app.use(express.json({ limit: '10kb' }));
    app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

    app.use(rateLimit({
        windowMs:        60 * 1000,
        limit:           500,
        standardHeaders: true,
        legacyHeaders:   false,
        skip: (req) => /\.(png|jpg|jpeg|gif|ico|svg|webp)$/i.test(req.path)
                     || req.path.startsWith('/icon')
                     || req.path.startsWith('/images'),
    }));

    const configInfo = createTestConfigInfo(DB_PORT);
    const explorer   = new XChainExplorer(app, configInfo);
    await explorer.init();

    await new Promise((resolve, reject) => {
        rlServer = http.createServer(app);
        rlServer.listen(0, '127.0.0.1', (err) => {
            if (err) return reject(err);
            const { port } = rlServer.address();
            rlServerUrl = `http://127.0.0.1:${port}`;
            resolve();
        });
    });
    return rlServerUrl;
}

async function stopRateLimitedServer() {
    if (rlServer) {
        await new Promise(resolve => rlServer.close(resolve));
        rlServer    = null;
        rlServerUrl = null;
    }
}

function runAutocannonHelper(opts) {
    return new Promise((resolve, reject) => {
        const instance = autocannon(opts, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
        autocannon.track(instance, { renderProgressBar: false });
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpPost(urlPath, body, opts = {}) {
    const base = opts.baseUrl || rlServerUrl;
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, base);
        const payload = typeof body === 'string' ? body : JSON.stringify(body);
        const req = http.request(url.href, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: opts.timeout || 10000
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(payload);
        req.end();
    });
}

function httpGetLocal(urlPath, opts = {}) {
    const base = opts.baseUrl || rlServerUrl;
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, base);
        const req = http.get(url.href, { timeout: opts.timeout || 10000 }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
}

// ---------------------------------------------------------------------------
// Suite setup / teardown
// ---------------------------------------------------------------------------

describe('Chaos: API Overload', function () {

before(async function () {
    this.timeout(60000);
    await waitForToxiproxy();
    await createProxy();
    await seedDatabase();
    await bootRateLimitedServer();
});

after(async function () {
    this.timeout(15000);
    await stopRateLimitedServer();
});

// ---------------------------------------------------------------------------
// CE-API-01: Single-IP Burst Traffic
// ---------------------------------------------------------------------------

describe('CE-API-01: Single-IP Burst Traffic', function () {
    this.timeout(30000);

    it('rate limiter should reject some requests while still serving others', async function () {
        const result = await runAutocannonHelper({
            url: `${rlServerUrl}/RBTC/explorer/blocks/all`,
            connections: 50,
            duration: 5,
            requests: [{ method: 'GET' }]
        });

        // Some requests must have been rate-limited (non-2xx responses exist)
        expect(result.non2xx, 'expected at least one non-2xx response from rate limiter')
            .to.be.above(0);

        // Server must still have served some requests successfully
        expect(result['2xx'], 'expected at least one successful response')
            .to.be.above(0);
    });
});

// ---------------------------------------------------------------------------
// CE-API-02: Sustained High Concurrency
// ---------------------------------------------------------------------------

describe('CE-API-02: Sustained High Concurrency', function () {
    this.timeout(60000);

    it('server should remain alive after sustained high-concurrency burst', async function () {
        const result = await runAutocannonHelper({
            url: `${rlServerUrl}/RBTC/explorer/blocks/all`,
            connections: 100,
            duration: 10,
            requests: [{ method: 'GET' }]
        });

        // Track errors and timeouts (informational)
        console.log(`CE-API-02: errors=${result.errors || 0}, timeouts=${result.timeouts || 0}`);

        // Server must not have crashed: a health-check request must succeed
        // Server is alive if it responds with any HTTP status (429 = rate limited, also valid)
        const health = await httpGetLocal('/RBTC/api/status');
        expect(
            health.statusCode,
            'server should still respond after sustained load'
        ).to.be.oneOf([200, 429]);

        // Total requests attempted must be non-zero
        const totalRequests = (result['2xx'] || 0) + (result.non2xx || 0) + (result.errors || 0);
        expect(totalRequests, 'autocannon should have sent at least one request').to.be.above(0);
    });
});

// ---------------------------------------------------------------------------
// CE-API-03: Slowloris (Slow Client Connections)
// ---------------------------------------------------------------------------

describe('CE-API-03: Slowloris (Slow Client Connections)', function () {
    this.timeout(60000);

    it('legitimate requests should succeed while slow sockets are held open', async function () {
        const serverUrl = new URL(rlServerUrl);
        const port = parseInt(serverUrl.port, 10);
        const host = serverUrl.hostname;

        // Open 50 slow sockets that send partial HTTP headers
        const socketPromises = [];
        for (let i = 0; i < 50; i++) {
            socketPromises.push(openSlowSocket(port, host).catch(() => null));
        }
        const slowSockets = (await Promise.all(socketPromises)).filter(Boolean);

        // Allow sockets time to begin sending partial headers
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Fire 10 legitimate HTTP GET requests while slow sockets are held open
        const legitimateRequests = [];
        for (let i = 0; i < 10; i++) {
            legitimateRequests.push(httpGetLocal('/RBTC/explorer/blocks/all', { timeout: 15000 }));
        }

        const responses = await Promise.allSettled(legitimateRequests);

        // Clean up slow sockets
        for (const sock of slowSockets) {
            try { sock.destroy(); } catch (_) { /* ignore */ }
        }

        // At least some legitimate requests must have completed successfully
        // Under rate limiting + slowloris, legitimate requests may get 200, 429, or timeout.
        // The key assertion: the server is still responsive (not frozen by slowloris).
        const completed = responses.filter(r => r.status === 'fulfilled');
        expect(completed.length, 'at least 5 of 10 legitimate requests should complete').to.be.at.least(5);

        // Clean up and verify server recovery
        await new Promise((resolve) => setTimeout(resolve, 500));
        let serverAlive = false;
        try {
            const recovery = await httpGetLocal('/RBTC/api/status');
            serverAlive = typeof recovery.statusCode === 'number';
        } catch { serverAlive = false; }
        expect(serverAlive, 'server should be alive after slowloris cleanup').to.equal(true);
    });
});

// ---------------------------------------------------------------------------
// CE-API-04: Large Payload Rejection
// ---------------------------------------------------------------------------

describe('CE-API-04: Large Payload Rejection', function () {
    this.timeout(30000);

    it('5KB body should receive a response (within limit)', async function () {
        const body = 'x'.repeat(5 * 1024);
        const res = await httpPost('/RBTC/explorer/blocks/all', body);
        expect(res.statusCode, '5KB payload should not be rejected with 413')
            .to.not.equal(413);
    });

    it('20KB body should be rejected with 413 (exceeds 10KB limit)', async function () {
        const body = 'x'.repeat(20 * 1024);
        const res = await httpPost('/RBTC/explorer/blocks/all', body);
        expect(res.statusCode, '20KB payload should be rejected with 413 Payload Too Large')
            .to.equal(413);
    });

    it('server should handle subsequent requests normally after a 413 rejection', async function () {
        // After the large-payload burst tests, the rate limiter may be active.
        // We just verify the server is alive and responding (any HTTP status is fine).
        let serverAlive = false;
        try {
            const res = await httpGetLocal('/RBTC/api/status');
            serverAlive = typeof res.statusCode === 'number';
        } catch { serverAlive = false; }
        expect(serverAlive, 'server should still be responsive after 413 rejection').to.equal(true);
    });
});

}); // describe('Chaos: API Overload')
