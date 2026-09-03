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
 * THE RAW ACTION FEED MUST ENUMERATE THE CHAIN, NOT ONLY ITS TRANSACTIONS.
 *
 * /{COIN}/api/actions is the one surface that claims to list the chain action
 * by action, so it is the surface a consumer walks to count what happened. A
 * query reaching `blocks` through an INNER-joined `transactions` cannot show
 * this correctly: a SYSTEM-INJECTED action has NO transactions row - a real
 * action_index and a real block_index, tx_index NULL, nothing in
 * `transactions` at all. An INNER join does not degrade such a row, it
 * DELETES it.
 *
 * The families that vanished are exactly the ones the chain generates rather
 * than a user broadcasting: ORDER_EXPIRE / SWAP_EXPIRE / DISPENSER_EXPIRE and
 * their siblings, ORDER_MATCH / SWAP_MATCH, DISPENSE, DISPENSER_CLOSE and
 * CROSS_SETTLE, plus a mirror-applied ATTEST v1 response.
 *
 * What makes this worth a real-database suite rather than a query-shape unit
 * test is that the omission is INVISIBLE from the response. Nothing errors,
 * the JSON is well-formed, the paging is consistent and `total` agrees with
 * the rows returned - the rows are simply absent, so a consumer under-counts
 * and cannot tell. Measured on the regtest venue before the fix: 483 rows
 * served against a highest action_index of 496. Only real rows in a real
 * MariaDB, with the tx-less ones present, can falsify that.
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

const Database       = require('../../src/db.js');
const Utility        = require('../../src/utility.js');
const { makeConfig } = require('../fixtures/mock-query-args.js');

const DB_HOST = process.env.CONFORMANCE_DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.CONFORMANCE_DB_PORT || 3307);
const DB_USER = process.env.CONFORMANCE_DB_USER || 'root';
const DB_PASS = process.env.CONFORMANCE_DB_PASS || 'testpass';

const INDEXER_DB      = 'XChain_ActionsFeed_Indexer';
const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'sql');

const BLOCK      = 664;
const BLOCK_TIME = 1788209886;
const TX_HASH    = 'ab'.repeat(32);

// One block of five actions. Two were broadcast (they have transactions rows);
// three were injected by the chain itself and have none. The three tx-less ones
// are drawn from the families the defect hid, and one of them carries the
// HIGHEST action_index in the fixture on purpose: that is what lets the suite
// assert "the feed reaches the top of the chain" rather than only "the feed is
// not empty".
const USER_ACTIONS = [
    { index: 70, action: 'SEND',   tx_index: 11 },
    { index: 71, action: 'ORDER',  tx_index: 12 }
];
const SYSTEM_ACTIONS = [
    { index: 72, action: 'DISPENSE' },
    { index: 73, action: 'ORDER_MATCH' },
    { index: 74, action: 'CROSS_SETTLE' }
];
const HIGHEST_INDEX = 74;

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

// Same tolerance the sibling conformance suites use: a dated migration that
// re-creates a table the base DDL already made has nothing to do here, and only
// those errnos are forgiven, so genuine DDL drift still fails loudly.
const ALREADY_APPLIED = new Set([1050 /* table exists */, 1061 /* duplicate key name */, 1060 /* duplicate column */]);

