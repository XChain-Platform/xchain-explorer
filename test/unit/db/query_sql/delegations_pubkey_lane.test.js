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
 * The getDelegations 'pubkey' lane: /{COIN}/api/delegations/{PUBKEY}/pubkey
 * lists the delegations holding one signing key, which the node CLI's STAKE v1
 * pre-check reads to mirror the indexer's validateFreeKey 'already delegated'.
 ********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { runListQuery }         = require('../../../../src/db/query_sql/data_rows.js');
const API_ROUTES = require('../../../../src/explorer/routes/api_methods.js').api;

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const MIXED_CASE_KEY = 'AbCd'.repeat(16);

function makeDb() {
    const configInfo = createConfigInfoStub();
    return new Database({ configInfo, util: new Utility(configInfo) });
}

function cfg(type, search) {
    return makeConfig({ type: 'api', data: { method: 'getDelegations', type, search } });
}

describe('getDelegations type=pubkey', () => {
    afterEach(() => sinon.restore());

    it('is a declared TYPE of the /delegations API route, beside the old three', () => {
        const route = API_ROUTES['/{COIN}/api/delegations/{QUERY}/{TYPE}'];
        expect(route[0]).to.equal('getDelegations');
        expect(route[1]).to.deep.equal(['block', 'address', 'source', 'pubkey']);
    });

    it('filters on the joined signing pubkey, not the delegator address', async () => {
        const sql = await makeDb().getQueryWhereSql(cfg('pubkey', MIXED_CASE_KEY));
        expect(sql).to.match(/ AND a3\.pubkey=\?$/);
        expect(sql).to.not.include('a2.address');
    });

    it('is scoped to getDelegations: another method with type=pubkey gets no a3 clause', async () => {
        const sql = await makeDb().getQueryWhereSql(makeConfig({ data: { method: 'getStakes', type: 'pubkey' } }));
        expect(sql).to.not.include('a3.pubkey');
    });

    it('binds the key lowercased in both the row and the count query', async () => {
        const db = makeDb();
        const config = cfg('pubkey', MIXED_CASE_KEY);
        config.data.sql.where.data = await db.getQueryWhereSql(config);
        const [query, args, count] = await db.getDelegations(config);
        const doQuery = sinon.stub(db, 'doQuery');
        doQuery.onFirstCall().resolves([{ signing_pubkey: MIXED_CASE_KEY.toLowerCase(), status: 'valid' }]);
        doQuery.onSecondCall().resolves([{ total: 1 }]);
        const [data, total] = await runListQuery(db, config, query, args, count);
        expect(doQuery.firstCall.args[2][0]).to.equal(MIXED_CASE_KEY.toLowerCase());
        expect(doQuery.secondCall.args[2]).to.deep.equal([MIXED_CASE_KEY.toLowerCase()]);
        expect(doQuery.secondCall.args[2][0]).to.not.equal(MIXED_CASE_KEY);
        expect(data).to.have.length(1);
        expect(total).to.equal(1);
    });

    it('leaves the address lane binding the search as given', async () => {
        const [, args] = await makeDb().getDelegations(cfg('address', 'mSomeAddress'));
        expect(args).to.equal(null);
    });
});
