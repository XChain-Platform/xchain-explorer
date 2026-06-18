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
 * P0 Regression Tests: Core API Endpoints
 *
 * Curated integration tests for the most critical data retrieval endpoints:
 * sends, balances, tokens, addresses, actions, status, network.
 *
 * Requires: MariaDB on port 3307 (npm run test:integration:up)
 * Run: mocha test/regression/p0-core-api.test.js --timeout 30000
 */

'use strict';

const { expect } = require('chai');
const supertest  = require('supertest');
const db         = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

// ---------------------------------------------------------------------------
// Seed reference constants
// ---------------------------------------------------------------------------

const ADDR1 = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR2 = 'bc1qaddr2bbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ADDR3 = 'bc1qaddr3ccccccccccccccccccccccccccc';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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
// @p0 @core Sends: primary data retrieval
// ===========================================================================

describe('@p0 @core Sends API regression', function () {

    it('GET /RBTC/api/sends/{block}/block: correct count and ordering', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(2);
        expect(res.body.data).to.be.an('array').with.lengthOf(2);
        // Default DESC order
        expect(Number(res.body.data[0].action_index)).to.be.greaterThan(Number(res.body.data[1].action_index));
    });

    it('GET /RBTC/api/sends/{address}/address: returns all sends involving address', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address`);
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(7);
        expect(res.body.data).to.be.an('array').with.lengthOf(7);
    });

    it('GET /RBTC/api/sends/{tick}/token: filters by token', async function () {
        const res = await request.get('/RBTC/api/sends/XCHAIN/token');
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(5);
        for (const row of res.body.data) {
            expect(row.tick).to.equal('XCHAIN');
        }
    });

    it('GET /RBTC/api/sends/{address}/source: filters by source only', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/source`);
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(5);
        for (const row of res.body.data) {
            expect(row.source).to.equal(ADDR1);
        }
    });

    it('GET /RBTC/api/sends/{address}/destination: filters by destination only', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR2}/destination`);
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(3);
        for (const row of res.body.data) {
            expect(row.destination).to.equal(ADDR2);
        }
    });

    it('no matching results returns empty collection', async function () {
        const res = await request.get('/RBTC/api/sends/NONEXISTENT/token');
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(0);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });

    it('response fields have correct structure', async function () {
        const res = await request.get('/RBTC/api/sends/XCHAIN/token');
        expect(res.status).to.equal(200);
        const row = res.body.data[0];
        for (const field of ['action', 'action_format', 'action_index', 'amount', 'block_index',
            'destination', 'memo', 'source', 'status', 'tick', 'timestamp', 'tx_hash', 'tx_index']) {
            expect(row).to.have.property(field);
        }
    });

    it('sortorder=ASC reverses default order', async function () {
        const res = await request.get('/RBTC/api/sends/5/block?sortorder=ASC');
        expect(res.status).to.equal(200);
        expect(Number(res.body.data[0].action_index)).to.be.lessThan(Number(res.body.data[1].action_index));
    });

    it('limit parameter caps results', async function () {
        const res = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=2`);
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(7);
        expect(res.body.data).to.be.an('array').with.lengthOf(2);
    });

    it('page parameter returns non-overlapping pages', async function () {
        const page1 = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=2&page=1`);
        const page2 = await request.get(`/RBTC/api/sends/${ADDR1}/address?limit=2&page=2`);
        const ids1 = page1.body.data.map(r => r.action_index);
        const ids2 = page2.body.data.map(r => r.action_index);
        const overlap = ids1.filter(i => ids2.includes(i));
        expect(overlap).to.be.empty;
    });
});

// ===========================================================================
// @p0 @core Balances
// ===========================================================================

describe('@p0 @core Balances API regression', function () {

    it('GET /RBTC/api/balances/{address}: returns all token balances', async function () {
        const res = await request.get(`/RBTC/api/balances/${ADDR1}`);
        expect(res.status).to.equal(200);
        expect(res.body.address).to.equal(ADDR1);
        // ADDR1 holds XCHAIN, TOKENONE, TOKENTWO
        expect(Number(res.body.total)).to.equal(3);
        expect(res.body.data).to.be.an('array').with.lengthOf(3);
        const first = res.body.data[0];
        expect(first).to.have.all.keys(['tick', 'amount', 'supply', 'decimals', 'coin_price']);
    });

    it('balance amounts are strings with correct decimal precision', async function () {
        const res = await request.get(`/RBTC/api/balances/${ADDR1}`);
        expect(res.status).to.equal(200);
        for (const row of res.body.data) {
            expect(row.amount).to.be.a('string');
            expect(row.amount).to.match(/^\d+\.\d+$/);
        }
    });

    it('default sort is ASC on tick', async function () {
        const res = await request.get(`/RBTC/api/balances/${ADDR1}`);
        expect(res.status).to.equal(200);
        // TOKENONE < TOKENTWO < XCHAIN alphabetically
        expect(res.body.data[0].tick).to.equal('TOKENONE');
    });
});

// ===========================================================================
// @p0 @core Holders
// ===========================================================================

describe('@p0 @core Holders API regression', function () {

    it('GET /RBTC/api/holders/{tick}: returns holder list', async function () {
        const res = await request.get('/RBTC/api/holders/XCHAIN');
        expect(res.status).to.equal(200);
        expect(res.body.tick).to.equal('XCHAIN');
        expect(res.body.supply).to.be.a('string');
        expect(Number(res.body.decimals)).to.equal(8);
        // ADDR1(500000), ADDR2(200000), ADDR3(100000)
        expect(Number(res.body.total)).to.be.at.least(3);
    });

    it('default sort is DESC by amount (largest holder first)', async function () {
        const res = await request.get('/RBTC/api/holders/XCHAIN');
        expect(res.status).to.equal(200);
        expect(res.body.data[0].address).to.equal(ADDR1);
    });
});

// ===========================================================================
// @p0 @core Token detail
// ===========================================================================

describe('@p0 @core Token API regression', function () {

    it('GET /RBTC/api/token/{tick}: returns full token detail', async function () {
        const res = await request.get('/RBTC/api/token/TOKENONE');
        expect(res.status).to.equal(200);
        // projects/registry are the Project_Registry.md display surfaces (2026-06)
        expect(res.body).to.have.all.keys(['callback', 'info', 'lists', 'locks', 'market', 'mints', 'projects', 'registry', 'runtime', 'supply']);
        expect(res.body.info.tick).to.equal('TOKENONE');
        expect(res.body.info.description).to.equal('Test Token One');
    });

    it('locks section correctly reflects seed data', async function () {
        const res = await request.get('/RBTC/api/token/TOKENONE');
        expect(res.body.locks.max_supply).to.equal(true);
        expect(res.body.locks.mint).to.equal(false);
    });

    it('token with all locks set', async function () {
        const res = await request.get('/RBTC/api/token/TOKENTHREE');
        expect(res.status).to.equal(200);
        expect(res.body.locks.max_supply).to.equal(true);
        expect(res.body.locks.mint).to.equal(true);
        expect(res.body.locks.mint_supply).to.equal(true);
        expect(res.body.locks.max_mint).to.equal(true);
        expect(res.body.locks.description).to.equal(true);
        expect(res.body.locks.sleep).to.equal(false);
        expect(res.body.locks.callback).to.equal(false);
    });

    it('nonexistent token returns 400', async function () {
        const res = await request.get('/RBTC/api/token/DOESNOTEXIST');
        expect(res.status).to.equal(400);
        expect(res.body.error).to.be.a('string');
    });
});

// ===========================================================================
// @p0 @core Block detail
// ===========================================================================

describe('@p0 @core Block API regression', function () {

    it('GET /RBTC/api/block/{N}: returns block info', async function () {
        const res = await request.get('/RBTC/api/block/5');
        expect(res.status).to.equal(200);
        expect(Number(res.body.block_index)).to.equal(5);
        expect(Number(res.body.timestamp)).to.equal(1700002400);
        expect(res.body.ledger_hash).to.be.a('string').and.have.length.greaterThan(0);
    });

    it('nonexistent block returns 400', async function () {
        const res = await request.get('/RBTC/api/block/999999');
        expect(res.status).to.equal(400);
        expect(res.body.error).to.be.a('string');
    });
});

// ===========================================================================
// @p0 @core Transaction
// ===========================================================================

describe('@p0 @core Transaction API regression', function () {

    it('GET /RBTC/api/transaction/{hash}/tx_hash: returns by hash', async function () {
        const hash = 'aaa1111111111111111111111111111111111111111111111111111111111111';
        const res = await request.get(`/RBTC/api/transaction/${hash}/tx_hash`);
        expect(res.status).to.equal(200);
        expect(Number(res.body.tx_index)).to.equal(1);
        expect(Number(res.body.block_index)).to.equal(1);
        expect(res.body.source).to.be.a('string');
        expect(res.body.actions).to.be.an('array');
    });

    it('GET /RBTC/api/transaction/{index}/tx_index: returns by index', async function () {
        const res = await request.get('/RBTC/api/transaction/1/tx_index');
        expect(res.status).to.equal(200);
        expect(Number(res.body.tx_index)).to.equal(1);
        expect(res.body.actions).to.be.an('array');
    });
});

// ===========================================================================
// @p0 @core Credits / Debits
// ===========================================================================

describe('@p0 @core Credits and Debits API regression', function () {

    it('GET /RBTC/api/credits/{address}/address: returns credits', async function () {
        const res = await request.get(`/RBTC/api/credits/${ADDR2}/address`);
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.be.at.least(3);
        const first = res.body.data[0];
        expect(first).to.have.all.keys(['action_index', 'tx_index', 'address', 'tick', 'amount', 'action', 'block_index', 'timestamp', 'tx_hash']);
    });

    it('GET /RBTC/api/debits/{address}/address: returns debits', async function () {
        const res = await request.get(`/RBTC/api/debits/${ADDR1}/address`);
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.be.at.least(3);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);
    });
});

// ===========================================================================
// @p0 @core Status / Network
// ===========================================================================

describe('@p0 @core Status and Network API regression', function () {

    it('GET /RBTC/api/status: returns supported and available coins', async function () {
        const res = await request.get('/RBTC/api/status').expect(200);
        expect(res.body.supported).to.include.keys('BTC', 'TBTC', 'RBTC', 'LTC', 'TLTC', 'RLTC');
        expect(res.body.available).to.have.property('RBTC');
    });

    it('GET /RBTC/api/network: returns totals, network, fee, coin, xchain', async function () {
        const res = await request.get('/RBTC/api/network').expect(200);
        expect(res.body).to.have.property('totals').that.is.an('object');
        expect(res.body).to.have.property('network').that.is.an('object');
        expect(res.body).to.have.property('fee').that.is.an('object');
        expect(res.body).to.have.property('coin').that.is.an('object');
        expect(res.body).to.have.property('xchain').that.is.an('object');
    });

    it('network totals include core action table counts', async function () {
        const res = await request.get('/RBTC/api/network').expect(200);
        expect(res.body.totals).to.include.keys('sends', 'orders', 'issues', 'mints', 'destroys', 'dispensers');
        expect(Number(res.body.totals.sends)).to.be.at.least(10);
    });
});

// ===========================================================================
// @p0 @core Address summary
// ===========================================================================

describe('@p0 @core Address API regression', function () {

    it('GET /RBTC/api/address/{addr}: returns address summary', async function () {
        const res = await request.get(`/RBTC/api/address/${ADDR1}`);
        expect(res.status).to.equal(200);
        expect(res.body.address).to.exist;
    });
});
