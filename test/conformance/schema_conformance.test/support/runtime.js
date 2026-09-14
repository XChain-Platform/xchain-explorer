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
 */

'use strict';

const { fs, path, express, mariadb, XChainExplorer, ChangeDetector, envView, DB_HOST, DB_PORT, DB_USER, DB_PASS, INDEXER_DB, DECODER_DB, FIXTURE_DB, HUB_DB, INDEXER_SQL_DIR, DECODER_SQL_DIR, HUB_SQL_DIR, MIRROR_SQL_DIR, FIXTURE_SCHEMA, HUB_LOCAL_TABLES, splitStatements, ddlFiles, migrationFiles } = require('../../schema_conformance.test.js');

const hasIndexerDdl = fs.existsSync(INDEXER_SQL_DIR);
const hasDecoderDdl = fs.existsSync(DECODER_SQL_DIR);
const hasHubDdl = HUB_LOCAL_TABLES.every((f) => fs.existsSync(path.join(HUB_SQL_DIR, f)));

const state = { adminPool: null, explorer: null, db: null, app: null };

async function adminQuery(sql) {
    const conn = await state.adminPool.getConnection();
    try { return await conn.query(sql); }
    finally { conn.release(); }
}

// Load a DDL script list into a freshly created database. Statement
// failures are fatal: the canary must run against the exact real schema.
async function loadSchema(dbName, files) {
    await adminQuery('DROP DATABASE IF EXISTS `' + dbName + '`');
    await adminQuery('CREATE DATABASE `' + dbName + '`');
    const conn = await state.adminPool.getConnection();
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
    const coinConfig = require('../../../../src/coin-config/BTC.js').getConfig('regtest');
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
        triggerConfigChanged: () => listeners.forEach(cb => cb()),
        // The live process.env view src/config.js exports; the readers under
        // src/db/ read every environment variable through it.
        env: envView
    };
}

function requireSiblingDdls() {
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
}

async function connectAdmin() {
    state.adminPool = mariadb.createPool({
        host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
        connectionLimit: 4, connectTimeout: 4000
    });
    try {
        await adminQuery('SELECT 1');
    } catch (e) {
        throw new Error('Conformance canary needs the test MariaDB on ' + DB_HOST + ':' + DB_PORT +
            ' (start it with `npm run test:integration:up`): ' + e.message);
    }
}

async function loadConformanceSchemas() {
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
}

async function bootExplorer() {
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
    state.app = express();
    state.app.use(express.json());
    state.explorer = new XChainExplorer(state.app, createConfigInfo());
    await state.explorer.init();
    state.db = state.explorer.db;
}

async function setupConformance() {
    requireSiblingDdls.call(this);
    await connectAdmin();
    await loadConformanceSchemas();
    await bootExplorer();
}

async function teardownConformance() {
    if (state.db && state.db.pools) {
        for (const key in state.db.pools) {
            const p = state.db.pools[key] && state.db.pools[key].pool;
            if (p && typeof p.end === 'function') { try { await p.end(); } catch (e) { /* teardown */ } }
        }
        for (const key in (state.db.decoderPools || {})) {
            const p = state.db.decoderPools[key];
            if (p && typeof p.end === 'function') { try { await p.end(); } catch (e) { /* teardown */ } }
        }
    }
    if (state.adminPool) {
        try {
            await adminQuery('DROP DATABASE IF EXISTS `' + INDEXER_DB + '`');
            await adminQuery('DROP DATABASE IF EXISTS `' + DECODER_DB + '`');
            await adminQuery('DROP DATABASE IF EXISTS `' + FIXTURE_DB + '`');
            await adminQuery('DROP DATABASE IF EXISTS `' + HUB_DB + '`');
        } catch (e) { /* teardown */ }
        await state.adminPool.end();
    }
    delete process.env.NO_HUB;
    delete process.env.EXPLORER_TIP_MAX_AGE_S;
}

/******************************************************************
 * 1. Every API-route read path executes against the real schema
 *****************************************************************/

// A composition that returns not-found before its composed legs run proves
// only that its identity read is legal. getRichList's subject is one seeded
// token, so its tokens/balances legs execute against the real DDL here.
async function seedRichListSubject() {
    const conn = await state.adminPool.getConnection();
    try {
        await conn.query('USE `' + INDEXER_DB + '`');
        const tick = await conn.query('INSERT INTO index_tickers (tick) VALUES (?)', ['RICHTICK']);
        const addr = await conn.query('INSERT INTO index_addresses (address) VALUES (?)', ['bcrt1qrichlist']);
        await conn.query(
            'INSERT INTO tokens (tick_id, action_index, supply, max_supply, max_mint, decimals, lock_max_supply, owner_id) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [Number(tick.insertId), 1, '1000', '1000', '0', 0, 1, Number(addr.insertId)]);
        await conn.query('INSERT INTO balances (address_id, tick_id, amount) VALUES (?, ?, ?)',
            [Number(addr.insertId), Number(tick.insertId), '1000']);
    } finally {
        conn.release();
    }
}

module.exports = { state, hasDecoderDdl, adminQuery, loadSchema, seedRichListSubject, setupConformance, teardownConformance };
