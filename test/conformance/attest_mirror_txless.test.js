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
 * A MIRROR-APPLIED ATTEST RESPONSE MUST BE LISTED AND MUST BE ANNOUNCED.
 *
 * Above the attest-response-mirror activation height a finalized attestation
 * response is no longer its own on-chain transaction (spec §4.4). The indexer
 * applies it as a system-synthesized ATTEST v1 action: a real action_index and a
 * real block_index, but tx_index NULL and NO `transactions` row anywhere. Two
 * explorer discovery queries used to INNER JOIN `transactions`, which does not
 * degrade such a row, it DELETES it from the result:
 *
 *   - getAttestations(), so the response never appears on /COIN/attestations;
 *   - getActionsSince(), which is worse than a missing list row, because
 *     ChangeDetector calls emitAttestationEvents ONLY for the actions that
 *     query returns. An absent row means ATTESTATION_RESPONSE never fires for
 *     any websocket subscriber, ever, for that response.
 *
 * A query-shape unit test cannot see this: the fault is a JOIN semantic against
 * real rows, so it needs a real database with a real tx-less row in it. This
 * suite builds exactly that fixture (NO transactions row for the response) and
 * drives the shipped queries and the shipped ChangeDetector against it.
 *
 * Requires the integration MariaDB fixture (127.0.0.1:3307):
 *   npm run test:integration:up
 * Skips when the sibling xchain-indexer checkout is absent, like the schema
 * conformance canary next to it, because the DDL under test is the indexer's.
 *********************************************************************/

'use strict';

const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');
const { expect } = require('chai');

const Database       = require('../../src/db/index.js');
const Utility        = require('../../src/lib/utility.js');
const { envView }    = require('../fixtures/mock-config.js');
const pre            = require('../integration/helpers/fixture-preflight.js');

const connection = pre.conformanceConnection();
const DB_HOST = connection.host;
const DB_PORT = connection.port;
const DB_USER = connection.user;
const DB_PASS = connection.password;

const INDEXER_DB      = pre.conformanceDatabase('XChain_AttestMirror_Indexer');
const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'sql');

// The tx-BACKED control row and the tx-LESS row under test. Both are ATTEST v1
// responses in the same block; the only difference is that one has a
// transactions row and the other has none, which is the whole experiment.
const BLOCK        = 4200;
const BLOCK_TIME   = 1756200000;
const TX_ACTION    = 900;   // legacy-era response: its own on-chain transaction
const MIRROR_ACTION = 901;  // mirror-applied response: no transaction at all
const TX_REQUEST_ID     = 'aa'.repeat(32);
const MIRROR_REQUEST_ID = 'bb'.repeat(32);

function splitStatements(sql){
    const stripped = sql.split('\n')
        .map(line => { const i = line.indexOf('--'); return i === -1 ? line : line.slice(0, i); })
        .join('\n');
    return stripped.split(';').map(s => s.trim()).filter(s => s.length > 0);
}

function ddlFiles(dir){
    return fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => path.join(dir, f));
}

function migrationFiles(dir){
    const mig = path.join(dir, 'migrations');
    if(!fs.existsSync(mig)) return [];
    return fs.readdirSync(mig).filter(f => f.endsWith('.sql')).sort().map(f => path.join(mig, f));
}

// A dated migration that carries the CREATE for a table the base DDL also
// creates re-runs its CREATE TABLE / CREATE INDEX against a schema that already
// has them. A real deployment applies a migration once, against the shape that
// predates it, so "already there" is the migration having nothing to do rather
// than a schema fault. Only those two errnos are tolerated; everything else is
// fatal, so genuine DDL drift still fails loudly.
const ALREADY_APPLIED = new Set([1050 /* table exists */, 1061 /* duplicate key name */, 1060 /* duplicate column */]);

const hasIndexerDdl = fs.existsSync(INDEXER_SQL_DIR);

let adminPool = null;
let db        = null;

async function adminQuery(sql, args){
    const conn = await adminPool.getConnection();
    try { return await conn.query(sql, args); }
    finally { conn.release(); }
}

