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
 * Chaos test setup — boots the explorer against MariaDB via toxiproxy
 * and provides HTTP load generation utilities.
 *
 * Requires:
 *   - MariaDB on port 3307 (proxied through toxiproxy)
 *   - Toxiproxy API on port 8474
 *   - See docker-compose.chaos.yml
 */

'use strict';

const http           = require('http');
const net            = require('net');
const express        = require('express');
const cors           = require('cors');
const rateLimit      = require('express-rate-limit');
const autocannon     = require('autocannon');
const { createTestConfigInfo } = require('../../integration/helpers/app-setup');
const XChainExplorer = require('../../../src/XChainExplorer.js');
const toxiproxy      = require('./toxiproxy-client');
const mariadb        = require('mariadb');
const fs             = require('fs');
const path           = require('path');

const DB_PORT = 3307;  // toxiproxy's proxied port

let server      = null;
let serverUrl   = null;
let cachedSetup = null;

// -------------------------------------------------------------------------
// Server lifecycle
// -------------------------------------------------------------------------

/**
 * Boot an Express app with the explorer attached.
 * Optionally applies rate limiting to match production config.
 */
async function bootServer(opts = {}) {
    if (cachedSetup) return cachedSetup;

    const app = express();
    app.use(express.json({ limit: '10kb' }));
    app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

    if (opts.rateLimit === true) {
        app.use(rateLimit({
            windowMs:        60 * 1000,
            limit:           opts.rateMax || 500,
            standardHeaders: true,
            legacyHeaders:   false,
            skip: (req) => /\.(png|jpg|jpeg|gif|ico|svg|webp)$/i.test(req.path)
                         || req.path.startsWith('/icon')
                         || req.path.startsWith('/images'),
        }));
    }

    const configInfo = createTestConfigInfo(DB_PORT);
    const explorer   = new XChainExplorer(app, configInfo);
    await explorer.init();

    await new Promise((resolve, reject) => {
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', (err) => {
            if (err) return reject(err);
            const { port } = server.address();
            serverUrl = `http://127.0.0.1:${port}`;
            resolve();
        });
    });

    cachedSetup = { app, explorer, configInfo, serverUrl, server };
    return cachedSetup;
}

async function stopServer() {
    if (server) {
        await new Promise(resolve => server.close(resolve));
        server      = null;
        serverUrl   = null;
        cachedSetup = null;
    }
}

function getServerUrl() {
    return serverUrl;
}

function getServer() {
    return server;
}

// -------------------------------------------------------------------------
// Database seeding via the proxied port
// -------------------------------------------------------------------------

async function seedDatabase() {
    const pool = mariadb.createPool({
        host: '127.0.0.1',
        port: DB_PORT,
        user: 'root',
        password: 'testpass',
        database: 'XChain_BTC_Regtest_Indexer',
        multipleStatements: true,
        connectionLimit: 2
    });
    const conn = await pool.getConnection();
    try {
        // Import schema
        const schemaPath = path.join(__dirname, '../../integration/fixtures/schema.sql');
        if (fs.existsSync(schemaPath)) {
            const schema = fs.readFileSync(schemaPath, 'utf8');
            await conn.query(schema);
        }
        // Import chaos seed data
        const seedPath = path.join(__dirname, '../fixtures/seed-chaos.sql');
        if (fs.existsSync(seedPath)) {
            const seed = fs.readFileSync(seedPath, 'utf8');
            await conn.query(seed);
        }
    } finally {
        conn.release();
        await pool.end();
    }
}

// -------------------------------------------------------------------------
// Load generation (autocannon wrapper)
// -------------------------------------------------------------------------

function runAutocannon(opts) {
    return new Promise((resolve, reject) => {
        const instance = autocannon(opts, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
        autocannon.track(instance, { renderProgressBar: false });
    });
}

// -------------------------------------------------------------------------
// HTTP helpers for targeted requests
// -------------------------------------------------------------------------

function httpGet(urlPath, opts = {}) {
    const base = opts.baseUrl || serverUrl;
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath, base);
        const req = http.get(url.href, { timeout: opts.timeout || 10000 }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers:    res.headers,
                    body
                });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    });
}

/**
 * Fire N concurrent HTTP GETs and collect results.
 * Returns { responses, errors, elapsed }
 */
async function concurrentRequests(urlPath, count, opts = {}) {
    const start    = Date.now();
    const promises = [];
    for (let i = 0; i < count; i++) {
        promises.push(
            httpGet(urlPath, opts).then(r => ({ ok: true, ...r }))
                                  .catch(e => ({ ok: false, error: e.message }))
        );
    }
    const results   = await Promise.all(promises);
    const elapsed   = Date.now() - start;
    const responses = results.filter(r => r.ok);
    const errors    = results.filter(r => !r.ok);
    return { responses, errors, elapsed, total: count };
}

// -------------------------------------------------------------------------
// TCP helpers (for slowloris-style tests)
// -------------------------------------------------------------------------

function openSlowSocket(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ port, host }, () => {
            // Send a partial HTTP request header very slowly
            socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
            resolve(socket);
        });
        socket.on('error', reject);
    });
}

// -------------------------------------------------------------------------
// Monitoring helpers
// -------------------------------------------------------------------------

/**
 * Poll a health endpoint at an interval and collect results.
 * Returns a stop function. Results are pushed to the provided array.
 */
function startHealthPoller(urlPath, results, intervalMs = 500) {
    const poll = async () => {
        const start = Date.now();
        try {
            const res = await httpGet(urlPath, { timeout: 5000 });
            results.push({
                ts:         Date.now(),
                latency:    Date.now() - start,
                statusCode: res.statusCode,
                ok:         res.statusCode < 500
            });
        } catch (e) {
            results.push({
                ts:      Date.now(),
                latency: Date.now() - start,
                ok:      false,
                error:   e.message
            });
        }
    };
    const timer = setInterval(poll, intervalMs);
    // Do an immediate first poll
    poll();
    return () => clearInterval(timer);
}

/**
 * Wait for the health endpoint to return 200.
 * Used to measure recovery time after a fault is removed.
 */
async function waitForRecovery(urlPath, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await httpGet(urlPath, { timeout: 3000 });
            if (res.statusCode < 500) return Date.now() - start;
        } catch { /* keep trying */ }
        await new Promise(r => setTimeout(r, 250));
    }
    return -1; // did not recover
}

module.exports = {
    bootServer,
    stopServer,
    getServerUrl,
    getServer,
    seedDatabase,
    runAutocannon,
    httpGet,
    concurrentRequests,
    openSlowSocket,
    startHealthPoller,
    waitForRecovery,
    DB_PORT
};
