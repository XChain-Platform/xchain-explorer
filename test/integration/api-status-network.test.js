'use strict';

/**
 * Integration tests — /api/status and /api/network endpoints
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
// /api/status
// ---------------------------------------------------------------------------

describe('GET /RBTC/api/status', function () {

    it('returns 200 with supported and available coins', async function () {
        const res = await request.get('/RBTC/api/status').expect(200);

        expect(res.body).to.have.property('supported').that.is.an('object');
        expect(res.body).to.have.property('available').that.is.an('object');

        // supported list should include all coin+network combos
        expect(res.body.supported).to.include.keys('BTC', 'TBTC', 'RBTC', 'LTC', 'TLTC', 'RLTC');

        // only RBTC is available in this test environment
        expect(res.body.available).to.have.property('RBTC');
    });

    it('status works even for an unsupported coin prefix', async function () {
        // /BTC/api/status — BTC (mainnet) is supported but not available;
        // the explorer forces status requests to validDataRequest=true regardless
        const res = await request.get('/BTC/api/status').expect(200);

        expect(res.body).to.have.property('supported').that.is.an('object');
        expect(res.body).to.have.property('available').that.is.an('object');
    });

});

// ---------------------------------------------------------------------------
// /api/network
// ---------------------------------------------------------------------------

describe('GET /RBTC/api/network', function () {

    it('returns 200 with totals, network, fee, coin, and xchain objects', async function () {
        const res = await request.get('/RBTC/api/network').expect(200);

        expect(res.body).to.have.property('totals').that.is.an('object');
        expect(res.body).to.have.property('network').that.is.an('object');
        expect(res.body).to.have.property('fee').that.is.an('object');
        expect(res.body).to.have.property('coin').that.is.an('object');
        expect(res.body).to.have.property('xchain').that.is.an('object');
    });

    it('totals contains keys for action tables', async function () {
        const res = await request.get('/RBTC/api/network').expect(200);

        const totals = res.body.totals;
        // Core action tables that are always populated in the schema
        expect(totals).to.include.keys('sends', 'orders', 'issues', 'mints', 'destroys', 'dispensers');
        expect(totals).to.include.key('tokens');
    });

    it('totals.sends is at least 10 (matches seed data)', async function () {
        const res = await request.get('/RBTC/api/network').expect(200);

        expect(Number(res.body.totals.sends)).to.be.at.least(10);
    });

});
