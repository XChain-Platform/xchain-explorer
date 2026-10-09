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
const { seedManifestReaders, deleteSeeded } = require('./dashboard_manifest_seed.js');

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

// Rows the /api route serves for one getData result, read the way the dashboard
// reads a parsed body: a list is its rows, a detail object is one row.
function servedRows(result, stringify = JSON.stringify) {
    const data = Array.isArray(result) ? result[0] : result;
    const rows = Array.isArray(data) ? data
        : data && typeof data === 'object' && Array.isArray(data.data) ? data.data
        : data && typeof data === 'object' ? [data] : [];
    // Round-trip through the response serializer so an undefined-valued key reads absent, as on the wire.
    return rows.map((row) => JSON.parse(stringify(row === undefined ? null : row)));
}

// Keys present on EVERY served row, since the dashboard rejects a read on any row.
function sharedRowKeys(rows) {
    let shared = null;
    for (const row of rows) {
        const keys = row && typeof row === 'object' && !Array.isArray(row) ? Object.keys(row) : [];
        shared = shared === null ? new Set(keys) : new Set(keys.filter((key) => shared.has(key)));
    }
    return shared || new Set();
}

// Run one reader and report its served rows; the widest SQL projection is a diagnostic only.
async function readerKeys(db, config) {
    let sqlKeys = new Set();
    const realDoQuery = db.doQuery;
    const ownedDoQuery = Object.prototype.hasOwnProperty.call(db, 'doQuery');
    const ownDescriptor = ownedDoQuery ? Object.getOwnPropertyDescriptor(db, 'doQuery') : null;
    db.doQuery = async function (...args) {
        const result = await realDoQuery.apply(this, args);
        const keys = new Set();
        addResultKeys(keys, result);
        if (keys.size > sqlKeys.size) sqlKeys = keys;
        return result;
    };
    let rows;
    try {
        const util = db.util;
        rows = servedRows(await db.getData(config),
            util && typeof util.jsonStringify === 'function' ? (value) => util.jsonStringify(value) : undefined);
    } finally {
        if (ownedDoQuery) Object.defineProperty(db, 'doQuery', ownDescriptor);
        else delete db.doQuery;
    }
    return { rowCount: rows.length, rowKeys: sharedRowKeys(rows), sqlKeys };
}

function missingManifestKeys(manifest, observed) {
    return manifest.filter((key) => !observed.has(key));
}

// Readers this rig cannot yet give a row: each prints NOT VERIFIED instead of
// passing, and an entry fails once its reader returns rows, so the list only shrinks.
const UNSEEDED_READERS = Object.freeze({});

// Judge one reader's served rows against its manifest fields; SQL keys only explain.
function readerVerdict(reader, fields, observed, unseeded = UNSEEDED_READERS) {
    const allowed = Object.prototype.hasOwnProperty.call(unseeded, reader);
    if (observed.rowCount === 0) {
        if (allowed) return { notVerified: reader + ': NOT VERIFIED (no fixture row: ' + unseeded[reader] + ')' };
        return { failure: reader + ': returned no rows; seed a fixture row' };
    }
    if (allowed) return { failure: reader + ': returns rows now; remove it from UNSEEDED_READERS' };
    const missing = missingManifestKeys(fields, observed.rowKeys).map((key) => observed.sqlKeys.has(key)
        ? key + ' (selected by SQL but dropped by the reader\'s mapping)' : key);
    return missing.length ? { failure: reader + ': missing ' + missing.join(', ') } : {};
}

function readerConfig(reader, conformance = {}) {
    const makeConfig = conformance.makeConfig || defaultMakeConfig;
    const probeArgs = conformance.PROBE_ARGS || DASHBOARD_PROBE_ARGS;
    const probes = Object.assign({}, DASHBOARD_PROBE_ARGS[reader] || {}, probeArgs[reader] || {});
    return makeConfig({ coin: 'RBTC', data: Object.assign({ method: reader }, probes) });
}

// Where the probed contract readers look, so the seed lands on the rows they read.
function seedProbe(db, conformance) {
    const state = readerConfig('getContractState', conformance);
    const balance = readerConfig('getContractBalance', conformance);
    return {
        stateContract: Number(state.data.search),
        balanceAddress: 'C:' + db.baseCoin[balance.coin] + ':' + balance.data.search,
    };
}

function registerDashboardManifest(runtime) {
    const conformance = require('../../schema_conformance.test.js');
    describe('dashboard explorer-reader manifest against the real schema', function () {
        const clientFile = dashboardClientPath();
        const tokensCacheMs = process.env.EXPLORER_TOKENS_CACHE_MS;
        let manifest;
        let seeded = [];

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

        before(async function () {
            if (!manifest) return;
            // A token list cached by an earlier test would hide the seeded row.
            process.env.EXPLORER_TOKENS_CACHE_MS = '1';
            seeded = await seedManifestReaders(runtime.state.adminPool, conformance.INDEXER_DB,
                seedProbe(runtime.state.db, conformance));
        });

        after(async function () {
            if (tokensCacheMs === undefined) delete process.env.EXPLORER_TOKENS_CACHE_MS;
            else process.env.EXPLORER_TOKENS_CACHE_MS = tokensCacheMs;
            if (seeded.length) await deleteSeeded(runtime.state.adminPool, conformance.INDEXER_DB, seeded);
            seeded = [];
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
                    const verdict = readerVerdict(reader, fields, observed);
                    if (verdict.failure) failures.push(verdict.failure);
                    if (verdict.notVerified) console.log('      ' + verdict.notVerified);
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
    servedRows,
    sharedRowKeys,
    readerKeys,
    missingManifestKeys,
    UNSEEDED_READERS,
    readerVerdict,
    readerConfig,
    registerDashboardManifest,
};
