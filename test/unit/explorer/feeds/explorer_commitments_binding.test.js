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
 * getCommitments bound end to end through the shared list path: the exact
 * SQL and argument arrays doQuery receives for the row query and the count.
 * The page is chosen in a derived table ahead of the two decoration legs, so
 * its cursor and offset bind before the join placeholders, and the count
 * binds only what its joinless WHERE carries. String pins on the reader
 * alone cannot catch a bind-order slip; these drive the binding itself.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');

const Utility = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { runListQuery }         = require('../../../../src/db/query_sql/data_rows.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const HUB      = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
const IDENTITY = ['BTC', 'mainnet', 'BTC', 'mainnet', 'BTC', 'mainnet', 'BTC', 'mainnet'];

function makeDb() {
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.checkpointDb = { ...HUB };
    return db;
}

// Runs getCommitments then the shared runListQuery against a stubbed doQuery,
// as getData does, and returns both calls.
async function bind(config) {
    const db = makeDb();
    config.data.sql.where.data = await db.getQueryWhereSql(config);
    const [query, args, count] = await db.getCommitments(config);
    const doQuery = sinon.stub(db, 'doQuery');
    doQuery.onFirstCall().resolves([{ block_index: 7 }]);
    doQuery.onSecondCall().resolves([{ total: 109812n }]);
    const [data, total] = await runListQuery(db, config, query, args, count);
    return {
        rowSql: doQuery.firstCall.args[1], rowArgs: doQuery.firstCall.args[2],
        countSql: doQuery.secondCall.args[1], countArgs: doQuery.secondCall.args[2],
        calls: doQuery.callCount, data, total
    };
}

function cfg(type, search, extras = {}) {
    return makeConfig({ type: extras.transport || 'api', data: { method: 'getCommitments', type, search } });
}

function placeholders(sql) {
    return (sql.match(/\?/g) || []).length;
}

describe('getCommitments bound through runListQuery', () => {
    afterEach(() => sinon.restore());

    it('list-all: the row query binds the identity alone, the count binds nothing', async () => {
        const r = await bind(cfg(null, null));
        expect(r.rowArgs).to.deep.equal(IDENTITY);
        expect(placeholders(r.rowSql)).to.equal(r.rowArgs.length);
        expect(r.countArgs).to.deep.equal([]);
        expect(placeholders(r.countSql)).to.equal(0);
        expect(r.calls).to.equal(2);
        expect(r.total).to.equal(109812);
    });

    it('type=block: the height binds first in the row query and alone in the count', async () => {
        const r = await bind(cfg('block', '950000'));
        expect(r.rowArgs).to.deep.equal(['950000', ...IDENTITY]);
        expect(placeholders(r.rowSql)).to.equal(r.rowArgs.length);
        expect(r.countArgs).to.deep.equal(['950000']);
        expect(placeholders(r.countSql)).to.equal(1);
    });

    it('explorer cursor: the cursor binds inside the page, before every join placeholder, and once', async () => {
        const config = cfg(null, null, { transport: 'explorer' });
        config.data.sql.where.offset     = ' AND m.block_index < ?';
        config.data.sql.where.offsetArgs = [67992067];
        const r = await bind(config);
        expect(r.rowArgs).to.deep.equal([67992067, ...IDENTITY]);
        expect(placeholders(r.rowSql)).to.equal(r.rowArgs.length);
        expect(r.rowSql.indexOf('m.block_index < ?')).to.be.lessThan(r.rowSql.indexOf('LEFT JOIN'));
        expect(r.countArgs).to.deep.equal([]);
        expect(r.countSql).to.not.include('m.block_index < ?');
    });

    it('api page>1: the offset splices into the page derived table and no trailing OFFSET ? is appended', async () => {
        const config = cfg(null, null);
        config.data.sql.apiOffset = 10000;
        const r = await bind(config);
        expect(r.rowSql).to.match(/LIMIT 100 OFFSET 10000\) m/);
        expect(r.rowSql).to.not.include('OFFSET ?');
        expect(r.rowArgs).to.deep.equal(IDENTITY);
        expect(config.data.sql.apiOffset).to.equal(0);
    });

    it('api offset is clamped to the 100k ceiling and ignored on the explorer transport', async () => {
        const api = cfg(null, null);
        api.data.sql.apiOffset = 5000000;
        expect((await bind(api)).rowSql).to.include('OFFSET 100000) m');
        const explorer = cfg(null, null, { transport: 'explorer' });
        explorer.data.sql.apiOffset = 10000;
        expect((await bind(explorer)).rowSql).to.not.include('OFFSET');
    });
});

describe('getCommitments decoration and getData through runListQuery', () => {
    afterEach(() => sinon.restore());

    it('the decoration legs and their correlated subqueries sit outside the paged derived table', async () => {
        const { rowSql, countSql } = await bind(cfg(null, null));
        const pageEnd = rowSql.indexOf(') m');
        expect(rowSql.indexOf('LIMIT 100')).to.be.lessThan(pageEnd);
        expect(rowSql.indexOf('SELECT MAX')).to.be.greaterThan(pageEnd);
        expect(rowSql.indexOf('LEFT JOIN')).to.be.greaterThan(pageEnd);
        expect(countSql).to.not.match(/JOIN|SELECT MAX|\(an\.action_index/);
    });

    it('getData on /api/commitments?page=101 pages inside the derived table and counts joinless', async () => {
        const db = makeDb();
        const doQuery = sinon.stub(db, 'doQuery');
        doQuery.onFirstCall().resolves([]);
        doQuery.onSecondCall().resolves([{ total: 109812 }]);
        const [, total] = await db.getData(makeConfig({ type: 'api', data: { method: 'getCommitments', query: { page: '101' } } }));
        expect(doQuery.firstCall.args[1]).to.match(/LIMIT 100 OFFSET 10000\) m/);
        expect(doQuery.firstCall.args[1]).to.not.include('OFFSET ?');
        expect(doQuery.firstCall.args[2]).to.deep.equal(IDENTITY);
        expect(doQuery.secondCall.args[1]).to.not.match(/JOIN/);
        expect(doQuery.secondCall.args[2]).to.deep.equal([]);
        expect(total).to.equal(109812);
    });

    it('a plain string count still binds the shared base args', async () => {
        const db = makeDb();
        const config = cfg('block', '5');
        const doQuery = sinon.stub(db, 'doQuery').resolves([{ total: 1 }]);
        await runListQuery(db, config, 'SELECT ?', ['5'], 'SELECT count(*) as total WHERE ?');
        expect(doQuery.secondCall.args[2]).to.deep.equal(['5']);
    });
});
