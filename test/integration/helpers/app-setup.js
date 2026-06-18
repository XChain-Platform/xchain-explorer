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
 * Integration test helper: boots the explorer against a test MariaDB
 * and returns a supertest agent for making HTTP requests.
 */

const express        = require('express');
const cors           = require('cors');
const path           = require('path');
const XChainExplorer = require('../../../src/XChainExplorer.js');

// Build a configInfo stub that behaves like src/config.js but uses our test config
function createTestConfigInfo(dbPort) {
    const port = dbPort || 3307;
    let configCache = null;
    const listeners = [];

    return {
        getConfig: async function () {
            if (configCache) return configCache;

            const coinFile = require('../../../src/configs/BTC.js');
            const coinConfig = coinFile.getConfig('regtest');

            const config = {};

            config['COIN_NETWORKS'] = { BTC: 'Bitcoin', LTC: 'Litecoin', DOGE: 'Dogecoin' };
            config['COIN_PREFIXES'] = { mainnet: '', testnet: 'T', regtest: 'R' };

            // Build supported list (all coin+network combos)
            config['COIN_SUPPORTED'] = {};
            for (const coin in config['COIN_NETWORKS']) {
                for (const network in config['COIN_PREFIXES']) {
                    const prefix = config['COIN_PREFIXES'][network];
                    const code = prefix + coin;
                    config['COIN_SUPPORTED'][code] = config['COIN_NETWORKS'][coin] + ' (' + network + ')';
                }
            }

            // Only regtest BTC is available
            config['COIN_AVAILABLE'] = { RBTC: 'BTC (regtest)' };
            config['DISPENSER_LIST_DELAY'] = 3600;

            config['API'] = {
                host: '127.0.0.1',
                user: false,
                pass: false,
                ssl: { key: 'mock', cert: 'mock', ca: 'mock' },
                port: { http: 0, https: 0 }
            };

            config['BTC'] = {
                chain: coinConfig.chain,
                regtest: {
                    database: {
                        indexer: { db_host: '127.0.0.1', db_port: port, user: 'root', pass: 'testpass', name: 'XChain_BTC_Regtest_Indexer' },
                        decoder: { db_host: '127.0.0.1', db_port: port, user: 'root', pass: 'testpass', name: 'XChain_BTC_Regtest_Decoder' }
                    },
                    address: coinConfig.address
                }
            };

            configCache = config;
            return config;
        },
        onConfigChanged: function (cb) { listeners.push(cb); },
        triggerConfigChanged: function () { listeners.forEach(cb => cb()); },
        // Allow tests to clear cache if config changes
        _clearCache: function () { configCache = null; }
    };
}

// Cached app instance (reused across test files in the same process)
let cachedResult = null;

// Boot an Express app with the explorer attached (no HTTP server, supertest injects directly)
async function createApp(dbPort) {
    if (cachedResult) return cachedResult;

    const app = express();
    app.use(express.json());
    app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

    const configInfo = createTestConfigInfo(dbPort);
    const explorer = new XChainExplorer(app, configInfo);
    await explorer.init();

    cachedResult = { app, explorer, configInfo };
    return cachedResult;
}

module.exports = { createApp, createTestConfigInfo };
