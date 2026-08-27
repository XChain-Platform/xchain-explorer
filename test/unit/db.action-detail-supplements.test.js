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
 **********************************************************************
 * Action-detail supplements: wire-carried fields stored in SIBLING event
 * tables that the per-type handlers cannot select from their primary table.
 *
 * Defect class: a field the wire format carries, and the indexer stores, was
 * absent from the action's API row - not even as null - so the page that
 * exists to render it had nothing to render.
 *  - ISSUE v6 (controller bind/unbind) omitted CONTROLLER / ACTION_CLASS /
 *    COOLDOWN_BLOCKS / UNBIND, though token_controllers holds them and
 *    /api/controllers serves them.
 *  - DEPLOY v4 omitted CODE_PART (deploy_chunks.code_part) from every API
 *    surface; only raw tx_data had it.
 *  - DEPLOY v0-v3 showed no gas anywhere, though the constructor run is
 *    recorded in contract_executions with gas_used / gas_limit.
 ********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const config = { coin: 'DOGE', data: {} };

// A Database answering each query from `rows` ([substring-of-SQL, result] pairs,
// FIRST match wins), recording every call. Unmatched queries answer empty.
function makeDb(type, rows) {
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    const db         = new Database({ configInfo, util });
    db.calls = [];
    db.doQuery = async (cfg, sql, args) => {
        const text = String(sql);
        db.calls.push({ sql: text, args: args || [] });
        for (const [needle, result] of rows)
            if (text.includes(needle)) return result;
        return [];
    };
    db.getActionType      = async () => type;
    db.getActionFeeData   = async () => null;
    db.getTransactionData = async () => null;
    return db;
}

