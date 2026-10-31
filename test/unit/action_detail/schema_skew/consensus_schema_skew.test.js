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
 * ATTEST and ROLLCALL detail on a replica that has not taken the additive
 * indexer migrations their newest columns come from (attests batch_*,
 * rollcall_signers.gates). A statement naming a missing column is a 1054 for
 * the whole statement, so each page must name the column only once present,
 * and render the same keys either way.
 *********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../../../src/lib/utility.js');
const { DbQueryError } = require('../../../../src/db/shared.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const config = { coin: 'DOGE', data: {} };
const BATCH_COLUMNS = ['batch_action_index', 'batch_window_start', 'batch_window_end', 'batch_row_count',
    'batch_chunk_index', 'batch_total_chunks'];

function unknownColumnError(column) {
    const driver = new Error("Unknown column '" + column + "' in 'field list'");
    driver.errno = 1054;
    driver.code  = 'ER_BAD_FIELD_ERROR';
    return new DbQueryError('SQL query failed: ' + driver.message, driver);
}

// A v0 ATTEST row carrying exactly the keys the statement projects: NULL for a
// `NULL as` alias, a value for a real batch column.
function attestRow(text) {
    const row = { action: 'ATTEST', action_format: 0, action_index: 9, version: 0 };
    for (const m of text.matchAll(/NULL as (batch_[a-z0-9_]+)/g)) row[m[1]] = null;
    for (const m of text.matchAll(/\bm\.(batch_[a-z0-9_]+)/g)) row[m[1]] = 1;
    return row;
}

// A db over a replica emulating MariaDB: a statement naming a column the schema lacks throws 1054.
function makeDb(type, state) {
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.getActionType      = async () => type;
    db.getActionFeeData   = async () => null;
    db.getTransactionData = async () => null;
    db.doQuery = async (cfg, sql) => {
        const text = String(sql);
        state.queries.push(text);
        if (/information_schema\.COLUMNS/i.test(text)) {
            if (state.probeThrows) throw new Error('information_schema unavailable');
            return state.columns.map((COLUMN_NAME) => ({ COLUMN_NAME }));
        }
        for (const m of text.matchAll(/\bm\.(batch_[a-z0-9_]+|gates)\b/g))
            if (!state.columns.includes(m[1])) throw unknownColumnError(m[1]);
        if (/FROM\s+attests/.test(text)) return [attestRow(text)];
        if (/SELECT\s+m\.gates/.test(text)) return [{ gates: state.gates }];
        if (/FROM\s+rollcall_signers/.test(text) && text.includes('LIMIT 1'))
            return [{ action: 'ROLLCALL', action_format: 1, action_index: 9 }];
        return [];
    };
    return db;
}

const named = (state, re) => state.queries.filter((q) => re.test(q) && !/information_schema/i.test(q));

describe('ATTEST detail across the batch-column migration @regression', function () {
    it('a pre-batch replica renders, names no batch column and keeps the keys as null', async function () {
        const state = { queries: [], columns: [] };
        const data  = await makeDb('ATTEST', state).getActionData(config, 9);
        assert.strictEqual(named(state, /m\.batch_/).length, 0, 'no statement may name a column the schema lacks');
        assert.strictEqual(data.action, 'ATTEST');
        for (const key of ['batch_action_index', 'batch_window_start', 'batch_btc_block_height', 'batch_crc32', 'batch_chunk_index'])
            assert.ok(key in data && data[key] === null, key);
    });

    it('an upgraded replica reads every batch column', async function () {
        const state = { queries: [], columns: BATCH_COLUMNS.concat(['batch_btc_block_height', 'batch_crc32']) };
        await makeDb('ATTEST', state).getActionData(config, 9);
        const reads = named(state, /FROM\s+attests/);
        assert.strictEqual(reads.length, 1);
        for (const name of state.columns) assert.ok(reads[0].includes('m.' + name), name);
    });

    it('a probe that errors takes the safe pre-batch read', async function () {
        const state = { queries: [], columns: [], probeThrows: true };
        const data  = await makeDb('ATTEST', state).getActionData(config, 9);
        assert.strictEqual(named(state, /m\.batch_/).length, 0);
        assert.strictEqual(data.batch_action_index, null);
    });

    it('a history list with an ATTEST row resolves on a pre-batch replica', async function () {
        const state = { queries: [], columns: [] };
        const db    = makeDb('ATTEST', state);
        // The page-level preload covers only the shared legs; skip it so the type read is the stub.
        db.buildActionPreload = async () => null;
        const out   = await db.getActionDataBatch(config, [9]);
        assert.strictEqual(out.get(9).action, 'ATTEST');
    });
});

describe('ROLLCALL detail across the gates migration @regression', function () {
    it('an upgraded replica reads and splits the gates', async function () {
        const state = { queries: [], columns: ['gates'], gates: 'vm.CALL,vm.DEPLOY' };
        const data  = await makeDb('ROLLCALL', state).getActionData(config, 9);
        assert.deepStrictEqual(data.gates, ['vm.CALL', 'vm.DEPLOY']);
    });

    it('a replica without the column renders with no gates and never names it', async function () {
        const state = { queries: [], columns: [] };
        const data  = await makeDb('ROLLCALL', state).getActionData(config, 9);
        assert.strictEqual(named(state, /m\.gates/).length, 0);
        assert.deepStrictEqual(data.gates, []);
        assert.strictEqual(data.action, 'ROLLCALL');
    });

    it('recovers from the 1054 a stale positive memo earns, then stops paying it', async function () {
        const state = { queries: [], columns: [] };
        const db    = makeDb('ROLLCALL', state);
        db.schemaColumnMemo = { [config.coin]: { 'rollcall_signers:gates': { present: true, at: Date.now() } } };
        const data  = await db.getActionData(config, 9);
        assert.deepStrictEqual(data.gates, []);
        assert.strictEqual(db.schemaColumnMemo[config.coin]['rollcall_signers:gates'].present, false);
        await db.getActionData(config, 10);
        assert.strictEqual(named(state, /m\.gates/).length, 1, 'exactly one statement pays for the wrong memo');
    });
});

function missingTableError(table) {
    const driver = new Error("Table 'xchain." + table + "' doesn't exist");
    driver.errno = 1146;
    driver.code  = 'ER_NO_SUCH_TABLE';
    return new DbQueryError('SQL query failed: ' + driver.message, driver);
}

const LEDGER = 'ab'.repeat(32);
const PUBLISHER = 'cd'.repeat(32);

// Emulate a DOGE replica with or without rollcall_actions: `actionRow` is that table's
// row for the action, `signerRows` the first-seen rows rollcall_signers holds for it.
function makeRollcallDb(state) {
    const db = makeDb('ROLLCALL', state);
    db.doQuery = async (cfg, sql) => {
        const text = String(sql);
        state.queries.push(text);
        if (/information_schema\.TABLES/i.test(text)) return state.tables.map((TABLE_NAME) => ({ TABLE_NAME }));
        if (/information_schema\.COLUMNS/i.test(text)) return ['gates'].map((COLUMN_NAME) => ({ COLUMN_NAME }));
        if (/FROM\s+rollcall_actions/.test(text)) {
            if (!state.tables.includes('rollcall_actions')) throw missingTableError('rollcall_actions');
            return state.actionRow ? [Object.assign({}, state.actionRow)] : [];
        }
        const rows = state.signerRows || [];
        if (/SELECT\s+m\.gates/.test(text)) return rows.length ? [{ gates: 'vm.CALL' }] : [];
        if (/FROM\s+rollcall_signers/.test(text) && text.includes('LIMIT 1'))
            return rows.length ? [{ action: 'ROLLCALL', action_format: 1, action_index: 9, epoch_height: 300,
                ledger_hash: LEDGER, publisher: PUBLISHER }] : [];
        if (/FROM\s+rollcall_signers/.test(text)) return rows.slice();
        return [];
    };
    return db;
}

const SIGNER_ROWS = [{ pubkey: '01'.repeat(32), sig: 'aa'.repeat(64), block_index: 50 },
    { pubkey: '02'.repeat(32), sig: 'bb'.repeat(64), block_index: 50 }];

describe('ROLLCALL detail reads rollcall_actions for actions with no first-seen signer @regression', function () {
    it('renders an action that carried only already-seen pubkeys from its rollcall_actions row', async function () {
        const state = { queries: [], tables: ['rollcall_actions'], signerRows: [], actionRow: { action: 'ROLLCALL',
            action_format: 1, action_index: 9, epoch_height: 300, ledger_hash: LEDGER, publisher: PUBLISHER,
            gates: 'vm.CALL,vm.DEPLOY', carried_count: 3, first_seen_count: 0 } };
        const data = await makeRollcallDb(state).getActionData(config, 9);
        assert.strictEqual(data.epoch_height, 300);
        assert.strictEqual(data.ledger_hash, LEDGER);
        assert.strictEqual(data.publisher, PUBLISHER);
        assert.deepStrictEqual(data.gates, ['vm.CALL', 'vm.DEPLOY']);
        assert.deepStrictEqual(data.signers, []);
        assert.strictEqual(data.carried_count, 3);
        assert.strictEqual(data.first_seen_count, 0);
        assert.strictEqual(named(state, /FROM\s+rollcall_signers[\s\S]*LIMIT 1/).length, 0, 'the row needed no legacy read');
    });

    it('falls back to rollcall_signers for an action indexed before rollcall_actions existed', async function () {
        const state = { queries: [], tables: ['rollcall_actions'], signerRows: SIGNER_ROWS, actionRow: null };
        const data = await makeRollcallDb(state).getActionData(config, 9);
        assert.strictEqual(data.epoch_height, 300);
        assert.strictEqual(data.publisher, PUBLISHER);
        assert.deepStrictEqual(data.gates, ['vm.CALL']);
        assert.strictEqual(data.signers.length, 2);
        assert.strictEqual(data.carried_count, null, 'no row states how many the action carried');
        assert.strictEqual(data.first_seen_count, 2);
    });

    it('a replica without the table never names it and reads rollcall_signers as before', async function () {
        const state = { queries: [], tables: [], signerRows: SIGNER_ROWS };
        const data = await makeRollcallDb(state).getActionData(config, 9);
        assert.strictEqual(named(state, /rollcall_actions/).length, 0);
        assert.strictEqual(data.epoch_height, 300);
        assert.strictEqual(data.carried_count, null);
        assert.strictEqual(data.first_seen_count, 2);
    });

    it('recovers from the missing-table error a stale positive memo earns', async function () {
        const state = { queries: [], tables: [], signerRows: SIGNER_ROWS };
        const db = makeRollcallDb(state);
        db.schemaTableMemo = { [config.coin]: { rollcall_actions: { present: true, at: Date.now() } } };
        const data = await db.getActionData(config, 9);
        assert.strictEqual(data.epoch_height, 300);
        assert.strictEqual(db.schemaTableMemo[config.coin].rollcall_actions.present, false);
    });
});
