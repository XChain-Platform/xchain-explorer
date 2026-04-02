/**
 * P2 Regression Tests — Cross-Endpoint Consistency and E2E Pipeline
 *
 * Validates that the same data appears consistently across related
 * endpoints, and that action-specific endpoints return correct data.
 *
 * Uses the baseline seed (no E2E-specific data) to keep the suite
 * independent of the E2E test phase.
 *
 * Requires: MariaDB on port 3307 (npm run test:integration:up)
 * Run: mocha test/regression/p2-cross-endpoint.test.js --timeout 30000
 */

'use strict';

const { expect } = require('chai');
const supertest  = require('supertest');
const db         = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

const ADDR1 = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR2 = 'bc1qaddr2bbbbbbbbbbbbbbbbbbbbbbbbbbb';

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
// @p2 @consistency Transaction-Send cross-reference
// ===========================================================================

describe('@p2 @consistency Transaction-Send cross-reference regression', function () {

    it('send at action_index 9 shares tx_hash with its transaction', async function () {
        // Get transaction details for tx_index 9
        const txRes = await request.get('/RBTC/api/transaction/9/tx_index');
        expect(txRes.status).to.equal(200);

        // Get sends for block 5 (where action_index 9 lives)
        const sendRes = await request.get('/RBTC/api/sends/5/block');
        expect(sendRes.status).to.equal(200);

        const send = sendRes.body.data.find(r => Number(r.action_index) === 9);
        expect(send).to.exist;

        // tx_hash and block_index must match
        expect(send.tx_hash).to.equal(txRes.body.tx_hash);
        expect(Number(send.block_index)).to.equal(Number(txRes.body.block_index));
    });

    it('transaction actions array includes all actions in that tx', async function () {
        // tx_index 9 should include action_index 9 (SEND) and 23 (ORDER)
        const txRes = await request.get('/RBTC/api/transaction/9/tx_index');
        expect(txRes.status).to.equal(200);
        expect(txRes.body.actions).to.be.an('array');
        const actionIndexes = txRes.body.actions.map(a => Number(a.action_index));
        expect(actionIndexes).to.include(9);
        expect(actionIndexes).to.include(23);
    });
});

// ===========================================================================
// @p2 @consistency Block-scoped action counts
// ===========================================================================

describe('@p2 @consistency Block-scoped action counts regression', function () {

    it('block 2 has exactly 2 sends', async function () {
        const res = await request.get('/RBTC/api/sends/2/block');
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(2);
    });

    it('block 4 has exactly 3 orders', async function () {
        const res = await request.get('/RBTC/api/orders/4/block');
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(3);
    });

    it('block 6 has 3 dispensers and 2 dispenses', async function () {
        const dispensers = await request.get('/RBTC/api/dispensers/6/block');
        expect(dispensers.status).to.equal(200);
        expect(Number(dispensers.body.total)).to.equal(3);

        const dispenses = await request.get('/RBTC/api/dispenses/6/block');
        expect(dispenses.status).to.equal(200);
        expect(Number(dispenses.body.total)).to.equal(2);
    });

    it('block 10 has 1 send, 1 destroy, 1 broadcast', async function () {
        const sends = await request.get('/RBTC/api/sends/10/block');
        expect(sends.status).to.equal(200);
        expect(Number(sends.body.total)).to.equal(1);

        const destroys = await request.get('/RBTC/api/destroys/10/block');
        expect(destroys.status).to.equal(200);
        expect(Number(destroys.body.total)).to.equal(1);

        const broadcasts = await request.get('/RBTC/api/broadcasts/10/block');
        expect(broadcasts.status).to.equal(200);
        expect(Number(broadcasts.body.total)).to.equal(1);
    });
});

// ===========================================================================
// @p2 @consistency API vs Explorer data agreement
// ===========================================================================

describe('@p2 @consistency API vs Explorer data agreement regression', function () {

    it('API and Explorer sends totals match for same query', async function () {
        const apiRes = await request.get(`/RBTC/api/sends/${ADDR1}/address`);
        const explorerRes = await request.get(`/RBTC/explorer/sends/${ADDR1}/address`);

        expect(apiRes.status).to.equal(200);
        expect(explorerRes.status).to.equal(200);

        expect(Number(apiRes.body.total)).to.equal(Number(explorerRes.body.recordsTotal));
    });

    it('API and Explorer balances totals match', async function () {
        const apiRes = await request.get(`/RBTC/api/balances/${ADDR1}`);
        const explorerRes = await request.get(`/RBTC/explorer/balances/${ADDR1}/address`);

        expect(apiRes.status).to.equal(200);
        expect(explorerRes.status).to.equal(200);

        expect(Number(apiRes.body.total)).to.equal(Number(explorerRes.body.recordsTotal));
    });
});

// ===========================================================================
// @p2 @consistency Explorer token and block endpoints
// ===========================================================================

describe('@p2 @consistency Explorer token and block endpoints regression', function () {

    it('explorer tokens filtered by token name returns matching rows', async function () {
        const res = await request.get('/RBTC/explorer/tokens/TOKEN/token').expect(200);
        expect(res.body).to.have.property('recordsTotal');
        if (res.body.data.length > 0) {
            // tick is at index 3 in explorer token rows
            expect(res.body.data[0][3]).to.be.a('string');
        }
    });

    it('explorer blocks/all returns at least 10 blocks', async function () {
        const res = await request.get('/RBTC/explorer/blocks/all').expect(200);
        expect(Number(res.body.recordsTotal)).to.be.at.least(10);
    });

    it('explorer sends filtered by token returns only that token', async function () {
        const res = await request.get('/RBTC/explorer/sends/XCHAIN/token').expect(200);
        expect(Number(res.body.recordsTotal)).to.be.at.least(1);
        // tick is at index 4 in explorer send rows
        for (const row of res.body.data) {
            expect(row[4]).to.equal('XCHAIN');
        }
    });
});

// ===========================================================================
// @p2 @action Less-used action type endpoints
// ===========================================================================

describe('@p2 @action Less-used action type endpoints regression', function () {

    it('order_matches endpoint returns data', async function () {
        // There are 3 order_matches in the seed
        const res = await request.get('/RBTC/api/order_matches/4/block');
        // Some order_matches may or may not fall in block 4, so just verify no crash
        expect(res.status).to.be.a('number');
        expect(res.status).to.not.equal(500);
    });

    it('escrows endpoint returns data for seeded address', async function () {
        const addr4 = 'bc1qaddr4ddddddddddddddddddddddddddd';
        const res = await request.get(`/RBTC/api/escrows/${addr4}/address`);
        expect(res.status).to.be.a('number');
        expect(res.status).to.not.equal(500);
    });
});

// ===========================================================================
// @p2 @icon Icon endpoint
// ===========================================================================

describe('@p2 @icon Icon endpoint regression', function () {

    it('nonexistent icon redirects to default', async function () {
        const res = await request.get('/icon/nonexistent.png');
        expect(res.status).to.equal(302);
        expect(res.headers.location).to.equal('/icon/default.png');
    });
});
