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
 * Where a chunked DEPLOY's contract actually is.
 *
 * A contract too large for one action ships as N base64 carriers plus one
 * assembling DEPLOY, and since deferred assembly the group deploys at whichever
 * piece CONFIRMS LAST, in that piece's own action. So the action a deployer
 * submitted and waits on is frequently NOT the action the contract was created
 * at, and nothing on the assembler's own row says where it went: its contracts
 * row keeps the status it landed with (`pending: CODE_HASH (awaiting chunks)`),
 * and the completing carrier is a different action_index entirely.
 *
 * /api/action/A answers that with two fields the SDK and the wallet poll:
 *
 *   deployed_contract_index  the contract's action_index, or null when there is
 *                            no contract (yet, or ever)
 *   assembly_status          why: `valid` once deployed, the consuming action's
 *                            terminal status when the assembly FAILED at the
 *                            completing carrier, else the assembler's own status
 *
 * Without the second field a client polling the first would wait out its whole
 * timeout on a group that died at C on a hash mismatch or a drained source: the
 * assembler's own row still reads `pending:` and always will (the status is
 * written once and never mutated).
 *
 * The resolution is SQL, so the four cases below are driven by RUNNING the
 * shipped query over seeded rows in an in-memory SQLite database rather than by
 * asserting on the query text. What is being pinned is the answer, not the
 * spelling: replacing the CASE with a constant null reds these.
 *********************************************************************/

'use strict';

const assert     = require('node:assert/strict');
const proxyquire = require('proxyquire');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { DEPLOY } = require('../../src/action-detail/contracts.js');

const Database = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });

// node:sqlite is the only engine available to a unit tier (mariadb is the
// integration fixture's job). The shipped query is plain SQL - CASE, correlated
// scalar subqueries, LEFT JOIN - so it runs unchanged here.
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (e) { sqlite = null; }

const VALID     = 1;
const PENDING   = 2;
const MISMATCH  = 3;
const PENDING_S  = 'pending: CODE_HASH (awaiting chunks)';
const MISMATCH_S = 'invalid: CODE_HASH (mismatch)';

// The columns the two DEPLOY queries actually touch, nothing else: this fixture
// exists to answer the resolution, not to restate the indexer's schema.
function seed() {
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec(`
        CREATE TABLE actions            (action_index INTEGER, action_format INTEGER, action_id INTEGER, tx_index INTEGER, source_id INTEGER, block_index INTEGER);
        CREATE TABLE transactions       (tx_index INTEGER, block_index INTEGER, source_id INTEGER, tx_hash_id INTEGER);
        CREATE TABLE blocks             (block_index INTEGER, block_time INTEGER);
        CREATE TABLE index_actions      (id INTEGER, action TEXT);
        CREATE TABLE index_addresses    (id INTEGER, address TEXT);
        CREATE TABLE index_statuses     (id INTEGER, status TEXT);
        CREATE TABLE index_transactions (id INTEGER, hash TEXT);
        CREATE TABLE deploy_chunks      (action_index INTEGER, source_id INTEGER, code_hash TEXT, chunk_index INTEGER, total_chunks INTEGER, status_id INTEGER);
        CREATE TABLE contracts          (action_index INTEGER, source_id INTEGER, code_hash TEXT, api_version INTEGER, cooldown_blocks INTEGER, slash_destination_id INTEGER, status_id INTEGER, meta_name TEXT, meta_version TEXT);
        CREATE TABLE contract_executions(action_index INTEGER, contract_index INTEGER, assembler_action_index INTEGER, status_id INTEGER);
        INSERT INTO index_actions      VALUES (9, 'DEPLOY');
        INSERT INTO index_addresses    VALUES (1, 'source-address'), (2, 'slash-address');
        INSERT INTO index_statuses     VALUES (${VALID}, 'valid'), (${PENDING}, '${PENDING_S}'), (${MISMATCH}, '${MISMATCH_S}');
        INSERT INTO index_transactions VALUES (1, 'tx-hash');
        INSERT INTO blocks             VALUES (10, 1700000000);
    `);
    return db;
}

// One on-chain action: every DEPLOY query joins actions/transactions/blocks, so
// a contracts or deploy_chunks row with no action behind it selects nothing.
function addAction(db, index, format) {
    db.prepare('INSERT INTO actions VALUES (?, ?, 9, ?, 1, 10)').run(index, format, index);
    db.prepare('INSERT INTO transactions VALUES (?, 10, 1, 1)').run(index);
}

