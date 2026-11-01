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
 ********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig } = require('../../../fixtures/mock-query-args.js');
const { openIndexerTables, runOnSqlite } = require('../../../helpers/indexer_ddl_sqlite.js');
const API = require('../../../../src/explorer/routes/api_methods.js').api;

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', {
        mariadb: { createPool: () => ({}) }
    })
});

// ROLLCALL publications exist only on DOGE, so that entry is queried on a DOGE route code
const ENDPOINTS = [
    { resource: 'rollcalls',    method: 'getRollcalls',   filters: ['block', 'address'], table: 'rollcall_signers', coin: 'DOGE' },
    { resource: 'xexecs',       method: 'getXexecs',      filters: ['block'], table: 'cross_chain_call_executions' },
    { resource: 'bet_expires',  method: 'getBetExpires',  filters: ['block', 'address'], table: 'bet_feed_statuses' },
    { resource: 'bet_cancels',  method: 'getBetCancels',  filters: ['block', 'address'], table: 'bet_cancels' },
    { resource: 'bet_edits',    method: 'getBetEdits',    filters: ['block', 'address'], table: 'bet_edits' },
    { resource: 'bet_resolves', method: 'getBetResolves', filters: ['block', 'address'], table: 'bet_resolves' },
    { resource: 'xbridges',     method: 'getXbridges',    filters: ['block', 'address', 'token'], table: 'actions' }
];

function queryConfig(method, type, search, coin){
    return makeConfig({
        coin: coin || 'BTC',
        type: 'api',
        data: {
            method,
            type,
            search,
            query: { limit: '100000', page: '1001' }
        }
    });
}

// Build a Database whose queries are composed but never sent.
function lifecycleDb(){
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.doQuery = async () => [];
    return db;
}

function lifecycleDbWithRollcallActions(){
    const db = lifecycleDb();
    db.doQuery = async (config, query) => String(query).includes('information_schema.TABLES')
        ? [{ TABLE_NAME: 'rollcall_actions' }]
        : [];
    return db;
}

function lifecycleDbWithTables(tables){
    const db = lifecycleDb();
    db.doQuery = async (config, query, args) => String(query).includes('information_schema.TABLES')
        ? (args || []).filter(name => tables.includes(name)).map(TABLE_NAME => ({ TABLE_NAME }))
        : [];
    return db;
}

function seedRollcallList(sqlite){
    sqlite.exec(`
        INSERT INTO index_actions (id, action) VALUES (1, 'ROLLCALL'), (2, 'SEND');
        INSERT INTO index_addresses (id, address) VALUES (1, 'Dpublisher');
        INSERT INTO index_transactions (id, hash) VALUES (1, 'tx10'), (2, 'tx11'), (3, 'tx12'), (4, 'tx13');
        INSERT INTO blocks (id, block_index, block_time) VALUES (1, 100, 1000), (2, 101, 1001), (3, 102, 1002), (4, 103, 1003);
        INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id)
            VALUES (10, 100, 1, 1), (11, 101, 2, 1), (12, 102, 3, 1), (13, 103, 4, 1);
        INSERT INTO actions (action_index, block_index, tx_index, action_id, action_format, source_id)
            VALUES (10, 100, 10, 1, 0, 1), (11, 101, 11, 1, 1, 1),
                   (12, 102, 12, 1, 1, 1), (13, 103, 13, 2, 0, 1);
        INSERT INTO rollcall_actions
            (action_index, block_index, epoch_height, ledger_hash, publisher, gates, carried_count, first_seen_count)
            VALUES (11, 101, 500, 'ledger11', 'publisher11', NULL, 3, 0),
                   (12, 102, 500, 'ledger12', 'publisher12', NULL, 2, 1);
        INSERT INTO rollcall_signers
            (epoch_height, pubkey, sig, ledger_hash, publisher, action_index, block_index, gates)
            VALUES (400, 'key10a', 'sig10a', 'ledger10', 'publisher10', 10, 100, NULL),
                   (400, 'key10b', 'sig10b', 'ledger10', 'publisher10', 10, 100, NULL),
                   (500, 'key12a', 'sig12a', 'ledger12', 'publisher12', 12, 102, NULL);
    `);
}