describe('Action detail supplements (sibling-table wire fields) @regression', function () {

    describe('ISSUE v6 controller bind/unbind', function () {

        const ISSUE_V6_ROW = {
            action: 'ISSUE', action_format: 6, action_index: 1163, tick: 'CAMPA',
            source: 'addr-owner', block_index: 2885, timestamp: 1787850145,
            tx_hash: 'hash-1163', tx_index: 1083, status: 'valid'
        };
        const CONTROLLER_ROW = {
            controller: 1138, action_class: 'mint', cooldown_blocks: 5, unbind: 0
        };

        it('publishes CONTROLLER / ACTION_CLASS / COOLDOWN_BLOCKS / UNBIND from token_controllers', async function () {
            const db = makeDb('ISSUE', [
                ['issues i1',           [ISSUE_V6_ROW]],
                ['token_controllers c', [CONTROLLER_ROW]],
            ]);
            const data = await db.getActionData(config, 1163);
            assert.strictEqual(data.controller, 1138, 'CONTROLLER (guard contract index) missing from the API row');
            assert.strictEqual(data.action_class, 'mint');
            assert.strictEqual(data.cooldown_blocks, 5);
            assert.strictEqual(data.unbind, 0, 'UNBIND flag missing from the API row');
        });

        it('an unbind row carries unbind=1', async function () {
            const db = makeDb('ISSUE', [
                ['issues i1',           [Object.assign({}, ISSUE_V6_ROW, { action_index: 1164 })]],
                ['token_controllers c', [Object.assign({}, CONTROLLER_ROW, { unbind: 1 })]],
            ]);
            const data = await db.getActionData(config, 1164);
            assert.strictEqual(data.unbind, 1);
        });

        it('binds the event lookup to the action_index', async function () {
            const db = makeDb('ISSUE', [
                ['issues i1',           [ISSUE_V6_ROW]],
                ['token_controllers c', [CONTROLLER_ROW]],
            ]);
            await db.getActionData(config, 1163);
            const call = db.calls.find(c => c.sql.includes('token_controllers'));
            assert.ok(call, 'no token_controllers lookup was issued');
            assert.ok(/WHERE\s+c\.action_index=\?/.test(call.sql));
            assert.deepStrictEqual(call.args, [1163]);
        });

        it('a non-v6 ISSUE carries the keys present-as-null and skips the lookup', async function () {
            const db = makeDb('ISSUE', [
                ['issues i1', [Object.assign({}, ISSUE_V6_ROW, { action_format: 0, max_supply: '1000' })]],
            ]);
            const data = await db.getActionData(config, 12);
            assert.strictEqual(data.controller, null);
            assert.strictEqual(data.action_class, null);
            assert.strictEqual(data.cooldown_blocks, null);
            assert.strictEqual(data.unbind, null);
            assert.ok(!db.calls.some(c => c.sql.includes('token_controllers')),
                'a non-v6 ISSUE must not query token_controllers');
        });

        it('a v6 with no surviving event row (invalid / rolled back) answers null, not reparsed tx_data', async function () {
            const db = makeDb('ISSUE', [
                ['issues i1', [Object.assign({}, ISSUE_V6_ROW, { status: 'invalid: not token owner' })]],
            ]);
            const data = await db.getActionData(config, 1163);
            assert.strictEqual(data.controller, null);
            assert.strictEqual(data.unbind, null);
        });
    });

    describe('DEPLOY v4 chunk carrier CODE_PART', function () {

        const CHUNK_ROW = {
            action: 'DEPLOY', action_format: 4, action_index: 1142, source: 'addr-dev',
            code_hash: 'c48a', chunk_index: 0, total_chunks: 3,
            block_index: 2856, timestamp: 1787849242, tx_hash: 'hash-1142',
            tx_index: 1062, status: 'valid'
        };

        it('publishes the base64 slice and its length on the single-action surface', async function () {
            const db = makeDb('DEPLOY', [
                ['SELECT action_format FROM actions', [{ action_format: 4 }]],
                ['CHAR_LENGTH(m.code_part)',          [{ code_part: 'bW9kdWxl', code_part_length: 8 }]],
                ['deploy_chunks m',                   [CHUNK_ROW]],
            ]);
            const data = await db.getActionData(config, 1142);
            assert.strictEqual(data.code_part, 'bW9kdWxl', 'CODE_PART missing from the v4 action row');
            assert.strictEqual(data.code_part_length, 8);
        });

        it('keys are present-as-null when the chunk row is gone', async function () {
            const db = makeDb('DEPLOY', [
                ['SELECT action_format FROM actions', [{ action_format: 4 }]],
                ['CHAR_LENGTH(m.code_part)',          []],
                ['deploy_chunks m',                   [CHUNK_ROW]],
            ]);
            const data = await db.getActionData(config, 1142);
            assert.strictEqual(data.code_part, null);
            assert.strictEqual(data.code_part_length, null);
        });
    });

    describe('DEPLOY v0-v3 constructor gas', function () {

        const DEPLOY_ROW = {
            action: 'DEPLOY', action_format: 0, action_index: 1138, source: 'addr-dev',
            code_hash: '8e85', api_version: 1, cooldown_blocks: null, slash_destination: null,
            block_index: 2850, timestamp: 1787848971, tx_hash: 'hash-1138',
            tx_index: 1058, status: 'valid'
        };
        const EXEC_ROW = {
            contract_index: 1138, method_name: 'constructor',
            gas_used: '118072', gas_limit: '500000'
        };

        it('surfaces gas_used / gas_limit and the execution linkage from contract_executions', async function () {
            const db = makeDb('DEPLOY', [
                ['SELECT action_format FROM actions', [{ action_format: 0 }]],
                ['contract_executions m',             [EXEC_ROW]],
                ['contracts m',                       [DEPLOY_ROW]],
            ]);
            const data = await db.getActionData(config, 1138);
            assert.strictEqual(data.gas_used, '118072', 'gas spent on the deploy is invisible on the action row');
            assert.strictEqual(data.gas_limit, '500000');
            assert.strictEqual(data.contract_index, 1138, 'deploy row does not link to the contract it created');
            assert.strictEqual(data.method_name, 'constructor');
        });

        it('an invalid deploy (no execution row) carries the keys present-as-null', async function () {
            const db = makeDb('DEPLOY', [
                ['SELECT action_format FROM actions', [{ action_format: 2 }]],
                ['contract_executions m',             []],
                ['contracts m',                       [Object.assign({}, DEPLOY_ROW, { action_format: 2, status: 'invalid: bad code' })]],
            ]);
            const data = await db.getActionData(config, 1150);
            assert.strictEqual(data.gas_used, null);
            assert.strictEqual(data.gas_limit, null);
            assert.strictEqual(data.contract_index, null);
        });

        it('a v4 carrier does not get the execution lookup (a chunk is not a contract)', async function () {
            const db = makeDb('DEPLOY', [
                ['SELECT action_format FROM actions', [{ action_format: 4 }]],
                ['deploy_chunks m',                   [{ action_format: 4, action_index: 9 }]],
            ]);
            await db.getActionData(config, 9);
            assert.ok(!db.calls.some(c => c.sql.includes('contract_executions')),
                'v4 chunk carrier must not query contract_executions');
        });
    });

    describe('deploy_chunks list surface', function () {

        it('selects code_part_length but never the raw code_part payload on list rows', async function () {
            const configInfo = createConfigInfoStub();
            const util       = new Utility(configInfo);
            const db         = new Database({ configInfo, util });
            const listConfig = { coin: 'DOGE', data: { sql: {
                where: { data: '1=1', offset: '' }, order: 'DESC', limit: '10'
            } } };
            const [query] = await db.getDeployChunks(listConfig);
            assert.ok(query.includes('CHAR_LENGTH(m.code_part) as code_part_length'),
                'list rows lost the code_part_length field');
            // The MEDIUMTEXT slice itself must stay off the paged list: every mention
            // of code_part in the row query must be inside CHAR_LENGTH().
            const bare = query.replace(/CHAR_LENGTH\(m\.code_part\)/g, '');
            assert.ok(!bare.includes('code_part,') && !/m\.code_part\b/.test(bare),
                'raw code_part leaked onto the paged list');
        });
    });
});