describe('raw /api/actions feed over system-injected actions (real MariaDB)', function () {

    this.timeout(120000);

    const hasIndexerDdl = fs.existsSync(INDEXER_SQL_DIR);

    let adminPool = null;
    let db        = null;

    async function adminQuery(sql, args){
        const conn = await adminPool.getConnection();
        try { return await conn.query(sql, args); }
        finally { conn.release(); }
    }

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

    async function seed(){
        const conn = await adminPool.getConnection();
        try {
            await conn.query('USE `' + INDEXER_DB + '`');
            const insertId = async (sql, args) => Number((await conn.query(sql, args)).insertId);

            const ledgerId  = await insertId('INSERT INTO index_transactions (hash) VALUES (?)', ['actions-feed-ledger']);
            const addressId = await insertId('INSERT INTO index_addresses (address) VALUES (?)', ['mzYXt4a991CYNpPVgf7GFVAdEoq8gdr4Um']);

            await conn.query('INSERT INTO blocks (block_index, block_time, ledger_hash_id) VALUES (?, ?, ?)',
                [BLOCK, BLOCK_TIME, ledgerId]);

            const actionId = async (name) =>
                insertId('INSERT INTO index_actions (action) VALUES (?)', [name]);

            // The broadcast control rows: transaction + action, the ordinary shape.
            for(const a of USER_ACTIONS){
                const txHashId = await insertId('INSERT INTO index_transactions (hash) VALUES (?)',
                    [TX_HASH.slice(0, 62) + String(a.tx_index)]);
                await conn.query(
                    'INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id, fee, data) VALUES (?, ?, ?, ?, ?, ?)',
                    [a.tx_index, BLOCK, txHashId, addressId, 1000, a.action + '|0|']);
                await conn.query(
                    'INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [a.index, BLOCK, a.tx_index, 0, await actionId(a.action), 0, addressId]);
            }

            // THE FIXTURE: chain-generated actions. Real action_index and
            // block_index, tx_index NULL, source_id NULL (a system action has no
            // sender), and deliberately no transactions row anywhere.
            for(const a of SYSTEM_ACTIONS){
                await conn.query(
                    'INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id) ' +
                    'VALUES (?, ?, NULL, NULL, ?, NULL, NULL)',
                    [a.index, BLOCK, await actionId(a.action)]);
            }
        } finally { conn.release(); }
    }

    // The fixture is only evidence while the system rows stay tx-less.
    async function assertFixtureIsTxLess(){
        for(const a of SYSTEM_ACTIONS){
            const rows = await adminQuery(
                'SELECT a.tx_index, (SELECT COUNT(*) FROM `' + INDEXER_DB + '`.transactions t WHERE t.tx_index=a.tx_index) AS txrows ' +
                'FROM `' + INDEXER_DB + '`.actions a WHERE a.action_index=?', [a.index]);
            expect(rows.length, 'action ' + a.index + ' is missing from the fixture').to.equal(1);
            expect(rows[0].tx_index, 'action ' + a.index + ' carries a tx_index, so it proves nothing').to.equal(null);
            expect(Number(rows[0].txrows), 'action ' + a.index + ' has a transactions row, so it proves nothing').to.equal(0);
        }
    }

    function makeDb(){
        const configInfo = {
            getConfig: async () => ({
                COIN_NETWORKS:  { BTC: 'Bitcoin' },
                COIN_PREFIXES:  { mainnet: '', testnet: 'T', regtest: 'R' },
                COIN_SUPPORTED: { RBTC: 'BTC (regtest)' },
                COIN_AVAILABLE: { RBTC: 'BTC (regtest)' },
                BTC: {
                    chain: require('../../src/configs/BTC.js').getConfig('regtest').chain,
                    regtest: {
                        database: {
                            indexer: { name: INDEXER_DB, db_host: DB_HOST, db_port: DB_PORT, user: DB_USER, pass: DB_PASS }
                        },
                        address: require('../../src/configs/BTC.js').getConfig('regtest').address
                    }
                }
            }),
            onConfigChanged: () => {}
        };
        const util = new Utility(configInfo);
        return new Database({ configInfo, util });
    }

    // The feed as a caller sees it: rows plus the `total` the paging is built on.
    async function feed(query){
        return db.getData(makeConfig({
            coin: 'RBTC', type: 'api',
            data: { method: 'getActions', query: query || {} }
        }));
    }

    let hadHubDbOptOut;

    before(async function () {
        if(!hasIndexerDdl) this.skip();
        // Indexer schema only: nothing under test reads a hub-mirrored table, so
        // the co-located hub schema is deliberately absent and its startup
        // assertion is downgraded to the warning it has an opt-out for.
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

    it('built a fixture whose system actions really have no transactions row', async function () {
        await assertFixtureIsTxLess();
    });

    /******************************************************************
     * 1. The feed enumerates the chain: every action row, nothing dropped
     *****************************************************************/

    it('lists every action in the table, tx-backed and system-injected alike', async function () {
        const [rows, total] = await feed();
        const indexes = rows.map(r => Number(r.action_index));
        for(const a of USER_ACTIONS)
            expect(indexes, 'the tx-backed control ' + a.action + ' vanished, so the rig is wrong, not the query')
                .to.include(a.index);
        for(const a of SYSTEM_ACTIONS)
            expect(indexes, 'the system-injected ' + a.action + ' is missing from /api/actions')
                .to.include(a.index);
        // The two halves of the ledger check that caught this on the venue: the
        // row count matches what the table holds, and the feed reaches the
        // highest action_index rather than stopping below it.
        const [{ total: actual }] = await adminQuery(
            'SELECT COUNT(*) AS total FROM `' + INDEXER_DB + '`.actions');
        expect(rows.length, 'the feed serves fewer rows than the chain has actions').to.equal(Number(actual));
        expect(Math.max(...indexes), 'the feed never reaches the highest action_index').to.equal(HIGHEST_INDEX);
        expect(Number(total), 'the count query disagrees with the row query').to.equal(rows.length);
    });

    it('serves sane values for every tx-derived column on a system-injected row', async function () {
        const [rows] = await feed();
        const row = rows.find(r => Number(r.action_index) === HIGHEST_INDEX);
        expect(row, 'CROSS_SETTLE is not in the feed at all').to.not.equal(undefined);
        expect(row.action).to.equal('CROSS_SETTLE');
        // Placed in its block off the ACTION's own block_index, not through a
        // transaction that does not exist.
        expect(Number(row.block_index)).to.equal(BLOCK);
        expect(Number(row.timestamp)).to.equal(BLOCK_TIME);
        // Real nulls, which is what the client's isNull/nullToBlank helpers
        // handle. The string 'undefined' or a thrown query are the failures.
        expect(row.tx_hash, 'tx_hash should be a real null, not a string').to.equal(null);
        expect(row.tx_index, 'tx_index should be a real null, not a string').to.equal(null);
        expect(row.source, 'a system action has no sender, so source is null').to.equal(null);
        for(const key in row)
            expect(String(row[key])).to.not.equal('undefined', 'column ' + key + ' came back undefined');
    });

    it('carries the tx-backed rows unchanged, so the LEFT join did not cost anything', async function () {
        const [rows] = await feed();
        const row = rows.find(r => Number(r.action_index) === USER_ACTIONS[0].index);
        expect(row.action).to.equal('SEND');
        expect(Number(row.tx_index)).to.equal(USER_ACTIONS[0].tx_index);
        expect(row.tx_hash, 'the tx-backed row lost its hash').to.be.a('string');
        expect(row.source).to.equal('mzYXt4a991CYNpPVgf7GFVAdEoq8gdr4Um');
        expect(Number(row.block_index)).to.equal(BLOCK);
    });

    /******************************************************************
     * 2. The filtered lanes still mean what they say
     *****************************************************************/

    it('serves the system-injected rows on the block-filtered lane too', async function () {
        // The block lane binds `b1.block_index=?`, so it is the lane that proves
        // b1 now hangs off the action rather than off a transaction row.
        const [rows] = await feed({ blockIndex: BLOCK });
        const indexes = rows.map(r => Number(r.action_index));
        for(const a of SYSTEM_ACTIONS)
            expect(indexes, 'the block lane resolves b1 through the transaction, so ' + a.action + ' is filtered out')
                .to.include(a.index);
        expect(rows.length).to.equal(USER_ACTIONS.length + SYSTEM_ACTIONS.length);
    });

    it('keeps the txid lane narrow: a LEFT join must not let tx-less rows leak in', async function () {
        const [rows, total] = await feed({ txid: TX_HASH.slice(0, 62) + String(USER_ACTIONS[0].tx_index) });
        expect(rows.map(r => Number(r.action_index)))
            .to.deep.equal([USER_ACTIONS[0].index]);
        expect(Number(total), 'the count query disagrees with the txid-filtered row query').to.equal(1);
    });
});
