/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

const assert = require('assert');
const path   = require('path');

const { siblingCheckout } = require('../../../helpers/sibling_checkout.js');
const { makeConfig: defaultMakeConfig } = require('../../../fixtures/mock-query-args.js');

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const DASHBOARD_CLIENT = path.join('monitor', 'src', 'lib', 'explorer-client.js');
const DASHBOARD_PROBE_ARGS = {
    getContract:        { search: '1' },
    getContractState:   { search: '1' },
    getContractBalance: { search: 'C:BTC:1' },
};

function dashboardClientPath(env = process.env, repoRoot = REPO_ROOT) {
    const dashboardRoot = env.XCHAIN_DASHBOARD_DIR || path.join(repoRoot, '..', 'xchain-dashboard');
    return path.join(dashboardRoot, DASHBOARD_CLIENT);
}

function loadDashboardManifest(clientFile) {
    const client = require(clientFile);
    const manifest = client.EXPLORER_ROW_FIELDS;
    assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest),
        clientFile + ' does not export EXPLORER_ROW_FIELDS');
    assert.ok(Object.keys(manifest).length > 0, clientFile + ' exports an empty EXPLORER_ROW_FIELDS');
    return manifest;
}

function addResultKeys(keys, result) {
    if (!result || typeof result !== 'object') return;
    if (Array.isArray(result.meta)) {
        for (const column of result.meta) {
            const name = column && typeof column.name === 'function' ? column.name()
                : column && typeof column.name === 'string' ? column.name : null;
            if (name) keys.add(name);
        }
    }
    const rows = Array.isArray(result) ? result : [result];
    for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        for (const key of Object.keys(row)) keys.add(key);
    }
}

async function readerKeys(db, config) {
    const candidates = [];
    const realDoQuery = db.doQuery;
    const ownedDoQuery = Object.prototype.hasOwnProperty.call(db, 'doQuery');
    const ownDescriptor = ownedDoQuery ? Object.getOwnPropertyDescriptor(db, 'doQuery') : null;
    db.doQuery = async function (...args) {
        const result = await realDoQuery.apply(this, args);
        const keys = new Set();
        addResultKeys(keys, result);
        if (keys.size) candidates.push(keys);
        return result;
    };
    try {
        const result = await db.getData(config);
        const keys = new Set();
        addResultKeys(keys, Array.isArray(result) ? result[0] : result);
        if (keys.size) candidates.push(keys);
    } finally {
        if (ownedDoQuery) Object.defineProperty(db, 'doQuery', ownDescriptor);
        else delete db.doQuery;
    }
    return candidates.reduce((largest, keys) => keys.size > largest.size ? keys : largest, new Set());
}

function missingManifestKeys(manifest, observed) {
    return manifest.filter((key) => !observed.has(key));
}

function readerConfig(reader, conformance = {}) {
    const makeConfig = conformance.makeConfig || defaultMakeConfig;
    const probeArgs = conformance.PROBE_ARGS || DASHBOARD_PROBE_ARGS;
    const probes = Object.assign({}, DASHBOARD_PROBE_ARGS[reader] || {}, probeArgs[reader] || {});
    return makeConfig({ coin: 'RBTC', data: Object.assign({ method: reader }, probes) });
}

function registerDashboardManifest(runtime) {
    const conformance = require('../../schema_conformance.test.js');
    describe('dashboard explorer-reader manifest against the real schema', function () {
        const clientFile = dashboardClientPath();
        let manifest;

        before(function () {
            const dashboard = siblingCheckout(__dirname, clientFile);
            // xchain-dashboard is private, so no CI venue can ship it (see
            // .ci-siblings): skip with the reason printed even under
            // XCHAIN_REQUIRE_SIBLINGS=1 rather than fail a run that could
            // never have supplied it.
            if (!dashboard.usable) {
                console.log('      NOT VERIFIED: dashboard explorer-reader manifest conformance skipped: '
                    + dashboard.reason + ' (private sibling, optional)');
                return this.skip();
            }
            manifest = loadDashboardManifest(clientFile);
        });

        it('returns every field the dashboard manifest maps for each reader', async function () {
            const failures = [];
            for (const [reader, fields] of Object.entries(manifest)) {
                if (!Array.isArray(fields) || fields.length === 0) {
                    failures.push(reader + ': manifest field list is empty or invalid');
                    continue;
                }
                if (typeof runtime.state.db[reader] !== 'function') {
                    failures.push(reader + ': explorer reader is missing');
                    continue;
                }
                try {
                    const observed = await readerKeys(runtime.state.db, readerConfig(reader, conformance));
                    const missing = missingManifestKeys(fields, observed);
                    if (missing.length) failures.push(reader + ': missing ' + missing.join(', '));
                } catch (e) {
                    failures.push(reader + ': ' + e.message);
                }
            }
            assert.deepStrictEqual(failures, [],
                'dashboard-mapped explorer reader drift:\n' + failures.join('\n'));
        });
    });
}

module.exports = {
    DASHBOARD_CLIENT,
    DASHBOARD_PROBE_ARGS,
    dashboardClientPath,
    loadDashboardManifest,
    addResultKeys,
    readerKeys,
    missingManifestKeys,
    readerConfig,
    registerDashboardManifest,
};