// Capture the refusal: a DbInputError (answered 400), never an empty page
async function refusal(db, method, coin){
    try { await db.getQuery(queryConfig(method, null, null, coin)); }
    catch(e){ return e; }
    return null;
}

// Register the route and query-shape cases every lifecycle endpoint shares.
function endpointCases(db, endpoint){
    it(`registers bare and filtered /api/${endpoint.resource} routes`, function () {
        expect(API[`/{COIN}/api/${endpoint.resource}`]).to.deep.equal([endpoint.method]);
        expect(API[`/{COIN}/api/${endpoint.resource}/{QUERY}/{TYPE}`])
            .to.deep.equal([endpoint.method, endpoint.filters]);
        expect(db[endpoint.method]).to.be.a('function');
    });

    it(`${endpoint.method} is parameterized, capped, and ordered by an indexed action key`, async function () {
        const type = endpoint.filters[0];
        const search = '987654321';
        const [query, args, count] = await db.getQuery(queryConfig(endpoint.method, type, search, endpoint.coin));

        expect(query).to.include(`FROM ${endpoint.table}`);
        expect(query).to.match(/WHERE[\s\S]*\?/);
        expect(query).to.not.include(search);
        expect(count).to.match(/WHERE[\s\S]*\?/);
        expect(count).to.not.include(search);
        expect(query).to.match(/ORDER BY m\.action_index DESC/);
        expect(query).to.match(/LIMIT 100\s*$/);
        if(args) expect(args).to.not.include(search);
    });
}

function rollcallPublicationShapeCases(db){
    it('reads ROLLCALL publications from the DOGE-written table only', async function () {
        const [query, , count] = await db.getQuery(queryConfig('getRollcalls', 'block', '100', 'RDOGE'));
        expect(query).to.include('FROM rollcall_signers m');
        for(const table of ['rollcalls ', 'rollcall_absences', 'rollcall_gates', 'responsible_set_json'])
            expect(query + count).to.not.include(table);
        for(const field of ['absence_count', 'evicted_count', 'gate_signer_count', 'close_block', 'rolled'])
            expect(query).to.not.include(field);
        expect(query).to.include('COUNT(*) as signer_count');
        expect(query).to.include('NULL as carried_count');
        expect(query).to.include('COUNT(*) as first_seen_count');
    });

    it('joins one-row ROLLCALL records with pre-migration first-seen groups', async function () {
        const upgraded = lifecycleDbWithRollcallActions();
        const [query, , count] = await upgraded.getQuery(queryConfig('getRollcalls', 'block', '100', 'RDOGE'));

        expect(query).to.include('FROM actions m');
        expect(query).to.include('LEFT  JOIN rollcall_actions   r  ON (r.action_index=m.action_index)');
        expect(query).to.include('LEFT  JOIN rollcall_signers   s  ON (s.action_index=m.action_index)');
        expect(query).to.include("a4.id=m.action_id AND a4.action='ROLLCALL'");
        expect(query).to.include('COUNT(s.action_index) as signer_count');
        expect(query).to.include('MAX(r.carried_count) as carried_count');
        expect(query).to.include('COALESCE(MAX(r.first_seen_count), COUNT(s.action_index)) as first_seen_count');
        expect(query).to.match(/WHERE m\.action_index IS NOT NULL AND m\.block_index=\? AND \(r\.action_index IS NOT NULL OR s\.action_index IS NOT NULL\)/);
        expect(query).to.match(/ORDER BY m\.action_index DESC[\s\S]*LIMIT 100\s*$/);
        expect(count).to.include('SELECT count(DISTINCT m.action_index) as total');
        expect(count).to.include('rollcall_actions');
        expect(count).to.include('rollcall_signers');
    });
}

