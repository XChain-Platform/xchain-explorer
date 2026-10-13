'use strict';

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
 **********************************************************************
 * The bare list-all API requests answer without a search term while their
 * filtered route declarations remain the canonical dispatch entries.
 */

const proxyquire = require('proxyquire');
const { expect, makeExplorer, request } = require('./explorer_routing.test/support/helpers.js');
const { api } = require('../../../../src/explorer/routes/api_methods.js');
const { supportsBareApiList } = require('../../../../src/explorer/request/resolve_route.js');
const Utility = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig } = require('../../../fixtures/mock-query-args.js');
const SPEC = require('../../../../docs/openapi.json');

const filteredLists = Object.entries(api).filter(([, info]) => supportsBareApiList(info));
const LIST_ALL = Object.fromEntries(filteredLists
    .map(([route, info]) => [route.replace('/{QUERY}/{TYPE}', ''), info[0]]));
const DERIVED_LIST_ALL = Object.fromEntries(filteredLists
    .filter(([route]) => !api[route.replace('/{QUERY}/{TYPE}', '')])
    .map(([route, info]) => [route.replace('/{QUERY}/{TYPE}', ''), info[0]]));
const SUBJECT_REQUIRED = ['/BTC/api/search', '/BTC/api/projects', '/BTC/api/transaction'];

const configInfo = createConfigInfoStub();
const util = new Utility(configInfo);
const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', {
        mariadb: { createPool: () => ({}) }
    })
});

function makeDatabase(calls){
    const db = new Database({ configInfo, util });
    db.doQuery = async function(_config, sql, args){
        calls.push({ sql, args: args || [] });
        if(/count\(DISTINCT\(/i.test(sql)) return [{ count: 1 }];
        if(/count\(\*\)/i.test(sql)) return [{ total: 1 }];
        return [];
    };
    return db;
}

let explorer;

function registerRouteContractTests(){
    for (const [route, method] of Object.entries(LIST_ALL)) {
        it(route + ' reuses the filtered ' + method + ' route declaration', function () {
            expect(api[route + '/{QUERY}/{TYPE}'][0]).to.equal(method);
        });

        it(route + ' is declared in the OpenAPI document without TYPE or QUERY', function () {
            const op = SPEC.paths[route] && SPEC.paths[route].get;
            expect(op, 'spec entry').to.be.an('object');
            const refs = op.parameters.map(p => p.$ref);
            expect(refs).to.include('#/components/parameters/coin');
            expect(refs).to.not.include('#/components/parameters/TYPE');
            expect(refs.filter(r => /parameters\/QUERY/.test(r))).to.deep.equal([]);
        });

        it(route + ' keeps its filtered sibling', function () {
            expect(api[route + '/{QUERY}/{TYPE}'][0]).to.equal(method);
            expect(SPEC.paths[route + '/{QUERY}/{TYPE}']).to.be.an('object');
        });

        it(route + ' resolves at runtime without a search term', async function () {
            const path = route.replace('{COIN}', 'BTC');
            const { cfg } = await request(explorer, path);
            expect(cfg, 'captured request config').to.not.equal(null);
            expect(cfg.type).to.equal('api');
            expect(cfg.data.method).to.equal(method);
            expect(cfg.data.search).to.equal(undefined);
        });
    }
}

function registerSqlSafetyTests(){
    for(const [route, method] of Object.entries(DERIVED_LIST_ALL)){
        it(route + ' keeps its unfiltered SQL page bounded and index-ordered', async function () {
            const calls = [];
            const db = makeDatabase(calls);
            const config = makeConfig({
                type: 'api',
                data: {
                    method,
                    search: null,
                    type: null,
                    query: { limit: 1000, page: 1000000 }
                }
            });
            const [query] = await db.getQuery(config);
            const statements = typeof query == 'string'
                ? [{ sql: query }].concat(calls)
                : calls;
            const rowCall = statements.find(call =>
                /ORDER BY\s+(?:m|a1)\.(?:action_index|id)\s+DESC/i.test(call.sql) &&
                /LIMIT\s+100\b/i.test(call.sql));
            expect(rowCall, 'bounded row query ordered by an indexed cursor').to.be.an('object');
            expect(config.data.sql.limit).to.equal(100);
            expect(config.data.sql.apiOffset).to.be.at.most(100000);
        });
    }
}

function registerSubjectRequiredTests(){
    for(const path of SUBJECT_REQUIRED){
        it(path + ' still requires a lookup subject', async function () {
            const { cfg } = await request(explorer, path);
            expect(cfg).to.equal(null);
        });
    }
}

describe('bare list-all API routes', function () {
    before(function () {
        explorer = makeExplorer();
    });

    registerRouteContractTests();
    registerSqlSafetyTests();
    registerSubjectRequiredTests();
});
