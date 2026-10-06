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
