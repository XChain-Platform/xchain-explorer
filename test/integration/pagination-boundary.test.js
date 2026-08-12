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
 * Integration tests: Pagination boundary conditions
 *
 * Exercises the limit/page/sortorder parameters and verifies boundary
 * behaviour: default limit, explicit limit, no-overlap between pages,
 * empty page beyond results, balances ASC sort, and holders DESC sort.
 *
 * Run: npm run test:integration  (or: mocha --timeout 0 test/integration/pagination-boundary.test.js)
 */

'use strict';

const { expect } = require('chai');
const supertest  = require('supertest');
const db         = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

let request;
let app, explorer, configInfo;

// Seed address with 7 sends (source or destination)
const ADDR1 = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';

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

describe('Pagination Boundary Conditions', function () {

    it('default limit is 100: all seeded sends are returned', async function () {
        // Seed has 7 sends for addr1; default limit is 100 so all should come back
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address`);

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('total', 7);
        expect(res.body.data).to.be.an('array');
        expect(res.body.data.length).to.be.at.most(100);
        expect(res.body.data.length).to.equal(7);
    });

    it('limit=3 returns exactly 3 rows', async function () {
        // addr1 has 7 sends; limit=3 should return only 3
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3`);

        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.lengthOf(3);
        // Total should still reflect the full count
        expect(res.body).to.have.property('total', 7);
    });

    it('page 1 and page 2 have no overlap', async function () {
        const page1 = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3&page=1`);
        const page2 = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3&page=2`);

        expect(page1.status).to.equal(200);
        expect(page2.status).to.equal(200);

        expect(page1.body.data).to.be.an('array').with.lengthOf(3);
        expect(page2.body.data).to.be.an('array').with.lengthOf(3);

        const page1Indexes = page1.body.data.map(r => r.action_index);
        const page2Indexes = page2.body.data.map(r => r.action_index);
        const overlap = page1Indexes.filter(i => page2Indexes.includes(i));
        expect(overlap).to.be.empty;
    });

    it('page beyond results returns empty data with correct total', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?page=999&limit=10`);

        expect(res.status).to.equal(200);
        // Total still reflects the real record count
        expect(res.body).to.have.property('total', 7);
        // But data is empty because there are no records on page 999
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });

    it('balances default sort is ASC by tick', async function () {
        // addr1 has balances for TOKENONE, TOKENTWO, and XCHAIN
        // ASC alphabetical order: TOKENONE < TOKENTWO < XCHAIN
        const res = await request.get(`/RBTC/api/balances/${ADDR1}`);

        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(1);

        const ticks = res.body.data.map(r => r.tick);
        const sortedTicks = [...ticks].sort();
        expect(ticks).to.deep.equal(sortedTicks);
    });

    it('getHolders sorts by amount DESC: first holder has largest amount', async function () {
        // XCHAIN balances from seed: addr1=500000, addr2=200000, addr3=100000
        const res = await request.get('/RBTC/api/holders/XCHAIN');

        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(1);

        // Parse amounts as numbers for comparison (they are stored as decimal strings)
        const amounts = res.body.data.map(r => parseFloat(r.amount));
        for (let i = 0; i < amounts.length - 1; i++) {
            expect(amounts[i]).to.be.at.least(amounts[i + 1]);
        }
    });

});
