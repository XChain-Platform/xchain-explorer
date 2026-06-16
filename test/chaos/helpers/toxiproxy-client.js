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
 * Toxiproxy client — manages proxy creation and toxic injection
 * for chaos engineering experiments.
 *
 * Toxiproxy API docs: https://github.com/Shopify/toxiproxy#http-api
 *
 * Requires: toxiproxy running on localhost:8474 (see docker-compose.chaos.yml)
 */

'use strict';

const http = require('http');

const TOXIPROXY_HOST = process.env.TOXIPROXY_HOST || '127.0.0.1';
const TOXIPROXY_PORT = parseInt(process.env.TOXIPROXY_PORT || '8474', 10);

// -------------------------------------------------------------------------
// Low-level HTTP helper (avoids adding axios as a test dependency)
// -------------------------------------------------------------------------

function request(method, path, body) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: TOXIPROXY_HOST,
            port:     TOXIPROXY_PORT,
            path,
            method,
            headers:  { 'Content-Type': 'application/json' }
        };
        if (payload) opts.headers['Content-Length'] = Buffer.byteLength(payload);

        const req = http.request(opts, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                const parsed = data ? JSON.parse(data) : null;
                if (res.statusCode >= 400) {
                    const err = new Error(`Toxiproxy ${method} ${path} → ${res.statusCode}: ${data}`);
                    err.statusCode = res.statusCode;
                    err.body = parsed;
                    return reject(err);
                }
                resolve(parsed);
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// -------------------------------------------------------------------------
// Proxy management
// -------------------------------------------------------------------------

const PROXY_NAME     = 'mariadb_chaos';
const DB_UPSTREAM    = 'mariadb-chaos:3306';   // container name inside chaos-net
const PROXY_LISTEN   = '0.0.0.0:3307';        // exposed to host

async function createProxy() {
    try {
        await request('POST', '/proxies', {
            name:     PROXY_NAME,
            listen:   PROXY_LISTEN,
            upstream: DB_UPSTREAM,
            enabled:  true
        });
    } catch (e) {
        // 409 = proxy already exists — that's fine
        if (e.statusCode !== 409) throw e;
    }
}

async function deleteProxy() {
    try {
        await request('DELETE', `/proxies/${PROXY_NAME}`);
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }
}

async function enableProxy() {
    await request('POST', `/proxies/${PROXY_NAME}`, { enabled: true });
}

async function disableProxy() {
    await request('POST', `/proxies/${PROXY_NAME}`, { enabled: false });
}

async function resetProxy() {
    await removeAllToxics();
    await enableProxy();
}

// -------------------------------------------------------------------------
// Toxic management
// -------------------------------------------------------------------------

/**
 * Add a toxic to the MariaDB proxy.
 *
 * @param {object} toxic
 * @param {string} toxic.type       - latency | bandwidth | slow_close | timeout |
 *                                    reset_peer | slicer | limit_data
 * @param {string} [toxic.stream]   - 'upstream' | 'downstream' (default: downstream)
 * @param {string} [toxic.name]     - unique name (auto-generated if omitted)
 * @param {number} [toxic.toxicity] - probability 0-1 (default: 1.0)
 * @param {object} toxic.attributes - toxic-specific params (e.g. { latency: 5000 })
 * @returns {object} created toxic
 */
async function addToxic(toxic) {
    return request('POST', `/proxies/${PROXY_NAME}/toxics`, {
        name:       toxic.name || `${toxic.type}_${toxic.stream || 'downstream'}`,
        type:       toxic.type,
        stream:     toxic.stream || 'downstream',
        toxicity:   toxic.toxicity != null ? toxic.toxicity : 1.0,
        attributes: toxic.attributes || {}
    });
}

async function removeToxic(name) {
    try {
        await request('DELETE', `/proxies/${PROXY_NAME}/toxics/${name}`);
    } catch (e) {
        if (e.statusCode !== 404) throw e;
    }
}

async function listToxics() {
    return request('GET', `/proxies/${PROXY_NAME}/toxics`);
}

async function removeAllToxics() {
    const toxics = await listToxics();
    if (Array.isArray(toxics)) {
        for (const t of toxics) {
            await removeToxic(t.name);
        }
    }
}

// -------------------------------------------------------------------------
// Convenience: pre-built fault scenarios
// -------------------------------------------------------------------------

const faults = {
    /** Simulate complete DB unavailability by disabling the proxy */
    async dbDown() {
        await disableProxy();
    },

    /** Restore DB connectivity */
    async dbUp() {
        await enableProxy();
    },

    /** Add latency to all DB responses */
    async addLatency(ms, jitter = 0) {
        return addToxic({
            type: 'latency',
            stream: 'downstream',
            name: 'chaos_latency',
            attributes: { latency: ms, jitter }
        });
    },

    /** Limit bandwidth (bytes/sec) to simulate slow network */
    async limitBandwidth(bytesPerSec) {
        return addToxic({
            type: 'bandwidth',
            stream: 'downstream',
            name: 'chaos_bandwidth',
            attributes: { rate: bytesPerSec }
        });
    },

    /** Randomly reset connections (toxicity = probability 0-1) */
    async resetConnections(toxicity = 0.3) {
        return addToxic({
            type: 'reset_peer',
            stream: 'downstream',
            name: 'chaos_reset',
            toxicity,
            attributes: { timeout: 0 }
        });
    },

    /** Hold connections open without responding (simulates stuck connections) */
    async timeout(ms) {
        return addToxic({
            type: 'timeout',
            stream: 'downstream',
            name: 'chaos_timeout',
            attributes: { timeout: ms }
        });
    },

    /** Cut connection after N bytes (simulates partial response) */
    async limitData(bytes) {
        return addToxic({
            type: 'limit_data',
            stream: 'downstream',
            name: 'chaos_limit_data',
            attributes: { bytes }
        });
    },

    /** Slice data into small chunks with delay between each */
    async sliceData(avgBytes = 10, delay = 100) {
        return addToxic({
            type: 'slicer',
            stream: 'downstream',
            name: 'chaos_slicer',
            attributes: { average_size: avgBytes, size_variation: 5, delay }
        });
    }
};

// -------------------------------------------------------------------------
// Health check — wait for toxiproxy to be ready
// -------------------------------------------------------------------------

async function waitForToxiproxy(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            await request('GET', '/version');
            return true;
        } catch {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    throw new Error(`Toxiproxy not reachable at ${TOXIPROXY_HOST}:${TOXIPROXY_PORT} after ${timeoutMs}ms`);
}

module.exports = {
    request,
    createProxy,
    deleteProxy,
    enableProxy,
    disableProxy,
    resetProxy,
    addToxic,
    removeToxic,
    listToxics,
    removeAllToxics,
    faults,
    waitForToxiproxy,
    PROXY_NAME,
    DB_UPSTREAM,
    PROXY_LISTEN
};
