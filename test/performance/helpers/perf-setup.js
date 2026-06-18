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
 * Performance test helper: boots the explorer against a test MariaDB
 * and provides autocannon load generation utilities.
 *
 * Requires: MariaDB on port 3307 (see docker-compose.test.yml)
 */

'use strict';

const autocannon  = require('autocannon');
const http        = require('http');
const express     = require('express');
const cors        = require('cors');
const { createTestConfigInfo } = require('../../integration/helpers/app-setup');
const XChainExplorer = require('../../../src/XChainExplorer.js');

const DB_PORT = 3307;

let server      = null;
let serverUrl   = null;
let cachedSetup = null;

// Boot an Express app with the explorer attached, bound to a random port
async function bootServer() {
    if (cachedSetup) return cachedSetup;

    const app = express();
    app.use(express.json());
    app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

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

    cachedSetup = { app, explorer, configInfo, serverUrl };
    return cachedSetup;
}

// Shut down the HTTP server
async function stopServer() {
    if (server) {
        await new Promise(resolve => server.close(resolve));
        server      = null;
        serverUrl   = null;
        cachedSetup = null;
    }
}

// Thin wrapper around autocannon's programmatic API (callback → Promise)
function runAutocannon(opts) {
    return new Promise((resolve, reject) => {
        const instance = autocannon(opts, (err, result) => {
            if (err) return reject(err);
            resolve(result);
        });
        autocannon.track(instance, { renderProgressBar: false });
    });
}

function getServerUrl() {
    return serverUrl;
}

module.exports = { bootServer, stopServer, runAutocannon, getServerUrl };