// Columns are NAMED rather than positional: the contracts row grew the identity
// manifest (meta_name / meta_version, spec contract-meta-manifest 2.5), and a
// positional INSERT would have to be rewritten by every column that lands next.
function addContract(db, index, statusId, opts) {
    const o = opts || {};
    addAction(db, index, o.format === undefined ? 2 : o.format);
    db.prepare(`INSERT INTO contracts
            (action_index, source_id, code_hash, api_version, cooldown_blocks, slash_destination_id, status_id, meta_name, meta_version)
            VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`).run(
        index, 'code-hash', o.api_version === undefined ? 1 : o.api_version,
        o.cooldown_blocks === undefined ? null : o.cooldown_blocks,
        o.slash_destination_id === undefined ? null : o.slash_destination_id, statusId,
        o.meta_name === undefined ? null : o.meta_name,
        o.meta_version === undefined ? null : o.meta_version);
}

function addExecution(db, index, assemblerIndex, statusId) {
    db.prepare('INSERT INTO contract_executions VALUES (?, ?, ?, ?)').run(index, index, assemblerIndex, statusId);
}

// The SHIPPED detail query for a format, taken from the handler rather than
// restated: the format probe is the handler's first query.
async function shippedQuery(actionFormat) {
    const db = { doQuery: async () => [{ action_format: actionFormat }] };
    const built = await DEPLOY.queries({ db, config: {}, action_index: 1 });
    return built.query;
}

// Run the shipped format-2/3 query for one action, exactly as getActionData does.
async function detailRow(db, action_index) {
    const sql = await shippedQuery(2);
    const row = db.prepare(sql).get(action_index);
    return row === undefined ? null : row;
}

// A Database answering each statement from [substring, rows] pairs, first match
// wins, matching the harness in db.action-detail-supplements.test.js.
function makeDb(type, rows) {
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    const db         = new Database({ configInfo, util });
    db.calls = [];
    db.doQuery = async (cfg, sql, args) => {
        db.calls.push({ sql: String(sql), args: args || [] });
        for (const [needle, result] of rows)
            if (String(sql).includes(needle)) return result;
        return [];
    };
    db.getActionType      = async () => type;
    db.getActionFeeData   = async () => null;
    db.getTransactionData = async () => null;
    return db;
}

const config = { coin: 'BTC', data: {} };

