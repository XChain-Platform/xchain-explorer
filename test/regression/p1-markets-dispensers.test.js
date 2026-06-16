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
 * P1 Regression Tests — Markets, Dispensers, Pagination
 *
 * Covers market pair queries, dispenser endpoints, order endpoints,
 * BigNumber accuracy, and pagination correctness.
 *
 * Requires: MariaDB on port 3307 (npm run test:integration:up)
 * Run: mocha test/regression/p1-markets-dispensers.test.js --timeout 30000
 */

'use strict';

const { expect } = require('chai');
const supertest  = require('supertest');
const db         = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

// ---------------------------------------------------------------------------
// Seed reference
// ---------------------------------------------------------------------------

const ADDR1 = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';

let request;

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();
    const { app } = await createApp();
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

// ===========================================================================
// @p1 @market Markets — list all pairs
// ===========================================================================

describe('@p1 @market Markets list regression', function () {

    it('GET /RBTC/api/markets — lists all market pairs', async function () {
        const res = await request.get('/RBTC/api/markets').expect(200);
        expect(res.body).to.have.property('total');
        expect(res.body).to.have.property('data').that.is.an('array');
        expect(Number(res.body.total)).to.be.at.least(2);
    });

    it('each market item has required fields', async function () {
        const res = await request.get('/RBTC/api/markets').expect(200);
        const item = res.body.data[0];
        expect(item).to.include.keys('tick1', 'tick2', 'tick1_price', 'tick2_price', 'id');
    });
});

// ===========================================================================
// @p1 @market Markets — filter by token
// ===========================================================================

describe('@p1 @market Markets filter by token regression', function () {

    it('GET /RBTC/api/markets/XCHAIN — returns both pairs', async function () {
        const res = await request.get('/RBTC/api/markets/XCHAIN').expect(200);
        expect(res.body.data.length).to.be.at.least(2);
    });
});

// ===========================================================================
// @p1 @market Market — specific pair
// ===========================================================================

describe('@p1 @market Market specific pair regression', function () {

    it('GET /RBTC/api/market/XCHAIN/TOKENONE — returns market data object', async function () {
        const res = await request.get('/RBTC/api/market/XCHAIN/TOKENONE').expect(200);
        expect(res.body).to.be.an('object').and.not.an('array');
        expect(res.body).to.include.keys('tick1', 'tick2', 'tick1_price', 'id');
    });

    it('nonexistent market pair returns error or empty', async function () {
        const res = await request.get('/RBTC/api/market/FAKE/PAIR');
        if (res.status === 200) {
            const body = res.body;
            if (Array.isArray(body)) {
                expect(body.length).to.equal(0);
            } else if (body && body.data) {
                expect(body.data.length).to.equal(0);
            }
        } else {
            expect(res.status).to.be.oneOf([400, 404]);
        }
    });
});

// ===========================================================================
// @p1 @market Market — orders and orderbook
// ===========================================================================

describe('@p1 @market Market orders and orderbook regression', function () {

    it('GET /RBTC/api/market/XCHAIN/TOKENONE/orders — returns orders wrapper', async function () {
        const res = await request.get('/RBTC/api/market/XCHAIN/TOKENONE/orders').expect(200);
        expect(res.body).to.have.property('total');
        expect(res.body).to.have.property('data').that.is.an('array');
    });

    it('GET /RBTC/api/market/XCHAIN/TOKENONE/orderbook — returns bids and asks', async function () {
        const res = await request.get('/RBTC/api/market/XCHAIN/TOKENONE/orderbook').expect(200);
        expect(res.body).to.have.property('bids').that.is.an('array');
        expect(res.body).to.have.property('asks').that.is.an('array');
    });
});

// ===========================================================================
// @p1 @action Orders
// ===========================================================================

describe('@p1 @action Orders API regression', function () {

    it('GET /RBTC/api/orders/{block}/block — returns orders in block', async function () {
        const res = await request.get('/RBTC/api/orders/4/block');
        expect(res.status).to.equal(200);
        // Block 4 has action_index 7 (ORDER), 8 (ORDER), 22 (ORDER)
        expect(Number(res.body.total)).to.equal(3);
        expect(res.body.data).to.be.an('array').with.lengthOf(3);
    });
});

// ===========================================================================
// @p1 @action Dispensers
// ===========================================================================

describe('@p1 @action Dispensers API regression', function () {

    it('GET /RBTC/api/dispensers/{block}/block — returns dispensers in block', async function () {
        const res = await request.get('/RBTC/api/dispensers/6/block');
        expect(res.status).to.equal(200);
        // Block 6: action_index 11, 12, 25 (all dispensers)
        expect(Number(res.body.total)).to.equal(3);
    });
});

