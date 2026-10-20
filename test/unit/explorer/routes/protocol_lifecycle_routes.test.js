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

// Register the ROLLCALL publication and epoch-close cases.
function rollcallCases(db){
    it('reads ROLLCALL publications from the DOGE-written table only', async function () {
        const [query, , count] = await db.getQuery(queryConfig('getRollcalls', 'block', '100', 'RDOGE'));
        expect(query).to.include('FROM rollcall_signers m');
        for(const table of ['rollcalls ', 'rollcall_absences', 'rollcall_gates', 'responsible_set_json'])
            expect(query + count).to.not.include(table);
        for(const field of ['absence_count', 'evicted_count', 'gate_signer_count', 'close_block', 'rolled'])
            expect(query).to.not.include(field);
    });

    it('refuses ROLLCALL publications on a non-DOGE chain with a 400 input error', async function () {
        for(const coin of ['BTC', 'TBTC', 'RBTC', 'LTC']){
            const err = await refusal(db, 'getRollcalls', coin);
            expect(err, coin).to.be.an('error');
            expect(err.name).to.equal('DbInputError');
            expect(err.code).to.equal('ROLLCALLS_DOGE_ONLY');
            expect(err.message).to.include('/api/rollcall_closes');
        }
    });

    it('registers bare and filtered /api/rollcall_closes routes', function () {
        expect(API['/{COIN}/api/rollcall_closes']).to.deep.equal(['getRollcallCloses']);
        expect(API['/{COIN}/api/rollcall_closes/{QUERY}/{TYPE}']).to.deep.equal(['getRollcallCloses', ['block']]);
        expect(db.getRollcallCloses).to.be.a('function');
    });

    it('reads BTC epoch closes from rollcalls with live counts, paged by epoch', async function () {
        const search = '987654321';
        const [query, args, count] = await db.getQuery(queryConfig('getRollcallCloses', 'block', search, 'RBTC'));
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