// Reload the whole indexer schema and re-seed. Called by every test that
// needs a pristine fixture, so a test can never inherit another's rows.
async function loadSchema(){
    await adminQuery('DROP DATABASE IF EXISTS `' + INDEXER_DB + '`');
    await adminQuery('CREATE DATABASE `' + INDEXER_DB + '`');
    const conn = await adminPool.getConnection();
    try {
        await conn.query('USE `' + INDEXER_DB + '`');
        const base = ddlFiles(INDEXER_SQL_DIR);
        const migs = migrationFiles(INDEXER_SQL_DIR);
        for(const file of base.concat(migs)){
            const isMigration = migs.includes(file);
            for(const stmt of splitStatements(fs.readFileSync(file, 'utf8'))){
                try { await conn.query(stmt); }
                catch(e){
                    if(isMigration && ALREADY_APPLIED.has(e.errno)) continue;
                    throw new Error('DDL load failed in ' + path.basename(file) + ': ' + e.message +
                                    '\nstatement: ' + stmt.slice(0, 200));
                }
            }
        }
    } finally { conn.release(); }
}

// One block carrying two ATTEST v1 responses. The mirror one has a real
// action row with tx_index NULL and NO transactions row: that absence is
// the fixture. If a transactions row ever appears here the falsification
// below stops meaning anything, so the suite asserts the absence too.
async function seed(){
    const conn = await adminPool.getConnection();
    try {
        await conn.query('USE `' + INDEXER_DB + '`');
        const insertId = async (sql, args) => Number((await conn.query(sql, args)).insertId);

        const ledgerId  = await insertId('INSERT INTO index_transactions (hash) VALUES (?)', ['mirror-ledger-1']);
        const txHashId  = await insertId('INSERT INTO index_transactions (hash) VALUES (?)', ['mirror-tx-1']);
        const addressId = await insertId('INSERT INTO index_addresses (address) VALUES (?)', ['bcrt1qattestmirror']);
        const validId   = await insertId('INSERT INTO index_statuses (status) VALUES (?)', ['valid']);
        const invalidId = await insertId('INSERT INTO index_statuses (status) VALUES (?)',
            ['invalid: REQUEST_ID (no matching request)']);
        const attestId  = await insertId('INSERT INTO index_actions (action) VALUES (?)', ['ATTEST']);

        await conn.query('INSERT INTO blocks (block_index, block_time, ledger_hash_id) VALUES (?, ?, ?)',
            [BLOCK, BLOCK_TIME, ledgerId]);

        // The tx-backed control: transaction, action, attests row.
        await conn.query(
            'INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id, fee, data) VALUES (?, ?, ?, ?, ?, ?)',
            [7, BLOCK, txHashId, addressId, 1000, 'ATTEST|1|' + TX_REQUEST_ID + '|']);
        await conn.query(
            'INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [TX_ACTION, BLOCK, 7, 0, attestId, 1, addressId]);
        await conn.query(
            `INSERT INTO attests (action_index, version, request_id, provider_id, response_status,
                                      response_payload, status_id, block_index)
                 VALUES (?, 1, ?, 'http_get', 'ok', 'legacy body', ?, ?)`,
            [TX_ACTION, TX_REQUEST_ID, validId, BLOCK]);

        // THE FIXTURE: a system-synthesized ATTEST v1. Real action_index and
        // block_index, tx_index NULL, and deliberately no transactions row.
        // status is the chain's REJECT verdict, which is also the two-status
        // shape: response_status 'ok' next to an action the chain refused.
        await conn.query(
            'INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id) VALUES (?, ?, NULL, NULL, ?, ?, ?)',
            [MIRROR_ACTION, BLOCK, attestId, 1, addressId]);
        await conn.query(
            `INSERT INTO attests (action_index, version, request_id, provider_id, response_status,
                                      response_payload, status_id, block_index)
                 VALUES (?, 1, ?, 'http_get', 'ok', 'mirror body', ?, ?)`,
            [MIRROR_ACTION, MIRROR_REQUEST_ID, invalidId, BLOCK]);
    } finally { conn.release(); }
}

// The fixture is only evidence while it stays tx-less. Asserted, not assumed.
async function assertFixtureIsTxLess(){
    const rows = await adminQuery(
        'SELECT a.tx_index, (SELECT COUNT(*) FROM `' + INDEXER_DB + '`.transactions t WHERE t.tx_index=a.tx_index) AS txrows ' +
        'FROM `' + INDEXER_DB + '`.actions a WHERE a.action_index=?', [MIRROR_ACTION]);
    expect(rows.length, 'the mirror action row is missing from the fixture').to.equal(1);
    expect(rows[0].tx_index, 'the mirror fixture carries a tx_index, so it proves nothing').to.equal(null);
    expect(Number(rows[0].txrows), 'the mirror fixture has a transactions row, so it proves nothing').to.equal(0);
}

function makeDb(){
    const configInfo = {
        getConfig: async () => ({
            COIN_NETWORKS:  { BTC: 'Bitcoin' },
            COIN_PREFIXES:  { mainnet: '', testnet: 'T', regtest: 'R' },
            COIN_SUPPORTED: { RBTC: 'BTC (regtest)' },
            COIN_AVAILABLE: { RBTC: 'BTC (regtest)' },
            BTC: {
                chain: require('../../src/coin-config/BTC.js').getConfig('regtest').chain,
                regtest: {
                    database: {
                        indexer: { name: INDEXER_DB, db_host: DB_HOST, db_port: DB_PORT, user: DB_USER, pass: DB_PASS }
                    },
                    address: require('../../src/coin-config/BTC.js').getConfig('regtest').address
                }
            }
        }),
        onConfigChanged: () => {},
        // The live process.env view src/config.js exports; the readers under
        // src/db/ read every environment variable through it.
        env: envView
    };
    const util = new Utility(configInfo);
    const database = new Database({ configInfo, util });
    return database;
}

let hadHubDbOptOut;

const attestTests = require('./attest_mirror_txless.test/support/tests.js');

describe('mirror-applied ATTEST response with no transaction row (real MariaDB)', function () {
    this.timeout(120000);

    before(async function () {
        if(!hasIndexerDdl) this.skip();
        // This rig serves the indexer schema only: the queries under test read
        // `attests`/`actions`/`blocks`/`transactions` and touch no hub-mirrored
        // table, so the co-located hub schema is deliberately absent and its
        // startup assertion is downgraded to the warning it has an opt-out for.
        hadHubDbOptOut = process.env.ALLOW_NO_COLOCATED_HUB_DB;
        process.env.ALLOW_NO_COLOCATED_HUB_DB = '1';
        adminPool = mariadb.createPool({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
            connectionLimit: 4, connectTimeout: 4000
        });
        try { await adminQuery('SELECT 1'); }
        catch(e){
            throw new Error('This suite needs the test MariaDB on ' + DB_HOST + ':' + DB_PORT +
                ' (start it with `npm run test:integration:up`): ' + e.message);
        }
        await loadSchema();
        await seed();
        db = makeDb();
        await db.init();
    });

    after(async function () {
        if(db && db.pools){
            for(const key in db.pools){
                const p = db.pools[key] && db.pools[key].pool;
                if(p && typeof p.end === 'function'){ try { await p.end(); } catch(e){ /* teardown */ } }
            }
        }
        if(adminPool){
            try { await adminQuery('DROP DATABASE IF EXISTS `' + INDEXER_DB + '`'); } catch(e){ /* teardown */ }
            await adminPool.end();
        }
        if(hadHubDbOptOut === undefined) delete process.env.ALLOW_NO_COLOCATED_HUB_DB;
        else process.env.ALLOW_NO_COLOCATED_HUB_DB = hadHubDbOptOut;
    });

    const fixture = {
        getDb: () => db,
        adminQuery,
        assertFixtureIsTxLess,
        BLOCK,
        BLOCK_TIME,
        TX_ACTION,
        MIRROR_ACTION,
        TX_REQUEST_ID,
        MIRROR_REQUEST_ID,
        INDEXER_DB
    };
    attestTests.registerListingTests(fixture);
    attestTests.registerActionTests(fixture);
    attestTests.registerSocketTests(fixture);
    attestTests.registerBatchDetailTests(fixture);
    attestTests.registerTimestampTests(fixture);
});
