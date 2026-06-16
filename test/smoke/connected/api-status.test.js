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
 * Smoke tests — Status and network API endpoints (SM-09, SM-10, SM-13)
 *
 * Requires MariaDB on port 3307 (start with: npm run test:integration:up).
 * Validates the most fundamental API endpoints respond with correct structure.
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
// SM-09: Status endpoint responds
// ---------------------------------------------------------------------------

describe('SM-09: GET /RBTC/api/status', function () {

    it('returns 200 with supported and available coins', async function () {
        const res = await request.get('/RBTC/api/status').expect(200);

        expect(res.body).to.have.property('supported').that.is.an('object');
        expect(res.body).to.have.property('available').that.is.an('object');
        expect(res.body.supported).to.include.keys('BTC', 'RBTC');
        expect(res.body.available).to.have.property('RBTC');
    });

    it('response is JSON, not HTML', async function () {
        const res = await request.get('/RBTC/api/status').expect(200);
        expect(res.headers['content-type']).to.match(/json/);
    });

});

// ---------------------------------------------------------------------------
// SM-10: Network endpoint responds
// ---------------------------------------------------------------------------

describe('SM-10: GET /RBTC/api/network', function () {

    it('returns 200 with totals, network, fee, coin, and xchain objects', async function () {
        const res = await request.get('/RBTC/api/network').expect(200);

        expect(res.body).to.have.property('totals').that.is.an('object');
        expect(res.body).to.have.property('network').that.is.an('object');
        expect(res.body).to.have.property('fee').that.is.an('object');
        expect(res.body).to.have.property('coin').that.is.an('object');
        expect(res.body).to.have.property('xchain').that.is.an('object');
    });

    it('totals contains keys for core action tables', async function () {
        const res = await request.get('/RBTC/api/network').expect(200);
        expect(res.body.totals).to.include.keys('sends', 'orders', 'issues');
    });

});

// ---------------------------------------------------------------------------
// SM-13: Invalid coin returns correct error
// ---------------------------------------------------------------------------

describe('SM-13: Invalid coin handling', function () {

    it('status endpoint works even for an unavailable coin prefix', async function () {
        // BTC (mainnet) is supported but not available in test env
        // The status endpoint forces validDataRequest=true regardless
        const res = await request.get('/BTC/api/status').expect(200);
        expect(res.body).to.have.property('supported');
        expect(res.body).to.have.property('available');
    });

    it('unsupported coin on data endpoint returns error or empty response', async function () {
        const res = await request.get('/INVALID/api/sends/all/all');

        // INVALID is not in COIN_SUPPORTED, so the explorer should either
        // return an error code or an empty data response
        if (res.status === 200) {
            // If 200, the body should indicate no data (unsupported coin has no pool)
            expect(res.body).to.satisfy(body =>
                (body.total === 0 || body.total === null || body.data === null || (Array.isArray(body.data) && body.data.length === 0)) ||
                typeof body === 'string' // HTML error page
            );
        } else {
            // Non-200 is also acceptable (404, redirect, etc.)
            expect(res.status).to.be.oneOf([301, 302, 404]);
        }
    });

});