describe('chunked DEPLOY: which action deployed the contract', function () {

    describe('the format-2/3 assembler, resolved by running the shipped SQL', function () {

        beforeEach(function () {
            if (!sqlite) this.skip();
        });

        it('an assembler that deployed on its own answers with its own index', async function () {
            // R2.1 and every inline deploy: the group was already complete from
            // lower carriers (or needed no carriers), so the contract is here.
            const db = seed();
            addContract(db, 100, VALID);
            addExecution(db, 100, null, VALID);
            const row = await detailRow(db, 100);
            assert.equal(Number(row.deployed_contract_index), 100);
            assert.equal(row.assembly_status, 'valid');
        });

        it('a pending assembler with no consumer answers null, and says it is pending', async function () {
            const db = seed();
            addContract(db, 200, PENDING);
            addExecution(db, 200, null, PENDING);   // the assembler's own base-gas row
            addContract(db, 900, PENDING);          // a second, unrelated group
            addExecution(db, 905, 900, VALID);      // whose carrier completed it
            const row = await detailRow(db, 200);
            assert.equal(row.deployed_contract_index, null);
            assert.equal(row.assembly_status, PENDING_S,
                'a client polling this must see it is still waiting, not a terminal answer');
        });

        it('a pending assembler consumed by a VALID carrier answers that carrier index', async function () {
            // The deferred case: the contract lives at C, the piece that completed
            // the group, and the assembler's own status still reads pending forever.
            const db = seed();
            addContract(db, 300, PENDING);
            addExecution(db, 300, null, PENDING);
            addContract(db, 305, VALID, { format: 4 });
            addExecution(db, 305, 300, VALID);
            const row = await detailRow(db, 300);
            assert.equal(Number(row.deployed_contract_index), 305);
            assert.equal(row.assembly_status, 'valid');
            assert.equal(row.status, PENDING_S, 'the assembler row itself is never mutated');
        });

        it('a pending assembler consumed by a FAILED carrier answers null plus that failure', async function () {
            // The reason assembly_status exists. The assembler is consumed and can
            // never deploy, but its own row will read `pending:` for good, so a
            // client with only deployed_contract_index would poll until timeout.
            const db = seed();
            addContract(db, 400, PENDING);
            addExecution(db, 400, null, PENDING);
            addExecution(db, 407, 400, MISMATCH);   // constructor row survives; contracts row does not
            const row = await detailRow(db, 400);
            assert.equal(row.deployed_contract_index, null);
            assert.equal(row.assembly_status, MISMATCH_S);
        });

        it('an ordinary invalid assembler reports its own status and no contract', async function () {
            const db = seed();
            addContract(db, 500, MISMATCH);
            const row = await detailRow(db, 500);
            assert.equal(row.deployed_contract_index, null);
            assert.equal(row.assembly_status, MISMATCH_S);
        });
    });

    describe('the format-4 carrier probe, driven through the shipped afterMain', function () {

        beforeEach(function () {
            if (!sqlite) this.skip();
        });

        function sqlDb(sq) {
            return { doQuery: async (cfg, sql, args) => sq.prepare(String(sql)).all(...(args || [])) };
        }

        it('a carrier that completed the group carries the contract and its deploy card', async function () {
            const sq = seed();
            addContract(sq, 305, VALID, { format: 4, api_version: 2, cooldown_blocks: 144, slash_destination_id: 2 });
            addExecution(sq, 305, 300, VALID);
            const data = { action_format: 4, action_index: 305, chunk_index: 0, total_chunks: 3 };
            await DEPLOY.afterMain({ db: sqlDb(sq), config, action_index: 305 }, data);
            assert.equal(Number(data.deployed_contract_index), 305,
                'the contract was created AT this carrier, so its page is where it is reachable from');
            assert.equal(Number(data.api_version), 2);
            assert.equal(Number(data.cooldown_blocks), 144);
            assert.equal(data.slash_destination, 'slash-address');
            assert.equal(data.contract_status, 'valid');
            assert.equal(Number(data.assembler_action_index), 300,
                'which DEPLOY asked for this contract');
        });

        it('an ordinary carrier that completed nothing answers null and adds no card fields', async function () {
            const sq = seed();
            addAction(sq, 306, 4);
            const data = { action_format: 4, action_index: 306, chunk_index: 1, total_chunks: 3 };
            await DEPLOY.afterMain({ db: sqlDb(sq), config, action_index: 306 }, data);
            assert.equal(data.deployed_contract_index, null);
            assert.equal('api_version' in data, false);
            assert.equal('contract_status' in data, false);
        });

        it('leaves a non-carrier DEPLOY alone, and issues no probe for it', async function () {
            let issued = 0;
            const db = { doQuery: async () => { issued++; return []; } };
            const data = { action_format: 2, action_index: 300, deployed_contract_index: 305 };
            await DEPLOY.afterMain({ db, config, action_index: 300 }, data);
            assert.equal(issued, 0, 'the v0-v3 resolution is in the detail query, not a follow-up');
            assert.equal(data.deployed_contract_index, 305, 'the query answer was overwritten');
        });
    });

    // The contract identity manifest on the DEPLOY payload (spec
    // contract-meta-manifest 2.6): the wallet and the explorer both render
    // "<name> v<version> · C:<CHAIN>:<index>" off these two keys, and a contract
    // deployed before the rule declares neither, so they must be present-and-null
    // rather than absent, exactly like deployed_contract_index.
    describe('the declared contract identity on the DEPLOY payload', function () {

        beforeEach(function () {
            if (!sqlite) this.skip();
        });

        function sqlDb(sq) {
            return { doQuery: async (cfg, sql, args) => sq.prepare(String(sql)).all(...(args || [])) };
        }

        it('a v0-v3 deploy answers the name and version off its own contracts row', async function () {
            const db = seed();
            addContract(db, 400, VALID, { meta_name: 'Escrow', meta_version: '2.0.0' });
            const row = await detailRow(db, 400);
            assert.equal(row.contract_meta_name, 'Escrow');
            assert.equal(row.contract_meta_version, '2.0.0');
        });

        it('a pre-activation deploy answers null for both, not a missing key', async function () {
            const db = seed();
            addContract(db, 401, VALID);
            const row = await detailRow(db, 401);
            assert.equal(row.contract_meta_name, null);
            assert.equal(row.contract_meta_version, null);
            assert.equal('contract_meta_name' in row, true);
        });

        it('a carrier that completed the group answers the assembled contract identity', async function () {
            const sq = seed();
            addContract(sq, 405, VALID, { format: 4, meta_name: 'Escrow', meta_version: '2.0.0' });
            addExecution(sq, 405, 400, VALID);
            const data = { action_format: 4, action_index: 405 };
            await DEPLOY.afterMain({ db: sqlDb(sq), config, action_index: 405 }, data);
            assert.equal(data.contract_meta_name, 'Escrow');
            assert.equal(data.contract_meta_version, '2.0.0');
        });

        it('a carrier that completed nothing answers null for both', async function () {
            const sq = seed();
            addAction(sq, 406, 4);
            const data = { action_format: 4, action_index: 406 };
            await DEPLOY.afterMain({ db: sqlDb(sq), config, action_index: 406 }, data);
            assert.equal(data.contract_meta_name, null);
            assert.equal(data.contract_meta_version, null);
        });
    });

    describe('the fields reach the API response', function () {

        it('a format-2/3 DEPLOY response carries both fields', async function () {
            const db = makeDb('DEPLOY', [
                ['SELECT action_format FROM actions', [{ action_format: 2 }]],
                ['contracts m', [{
                    action: 'DEPLOY', action_format: 2, action_index: 300, code_hash: 'c48a',
                    api_version: 1, status: PENDING_S,
                    deployed_contract_index: 305, assembly_status: 'valid'
                }]],
            ]);
            const data = await db.getActionData(config, 300);
            assert.equal(data.deployed_contract_index, 305);
            assert.equal(data.assembly_status, 'valid');
        });

        it('a format-4 response carries deployed_contract_index, null when it completed nothing', async function () {
            const db = makeDb('DEPLOY', [
                ['SELECT action_format FROM actions', [{ action_format: 4 }]],
                ['deploy_chunks m', [{
                    action: 'DEPLOY', action_format: 4, action_index: 306,
                    code_hash: 'c48a', chunk_index: 1, total_chunks: 3, status: 'valid'
                }]],
            ]);
            const data = await db.getActionData(config, 306);
            assert.equal(data.deployed_contract_index, null);
        });
    });

    // D49. The pending answer is the one that MUST NOT be frozen: the action LRU
    // has no TTL and only a reorg invalidates it, so a null cached while the group
    // was incomplete would be served for the life of the process - to the very
    // clients polling this endpoint to learn where their contract landed. Nothing
    // rewrites the assembler's response when the group completes; the values simply
    // resolve differently on the next read, which the cache would prevent.
    describe('the action cache refuses a pending response', function () {

        function db() {
            const configInfo = createConfigInfoStub();
            return new Database({ configInfo, util: new Utility(configInfo) });
        }

        it('refuses a pending assembler, whose deployed_contract_index resolves later', function () {
            assert.equal(db()._isCacheableAction({
                action: 'DEPLOY', action_index: 300, action_format: 2, status: PENDING_S,
                deployed_contract_index: null, assembly_status: PENDING_S
            }), false);
        });

        it('still caches the same DEPLOY once it has deployed', function () {
            assert.equal(db()._isCacheableAction({
                action: 'DEPLOY', action_index: 300, action_format: 2, status: 'valid',
                deployed_contract_index: 300, assembly_status: 'valid'
            }), true, 'a settled deploy is immutable and the LRU exists for it');
        });

        it('caches a deferred assembler whose consuming carrier failed, a terminal answer', function () {
            assert.equal(db()._isCacheableAction({
                action: 'DEPLOY', action_index: 400, action_format: 2, status: MISMATCH_S,
                deployed_contract_index: null, assembly_status: MISMATCH_S
            }), true);
        });

        it('matches the status, not the new fields: every other DEPLOY stays cacheable', function () {
            // deployed_contract_index is on EVERY deploy response, so listing it in
            // MUTABLE_ACTION_FIELDS (which matches by presence) would uncache the
            // whole action type for a mutation only the pending case has.
            assert.equal(Database.MUTABLE_ACTION_FIELDS.includes('deployed_contract_index'), false);
            assert.equal(Database.MUTABLE_ACTION_FIELDS.includes('assembly_status'), false);
        });

        it('a pending response stays absent from the LRU, so the next read resolves it', function () {
            const d   = db();
            const key = d._cacheKey('BTC', 300);
            const pending = { action: 'DEPLOY', action_index: 300, status: PENDING_S, deployed_contract_index: null };
            if (d._isCacheableAction(pending)) d._cacheSet(d._actionDataCache, key, pending);
            assert.equal(d._cacheGet(d._actionDataCache, key), undefined);
            const done = { action: 'DEPLOY', action_index: 300, status: 'valid', deployed_contract_index: 305 };
            if (d._isCacheableAction(done)) d._cacheSet(d._actionDataCache, key, done);
            assert.deepEqual(d._cacheGet(d._actionDataCache, key), done);
        });
    });

    // A field that never leaves the SQL is not a contract the clients can build
    // against, and the two aliases are what row 12 and row 13 poll by name.
    it('the shipped format-2/3 query publishes both fields under their contract names', async function () {
        const sql = await shippedQuery(2);
        assert.match(sql, /as\s+deployed_contract_index/);
        assert.match(sql, /as\s+assembly_status/);
        assert.match(sql, /assembler_action_index=m\.action_index/,
            'the reverse lookup is what finds the action that completed the group');
    });
});
