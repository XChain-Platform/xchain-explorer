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
 * Integration tests: explorer (DataTables) endpoints
 *
 * Explorer responses follow the DataTables server-side protocol:
 *   { recordsTotal: N, recordsFiltered: N, data: [[...], [...], ...] }
 *
 * Each inner array contains fields in a fixed order determined by the method;
 * for getSends: [count_reverse, block_index, timestamp, source, tick, amount, destination, status, action_index]
 *
 * Seed data used (seed-baseline.sql):
 *   - 10 sends total involving bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa as source or destination
 *   - 4 tokens (XCHAIN, TOKENONE, TOKENTWO, TOKENTHREE)
 *   - 10 blocks
 *   - balances for bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa across multiple tickers
 */

const { expect } = require('chai');
const supertest  = require('supertest');
const db         = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

const ADDR1 = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';

let request, app, explorer, configInfo;

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();
    ({ app, explorer, configInfo } = await createApp());
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

// ---------------------------------------------------------------------------
// Sends by address
// ---------------------------------------------------------------------------

describe('GET /RBTC/explorer/sends/{address}/address', function () {

    it('returns DataTables format with recordsTotal, recordsFiltered, data', async function () {
        const res = await request
            .get(`/RBTC/explorer/sends/${ADDR1}/address`)
            .expect(200);

        expect(res.body).to.have.property('recordsTotal');
        expect(res.body).to.have.property('recordsFiltered');
        expect(res.body).to.have.property('data').that.is.an('array');
    });

    it('data rows are arrays (not objects)', async function () {
        const res = await request
            .get(`/RBTC/explorer/sends/${ADDR1}/address`)
            .expect(200);

        if (res.body.data.length > 0) {
            expect(res.body.data[0]).to.be.an('array');
        }
    });

});

// ---------------------------------------------------------------------------
// Pagination: start / length parameters
// ---------------------------------------------------------------------------

describe('Explorer pagination with start and length parameters', function () {

    it('honours length=3 and returns at most 3 rows', async function () {
        const res = await request
            .get(`/RBTC/explorer/sends/${ADDR1}/address?start=0&length=3`)
            .expect(200);

        expect(res.body.data.length).to.be.at.most(3);
    });

    it('start offset shifts the returned page', async function () {
        const resPage1 = await request
            .get(`/RBTC/explorer/sends/${ADDR1}/address?start=0&length=2`)
            .expect(200);

        const resPage2 = await request
            .get(`/RBTC/explorer/sends/${ADDR1}/address?start=2&length=2`)
            .expect(200);

        // If there are enough rows, the two pages should differ
        const total = Number(resPage1.body.recordsTotal);
        if (total > 2 && resPage2.body.data.length > 0) {
            const firstRowPage1 = resPage1.body.data[0];
            const firstRowPage2 = resPage2.body.data[0];
            expect(firstRowPage1).to.not.deep.equal(firstRowPage2);
        }
    });

});

// ---------------------------------------------------------------------------
// Balances by address
// ---------------------------------------------------------------------------

describe('GET /RBTC/explorer/balances/{address}/address', function () {

    it('returns DataTables format with balance rows as arrays', async function () {
        const res = await request
            .get(`/RBTC/explorer/balances/${ADDR1}/address`)
            .expect(200);

        expect(res.body).to.have.property('recordsTotal');
        expect(res.body).to.have.property('recordsFiltered');
        expect(res.body).to.have.property('data').that.is.an('array');
    });

    it('balance row format is [count, tick, amount, percent, value, null]', async function () {
        const res = await request
            .get(`/RBTC/explorer/balances/${ADDR1}/address`)
            .expect(200);

        expect(Number(res.body.recordsTotal)).to.be.at.least(1);
        const row = res.body.data[0];
        expect(row).to.be.an('array');
        // 6 elements: count, tick, amount, percent, value, null
        expect(row.length).to.equal(6);
        // last element is always null
        expect(row[5]).to.be.null;
    });

});

// ---------------------------------------------------------------------------
// Tokens list
// ---------------------------------------------------------------------------

describe('GET /RBTC/explorer/tokens (token list)', function () {

    it('returns recordsTotal >= 2 (seed has tokens issued in block 1)', async function () {
        const res = await request
            .get('/RBTC/explorer/tokens/1/block')
            .expect(200);

        expect(res.body).to.have.property('recordsTotal');
        expect(res.body).to.have.property('data').that.is.an('array');
        expect(Number(res.body.recordsTotal)).to.be.at.least(2);
    });

    it('token rows are arrays with tick as 4th element (index 3)', async function () {
        const res = await request
            .get('/RBTC/explorer/tokens/TOKEN/token')
            .expect(200);

        if (res.body.data.length > 0) {
            const row = res.body.data[0];
            expect(row).to.be.an('array');
            // format: [count_reverse, block_index, timestamp, tick, supply, max_supply, max_mint, locks, id]
            expect(row[3]).to.be.a('string');
        }
    });

});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

describe('GET /RBTC/explorer/blocks/all', function () {

    it('returns block list in DataTables format', async function () {
        const res = await request
            .get('/RBTC/explorer/blocks/all')
            .expect(200);

        expect(res.body).to.have.property('recordsTotal');
        expect(res.body).to.have.property('data').that.is.an('array');
        expect(Number(res.body.recordsTotal)).to.be.at.least(10);
    });

    it('block rows are arrays with [block_index, timestamp, actions, block_index]', async function () {
        const res = await request
            .get('/RBTC/explorer/blocks/all')
            .expect(200);

        if (res.body.data.length > 0) {
            const row = res.body.data[0];
            expect(row).to.be.an('array');
            // format: [block_index, timestamp, actions_string, block_index]
            expect(row.length).to.equal(4);
            // first and last elements are the same block_index
            expect(row[0]).to.equal(row[3]);
            // actions is a pipe-delimited string
            expect(row[2]).to.be.a('string');
        }
    });

});

// ---------------------------------------------------------------------------
// Sends by token
// ---------------------------------------------------------------------------

describe('GET /RBTC/explorer/sends/XCHAIN/token', function () {

    it('returns sends filtered to the XCHAIN token', async function () {
        const res = await request
            .get('/RBTC/explorer/sends/XCHAIN/token')
            .expect(200);

        expect(res.body).to.have.property('recordsTotal');
        expect(res.body).to.have.property('data').that.is.an('array');
        // seed has multiple XCHAIN sends
        expect(Number(res.body.recordsTotal)).to.be.at.least(1);
    });

    it('every returned send row references XCHAIN (tick at index 4)', async function () {
        const res = await request
            .get('/RBTC/explorer/sends/XCHAIN/token')
            .expect(200);

        for (const row of res.body.data) {
            // format: [count_reverse, block_index, timestamp, source, tick, amount, destination, status, action_index]
            expect(row[4]).to.equal('XCHAIN');
        }
    });

});
