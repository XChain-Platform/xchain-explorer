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
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const support = require('../../conformance/schema_conformance.test/support/dashboard_manifest.js');

let tempDir;

function cleanupTempDir() {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
}

function moduleFile(source) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-manifest-'));
    const file = path.join(tempDir, 'client.js');
    fs.writeFileSync(file, source);
    return file;
}

function resolvesDashboardClient() {
    const defaultPath = support.dashboardClientPath({}, path.join('/checkout', 'xchain-explorer'));
    assert.strictEqual(defaultPath,
        path.join('/checkout', 'xchain-dashboard', support.DASHBOARD_CLIENT));

    const overridePath = support.dashboardClientPath(
        { XCHAIN_DASHBOARD_DIR: path.join('/venue', 'dashboard') },
        path.join('/ignored', 'xchain-explorer'));
    assert.strictEqual(overridePath,
        path.join('/venue', 'dashboard', support.DASHBOARD_CLIENT));
}

function loadsReaderManifest() {
    const file = moduleFile("module.exports = { EXPLORER_ROW_FIELDS: { getTokens: ['tick'] } };\n");
    assert.deepStrictEqual(support.loadDashboardManifest(file), { getTokens: ['tick'] });
}

function rejectsInvalidReaderManifest() {
    const file = moduleFile('module.exports = {};\n');
    assert.throws(() => support.loadDashboardManifest(file), /does not export EXPLORER_ROW_FIELDS/);

    fs.writeFileSync(file, 'module.exports = { EXPLORER_ROW_FIELDS: {} };\n');
    delete require.cache[require.resolve(file)];
    assert.throws(() => support.loadDashboardManifest(file), /exports an empty EXPLORER_ROW_FIELDS/);
}

function collectsProjectedKeys() {
    const rows = [{ tick: 'TST' }];
    rows.meta = [
        { name: 'supply' },
        { name: () => 'max_supply' },
        null,
    ];
    const keys = new Set();
    support.addResultKeys(keys, rows);
    assert.deepStrictEqual([...keys].sort(), ['max_supply', 'supply', 'tick']);
}

async function usesWidestReaderProjection() {
    const calls = [];
    const prototype = {
        async doQuery(config, query) {
            calls.push([config.data.method, query]);
            if (query === 'count') return [{ total: 0 }];
            const rows = [];
            rows.meta = [{ name: () => 'tick' }, { name: () => 'supply' }];
            return rows;
        },
    };
    const db = Object.create(prototype);
    db.getData = async function (config) {
        await this.doQuery(config, 'count');
        const rows = await this.doQuery(config, 'rows');
        return [rows, 0];
    };
    const config = { data: { method: 'getTokens' } };

    const observed = await support.readerKeys(db, config);

    // The widest projection is kept as a diagnostic only: zero served rows verify nothing.
    assert.deepStrictEqual([...observed.sqlKeys].sort(), ['supply', 'tick']);
    assert.strictEqual(observed.rowCount, 0);
    assert.deepStrictEqual([...observed.rowKeys], []);
    assert.deepStrictEqual(calls, [['getTokens', 'count'], ['getTokens', 'rows']]);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(db, 'doQuery'), false);
    assert.strictEqual(db.doQuery, prototype.doQuery);
}

// A stub reader whose SQL selects every field and whose mapper returns `rows`.
function mappedReader(rows) {
    const db = {
        async doQuery() {
            const result = [{ tick: 'TST', supply: '1', decimals: 0 }];
            result.meta = [{ name: 'tick' }, { name: 'supply' }, { name: 'decimals' }];
            return result;
        },
        async getData(config) {
            await this.doQuery(config, 'rows');
            return [rows, 1];
        },
    };
    return db;
}

async function reportsFieldDroppedByMapper() {
    const observed = await support.readerKeys(mappedReader([{ tick: 'TST', decimals: 0 }]), {});
    const verdict = support.readerVerdict('getTokens', ['tick', 'supply', 'decimals'], observed, {});
    assert.deepStrictEqual(verdict,
        { failure: "getTokens: missing supply (selected by SQL but dropped by the reader's mapping)" });
}

async function treatsUndefinedValueAsAbsent() {
    const observed = await support.readerKeys(mappedReader([{ tick: 'TST', supply: undefined, decimals: 0 }]), {});
    assert.strictEqual(observed.rowCount, 1);
    assert.deepStrictEqual([...observed.rowKeys].sort(), ['decimals', 'tick']);
}

