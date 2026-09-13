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
 * getActionData has no not-found return of its own: when
 * getActionType finds no `actions` row for the requested index, getActionData
 * still falls through to a truthy all-null baseline object ({credits, debits,
 * escrows, fee: null}), and getAction wrapped that as [data] - a 200 with a
 * body of nulls, where getBlock and getCheckpoint answer a missing index with
 * the 404 convention [null]. A bug report misread that 200-with-nulls, observed
 * under five rapid reads, as a rate limit; it was this branch, not a limiter.
 *
 * getAction now resolves the type itself before deferring to getActionData,
 * and matches the getBlock/getCheckpoint not-found convention.
 */

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const Database = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

// A Database whose doQuery answers the getActionType lookup (the one query
// getAction's own guard issues) by substring match on the shipped SQL, same
// harness shape as action-detail-deploy-resolution.test.js.
function makeDb(typeRows) {
    const db = new Database(mockExplorer);
    db.calls = [];
    db.doQuery = async (config, sql, args) => {
        db.calls.push({ sql: String(sql), args: args || [] });
        if (String(sql).includes('FROM') && String(sql).includes('actions a1'))
            return typeRows;
        return [];
    };
    return db;
}

const config = { coin: 'BTC', data: { search: 42 } };

describe('getAction: unknown index answers 404, not 200-with-nulls', function () {

    it('an unknown index resolves [null], the getBlock/getCheckpoint not-found shape', async function () {
        const db = makeDb([]); // getActionType's query finds no `actions` row
        const result = await db.getAction(config);
        expect(result).to.deep.equal([null]);
    });

    it('[REGRESSION] the not-found path never reaches getActionData', async function () {
        const db = makeDb([]);
        let called = false;
        db.getActionData = async () => { called = true; return {}; };
        await db.getAction(config);
        expect(called).to.equal(false,
            'a not-found answer must take the cheap path, not the full detail fan-out');
    });

    it('a known index still proceeds to getActionData and returns its row', async function () {
        const db = makeDb([{ action: 'SEND' }]); // getActionType finds a row
        let calledWith = null;
        db.getActionData = async (cfg, action_index) => {
            calledWith = action_index;
            return { action: 'SEND', action_index: 42, credits: null, debits: null, escrows: null, fee: null };
        };
        const result = await db.getAction(config);
        expect(calledWith).to.equal(42);
        expect(result[0]).to.be.an('object');
        expect(result[0]).to.have.property('action_index', 42);
    });
});
