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
 * Real-schema conformance canary.
 *
 * Why this tier exists: a SELECT of a non-existent blocks.block_hash column
 * once silently killed the live WebSocket feed for 9 days because every unit
 * test stubbed doQuery and the integration tier runs against a fixture
 * SNAPSHOT of the schema, so no automated test ever executed the explorer's
 * real SQL against the REAL indexer DDL. This suite closes that class of gap
 * systemically, not just for the one bug:
 *
 *   1. Loads the indexer's REAL DDL (xchain-indexer/src/sql/*.sql, plus its
 *      dated migrations) verbatim into a real MariaDB, and the co-located
 *      hub-mirror schema the serving invariant requires (this repo's vendored
 *      src/sql/hub-mirror twins plus the hub's own operational-table DDL).
 *   2. Executes every db.js read path reachable from the API route table
 *      (pulled live from XChainExplorer.urls, so new endpoints are covered
 *      automatically) and fails on any schema error (unknown column /
 *      missing table / SQL syntax).
 *   3. Drives the ChangeDetector poll loop end-to-end and asserts the WS
 *      feed emits a block + action event for a freshly inserted block
 *      (the exact surface that outage killed).
 *   4. Guards the integration fixture snapshot against drift from the real
 *      DDL (per-table column-name parity), so the existing integration tier
 *      keeps testing the schema production actually has.
 *
 * Deployment shape: NO_HUB, i.e. no hub JSON-RPC endpoint. That is deliberate.
 * With a hub endpoint configured, validator_capabilities / governance_proposals
 * / governance_votes are served over JSON-RPC and carry no local SQL at all, so
 * an unreachable hub turned 13 routed read paths into tolerated no-ops that the
 * canary still printed as green. Running the no-hub shape routes those tables
 * to the co-located hub schema, where they execute real SQL against the real
 * DDL, which is the only shape in which this tier can see them.
 *
 * Requires the integration MariaDB fixture (127.0.0.1:3307):
 *   npm run test:integration:up
 * In CI this runs in a dedicated job with a mariadb service container plus
 * sibling checkouts of xchain-indexer and xchain-hub (same pattern as the
 * drift-guards job). The decoder-DB checks run only when a sibling
 * xchain-decoder checkout is present (always true in the platform monorepo).
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const express = require('express');
const mariadb = require('mariadb');
const { expect } = require('chai');

const XChainExplorer = require('../../src/XChainExplorer.js');
const ChangeDetector = require('../../src/ws/ChangeDetector.js');
const { makeConfig } = require('../fixtures/mock-query-args.js');

const DB_HOST = process.env.CONFORMANCE_DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.CONFORMANCE_DB_PORT || 3307);
const DB_USER = process.env.CONFORMANCE_DB_USER || 'root';
const DB_PASS = process.env.CONFORMANCE_DB_PASS || 'testpass';

const INDEXER_DB = 'XChain_Conformance_Indexer';
const DECODER_DB = 'XChain_Conformance_Decoder';
const FIXTURE_DB = 'XChain_Conformance_Fixture';
const HUB_DB     = 'XChain_Conformance_Hub';

const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'sql');
const DECODER_SQL_DIR = path.join(__dirname, '..', '..', '..', 'xchain-decoder', 'src', 'sql');
const HUB_SQL_DIR     = path.join(__dirname, '..', '..', '..', 'xchain-hub', 'src', 'sql');
const MIRROR_SQL_DIR  = path.join(__dirname, '..', '..', 'src', 'sql', 'hub-mirror');
const FIXTURE_SCHEMA  = path.join(__dirname, '..', 'integration', 'fixtures', 'schema.sql');

