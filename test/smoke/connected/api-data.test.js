'use strict';

/**
 * Smoke tests — Data query endpoints (SM-11, SM-16)
 *
 * Requires MariaDB on port 3307 (start with: npm run test:integration:up).
 * Validates core data endpoints return the standard response envelope.
 *
 * Run: npm run test:smoke:connected
 */

const { expect }     = require('chai');
const supertest      = require('supertest');
const db             = require('../../integration/helpers/db-setup');
const { createApp }  = require('../../integration/helpers/app-setup');

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
// SM-11: Data endpoint responds with correct structure
// ---------------------------------------------------------------------------

describe('SM-11: GET /RBTC/api/sends/{block}/block', function () {

    it('returns 200 with total and data keys', async function () {
        const res = await request.get('/RBTC/api/sends/1/block').expect(200);

        expect(res.body).to.have.property('total');
        expect(res.body).to.have.property('data').that.is.an('array');
    });

    it('total is a number', async function () {
        const res = await request.get('/RBTC/api/sends/5/block').expect(200);

        expect(Number(res.body.total)).to.be.a('number');
    });

    it('response is JSON with correct content type', async function () {
        const res = await request.get('/RBTC/api/sends/1/block').expect(200);
        expect(res.headers['content-type']).to.match(/json/);
    });

});

// ---------------------------------------------------------------------------
// SM-16: Market endpoint responds
// ---------------------------------------------------------------------------

describe('SM-16: GET /RBTC/api/markets', function () {

    it('returns 200 with total and data keys', async function () {
        const res = await request.get('/RBTC/api/markets').expect(200);

        expect(res.body).to.have.property('total');
        expect(res.body).to.have.property('data').that.is.an('array');
    });

    it('response is JSON', async function () {
        const res = await request.get('/RBTC/api/markets').expect(200);
        expect(res.headers['content-type']).to.match(/json/);
    });

});
