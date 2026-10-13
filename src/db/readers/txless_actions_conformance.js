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
 **********************************************************************/

'use strict';

const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');
const { expect } = require('chai');

const Utility        = require('../../lib/utility.js');
const { makeConfig } = require('../../../test/fixtures/mock-query-args.js');
const pre            = require('../../../test/integration/helpers/fixture-preflight.js');

const connection = pre.conformanceConnection();
const DATABASE   = pre.conformanceDatabase('XChain_Txless_Emittable_Readers');
const SCHEMA     = path.join(__dirname, '..', '..', '..', 'test', 'integration', 'fixtures', 'schema.sql');
const TX_BLOCK   = 800;
const EMIT_BLOCK = 801;
const TX_ACTION  = 900;
const EMIT_SEND  = 901;
const EMIT_BURN  = 902;
const EMITTER    = 'C:BTC:txless-emitter';
const DATABASE_MODULE = '../index.js';

let adminPool;
let db;
let schemaLoaded = false;

async function adminQuery(sql, args){
    const conn = await adminPool.getConnection();
    try { return await conn.query(sql, args); }
    finally { conn.release(); }
}

async function loadSchema(){
    await adminQuery('DROP DATABASE IF EXISTS `' + DATABASE + '`');
    await adminQuery('CREATE DATABASE `' + DATABASE + '`');
    const conn = await adminPool.getConnection();
    try {
        await conn.query('USE `' + DATABASE + '`');
        await conn.query(fs.readFileSync(SCHEMA, 'utf8'));
    } finally { conn.release(); }
}

async function seed(){
    const conn = await adminPool.getConnection();
    try {
        await conn.query('USE `' + DATABASE + '`');
        await conn.query("INSERT INTO index_actions (id, action) VALUES (1,'SEND'),(2,'DESTROY')");
        await conn.query("INSERT INTO index_addresses (id, address) VALUES (1,'tx-backed-source'),(2,?),(3,'send-destination')", [EMITTER]);
        await conn.query("INSERT INTO index_tickers (id, tick) VALUES (1,'TXLESS')");
        await conn.query("INSERT INTO index_statuses (id, status) VALUES (1,'valid')");
        await conn.query("INSERT INTO index_memos (id, memo) VALUES (1,'fixture')");
        await conn.query("INSERT INTO index_transactions (id, hash) VALUES (1,'tx-backed-hash')");
        await conn.query('INSERT INTO blocks (block_index, block_time) VALUES (?,1700000800),(?,1700000801)',
            [TX_BLOCK, EMIT_BLOCK]);
        await conn.query("INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id, data) VALUES (700,?,1,1,'SEND|0|')",
            [TX_BLOCK]);
        await conn.query('INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id) VALUES ' +
            '(?,?,700,0,1,0,1),(?,?,NULL,NULL,1,0,2),(?,?,NULL,NULL,2,0,2)',
            [TX_ACTION, TX_BLOCK, EMIT_SEND, EMIT_BLOCK, EMIT_BURN, EMIT_BLOCK]);
        await conn.query("INSERT INTO sends (action_index, tick_id, destination_id, amount, memo_id, status_id, leg_ordinal) VALUES " +
            "(?,1,3,'1',1,1,0),(?,1,3,'2',1,1,0)", [TX_ACTION, EMIT_SEND]);
        await conn.query("INSERT INTO destroys (action_index, tick_id, amount, memo_id, status_id, leg_ordinal) VALUES (?,1,'3',1,1,0)",
            [EMIT_BURN]);
    } finally { conn.release(); }
}

function makeDb(Database){
    const configInfo = {
        getConfig: async () => ({
            COIN_NETWORKS:  { BTC: 'Bitcoin' },
            COIN_PREFIXES:  { mainnet: '', testnet: 'T', regtest: 'R' },
            COIN_SUPPORTED: { RBTC: 'BTC (regtest)' },
            COIN_AVAILABLE: { RBTC: 'BTC (regtest)' },
            BTC: {
                chain: require('../../coin-config/BTC.js').getConfig('regtest').chain,
                regtest: {
                    database: {
                        indexer: {
                            name: DATABASE,
                            db_host: connection.host,
                            db_port: connection.port,
                            user: connection.user,
                            pass: connection.password
                        }
                    },
                    address: require('../../coin-config/BTC.js').getConfig('regtest').address
                }
            }
        }),
        onConfigChanged: () => {},
        env: { ALLOW_NO_COLOCATED_HUB_DB: '1' }
    };
    return new Database({ configInfo, util: new Utility(configInfo) });
}

function sends(search, type, transport, query, offset){
    return db.getData(makeConfig({
        coin: 'RBTC',
        type: transport || 'api',
        data: { method: 'getSends', search, type, query: query || {}, offset: offset || {} }
    }));
}

async function setupConformance(){
    const Database = require(DATABASE_MODULE);
    adminPool = mariadb.createPool({
        ...connection,
        multipleStatements: true,
        connectionLimit: 4,
        connectTimeout: 4000
    });
    await adminQuery('SELECT 1');
    await loadSchema();
    schemaLoaded = true;
    await seed();
    db = makeDb(Database);
    await db.init();
}

async function teardownConformance(){
    if(db && db.pools){
        for(const key in db.pools){
            const pool = db.pools[key] && db.pools[key].pool;
            if(pool && typeof pool.end === 'function') await pool.end();
        }
    }
    if(adminPool){
        if(schemaLoaded) await adminQuery('DROP DATABASE IF EXISTS `' + DATABASE + '`');
        await adminPool.end();
    }
}

describe('contract-emittable reader conformance over transactionless rows', function () {
    this.timeout(120000);

    before(setupConformance);
    after(teardownConformance);

    it('lists the emitted row and includes it in the total', async function () {
        const [rows, total] = await sends();
        expect(rows.map((row) => Number(row.action_index))).to.deep.equal([EMIT_SEND, TX_ACTION]);
        expect(total).to.equal(2);
        expect(rows[0].tx_index).to.equal(null);
        expect(Number(rows[0].block_index)).to.equal(EMIT_BLOCK);
    });

    it('keeps the emitted row in the address lane', async function () {
        const [rows, total] = await sends(EMITTER, 'address');
        expect(rows.map((row) => Number(row.action_index))).to.deep.equal([EMIT_SEND]);
        expect(total).to.equal(1);
    });

    it('keeps the emitted row in the block lane', async function () {
        const [rows, total] = await sends(EMIT_BLOCK, 'block');
        expect(rows.map((row) => Number(row.action_index))).to.deep.equal([EMIT_SEND]);
        expect(total).to.equal(1);
    });

    it('uses transactionless-safe first, last, and stop boundaries', async function () {
        const [first] = await sends(null, null, 'explorer',
            { start: 0, length: 1, total: 2, action: 'first' }, { action: 'first' });
        const [last] = await sends(null, null, 'explorer',
            { start: 1, length: 1, total: 2, action: 'last' }, { action: 'last' });
        expect(first.map((row) => Number(row.action_index))).to.deep.equal([EMIT_SEND]);
        expect(last.map((row) => Number(row.action_index))).to.deep.equal([TX_ACTION]);
    });

    it('renders a transactionless emitted action detail', async function () {
        const detail = await db.getActionData(makeConfig({ coin: 'RBTC' }), EMIT_BURN);
        expect(detail.action).to.equal('DESTROY');
        expect(Number(detail.action_index)).to.equal(EMIT_BURN);
        expect(Number(detail.block_index)).to.equal(EMIT_BLOCK);
        expect(detail.tx_index).to.equal(null);
        expect(detail.tx_hash).to.equal(null);
    });
});