// Hub-LOCAL operational tables the explorer reads out of the co-located hub
// schema in the no-hub shape (db.js _hubSource). These are the hub's own
// tables, never vendored here, so their DDL comes from the sibling checkout.
// The mirror twins (state_checkpoints, capability_snapshots, price_snapshots,
// oracle_prices, cross_chain_matches, cross_chain_calls,
// anchor_reward_attestations) are loaded from THIS repo's vendored copies
// instead, because those are the files the explorer's own ensureTables()
// creates in production; drift between them and the hub is the drift-guards
// job's business, not this one's.
const HUB_LOCAL_TABLES = [
    'validators.sql',
    'validator_capabilities.sql',
    'governance_proposals.sql',
    'governance_votes.sql',
    'p2p_peers.sql',
    'consensus_state.sql',
    'configs.sql',
    'telemetry_pings.sql'
];

// Per-method probe arguments for read paths whose WHERE clause binds a
// parameter unconditionally. Without a value the driver refuses the query with
// "Parameter at position 1 is not set" BEFORE it reaches the server, so the SQL
// never meets the schema and the method contributes nothing to this tier. The
// values are deliberately arbitrary: the canary asserts the query is legal
// against the real DDL, not that it matches a row.
const PROBE_ARGS = {
    // contract_state / contract balance reads key off the contract's index and
    // its derived custody address respectively.
    getContractState:   { search: '1' },
    getContractBalance: { search: 'C:BTC:1' },
    // poll_results is keyed by the poll's creating action_index.
    getPollResults:     { search: '1' },
    // A single state checkpoint is keyed by block height.
    getCheckpoint:      { search: '1' }
};

// The canonical UTF-8 ACTION string the decoder writes to
// mempool_transactions.data. Kept as plain text on purpose: it is the
// same representation the confirmed-block path writes to transactions.data.
const MEMPOOL_ACTION_STRING = 'SEND|0|CONFTICK|1|bcrt1qconformance|';

// A MariaDB error that means the SQL disagrees with the schema. This is the
// drift class the canary exists for; anything matching it is a hard failure.
// (doQuery wraps the driver error, so match on the propagated message text.)
const SCHEMA_ERROR = /Unknown column|doesn't exist|Unknown table|in 'field list'|in 'where clause'|in 'on clause'|in 'order clause'|your SQL syntax/i;

function isSchemaError(err) {
    for (let e = err; e; e = e.cause) {
        if (e.message && SCHEMA_ERROR.test(e.message)) return true;
    }
    return false;
}

// Strip `-- ...` end-of-line comments and split a DDL script into statements.
// The indexer/decoder DDL uses no DELIMITER blocks and no string literals
// containing `;` or `--`, so plain splitting is sufficient (asserted by the
// suite passing; a future procedure would fail loudly here, not silently).
function splitStatements(sql) {
    const stripped = sql.split('\n')
        .map(line => {
            const i = line.indexOf('--');
            return i === -1 ? line : line.slice(0, i);
        })
        .join('\n');
    return stripped.split(';').map(s => s.trim()).filter(s => s.length > 0);
}

function ddlFiles(dir) {
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.sql'))
        .sort()
        .map(f => path.join(dir, f));
}

function migrationFiles(dir) {
    const mig = path.join(dir, 'migrations');
    if (!fs.existsSync(mig)) return [];
    return fs.readdirSync(mig)
        .filter(f => f.endsWith('.sql'))
        .sort()                            // dated filenames: lexical = chronological
        .map(f => path.join(mig, f));
}

