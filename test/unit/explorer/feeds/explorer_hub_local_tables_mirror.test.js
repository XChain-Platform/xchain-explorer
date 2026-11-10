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
 * The four hub-local operational readers (p2p_peers, consensus_state, configs,
 * telemetry_pings) on a coin pointed at a co-located hub schema. A self-synced
 * mirror never holds these tables, and the route refuses them there before any
 * reader runs (test/unit/explorer/explorer_hub_local_pages_self_sync.test.js).
 * This pins the other half: on a co-located hub schema each reader still
 * qualifies its own table to that schema and the request is served from it.
 */

const { expect } = require('chai');
const sinon      = require('sinon');

const { makeConfig } = require('../../../fixtures/mock-query-args.js');
const { makeRealDb } = require('./explorer_capability_snapshots.test/support/helpers.js');
const { loadData }   = require('../../../../src/explorer/request/load_data.js');

const HUBDB = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest', selfSync: false } };

const PAGES = [
    ['getPeers',          'p2p_peers'],
    ['getConsensusState', 'consensus_state'],
    ['getConfigs',        'configs'],
    ['getTelemetryPings', 'telemetry_pings']
];

function pageConfig(method){
    return makeConfig({
        coin: 'RBTC',
        type: 'api',
        data: {
            method, search: null, type: null,
            sql: { order: 'DESC', limit: 100,
                   where: { data: 'm.id IS NOT NULL', offset: '', offsetArgs: [] } }
        }
    });
}

// The request path for these pages: the reader builds its statement, the statement
// runs on the pool, and loadData maps the outcome to the HTTP answer.
async function serve(db, method){
    const st = { cfg: pageConfig(method), response: { code: 200, json: null } };
    const explorer = { db: {
        getData: async (cfg) => {
            const [query, args, count] = await db[method](cfg);
            const rows  = await db.doQuery(cfg, query, args);
            const total = await db.doQuery(cfg, count, args);
            return [rows, total];
        }
    } };
    await loadData(explorer, { path: '/RBTC/api/' + method }, st);
    return st;
}

describe('hub-local operational readers on a co-located hub schema', () => {

    PAGES.forEach(([method, table]) => {
        it(method + ' runs its direct query against the hub schema', async () => {
            const db = makeRealDb();
            db.checkpointDb = { ...HUBDB };
            const [query, args, count] = await db[method](pageConfig(method));
            expect(query).to.include('FROM `XChain_Hub`.' + table + ' m');
            expect(count).to.include('FROM `XChain_Hub`.' + table + ' m');
            expect(args).to.equal(null);

            const doQuery = sinon.stub(db, 'doQuery').resolves([]);
            const st = await serve(db, method);
            expect(st.dbError).to.not.equal(true);
            expect(st.response.code).to.equal(200);
            expect(doQuery.callCount).to.equal(2);
        });
    });
});
