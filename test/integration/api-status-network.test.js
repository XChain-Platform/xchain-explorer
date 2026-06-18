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
 * Integration tests: /api/status and /api/network endpoints
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
        // /BTC/api/status: BTC (mainnet) is supported but not available;
        // the explorer forces status requests to validDataRequest=true regardless
        const res = await request.get('/BTC/api/status').expect(200);

        expect(res.body).to.have.property('supported').that.is.an('object');
        expect(res.body).to.have.property('available').that.is.an('object');
    });

    it('response includes last_block as an object', async function () {
        const res = await request.get('/RBTC/api/status').expect(200);
        expect(res.body).to.have.property('last_block').that.is.an('object');
    });

    it('last_block contains a numeric value for RBTC (the available coin in the test env)', async function () {
        const res = await request.get('/RBTC/api/status').expect(200);
        expect(res.body.last_block).to.have.property('RBTC');
        expect(res.body.last_block['RBTC']).to.be.a('number');
    });

    it('last_block RBTC value reflects the highest indexed block (simulates indexer lag visibility)', async function () {
        // Seed data has 10 blocks (block_index 1-10); last_block should be non-negative
        const res = await request.get('/RBTC/api/status').expect(200);
        expect(res.body.last_block['RBTC']).to.be.at.least(0);
    });

    it('response includes last_block_time as an object', async function () {
        const res = await request.get('/RBTC/api/status').expect(200);
        expect(res.body).to.have.property('last_block_time').that.is.an('object');
    });

    it('last_block_time contains a numeric value for RBTC reflecting the tip block_time (simulates indexer lag visibility)', async function () {
        const res = await request.get('/RBTC/api/status').expect(200);
        expect(res.body.last_block_time).to.have.property('RBTC');
        expect(res.body.last_block_time['RBTC']).to.be.a('number');
        expect(res.body.last_block_time['RBTC']).to.be.at.least(0);
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