describe('Real-schema conformance canary (real DDL on real MariaDB)', function () {

    this.timeout(120000);

    const hasIndexerDdl = fs.existsSync(INDEXER_SQL_DIR);
    const hasDecoderDdl = fs.existsSync(DECODER_SQL_DIR);
    const hasHubDdl     = HUB_LOCAL_TABLES.every(f => fs.existsSync(path.join(HUB_SQL_DIR, f)));

    let adminPool = null;
    let explorer  = null;
    let db        = null;
    let app       = null;

    async function adminQuery(sql) {
        const conn = await adminPool.getConnection();
        try { return await conn.query(sql); }
        finally { conn.release(); }
    }

    // Load a DDL script list into a freshly created database. Statement
    // failures are fatal: the canary must run against the exact real schema.
    async function loadSchema(dbName, files) {
        await adminQuery('DROP DATABASE IF EXISTS `' + dbName + '`');
        await adminQuery('CREATE DATABASE `' + dbName + '`');
        const conn = await adminPool.getConnection();
        try {
            await conn.query('USE `' + dbName + '`');
            for (const file of files) {
                for (const stmt of splitStatements(fs.readFileSync(file, 'utf8'))) {
                    try {
                        await conn.query(stmt);
                    } catch (e) {
                        throw new Error('DDL load failed in ' + path.basename(file) + ': ' +
                                        e.message + '\nstatement: ' + stmt.slice(0, 200));
                    }
                }
            }
        } finally {
            conn.release();
        }
    }

    // configInfo stub shaped like src/config.js output, pointing BTC/regtest
    // (key RBTC) at the conformance schemas. Same shape the integration
    // harness uses; distinct DB names so the tiers never clobber each other.
    function createConfigInfo() {
        const coinConfig = require('../../src/configs/BTC.js').getConfig('regtest');
        const listeners  = [];
        const dbCreds    = { db_host: DB_HOST, db_port: DB_PORT, user: DB_USER, pass: DB_PASS };
        const config = {
            COIN_NETWORKS:  { BTC: 'Bitcoin', LTC: 'Litecoin', DOGE: 'Dogecoin' },
            COIN_PREFIXES:  { mainnet: '', testnet: 'T', regtest: 'R' },
            COIN_SUPPORTED: { RBTC: 'BTC (regtest)' },
            COIN_AVAILABLE: { RBTC: 'BTC (regtest)' },
            DISPENSER_LIST_DELAY: 3600,
            API: {
                host: '127.0.0.1', user: false, pass: false,
                ssl: { key: 'mock', cert: 'mock', ca: 'mock' },
                port: { http: 0, https: 0 }
            },
            BTC: {
                chain: coinConfig.chain,
                regtest: {
                    database: {
                        indexer: Object.assign({ name: INDEXER_DB }, dbCreds),
                        decoder: hasDecoderDdl ? Object.assign({ name: DECODER_DB }, dbCreds) : undefined,
                        // Mandatory co-located hub schema. db.js honours this block only
                        // when host/port/user/pass match the indexer block exactly, which
                        // is why it reuses dbCreds rather than restating them.
                        checkpoint: Object.assign({ name: HUB_DB }, dbCreds)
                    },
                    address: coinConfig.address
                }
            }
        };
        return {
            getConfig: async () => config,
            onConfigChanged: (cb) => listeners.push(cb),
            triggerConfigChanged: () => listeners.forEach(cb => cb())
        };
    }

    before(async function () {
        // Only skip when this checkout is the standalone explorer repo without
        // the sibling indexer DDL (CI provides it via a sibling checkout).
        if (!hasIndexerDdl) this.skip();

        // A venue that HAS the indexer sibling but not the hub one is a
        // misconfigured venue, not a standalone checkout, and `.ci-siblings`
        // declares both. Say so rather than skipping (which prints green) or
        // letting it surface downstream as a pile of "Unknown table" errors.
        if (!hasHubDdl)
            throw new Error('Conformance canary needs the sibling xchain-hub checkout at ' + HUB_SQL_DIR +
                ' for the co-located hub schema (declared in .ci-siblings). Without it the ' +
                'checkpoint/mirror/federation read paths cannot be exercised at all.');

        adminPool = mariadb.createPool({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
            connectionLimit: 4, connectTimeout: 4000
        });
        try {
            await adminQuery('SELECT 1');
        } catch (e) {
            throw new Error('Conformance canary needs the test MariaDB on ' + DB_HOST + ':' + DB_PORT +
                ' (start it with `npm run test:integration:up`): ' + e.message);
        }

        // 1. Real indexer DDL + its dated migrations, loaded VERBATIM.
        await loadSchema(INDEXER_DB, ddlFiles(INDEXER_SQL_DIR).concat(migrationFiles(INDEXER_SQL_DIR)));

        // 2. Real decoder DDL (mempool feed source) when the sibling exists.
        if (hasDecoderDdl) {
            await loadSchema(DECODER_DB, ddlFiles(DECODER_SQL_DIR).concat(migrationFiles(DECODER_SQL_DIR)));
        }

        // 3. Co-located hub schema: this repo's vendored mirror twins (what
        //    ensureTables() creates in production) plus the hub's own
        //    operational tables from the sibling checkout. Loading it for real
        //    is what lets the read loop below reach the checkpoint/mirror/
        //    federation paths at all; without it they throw a config error the
        //    loop can only tolerate.
        const hubFiles = ddlFiles(MIRROR_SQL_DIR)
            .concat(HUB_LOCAL_TABLES.map(f => path.join(HUB_SQL_DIR, f)));
        await loadSchema(HUB_DB, hubFiles);

        // 4. Boot the real explorer (routes + Database with real pools).
        //    NO_HUB is the shape this tier runs in: see the header. It also has
        //    to be set before construction, because HubOperationalCache resolves
        //    its endpoint list once in its constructor.
        //    The checkpoint block above satisfies the mandatory co-located hub-DB
        //    invariant, so this rig deliberately does NOT take the
        //    ALLOW_NO_COLOCATED_HUB_DB bypass: the canary boots under the same
        //    startup contract a serving node does.
        //    The rig indexes one block at a fixed past timestamp, so the tip-age
        //    freshness gate would answer 503 COIN_DATA_STALE on every route before
        //    any SQL ran. Disable it via its own escape hatch (explicit 0), the
        //    same way the integration and perf harnesses do; freshness has its own
        //    unit coverage and is not what this tier measures.
        process.env.NO_HUB = '1';
        process.env.EXPLORER_TIP_MAX_AGE_S = '0';
        delete process.env.HUB_API_URL;
        delete process.env.ALLOW_NO_COLOCATED_HUB_DB;
        app = express();
        app.use(express.json());
        explorer = new XChainExplorer(app, createConfigInfo());
        await explorer.init();
        db = explorer.db;
    });

    after(async function () {
        if (db && db.pools) {
            for (const key in db.pools) {
                const p = db.pools[key] && db.pools[key].pool;
                if (p && typeof p.end === 'function') { try { await p.end(); } catch (e) { /* teardown */ } }
            }
            for (const key in (db.decoderPools || {})) {
                const p = db.decoderPools[key];
                if (p && typeof p.end === 'function') { try { await p.end(); } catch (e) { /* teardown */ } }
            }
        }
        if (adminPool) {
            try {
                await adminQuery('DROP DATABASE IF EXISTS `' + INDEXER_DB + '`');
                await adminQuery('DROP DATABASE IF EXISTS `' + DECODER_DB + '`');
                await adminQuery('DROP DATABASE IF EXISTS `' + FIXTURE_DB + '`');
                await adminQuery('DROP DATABASE IF EXISTS `' + HUB_DB + '`');
            } catch (e) { /* teardown */ }
            await adminPool.end();
        }
        delete process.env.NO_HUB;
        delete process.env.EXPLORER_TIP_MAX_AGE_S;
    });

    /******************************************************************
     * 1. Every API-route read path executes against the real schema
     *****************************************************************/

    it('runs every routed db.getData read path without a schema error', async function () {
        // Pull the method list from the LIVE route table so a new endpoint is
        // covered the moment it is routed, with no test edit.
        const methods = new Set();
        for (const url in explorer.urls.api) {
            const info = explorer.urls.api[url];
            const name = Array.isArray(info) ? info[0] : info;
            if (typeof name === 'string' && typeof db[name] === 'function') methods.add(name);
        }
        expect(methods.size).to.be.at.least(40, 'route table unexpectedly small; canary coverage collapsed');

        const schemaFailures = [];
        const tolerated      = [];
        let executed = 0;
        for (const method of methods) {
            const cfg = makeConfig(Object.assign({ coin: 'RBTC' },
                { data: Object.assign({ method }, PROBE_ARGS[method] || {}) }));
            try {
                await db.getData(cfg);
                executed++;
            } catch (e) {
                if (isSchemaError(e)) {
                    schemaFailures.push(method + ': ' + e.message);
                } else {
                    // Non-schema throws are not schema drift, but they are also
                    // not coverage: the method did not execute SQL. Recorded so
                    // the ratchet below can tell a benign throw from a read path
                    // this rig silently stopped exercising.
                    tolerated.push(method + ': ' + e.message.split('\n')[0]);
                }
            }
        }
        if (tolerated.length) console.log('conformance: tolerated non-schema errors:\n  ' + tolerated.join('\n  '));
        expect(schemaFailures, 'queries disagreeing with the REAL schema:\n' + schemaFailures.join('\n'))
            .to.deep.equal([]);

        // Anti-silent-skip ratchet. A tolerated throw looks identical to a pass
        // in the count above, which is how an unreachable hub and a missing
        // checkpoint schema quietly removed 13 read paths from this tier while
        // it kept printing green. These two patterns mean "the rig is wired
        // wrong", never "the schema is fine", so they fail loudly.
        const rigFailures = tolerated.filter(t =>
            /No co-located hub DB|Hub unreachable|Parameter at position|is not set|ECONNREFUSED/i.test(t));
        expect(rigFailures, 'read paths the conformance rig failed to exercise (harness wiring, not schema):\n' +
            rigFailures.join('\n')).to.deep.equal([]);

        // Guard against a vacuous pass (e.g. every method throwing tolerated
        // config errors would otherwise still be green).
        expect(executed).to.be.at.least(40, 'too few read paths actually executed SQL');
    });

    // The routed surface, not just the db layer. Every list route in the
    // hub-mirrored family is reachable with no {QUERY}/{TYPE} segment, and that
    // shape is the one no other tier boots with a checkpoint schema to test: the
    // integration fixture has none, so these routes fail their config check there
    // long before any SQL runs. A bare cross_chain_matches request answered 500
    // here (its `AND m.network = ?` bind was dropped with the phantom search seed)
    // on exactly the installs that are configured correctly.
    it('serves the hub-mirrored list routes with no QUERY/TYPE segment', async function () {
        const request = require('supertest');
        const routes = [
            '/RBTC/api/cross_chain_matches',
            '/RBTC/api/checkpoints',
            '/RBTC/api/validator_capabilities',
            '/RBTC/api/governance_proposals',
            '/RBTC/api/governance_votes',
            '/RBTC/api/peers',
            '/RBTC/api/consensus_state',
            '/RBTC/api/configs'
        ];
        const failures = [];
        for (const route of routes) {
            // A route this build does not expose is not this test's business;
            // 404 means "not routed", anything 5xx means "routed and broken".
            const res = await request(app).get(route);
            if (res.status >= 500) failures.push(route + ' -> ' + res.status + ' ' + JSON.stringify(res.body));
        }
        expect(failures, 'hub-mirrored list routes failing on a correctly configured install:\n' +
            failures.join('\n')).to.deep.equal([]);
    });

    it('runs the single-item detail reads without a schema error', async function () {
        // Point reads the list loop above does not reach (non-getData paths).
        const failures = [];
        const probes = [
            ['getMaxBlockIndex',   () => db.getMaxBlockIndex({ coin: 'RBTC' })],
            ['getMaxActionIndex',  () => db.getMaxActionIndex({ coin: 'RBTC' })],
            ['getBlocksSince',     () => db.getBlocksSince({ coin: 'RBTC' }, 0, 10)],
            ['getActionsSince',    () => db.getActionsSince({ coin: 'RBTC' }, 0, 10)],
            ['checkReorg',         () => db.checkReorgAndInvalidate({ coin: 'RBTC' })],
            ['getActionData',      () => db.getActionData(makeConfig({ coin: 'RBTC' }), 1)],
            ['getAddressId',       () => db.getAddressId(makeConfig({ coin: 'RBTC' }), 'bcrt1qconformance')],
            ['getTickId',          () => db.getTickId(makeConfig({ coin: 'RBTC' }), 'XCHAIN')],
            ['getActionType',      () => db.getActionType(makeConfig({ coin: 'RBTC' }), 1)],
            ['getAddressBalances', () => db.getAddressBalances(makeConfig({ coin: 'RBTC' }), 'bcrt1qconformance')],
            ['getTokenInfo',       () => db.getTokenInfo(makeConfig({ coin: 'RBTC' }), 'XCHAIN')]
        ];
        for (const [name, fn] of probes) {
            try { await fn(); }
            catch (e) {
                if (isSchemaError(e)) failures.push(name + ': ' + e.message);
            }
        }
        expect(failures, failures.join('\n')).to.deep.equal([]);
    });

    /******************************************************************
     * 2. ChangeDetector WS-feed smoke: a fresh block must emit events
     *****************************************************************/

    it('emits WS block + action events for a freshly indexed block (guards the missing-column outage class)', async function () {
        const conn = await adminPool.getConnection();
        async function insertId(sql, args) {
            const res = await conn.query(sql, args);
            return Number(res.insertId);
        }
        try {
            await conn.query('USE `' + INDEXER_DB + '`');

            const detector = new ChangeDetector({ db, pollInterval: 3600000, fetchLimit: 100 });
            const events = { block: [], action: [] };
            detector.on('block',  (coin, b) => events.block.push(b));
            detector.on('action', (coin, a) => events.action.push(a));
            detector.state = { RBTC: { blockIndex: 0, actionIndex: 0, initialized: false } };
            detector.mempoolState = { RBTC: { seenHashes: new Set(), initialized: false } };

            // First poll seeds cursors from the (empty) real schema. Any bad
            // column in the tip poll throws HERE, exactly like production.
            await detector._checkCoin('RBTC');

            // Index one block with one SEND action, real-schema column names.
            const ledgerHashId = await insertId('INSERT INTO index_transactions (hash) VALUES (?)', ['conformance-ledger-1']);
            const txHashId     = await insertId('INSERT INTO index_transactions (hash) VALUES (?)', ['conformance-tx-1']);
            const addressId    = await insertId('INSERT INTO index_addresses (address) VALUES (?)', ['bcrt1qconformance']);
            const tickId       = await insertId('INSERT INTO index_tickers (tick) VALUES (?)', ['CONFTICK']);
            const statusId     = await insertId('INSERT INTO index_statuses (status) VALUES (?)', ['valid']);
            const actionId     = await insertId('INSERT INTO index_actions (action) VALUES (?)', ['SEND']);
            await conn.query('INSERT INTO blocks (block_index, block_time, ledger_hash_id) VALUES (?, ?, ?)',
                [101, 1700000000, ledgerHashId]);
            await conn.query('INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id, fee, data) VALUES (?, ?, ?, ?, ?, ?)',
                [1, 101, txHashId, addressId, 1000, 'SEND|0|CONFTICK|1|bcrt1qconformance|']);
            await conn.query('INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [1, 101, 1, 0, actionId, 0, addressId]);
            await conn.query('INSERT INTO sends (action_index, tick_id, destination_id, amount, status_id) VALUES (?, ?, ?, ?, ?)',
                [1, tickId, addressId, '1', statusId]);

            // Second poll must see the block and the action. This exercises
            // checkReorgAndInvalidate, getMax*, get*Since AND the lifecycle /
            // entity / attestation emit queries against the real DDL; a
            // schema error in any of them throws and fails the test.
            await detector._checkCoin('RBTC');

            expect(events.block.length, 'NEW_BLOCK feed emitted nothing for a fresh block').to.be.at.least(1);
            expect(Number(events.block[0].block_index)).to.equal(101);
            expect(events.action.length, 'NEW_ACTION feed emitted nothing for a fresh action').to.be.at.least(1);
            expect(events.action[0].action).to.equal('SEND');
            expect(events.action[0].source).to.equal('bcrt1qconformance');
        } finally {
            conn.release();
        }
    });

    it('reads the decoder mempool feed against the real decoder DDL', async function () {
        if (!hasDecoderDdl) this.skip();
        const conn = await adminPool.getConnection();
        try {
            await conn.query('USE `' + DECODER_DB + '`');
            // Seeded as the canonical UTF-8 ACTION string, which is what the
            // decoder's mempool path writes; this row is byte-identical
            // to the `transactions.data` value its confirmed twin would carry.
            await conn.query('INSERT INTO mempool_transactions (tx_hash, source, destination, amount, fee, data) VALUES (?, ?, ?, ?, ?, ?)',
                ['conf-mempool-tx-1', 'bcrt1qconformance', 'bcrt1qconformance', 0, 500, MEMPOOL_ACTION_STRING]);
        } finally {
            conn.release();
        }
        // getDecoderMempoolRows swallows query errors into a console.warn and
        // returns [] (WS polls must tolerate outages), which would mask schema
        // drift; asserting the seeded row actually comes back un-masks it.
        const rows = await db.getDecoderMempoolRows({ coin: 'RBTC' }, 10);
        expect(rows.length, 'decoder mempool query returned nothing for a seeded row (schema drift or pool wiring)').to.equal(1);
        expect(rows[0].tx_hash).to.equal('conf-mempool-tx-1');
        // Encoding parity against the REAL column type, not a stub: the read has
        // to hand back the same string that went in, and decodeMempoolRow has to
        // parse it. A one-sided switch back to hex on either side fails here.
        expect(String(rows[0].data), 'mempool data column round-trip changed the payload').to.equal(MEMPOOL_ACTION_STRING);
        const decodedMempool = db.decodeMempoolRow(rows[0]);
        expect(decodedMempool, 'explorer could not decode a real decoder mempool row').to.not.equal(null);
        expect(decodedMempool.action).to.equal('SEND');
        expect(decodedMempool.data).to.equal(MEMPOOL_ACTION_STRING);
    });

    /******************************************************************
     * 3. Integration fixture snapshot must not drift from the real DDL
     *****************************************************************/

    it('integration fixture schema.sql matches the real indexer DDL (column parity)', async function () {
        if (!fs.existsSync(FIXTURE_SCHEMA)) this.skip();
        await loadSchema(FIXTURE_DB, [FIXTURE_SCHEMA]);

        async function columnsByTable(schema) {
            const rows = await adminQuery(
                "SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='" + schema + "'");
            const map = {};
            for (const r of rows) {
                (map[r.t] = map[r.t] || []).push(r.c);
            }
            for (const t in map) map[t].sort();
            return map;
        }
        const real    = await columnsByTable(INDEXER_DB);
        const fixture = await columnsByTable(FIXTURE_DB);

        const drift = [];
        for (const table in fixture) {
            if (!real[table]) {
                drift.push(table + ': in fixture but not in real DDL');
                continue;
            }
            const missing = real[table].filter(c => !fixture[table].includes(c));
            const extra   = fixture[table].filter(c => !real[table].includes(c));
            if (missing.length) drift.push(table + ': fixture missing columns ' + missing.join(', '));
            if (extra.length)   drift.push(table + ': fixture has phantom columns ' + extra.join(', '));
        }
        expect(drift, 'integration fixture drifted from the real indexer DDL:\n' + drift.join('\n'))
            .to.deep.equal([]);
    });
});