// ===========================================================================
// @p1 @action Dispenses
// ===========================================================================

describe('@p1 @action Dispenses API regression', function () {

    it('GET /RBTC/api/dispenses/{block}/block — returns dispenses in block', async function () {
        const res = await request.get('/RBTC/api/dispenses/6/block');
        expect(res.status).to.equal(200);
        // Block 6: action_index 25, 26
        expect(Number(res.body.total)).to.equal(2);
    });
});

// ===========================================================================
// @p1 @action Issues
// ===========================================================================

describe('@p1 @action Issues API regression', function () {

    it('GET /RBTC/api/issues/{block}/block — returns issues in block', async function () {
        const res = await request.get('/RBTC/api/issues/1/block');
        expect(res.status).to.equal(200);
        // Block 1: action_index 1 (ISSUE), 2 (ISSUE)
        expect(Number(res.body.total)).to.equal(2);
    });
});

// ===========================================================================
// @p1 @action Mints
// ===========================================================================

describe('@p1 @action Mints API regression', function () {

    it('GET /RBTC/api/mints/{block}/block — returns mints in block', async function () {
        const res = await request.get('/RBTC/api/mints/9/block');
        expect(res.status).to.equal(200);
        // Block 9: action_index 18 (MINT)
        expect(Number(res.body.total)).to.equal(1);
    });
});

// ===========================================================================
// @p1 @action Destroys
// ===========================================================================

describe('@p1 @action Destroys API regression', function () {

    it('GET /RBTC/api/destroys/{block}/block — returns destroys in block', async function () {
        const res = await request.get('/RBTC/api/destroys/10/block');
        expect(res.status).to.equal(200);
        // Block 10: action_index 20 (DESTROY)
        expect(Number(res.body.total)).to.equal(1);
    });
});

// ===========================================================================
// @p1 @action Broadcasts
// ===========================================================================

describe('@p1 @action Broadcasts API regression', function () {

    it('GET /RBTC/api/broadcasts/{block}/block — returns broadcasts in block', async function () {
        const res = await request.get('/RBTC/api/broadcasts/10/block');
        expect(res.status).to.equal(200);
        // Block 10: action_index 30 (BROADCAST)
        expect(Number(res.body.total)).to.equal(1);
    });
});

// ===========================================================================
// @p1 @pagination Pagination correctness
// ===========================================================================

describe('@p1 @pagination Pagination regression', function () {

    it('paginated results cover the full result set without gaps', async function () {
        // Get all sends for ADDR1 (total = 7) in pages of 3
        const all = [];
        for (let page = 1; page <= 3; page++) {
            const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3&page=${page}`);
            expect(res.status).to.equal(200);
            all.push(...res.body.data.map(r => Number(r.action_index)));
        }
        // Should have 7 unique action_indexes (7 total sends for ADDR1)
        const unique = [...new Set(all)];
        expect(unique.length).to.equal(7);
    });

    it('total count is consistent across pages', async function () {
        const page1 = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3&page=1`);
        const page2 = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=3&page=2`);
        expect(Number(page1.body.total)).to.equal(Number(page2.body.total));
    });
});

// ===========================================================================
// @p1 @precision BigNumber precision
// ===========================================================================

describe('@p1 @precision BigNumber amount precision regression', function () {

    it('balance amounts preserve 8 decimal places', async function () {
        const res = await request.get(`/RBTC/api/balances/${ADDR1}`);
        expect(res.status).to.equal(200);
        for (const row of res.body.data) {
            expect(row.amount).to.match(/^\d+\.\d{8}$/);
        }
    });

    it('send amounts are strings not numbers', async function () {
        const res = await request.get('/RBTC/api/sends/XCHAIN/token');
        expect(res.status).to.equal(200);
        for (const row of res.body.data) {
            expect(row.amount).to.be.a('string');
        }
    });

    it('token supply values are strings', async function () {
        const res = await request.get('/RBTC/api/token/XCHAIN');
        expect(res.status).to.equal(200);
        expect(res.body.supply.current).to.be.a('string');
        expect(res.body.supply.max).to.be.a('string');
    });
});

// ===========================================================================
// @p1 @error Error responses
// ===========================================================================

describe('@p1 @error Error response regression', function () {

    it('invalid coin prefix returns appropriate error', async function () {
        const res = await request.get('/INVALID/api/sends/1/block');
        // Invalid coin should not crash the server
        expect(res.status).to.be.a('number');
        expect(res.status).to.not.equal(500);
    });

    it('malformed block index does not crash', async function () {
        const res = await request.get('/RBTC/api/sends/not-a-number/block');
        expect(res.status).to.be.a('number');
        expect(res.status).to.not.equal(500);
    });
});