async function requiresKeyOnEveryRow() {
    const observed = await support.readerKeys(mappedReader([
        { tick: 'A', supply: '1', decimals: 0 },
        { tick: 'B', decimals: 0 },
    ]), {});
    assert.strictEqual(observed.rowCount, 2);
    assert.deepStrictEqual([...observed.rowKeys].sort(), ['decimals', 'tick']);
}

async function readsDetailObjectAsOneRow() {
    const observed = await support.readerKeys(mappedReader({ source: 'addr', status: 'valid' }), {});
    assert.strictEqual(observed.rowCount, 1);
    assert.deepStrictEqual([...observed.rowKeys].sort(), ['source', 'status']);
}

function failsReaderWithNoRows() {
    const empty = { rowCount: 0, rowKeys: new Set(), sqlKeys: new Set(['tick']) };
    assert.deepStrictEqual(support.readerVerdict('getTokens', ['tick'], empty, {}),
        { failure: 'getTokens: returned no rows; seed a fixture row' });
    assert.deepStrictEqual(support.readerVerdict('getTokens', ['tick'], empty, { getTokens: 'no table' }),
        { notVerified: 'getTokens: NOT VERIFIED (no fixture row: no table)' });
    const served = { rowCount: 1, rowKeys: new Set(['tick']), sqlKeys: new Set(['tick']) };
    assert.deepStrictEqual(support.readerVerdict('getTokens', ['tick'], served, { getTokens: 'no table' }),
        { failure: 'getTokens: returns rows now; remove it from UNSEEDED_READERS' });
    assert.deepStrictEqual(support.readerVerdict('getTokens', ['tick'], served, {}), {});
}

async function restoresOwnedQueryAfterFailure() {
    const original = async function () { return []; };
    const db = {
        doQuery: original,
        async getData() {
            await this.doQuery({}, 'rows');
            throw new Error('reader failed');
        },
    };

    await assert.rejects(support.readerKeys(db, {}), /reader failed/);
    assert.strictEqual(db.doQuery, original);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(db, 'doQuery'), true);
}

function reportsAbsentManifestKeys() {
    assert.deepStrictEqual(
        support.missingManifestKeys(['tick', 'supply', 'decimals'], new Set(['tick', 'decimals'])),
        ['supply']);
}

function buildsReaderConfig() {
    let received;
    const makeConfig = (overrides) => {
        received = overrides;
        return { wrapped: overrides };
    };
    const config = support.readerConfig('getContractBalance', {
        makeConfig,
        PROBE_ARGS: { getContractBalance: { search: 'C:RBTC:9', type: 'address' } },
    });

    assert.strictEqual(config.wrapped, received);
    assert.deepStrictEqual(received, {
        coin: 'RBTC',
        data: { method: 'getContractBalance', search: 'C:RBTC:9', type: 'address' },
    });
    assert.strictEqual(support.readerConfig('getContract').data.search, '1');
}

function registerTests() {
    afterEach(cleanupTempDir);
    it('resolves the dashboard client from the sibling root or environment override', resolvesDashboardClient);
    it('loads a non-empty exported reader manifest', loadsReaderManifest);
    it('rejects a missing or empty reader manifest', rejectsInvalidReaderManifest);
    it('collects projected keys from rows and MariaDB metadata', collectsProjectedKeys);
    it('uses the widest reader query projection and restores an inherited doQuery', usesWidestReaderProjection);
    it('restores an owned doQuery after a reader failure', restoresOwnedQueryAfterFailure);
    it('reports a field the SQL selects but the reader mapping drops', reportsFieldDroppedByMapper);
    it('treats an undefined-valued row key as absent from the served row', treatsUndefinedValueAsAbsent);
    it('requires a manifest key on every served row, not only the first', requiresKeyOnEveryRow);
    it('reads a single-object detail result as one served row', readsDetailObjectAsOneRow);
    it('fails a reader with no served rows unless it is listed as unseeded', failsReaderWithNoRows);
    it('reports only absent manifest keys', reportsAbsentManifestKeys);
    it('builds an RBTC reader config with required and conformance probe arguments', buildsReaderConfig);
}

describe('dashboard manifest conformance support', registerTests);
