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
 * Unit tests for db.js#getHistoryData's M1.6 addition (spec
 * explorer-coverage-completion): a correlated scalar subquery in
 * the LIST query's select list that derives BATCH parenthood (the indexer
 * stores no parent column; parent and children share (tx_index, tx_vout) on
 * `actions`, and the parent is whichever of those rows is also present in
 * `batches`).
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

function makeDb() {
    return new Database(mockExplorer);
}

const WHERE_DATA = 'm.action_index IS NOT NULL';

function makeHistoryConfig(type, search, extras = {}) {
    return makeConfig({
        data: {
            method: 'getHistory',
            search,
            type,
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: WHERE_DATA, offset: '' }
            },
            query: { total: null },
            ...extras
        }
    });
}

describe('db.getHistoryData: parent_batch_action_index (M1.6)', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    it('the LIST query carries the correlated subquery, aliased parent_batch_action_index', async () => {
        let listQuery = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && q.includes('count(DISTINCT')) return [{ count: 1 }];
            listQuery = q;
            return [];
        });
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);
        const config = makeHistoryConfig('block', '500');
        await db.getHistoryData(config);
        expect(listQuery).to.not.equal(null);
        expect(listQuery).to.include('parent_batch_action_index');
        // Correlated scalar subquery, not a FROM-clause join: batches only ever
        // appears inside the subquery's own FROM, never joined onto the outer
        // mappings_actions/actions/blocks chain (a join that multi-matches would
        // re-materialize duplicates past the outer SELECT DISTINCT).
        expect(listQuery).to.match(/\(\s*SELECT\s+\w+\.action_index\s+FROM\s+actions\s+\w+\s+INNER JOIN batches/);
        // The parent-exclusion predicate: a batch's own row must not match itself.
        expect(listQuery).to.match(/action_index\s*!=\s*a1\.action_index/);
        // Correlated on the OUTER row's own (tx_index, tx_vout), not a constant.
        expect(listQuery).to.match(/tx_index\s*=\s*a1\.tx_index/);
        expect(listQuery).to.match(/tx_vout\s*=\s*a1\.tx_vout/);
    });

    it('the COUNT query does NOT carry the subquery (spec: LIST query only)', async () => {
        let countQuery = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && q.includes('count(DISTINCT')){ countQuery = q; return [{ count: 0 }]; }
            return [];
        });
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);
        const config = makeHistoryConfig('block', '500');
        await db.getHistoryData(config);
        expect(countQuery).to.not.equal(null);
        expect(countQuery).to.not.include('parent_batch_action_index');
        expect(countQuery).to.not.include('batches');
    });

    it('a BATCH child row carries the parent action_index; the parent BATCH row itself carries null', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && q.includes('count(DISTINCT'))
                return [{ count: 2 }];
            // Simulates what MariaDB would hand back for one BATCH (action_index 10)
            // and one of its children (action_index 11), sharing a (tx_index, tx_vout)
            // the subquery resolved against `batches`.
            return [
                { action_index: 10, action: 'BATCH', block_index: 500, timestamp: 1700000000, tx_hash: 'h1', tx_index: 1, parent_batch_action_index: null },
                { action_index: 11, action: 'SEND',  block_index: 500, timestamp: 1700000000, tx_hash: 'h1', tx_index: 1, parent_batch_action_index: 10 }
            ];
        });
        // Exercise the REAL getActionSummaryData (mutate-in-place), not a stub, to
        // confirm the column survives it: getActionSummaryData only ever ADDS
        // .status/.details onto each row, never rebuilds the row object.
        sinon.stub(db, '_buildActionPreload').resolves(null);
        sinon.stub(db, 'getActionData').resolves({ action: 'BATCH', status: 'valid' });
        const config = makeHistoryConfig('block', '500');
        const [data] = await db.getHistoryData(config);
        expect(data).to.have.lengthOf(2);
        const parent = data.find((r) => Number(r.action_index) === 10);
        const child  = data.find((r) => Number(r.action_index) === 11);
        expect(parent.parent_batch_action_index).to.equal(null);
        expect(child.parent_batch_action_index).to.equal(10);
        // Confirms the field rode through getActionSummaryData's mutate-in-place
        // pass alongside the fields it does add.
        expect(child).to.have.property('status');
    });

    it('a non-batch row carries null for parent_batch_action_index', async () => {
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(q && q.includes('count(DISTINCT')) return [{ count: 1 }];
            return [
                { action_index: 20, action: 'SEND', block_index: 500, timestamp: 1700000000, tx_hash: 'h2', tx_index: 2, parent_batch_action_index: null }
            ];
        });
        sinon.stub(db, 'getActionSummaryData').callsFake(async (c, a) => a);
        const config = makeHistoryConfig('block', '500');
        const [data] = await db.getHistoryData(config);
        expect(data[0].parent_batch_action_index).to.equal(null);
    });
});