function rollcallPublicationExecutionCases(){
    it('executes the mixed-generation ROLLCALL list against the real indexer column sets', async function () {
        const tables = ['actions', 'index_actions', 'blocks', 'transactions', 'index_addresses',
            'index_transactions', 'rollcall_actions', 'rollcall_signers'];
        const sqlite = openIndexerTables(this, tables);
        if(!sqlite) return;
        try {
            seedRollcallList(sqlite);
            const upgraded = lifecycleDbWithRollcallActions();
            const [query, args, count] = await upgraded.getQuery(
                queryConfig('getRollcalls', null, null, 'RDOGE'));
            const rows = runOnSqlite(sqlite, query, args);
            const total = runOnSqlite(sqlite, count, args)[0].total;

            expect(rows.map(row => [row.action_index, row.signer_count,
                row.carried_count, row.first_seen_count])).to.deep.equal([
                [12, 1, 2, 1], [11, 0, 3, 0], [10, 2, null, 2]
            ]);
            expect(total).to.equal(3);
        } finally {
            sqlite.close();
        }
    });

    it('retries the legacy list when a failed probe is followed by a missing table', async function () {
        const recovering = lifecycleDb();
        const statements = [];
        recovering.doQuery = async (config, query) => {
            const text = String(query);
            statements.push(text);
            if(text.includes('information_schema.TABLES')) throw new Error('probe unavailable');
            if(text.includes('rollcall_actions')){
                const error = new Error('rollcall_actions does not exist');
                error.errno = 1146;
                error.code = 'ER_NO_SUCH_TABLE';
                throw error;
            }
            if(/^SELECT count\(/.test(text)) return [{ total: 0 }];
            return [];
        };

        const [rows, total] = await recovering.getData(
            queryConfig('getRollcalls', 'block', '100', 'RDOGE'));
        expect(rows).to.deep.equal([]);
        expect(total).to.equal(0);
        expect(statements.some(text => text.includes('rollcall_actions'))).to.equal(true);
        expect(statements.some(text => text.includes('FROM rollcall_signers m'))).to.equal(true);
        expect(recovering.schemaTableMemo.RDOGE.rollcall_actions.present).to.equal(false);
    });
}

function rollcallPublicationPolicyCases(db){
    it('refuses ROLLCALL publications on a non-DOGE chain with a 400 input error', async function () {
        for(const coin of ['BTC', 'TBTC', 'RBTC', 'LTC']){
            const err = await refusal(db, 'getRollcalls', coin);
            expect(err, coin).to.be.an('error');
            expect(err.name).to.equal('DbInputError');
            expect(err.code).to.equal('ROLLCALLS_DOGE_ONLY');
            expect(err.message).to.include('/api/rollcall_closes');
        }
    });
}

function rollcallCloseCases(db){
    it('registers bare and filtered /api/rollcall_closes routes', function () {
        expect(API['/{COIN}/api/rollcall_closes']).to.deep.equal(['getRollcallCloses']);
        expect(API['/{COIN}/api/rollcall_closes/{QUERY}/{TYPE}']).to.deep.equal(['getRollcallCloses', ['block']]);
        expect(db.getRollcallCloses).to.be.a('function');
    });

    it('reads BTC epoch closes from rollcalls with live counts, paged by epoch', async function () {
        const search = '987654321';
        const upgraded = lifecycleDbWithTables(['rollcall_gates']);
        const [query, args, count] = await upgraded.getQuery(queryConfig('getRollcallCloses', 'block', search, 'RBTC'));
        expect(query).to.include('FROM rollcalls m');
        expect(query).to.include('rollcall_absences ra WHERE ra.epoch_height=m.epoch_height) as absence_count');
        expect(query).to.include('ra.evicted=1) as evicted_count');
        expect(query).to.include('rollcall_gates rg WHERE rg.epoch_height=m.epoch_height) as gate_signer_count');
        expect(query).to.not.include('responsible_set_json');
        expect(query).to.not.include('rollcall_signers');
        expect(query).to.match(/WHERE m\.epoch_height IS NOT NULL AND m\.close_block=\?/);
        expect(count).to.match(/FROM rollcalls m WHERE m\.epoch_height IS NOT NULL AND m\.close_block=\?/);
        expect(query).to.not.include(search);
        expect(query).to.match(/ORDER BY m\.epoch_height DESC/);
        expect(query).to.match(/LIMIT 100\s*$/);
        if(args) expect(args).to.not.include(search);
    });

    it('serves close rows without a gate count on a replica predating rollcall_gates', async function () {
        const [query, , count] = await lifecycleDb().getQuery(
            queryConfig('getRollcallCloses', 'block', '987654321', 'RBTC'));
        expect(query).to.include('NULL as gate_signer_count');
        expect(query).to.not.include('FROM rollcall_gates');
        expect(query).to.include('FROM rollcalls m');
        expect(query).to.include('rollcall_absences ra WHERE ra.epoch_height=m.epoch_height');
        expect(count).to.match(/FROM rollcalls m WHERE m\.epoch_height IS NOT NULL AND m\.close_block=\?/);
    });

    it('fails open to the newest close query when the table probe is unavailable', async function () {
        const probeFailure = lifecycleDb();
        probeFailure.doQuery = async () => { throw new Error('probe unavailable'); };
        const [query] = await probeFailure.getQuery(
            queryConfig('getRollcallCloses', 'block', '987654321', 'RBTC'));
        expect(query).to.include('FROM rollcall_gates');
    });

    it('refuses ROLLCALL epoch closes on a non-BTC chain with a 400 input error', async function () {
        for(const coin of ['DOGE', 'TDOGE', 'RDOGE', 'LTC']){
            const err = await refusal(db, 'getRollcallCloses', coin);
            expect(err, coin).to.be.an('error');
            expect(err.name).to.equal('DbInputError');
            expect(err.code).to.equal('ROLLCALL_CLOSES_BTC_ONLY');
            expect(err.message).to.include('/api/rollcalls');
        }
    });
}

// Register the ROLLCALL publication and epoch-close cases.
function rollcallCases(db){
    rollcallPublicationShapeCases(db);
    rollcallPublicationExecutionCases();
    rollcallPublicationPolicyCases(db);
    rollcallCloseCases(db);
}

// Register the XBRIDGE join and filter cases and the BET_EXPIRE action restriction.
function actionFilterCases(db){
    it('unifies user and settlement XBRIDGE legs without dropping transactionless rows', async function () {
        const [query] = await db.getQuery(queryConfig('getXbridges', 'block', '100'));
        expect(query).to.include('LEFT  JOIN xbridges');
        expect(query).to.include('LEFT  JOIN bridge_settlements');
        expect(query).to.include('LEFT  JOIN transactions');
        expect(query).to.match(/a4\.action='XBRIDGE'/);
    });

    it('binds every address and token alternative in the XBRIDGE filters', async function () {
        const address = await db.getQuery(queryConfig('getXbridges', 'address', 'destination'));
        const token = await db.getQuery(queryConfig('getXbridges', 'token', 'TOKEN'));
        expect((address[0].match(/\?/g) || []).length).to.equal(3);
        expect(address[1]).to.deep.equal(['destination', 'destination', 'destination']);
        expect((token[0].match(/\?/g) || []).length).to.equal(2);
        expect(token[1]).to.deep.equal(['TOKEN', 'TOKEN']);
    });

    it('restricts BET_EXPIRE rows to the synthetic action type', async function () {
        const [query, , count] = await db.getQuery(queryConfig('getBetExpires', 'block', '100'));
        expect(query).to.match(/a4\.action='BET_EXPIRE'/);
        expect(count).to.match(/a4\.action='BET_EXPIRE'/);
    });
}

describe('protocol lifecycle list routes', function () {
    const db = lifecycleDb();
    for(const endpoint of ENDPOINTS) endpointCases(db, endpoint);
    rollcallCases(db);
    actionFilterCases(db);
});
