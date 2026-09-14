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
 * The contract identity manifest, on the reader side: the four meta columns
 * the indexer stores for a conforming deploy and the surfaces that show them.
 *
 * A contract now carries a declared name, description and version, extracted
 * into four columns and a FULLTEXT index by the indexer. Everything here is
 * about what the EXPLORER does with them: which columns each contract query
 * names, what the parsed `meta` object is when meta_json is not a plain object,
 * and the two search paths that read the index rather than scanning with LIKE.
 *
 * The MATCH lanes get the most attention, because they are the only queries in
 * this service whose bound value has query-language meaning: MATCH ... AGAINST
 * (? IN BOOLEAN MODE) reads +, -, ~, *, ", ( ), < > and @ inside the value as
 * operators, so a term is sanitized before it is bound and a term with nothing
 * left is answered as no results rather than as a match on everything.
 *********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { makeConfig }           = require('../../fixtures/mock-query-args.js');

const Database = proxyquire('../../../src/db/index.js', {
    './connection.js': proxyquire('../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

function makeDb(){
    const db = new Database({ configInfo, util });
    // RBTC -> BTC, the same base-chain map getContractBalance derives a contract's
    // C:<CHAIN>:<action_index> address from.
    db.baseCoin = { BTC: 'BTC', RBTC: 'BTC' };
    return db;
}

const META = { name: 'Escrow', description: 'Two-party escrow with an arbiter', version: '2.0.0' };

function contractRow(overrides = {}){
    return Object.assign({
        action:            'DEPLOY',
        action_index:      900,
        action_format:     0,
        source:            'deployerAddr',
        code:              'module.exports={}',
        code_hash:         'abc123',
        api_version:       1,
        cooldown_blocks:   null,
        slash_destination: null,
        meta_name:         'Escrow',
        meta_description:  'Two-party escrow with an arbiter',
        meta_version:      '2.0.0',
        meta_json:         JSON.stringify(META),
        block_index:       500,
        timestamp:         1700000000,
        tx_hash:           'tx900',
        tx_index:          90,
        status:            'valid',
        permissions:       null,
        max_take_bps:      null
    }, overrides);
}

const contractCfg = () => makeConfig({
    data: { search: '900', sql: { where: { data: 'm.action_index=?', offset: '' }, order: 'DESC', limit: 1 } }
});

let sqlite = null;

function setupSqlite() {
    try { sqlite = require('node:sqlite'); } catch(e) { sqlite = null; }
    if(!sqlite) this.skip();
}

function seed(){
        const sq = new sqlite.DatabaseSync(':memory:');
        sq.exec(`
            CREATE TABLE actions            (action_index INTEGER, action_format INTEGER, action_id INTEGER, tx_index INTEGER, source_id INTEGER, block_index INTEGER);
            CREATE TABLE transactions       (tx_index INTEGER, block_index INTEGER, source_id INTEGER, tx_hash_id INTEGER);
            CREATE TABLE blocks             (block_index INTEGER, block_time INTEGER);
            CREATE TABLE index_actions      (id INTEGER, action TEXT);
            CREATE TABLE index_addresses    (id INTEGER, address TEXT);
            CREATE TABLE index_statuses     (id INTEGER, status TEXT);
            CREATE TABLE index_transactions (id INTEGER, hash TEXT);
            CREATE TABLE index_tickers      (id INTEGER, tick TEXT);
            CREATE TABLE contracts          (action_index INTEGER, meta_name TEXT, meta_version TEXT);
            CREATE TABLE contract_executions(action_index INTEGER, contract_index INTEGER, caller_id INTEGER, method_name TEXT, input_params TEXT, gas_used INTEGER, gas_limit INTEGER, emitted_count INTEGER, error_message TEXT, status_id INTEGER);
            CREATE TABLE deposits           (action_index INTEGER, contract_index INTEGER, source_id INTEGER, tick_id INTEGER, amount TEXT, status_id INTEGER);
            INSERT INTO index_actions      VALUES (9, 'EXECUTE');
            INSERT INTO index_addresses    VALUES (1, 'caller-address');
            INSERT INTO index_statuses     VALUES (1, 'valid');
            INSERT INTO index_transactions VALUES (1, 'tx-hash');
            INSERT INTO index_tickers      VALUES (1, 'XCHAIN');
            INSERT INTO blocks             VALUES (10, 1700000000);
            INSERT INTO actions            VALUES (700, 0, 9, 700, 1, 10), (800, 0, 9, 800, 1, 10);
            INSERT INTO transactions       VALUES (700, 10, 1, 1), (800, 10, 1, 1);
            INSERT INTO contracts          VALUES (42, 'Escrow', '2.0.0'), (43, NULL, NULL);
        `);
        return sq;
    }

function run(sq, sql, index){
        const row = sq.prepare(String(sql)).get(index);
        return row === undefined ? null : row;
    }

module.exports = {
    sinon, expect, makeConfig, makeDb, META, contractRow, contractCfg, setupSqlite, seed, run,
};
