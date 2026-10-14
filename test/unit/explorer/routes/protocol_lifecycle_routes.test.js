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

const ENDPOINTS = [
    { resource: 'rollcalls',    method: 'getRollcalls',   filters: ['block', 'address'], table: 'rollcall_signers' },
    { resource: 'xexecs',       method: 'getXexecs',      filters: ['block'], table: 'cross_chain_call_executions' },
    { resource: 'bet_expires',  method: 'getBetExpires',  filters: ['block', 'address'], table: 'bet_feed_statuses' },
    { resource: 'bet_cancels',  method: 'getBetCancels',  filters: ['block', 'address'], table: 'bet_cancels' },
    { resource: 'bet_edits',    method: 'getBetEdits',    filters: ['block', 'address'], table: 'bet_edits' },
    { resource: 'bet_resolves', method: 'getBetResolves', filters: ['block', 'address'], table: 'bet_resolves' },
    { resource: 'xbridges',     method: 'getXbridges',    filters: ['block', 'address', 'token'], table: 'actions' }
];

function queryConfig(method, type, search){
    return makeConfig({
        type: 'api',
        data: {
            method,
            type,
            search,
            query: { limit: '100000', page: '1001' }
        }
    });
}

describe('protocol lifecycle list routes', function () {
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.doQuery = async () => [];

    for(const endpoint of ENDPOINTS){
        it(`registers bare and filtered /api/${endpoint.resource} routes`, function () {
            expect(API[`/{COIN}/api/${endpoint.resource}`]).to.deep.equal([endpoint.method]);
            expect(API[`/{COIN}/api/${endpoint.resource}/{QUERY}/{TYPE}`])
                .to.deep.equal([endpoint.method, endpoint.filters]);
            expect(db[endpoint.method]).to.be.a('function');
        });

        it(`${endpoint.method} is parameterized, capped, and ordered by an indexed action key`, async function () {
            const type = endpoint.filters[0];
            const search = '987654321';
            const [query, args, count] = await db.getQuery(queryConfig(endpoint.method, type, search));

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

    it('uses every ROLLCALL table to summarize publications and close outcomes', async function () {
        const [query] = await db.getQuery(queryConfig('getRollcalls', 'block', '100'));
        for(const table of ['rollcall_signers', 'rollcalls', 'rollcall_absences', 'rollcall_gates'])
            expect(query).to.include(table);
    });

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
});
