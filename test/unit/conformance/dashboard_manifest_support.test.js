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
const { siblingCheckout } = require('../../helpers/sibling_checkout.js');
const seed    = require('../../conformance/schema_conformance.test/support/dashboard_manifest_seed.js');

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

// Spell the client path out, so a constant pointing at the wrong file cannot pass by comparing with itself
const CLIENT_IN_DASHBOARD = path.join('plugins', 'monitor', 'src', 'lib', 'clients', 'explorer_client.js');

function resolvesDashboardClient() {
    const defaultPath = support.dashboardClientPath({}, path.join('/checkout', 'xchain-explorer'));
    assert.strictEqual(defaultPath,
        path.join('/checkout', 'xchain-dashboard', CLIENT_IN_DASHBOARD));

    const overridePath = support.dashboardClientPath(
        { XCHAIN_DASHBOARD_DIR: path.join('/venue', 'dashboard') },
        path.join('/ignored', 'xchain-explorer'));
    assert.strictEqual(overridePath,
        path.join('/venue', 'dashboard', CLIENT_IN_DASHBOARD));
}

function failsWhenDashboardCheckoutLacksClient() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-checkout-'));
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{}\n');
    const clientFile = path.join(tempDir, support.DASHBOARD_CLIENT);
    assert.throws(() => support.dashboardManifestForCheckout(
        { usable: false, reason: 'sibling path absent: ' + clientFile }, clientFile),
    /has no .*explorer_client\.js: point DASHBOARD_CLIENT at the file that exports EXPLORER_ROW_FIELDS/);
}

function failsRefusedClientOnlyInStrictMode() {
    const file = moduleFile("module.exports = { EXPLORER_ROW_FIELDS: { getTokens: ['live'] } };\n");
    const refused = { usable: false, reason: 'sibling resolves through a symlink into the live main checkout' };
    assert.throws(() => support.dashboardManifestForCheckout(refused, file, undefined,
        { XCHAIN_REQUIRE_SIBLINGS: '1' }), /XCHAIN_REQUIRE_SIBLINGS=1 .*symlink into the live main checkout/);
    assert.strictEqual(support.dashboardManifestForCheckout(refused, file, undefined, {}),
        support.loadDashboardManifestFixture());
}

// Skip, never fail, without the dashboard: it is a private repo no CI venue checks out
function pinnedManifestMatchesDashboardClient() {
    const clientFile = support.dashboardClientPath();
    if (!siblingCheckout(__dirname, clientFile).usable) return this.skip();
    assert.deepStrictEqual(support.loadDashboardManifest(clientFile), support.loadDashboardManifestFixture(),
        'test/fixtures/dashboard-explorer-row-fields.json differs from the dashboard EXPLORER_ROW_FIELDS');
}

function loadsReaderManifest() {
    const file = moduleFile("module.exports = { EXPLORER_ROW_FIELDS: { getTokens: ['tick'] } };\n");
    assert.deepStrictEqual(support.loadDashboardManifest(file), { getTokens: ['tick'] });
}

function loadsPinnedManifestWhenDashboardIsAbsent() {
    const manifest = support.dashboardManifestForCheckout(
        { usable: false }, path.join('/absent', support.DASHBOARD_CLIENT));
    assert.strictEqual(manifest, support.loadDashboardManifestFixture());
    assert.strictEqual(Object.keys(manifest).length, 17);
    assert.deepStrictEqual(manifest.getTokens,
        ['tick', 'supply', 'max_supply', 'decimals', 'block_index']);
}

