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
 * Integration tests: REST API action endpoints (sends)
 *
 * Boots a real Express app against a test MariaDB on port 3307.
 * Uses the baseline seed fixture which includes 10 sends across multiple
 * addresses, tickers, and blocks.
 *
 * Run: npm run test:integration  (or: mocha --timeout 0 test/integration/api-actions.test.js)
 */

'use strict';

const { expect } = require('chai');
const supertest  = require('supertest');
const db         = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let request;
let app, explorer, configInfo;

// ---------------------------------------------------------------------------
// Seed reference constants
// ---------------------------------------------------------------------------

const ADDR1 = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR2 = 'bc1qaddr2bbbbbbbbbbbbbbbbbbbbbbbbbbb';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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

// ===========================================================================
// API Action Endpoints: Sends
// ===========================================================================

describe('API Action Endpoints: Sends', function () {

    // -----------------------------------------------------------------------
    // 1. Block query
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/sends/{block}/block: returns sends in a specific block', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(2);
        expect(res.body.data).to.be.an('array').with.lengthOf(2);

        // Default sort is DESC by action_index -> [10, 9]
        expect(Number(res.body.data[0].action_index)).to.equal(10);
        expect(Number(res.body.data[1].action_index)).to.equal(9);
    });

    // -----------------------------------------------------------------------
    // 2. Address query (source or destination)
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/sends/{address}/address: returns sends by address (source or dest)', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address`);

        expect(res.status).to.equal(200);
        // addr1 is source on 3,6,9,16,19 and dest on 4,15 -> 7 total
        expect(Number(res.body.total)).to.equal(7);
        expect(res.body.data).to.be.an('array').with.lengthOf(7);

        // Verify descending order: each item has a lower action_index than the one before it
        expect(Number(res.body.data[0].action_index)).to.be.greaterThan(Number(res.body.data[1].action_index));
    });

    // -----------------------------------------------------------------------
    // 3. Token query
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/sends/{tick}/token: filters by token', async function () {
        const res = await request.get('/RBTC/api/sends/XCHAIN/token');

        expect(res.status).to.equal(200);
        // XCHAIN sends: action_indexes 3, 5, 9, 16, 19 -> 5 total
        expect(Number(res.body.total)).to.equal(5);
        expect(res.body.data).to.be.an('array').with.lengthOf(5);

        // Every returned row should be for the XCHAIN tick
        for (const row of res.body.data) {
            expect(row.tick).to.equal('XCHAIN');
        }
    });

    // -----------------------------------------------------------------------
    // 4. Source-only query
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/sends/{address}/source: filters by source only', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/source`);

        expect(res.status).to.equal(200);
        // addr1 as source: 3, 6, 9, 16, 19 -> 5 total
        expect(Number(res.body.total)).to.equal(5);
        expect(res.body.data).to.be.an('array').with.lengthOf(5);

        // Every returned row should have addr1 as the source
        for (const row of res.body.data) {
            expect(row.source).to.equal(ADDR1);
        }
    });

    // -----------------------------------------------------------------------
    // 5. Destination-only query
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/sends/{address}/destination: filters by destination only', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR2}/destination`);

        expect(res.status).to.equal(200);
        // addr2 as destination: 3, 10, 19 -> 3 total
        expect(Number(res.body.total)).to.equal(3);
        expect(res.body.data).to.be.an('array').with.lengthOf(3);

        // Every returned row should have addr2 as the destination
        for (const row of res.body.data) {
            expect(row.destination).to.equal(ADDR2);
        }
    });

    // -----------------------------------------------------------------------
    // 6. sortorder=ASC reverses default order
    // -----------------------------------------------------------------------

    it('sortorder=ASC reverses order', async function () {
        const res = await request.get('/RBTC/api/sends/5/block?sortorder=ASC');

        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.lengthOf(2);

        // ASC: first item has a lower action_index than the second
        expect(Number(res.body.data[0].action_index)).to.be.lessThan(Number(res.body.data[1].action_index));
    });

    // -----------------------------------------------------------------------
    // 7. limit parameter caps results
    // -----------------------------------------------------------------------

    it('limit parameter caps results', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=2`);

        expect(res.status).to.equal(200);
        // Total should still reflect the full count, but data is capped
        expect(Number(res.body.total)).to.equal(7);
        expect(res.body.data).to.be.an('array').with.lengthOf(2);
    });

    // -----------------------------------------------------------------------
    // 8. page parameter returns the correct page
    // -----------------------------------------------------------------------

    it('page parameter returns correct page', async function () {
        const page1 = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=2&page=1`);
        const page2 = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=2&page=2`);

        expect(page1.status).to.equal(200);
        expect(page2.status).to.equal(200);

        expect(page1.body.data).to.be.an('array').with.lengthOf(2);
        expect(page2.body.data).to.be.an('array').with.lengthOf(2);

        // Pages must not overlap: collect all action_indexes across both pages
        const page1Indexes = page1.body.data.map(r => r.action_index);
        const page2Indexes = page2.body.data.map(r => r.action_index);
        const overlap = page1Indexes.filter(i => page2Indexes.includes(i));
        expect(overlap).to.be.empty;
    });

    // -----------------------------------------------------------------------
    // 9. total count is accurate
    // -----------------------------------------------------------------------

    it('total count is accurate', async function () {
        const res = await request.get('/RBTC/api/sends/2/block');

        expect(res.status).to.equal(200);
        // Block 2 sends: action_indexes 3, 4 -> total = 2
        expect(Number(res.body.total)).to.equal(2);
        expect(res.body.data).to.be.an('array').with.lengthOf(2);
    });

    // -----------------------------------------------------------------------
    // 10. No matching results returns empty collection
    // -----------------------------------------------------------------------

    it('no matching results returns empty', async function () {
        const res = await request.get('/RBTC/api/sends/NONEXISTENT/token');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(0);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });

    // -----------------------------------------------------------------------
    // 11. Response fields have correct structure
    // -----------------------------------------------------------------------

    it('response fields have correct structure', async function () {
        const res = await request.get('/RBTC/api/sends/XCHAIN/token');

        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);

        const row = res.body.data[0];
        const expectedFields = [
            'action',
            'action_format',
            'action_index',
            'amount',
            'block_index',
            'destination',
            'memo',
            'source',
            'status',
            'tick',
            'timestamp',
            'tx_hash',
            'tx_index',
        ];

        for (const field of expectedFields) {
            expect(row).to.have.property(field);
        }
    });

    // -----------------------------------------------------------------------
    // 12. Response properties are alphabetically sorted
    // -----------------------------------------------------------------------

    it('response properties are alphabetically sorted', async function () {
        const res = await request.get('/RBTC/api/sends/XCHAIN/token');

        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);

        // Top-level body: all keys except the trailing `runtime` must be sorted
        const bodyKeys       = Object.keys(res.body);
        const withoutRuntime = bodyKeys.filter(k => k !== 'runtime');
        expect(withoutRuntime).to.deep.equal([...withoutRuntime].sort());
        // `runtime` is always appended last
        expect(bodyKeys[bodyKeys.length - 1]).to.equal('runtime');

        // Each data item must have fully sorted keys
        for (const row of res.body.data) {
            const rowKeys = Object.keys(row);
            expect(rowKeys).to.deep.equal([...rowKeys].sort());
        }
    });

});
