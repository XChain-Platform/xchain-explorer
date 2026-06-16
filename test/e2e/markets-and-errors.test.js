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
 * E2E tests — Market Value Verification & Advanced Error Handling
 *
 * Validates that market endpoints return exact seeded price/volume data,
 * market history is correctly ordered, SQL injection is prevented, and
 * the explorer handles an empty database gracefully.
 *
 * Covers: E2E-09, E2E-11, E2E-13, E2E-31, E2E-34
 */

'use strict';

const { expect }    = require('chai');
const supertest     = require('supertest');
const db            = require('./helpers/db-setup');
const { createApp } = require('../integration/helpers/app-setup');

let request;

before(async function () {
    this.timeout(30000);
    await db.setupE2EDatabase();
    const { app } = await createApp();
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.teardownE2EDatabase();
});

// ===========================================================================
// E2E-09 — Market detail returns exact seeded prices
// ===========================================================================

describe('E2E-09: Market detail value verification', function () {

    it('XCHAIN/TOKENONE pair returns seeded price data', async function () {
        const res = await request.get('/RBTC/api/market/XCHAIN/TOKENONE');
        expect(res.status).to.equal(200);

        // Seeded values from seed-baseline.sql markets row 1
        expect(res.body.tick1).to.equal('XCHAIN');
        expect(res.body.tick2).to.equal('TOKENONE');
        expect(res.body.tick1_price).to.equal('2.00000000');
        expect(res.body.tick1_bid).to.equal('1.95000000');
        expect(res.body.tick1_ask).to.equal('2.05000000');
    });

    it('XCHAIN/TOKENTWO pair returns seeded price data', async function () {
        const res = await request.get('/RBTC/api/market/XCHAIN/TOKENTWO');
        expect(res.status).to.equal(200);

        expect(res.body.tick1).to.equal('XCHAIN');
        expect(res.body.tick2).to.equal('TOKENTWO');
        expect(res.body.tick1_price).to.equal('5.00000000');
        expect(res.body.tick1_bid).to.equal('4.90000000');
        expect(res.body.tick1_ask).to.equal('5.10000000');
    });

    it('24hr fields are present with seeded values', async function () {
        const res = await request.get('/RBTC/api/market/XCHAIN/TOKENONE');
        expect(res.status).to.equal(200);

        expect(res.body.tick1_24hr_high).to.equal('2.10000000');
        expect(res.body.tick1_24hr_low).to.equal('1.90000000');
        expect(res.body.tick1_24hr_volume).to.equal('5000.00000000');
    });
});

// ===========================================================================
// E2E-11 — Market history endpoint
// ===========================================================================

describe('E2E-11: Market history returns ordered trade data', function () {

    it('returns at least one history entry for XCHAIN/TOKENONE', async function () {
        const res = await request.get('/RBTC/api/market/XCHAIN/TOKENONE/history');
        expect(res.status).to.equal(200);

        expect(res.body).to.have.property('total');
        expect(res.body).to.have.property('data').that.is.an('array');
        expect(Number(res.body.total)).to.be.at.least(1);
    });

    it('history entries have required fields', async function () {
        const res = await request.get('/RBTC/api/market/XCHAIN/TOKENONE/history');
        expect(res.status).to.equal(200);

        if (res.body.data.length > 0) {
            const entry = res.body.data[0];
            // getMarketHistory transforms results into: type, price, amount, action_index, block_index, timestamp
            expect(entry).to.have.property('type');
            expect(entry).to.have.property('price');
            expect(entry).to.have.property('amount');
            expect(entry).to.have.property('block_index');
            expect(entry).to.have.property('timestamp');
        }
    });

    it('history entries are in descending block_index order', async function () {
        const res = await request.get('/RBTC/api/market/XCHAIN/TOKENONE/history');
        expect(res.status).to.equal(200);

        const data = res.body.data;
        if (data.length >= 2) {
            for (let i = 0; i < data.length - 1; i++) {
                expect(Number(data[i].block_index)).to.be.at.least(Number(data[i + 1].block_index));
            }
        }
    });
});

// ===========================================================================
// E2E-13 — Filtered market listing
// ===========================================================================

describe('E2E-13: Filtered market listing returns correct count', function () {

    it('XCHAIN filter returns exactly 2 pairs', async function () {
        const res = await request.get('/RBTC/api/markets/XCHAIN');
        expect(res.status).to.equal(200);

        expect(res.body).to.have.property('data').that.is.an('array');
        expect(Number(res.body.total)).to.equal(2);
        expect(res.body.data).to.have.lengthOf(2);

        // Both pairs should involve XCHAIN
        for (const market of res.body.data) {
            const hasTick = market.tick1 === 'XCHAIN' || market.tick2 === 'XCHAIN';
            expect(hasTick).to.equal(true, `Market ${market.tick1}/${market.tick2} should involve XCHAIN`);
        }
    });

    it('TOKENONE filter returns only markets involving TOKENONE', async function () {
        const res = await request.get('/RBTC/api/markets/TOKENONE');
        expect(res.status).to.equal(200);

        expect(Number(res.body.total)).to.equal(1);
        const market = res.body.data[0];
        const hasTick = market.tick1 === 'TOKENONE' || market.tick2 === 'TOKENONE';
        expect(hasTick).to.equal(true);
    });
});

// ===========================================================================
// E2E-31 — SQL Injection Prevention
// ===========================================================================

describe('E2E-31: SQL injection is prevented', function () {

    it('injection in token query does not cause 500', async function () {
        const res = await request.get("/RBTC/api/token/' OR '1'='1");
        // Should be 400 (not found) or 200 (empty) — never 500
        expect(res.status).to.not.equal(500);
    });

    it('injection in sends query does not cause 500', async function () {
        const res = await request.get("/RBTC/api/sends/'; DROP TABLE sends; --/token");
        expect(res.status).to.not.equal(500);
    });

    it('database is intact after injection attempts', async function () {
        // Verify XCHAIN token is still accessible
        const res = await request.get('/RBTC/api/token/XCHAIN');
        expect(res.status).to.equal(200);
        expect(res.body.info.tick).to.equal('XCHAIN');
    });
});

// ===========================================================================
// E2E-34 — Empty Database Handling
// ===========================================================================

describe('E2E-34: Empty database returns graceful responses', function () {

    before(async function () {
        this.timeout(10000);
        await db.truncateAll();
    });

    after(async function () {
        this.timeout(30000);
        // Re-seed baseline + E2E data for any subsequent test files
        const fs   = require('fs');
        const path = require('path');
        await db.importSchema();
        await db.seed();
        const e2eSql = fs.readFileSync(path.join(__dirname, 'fixtures/seed-e2e.sql'), 'utf8');
        await db.query(e2eSql);
    });

    it('status endpoint returns 200 on empty DB', async function () {
        const res = await request.get('/RBTC/api/status');
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
    });

    it('sends endpoint returns empty array on empty DB', async function () {
        const res = await request.get('/RBTC/api/sends/1/block');
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
        expect(Number(res.body.total)).to.equal(0);
    });

    it('token query returns error on empty DB', async function () {
        const res = await request.get('/RBTC/api/token/ANYTICK');
        // No token data → 400
        expect(res.status).to.equal(400);
    });

    it('markets endpoint returns empty on empty DB', async function () {
        const res = await request.get('/RBTC/api/markets');
        expect(res.status).to.equal(200);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });
});
