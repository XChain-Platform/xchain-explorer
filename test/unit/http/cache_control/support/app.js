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
 * A real express app carrying the Cache-Control stamp, the CORS policy, the
 * bridge panel routes and every listener a real XChainExplorer mounts, with
 * only the database replaced. Requests go through the same writers production
 * uses.
 */

'use strict';

const express    = require('express');
const proxyquire = require('proxyquire');

const { applyCacheControl }      = require('../../../../../src/http/cache_control.js');
const { applyCors }              = require('../../../../../src/http/api_boot/cors.js');
const { applyRateLimits }        = require('../../../../../src/http/api_boot/rate_limits.js');
const { mountBridgePanelRoutes } = require('../../../../../src/http/bridge_panel_routes.js');
const { createConfigInfoStub }   = require('../../../../fixtures/mock-config.js');

// What getData answers, per test.
const state = { getDataResult: [[], null], getDataError: null };

class MockDB {
    constructor() {}
    async init() {}
    getMaxMethodResults() { return 100; }
    async getData() {
        if (state.getDataError) throw state.getDataError;
        return state.getDataResult;
    }
}

const XChainExplorer = proxyquire('../../../../../src/XChainExplorer.js', {
    './db/index.js': MockDB
});

/**
 * Build the app in createApp's mount order.
 *
 * @param {object} [options]
 * @param {number} [options.rateLimitRpm] mount the app-wide limiter at this ceiling
 * @param {string} [options.corsOrigin] an EXPLORER_CORS_ORIGIN allowlist
 * @param {object} [options.hub] the hub connector the bridge routes read through
 * @returns {{app: object, explorer: object}}
 */
function buildApp(options = {}) {
    const app = express();
    applyCacheControl(app);
    applyCors(app, { env: { EXPLORER_CORS_ORIGIN: options.corsOrigin || '' } });
    if (options.rateLimitRpm)
        applyRateLimits(app, { env: { EXPLORER_RATE_LIMIT_RPM: String(options.rateLimitRpm) } }, () => false);
    let explorer = null;
    mountBridgePanelRoutes(app, () => explorer, options.hub || null);
    explorer = new XChainExplorer(app, createConfigInfoStub());
    return { app, explorer };
}

/**
 * Every GET listener the app registered, in registration order, with the
 * layer so a caller can ask which ones match a path.
 */
function getRoutes(app) {
    return app.router.stack
        .filter(layer => layer.route && layer.route.methods && layer.route.methods.get)
        .map(layer => ({ path: layer.route.path, layer }));
}

module.exports = { buildApp, getRoutes, state };
