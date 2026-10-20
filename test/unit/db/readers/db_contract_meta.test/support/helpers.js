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

const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../../../fixtures/mock-query-args.js');
const { openIndexerTables, toSqlite } = require('../../../../../helpers/indexer_ddl_sqlite.js');

const Database = proxyquire('../../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
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
const TABLES = ['actions', 'transactions', 'blocks', 'index_actions', 'index_addresses',
    'index_statuses', 'index_transactions', 'index_tickers', 'contract_executions', 'deposits'];
const CONTRACTS_DDL = path.join(__dirname, '..', '..', '..', '..', '..', '..', '..',
    'xchain-indexer', 'src', 'sql', 'contracts.sql');

function setupSqlite() {
    sqlite = openIndexerTables(this, TABLES);
    if(!sqlite) return;
    const contracts = toSqlite(fs.readFileSync(CONTRACTS_DDL, 'utf8'))
        .replace(/^CREATE FULLTEXT INDEX[^;]*;/gim, '');
    sqlite.exec(contracts);
}

function seed(){
        sqlite.exec(`
            INSERT INTO index_actions (id, action) VALUES (9, 'EXECUTE');
            INSERT INTO index_addresses (id, address) VALUES (1, 'caller-address');
            INSERT INTO index_statuses (id, status) VALUES (1, 'valid');
            INSERT INTO index_transactions (id, hash) VALUES (1, 'tx-hash');
            INSERT INTO index_tickers (id, tick) VALUES (1, 'XCHAIN');
            INSERT INTO blocks (block_index, block_time) VALUES (10, 1700000000);
            INSERT INTO actions (action_index, action_format, action_id, tx_index, source_id, block_index)
                VALUES (700, 0, 9, 700, 1, 10), (800, 0, 9, 800, 1, 10);
            INSERT INTO transactions (tx_index, block_index, source_id, tx_hash_id)
                VALUES (700, 10, 1, 1), (800, 10, 1, 1);
            INSERT INTO contracts (action_index, source_id, code, code_hash, block_index, meta_name, meta_version)
                VALUES (42, 1, '', 'hash-42', 10, 'Escrow', '2.0.0'), (43, 1, '', 'hash-43', 10, NULL, NULL);
        `);
        return {
            prepare: (...args) => sqlite.prepare(...args),
            exec(sql) {
                sql = String(sql)
                    .replace(/INSERT INTO contract_executions VALUES \(([^;]+)\)/,
                        'INSERT INTO contract_executions (action_index, contract_index, caller_id, method_name, input_params, gas_used, gas_limit, emitted_count, error_message, status_id, block_index) VALUES ($1, 10)')
                    .replace(/INSERT INTO deposits VALUES \(([^;]+)\)/,
                        'INSERT INTO deposits (action_index, contract_index, source_id, tick_id, amount, status_id, block_index) VALUES ($1, 10)');
                return sqlite.exec(sql);
            }
        };
    }

function run(sq, sql, index){
        const row = sq.prepare(String(sql)).get(index);
        return row === undefined ? null : row;
    }

module.exports = {
    sinon, expect, makeConfig, makeDb, META, contractRow, contractCfg, setupSqlite, seed, run,
};
