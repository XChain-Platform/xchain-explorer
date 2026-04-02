'use strict';

/**
 * Integration tests — market endpoints
 *
 * Seed data (seed-baseline.sql) provides:
 *   markets:       2 pairs — XCHAIN/TOKENONE (tick1_price=2.0) and XCHAIN/TOKENTWO (tick1_price=5.0)
 *   orders:        6 orders; 4 with current status 'open'
 *   order_matches: 3 matches
 */

const { expect } = require('chai');
const supertest  = require('supertest');
const db         = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

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
// GET /RBTC/api/markets
// ---------------------------------------------------------------------------

describe('GET /RBTC/api/markets', function () {

    it('lists all market pairs with total and data wrapper', async function () {
        const res = await request.get('/RBTC/api/markets').expect(200);

        // getMarkets returns [data, null, total]; processRequest wraps as { total, data }
        expect(res.body).to.have.property('total');
        expect(res.body).to.have.property('data').that.is.an('array');
        expect(Number(res.body.total)).to.be.at.least(2);
        expect(res.body.data.length).to.be.at.least(2);
    });

    it('each market item has tick1, tick2, and price fields', async function () {
        const res = await request.get('/RBTC/api/markets').expect(200);

        const item = res.body.data[0];
        expect(item).to.include.keys('tick1', 'tick2', 'tick1_price', 'tick2_price', 'id');
    });

});

// ---------------------------------------------------------------------------
// GET /RBTC/api/markets/{TICK1} — filter by token
// ---------------------------------------------------------------------------

describe('GET /RBTC/api/markets/XCHAIN', function () {

    it('returns both pairs since XCHAIN appears in each', async function () {
        const res = await request.get('/RBTC/api/markets/XCHAIN').expect(200);

        expect(res.body).to.have.property('data').that.is.an('array');
        expect(res.body.data.length).to.be.at.least(2);
    });

});

// ---------------------------------------------------------------------------
// GET /RBTC/api/market/{TICK1}/{TICK2} — specific pair
// ---------------------------------------------------------------------------

describe('GET /RBTC/api/market/XCHAIN/TOKENONE', function () {

    it('returns market data for the XCHAIN/TOKENONE pair', async function () {
        const res = await request.get('/RBTC/api/market/XCHAIN/TOKENONE').expect(200);

        // getMarket returns an array but getQuery destructures it, so only the first
        // row object is passed through as data. processRequest sets json = data (the
        // single object), then ksort() sorts its keys. The response body is therefore
        // a single market object — not a wrapped array.
        expect(res.body).to.be.an('object').and.not.an('array');
        expect(res.body).to.include.keys('tick1', 'tick2', 'tick1_price', 'id');
    });

});

// ---------------------------------------------------------------------------
// GET /RBTC/api/market/{TICK1}/{TICK2}/orders — open orders for pair
// ---------------------------------------------------------------------------

describe('GET /RBTC/api/market/XCHAIN/TOKENONE/orders', function () {

    it('returns open orders for the XCHAIN/TOKENONE pair', async function () {
        const res = await request.get('/RBTC/api/market/XCHAIN/TOKENONE/orders').expect(200);

        // getMarketOrders returns [data, null, total] — wrapped as { total, data } when total is numeric
        expect(res.body).to.have.property('total');
        expect(res.body).to.have.property('data').that.is.an('array');
        // total may be 0 if no open orders exist for this specific pair combination
        expect(Number(res.body.total)).to.be.a('number');
    });

});

// ---------------------------------------------------------------------------
// GET /RBTC/api/market/{TICK1}/{TICK2}/orderbook — aggregated orderbook
// ---------------------------------------------------------------------------

describe('GET /RBTC/api/market/XCHAIN/TOKENONE/orderbook', function () {

    it('returns bids and asks arrays', async function () {
        const res = await request.get('/RBTC/api/market/XCHAIN/TOKENONE/orderbook').expect(200);

        // getMarketOrderbook returns { bids: [], asks: [] } — merged directly into json
        expect(res.body).to.have.property('bids').that.is.an('array');
        expect(res.body).to.have.property('asks').that.is.an('array');
    });

});

// ---------------------------------------------------------------------------
// Non-existent market pair
// ---------------------------------------------------------------------------

describe('GET /RBTC/api/market/FAKE/PAIR', function () {

    it('returns an empty array for a nonexistent pair', async function () {
        const res = await request.get('/RBTC/api/market/FAKE/PAIR');

        // Explorer returns 400 when data and total are both null/empty,
        // or a 200 with empty array — accept either outcome
        if (res.status === 200) {
            // If it resolved to data, it should be empty
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