function prefersDashboardManifestWhenDashboardIsUsable() {
    const file = moduleFile("module.exports = { EXPLORER_ROW_FIELDS: { getTokens: ['live'] } };\n");
    assert.deepStrictEqual(support.dashboardManifestForCheckout({ usable: true }, file),
        { getTokens: ['live'] });
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

function probesContractReadersWithBareIndex() {
    for (const reader of ['getContractState', 'getContractBalance']) {
        const config = support.readerConfig(reader);
        assert.strictEqual(config.data.type, 'contract', reader);
        assert.strictEqual(config.data.search, '1', reader);
    }
}

// getContractBalance prepends C:<CHAIN>: itself, so the seeded custody address
// must carry a single C: prefix or the seed lands on a row the reader never reads.
function seedsCustodyAddressWithSingleContractPrefix() {
    const db = { baseCoin: { RBTC: 'BTC' } };
    const probe = support.seedProbe(db, {});
    assert.deepStrictEqual(probe, { stateContract: 1, balanceAddress: 'C:BTC:1' });

    const conformance = { PROBE_ARGS: { getContractBalance: { search: '7', type: 'contract' } } };
    assert.strictEqual(support.seedProbe(db, conformance).balanceAddress, 'C:BTC:7');
}

// A connection that interns nothing up front and hands out increasing insert ids.
function recordingPool() {
    const inserts = [];
    let nextId = 1;
    const conn = {
        async query(sql, args) {
            if (/^INSERT INTO (\S+)/.test(sql)) {
                inserts.push([sql.match(/^INSERT INTO (\S+)/)[1], sql, args]);
                return { insertId: nextId++ };
            }
            return [];
        },
        release() {},
    };
    return { inserts, pool: { async getConnection() { return conn; } } };
}

async function seedsSwapAndDispenserRows() {
    const { inserts, pool } = recordingPool();
    const made = await seed.seedManifestReaders(pool, 'indexer', { stateContract: 1, balanceAddress: 'C:BTC:1' });
    const tables = inserts.map(([table]) => table);
    for (const table of ['swaps', 'dispensers']) {
        assert.strictEqual(tables.filter((name) => name === table).length, 1, table);
        assert.ok(made.some(([name, key]) => name === table && key === 'action_index'), table);
    }
    // Each seeded action row carries its own action_index, and swaps and dispensers point at theirs.
    const actionIndexes = inserts.filter(([table]) => table === 'actions').map(([, , args]) => args[0]);
    for (const table of ['swaps', 'dispensers']) {
        const [, sql, args] = inserts.find(([name]) => name === table);
        const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(', ');
        assert.ok(actionIndexes.includes(args[columns.indexOf('action_index')]), table);
    }
    assert.strictEqual(new Set(actionIndexes).size, actionIndexes.length);
    const custody = inserts.find(([table, , args]) => table === 'index_addresses' && args[0].startsWith('C:'));
    assert.deepStrictEqual(custody[2], ['C:BTC:1']);
}

function registerTests() {
    afterEach(cleanupTempDir);
    it('resolves the dashboard client from the sibling root or environment override', resolvesDashboardClient);
    it('loads a non-empty exported reader manifest', loadsReaderManifest);
    it('loads the pinned reader manifest when the dashboard sibling is absent',
        loadsPinnedManifestWhenDashboardIsAbsent);
    it('prefers the dashboard reader manifest when the sibling is usable',
        prefersDashboardManifestWhenDashboardIsUsable);
    it('fails when a dashboard checkout is present but has no reader client at the expected path',
        failsWhenDashboardCheckoutLacksClient);
    it('fails a refused dashboard client in strict mode and falls back to the fixture otherwise',
        failsRefusedClientOnlyInStrictMode);
    it('pins a fixture equal to the dashboard reader manifest whenever the dashboard is checked out',
        pinnedManifestMatchesDashboardClient);
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
    it('probes the contract state and balance readers with type contract and a bare index',
        probesContractReadersWithBareIndex);
    it('seeds the custody address with a single C: prefix', seedsCustodyAddressWithSingleContractPrefix);
    it('seeds a swaps row and a dispensers row on their own actions', seedsSwapAndDispenserRows);
}

describe('dashboard manifest conformance support', registerTests);
