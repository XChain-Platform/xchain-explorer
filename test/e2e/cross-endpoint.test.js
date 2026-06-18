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
 * E2E tests: Cross-Endpoint Consistency
 *
 * Validates mathematical and relational consistency across different
 * API endpoints querying the same underlying data.
 *
 * Covers: E2E-37, E2E-38, E2E-39, E2E-40
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
// E2E-37: Balance == sum(credits) - sum(debits)
// ===========================================================================

describe('E2E-37: Balance equals credits minus debits', function () {

    const E2E_ADDR = 'bc1qe2eaddr210aaaaaaaaaaaaaaaaaaaaaa';

    it('XCHAIN balance for E2E address matches credits - debits', async function () {
        // 1. Get balance
        const balRes = await request.get(`/RBTC/api/balances/${E2E_ADDR}`);
        expect(balRes.status).to.equal(200);

        const xchainBal = balRes.body.data.find(r => r.tick === 'XCHAIN');
        expect(xchainBal).to.exist;
        const balance = parseFloat(xchainBal.amount);

        // 2. Get credits
        const credRes = await request.get(`/RBTC/api/credits/${E2E_ADDR}/address`);
        expect(credRes.status).to.equal(200);

        let creditSum = 0;
        for (const row of credRes.body.data) {
            if (row.tick === 'XCHAIN') {
                creditSum += parseFloat(row.amount);
            }
        }

        // 3. Get debits
        const debRes = await request.get(`/RBTC/api/debits/${E2E_ADDR}/address`);
        expect(debRes.status).to.equal(200);

        let debitSum = 0;
        for (const row of debRes.body.data) {
            if (row.tick === 'XCHAIN') {
                debitSum += parseFloat(row.amount);
            }
        }

        // 4. Assert: balance == credits - debits
        // Seeded: credits = 1200 + 800 = 2000, debits = 500, balance = 1500
        expect(creditSum).to.equal(2000);
        expect(debitSum).to.equal(500);
        expect(balance).to.equal(creditSum - debitSum);
    });
});

// ===========================================================================
// E2E-38: Token supply == sum(holder balances)
// ===========================================================================

describe('E2E-38: Token supply equals sum of holder balances', function () {

    it('SUMTOKEN supply matches holder total', async function () {
        // 1. Get token supply
        const tokenRes = await request.get('/RBTC/api/token/SUMTOKEN');
        expect(tokenRes.status).to.equal(200);

        const supply = parseFloat(tokenRes.body.supply.current);

        // 2. Get all holders
        const holdersRes = await request.get('/RBTC/api/holders/SUMTOKEN');
        expect(holdersRes.status).to.equal(200);

        let holderSum = 0;
        for (const row of holdersRes.body.data) {
            holderSum += parseFloat(row.amount);
        }

        // 3. Assert: supply == sum(holders)
        // Seeded: supply = 3000, holders = 1000 + 1200 + 800 = 3000
        expect(Number(holdersRes.body.total)).to.equal(3);
        expect(supply).to.equal(3000);
        expect(holderSum).to.equal(supply);
    });
});

// ===========================================================================
// E2E-39: Action data from transaction matches send endpoint
// ===========================================================================

describe('E2E-39: Transaction and send endpoints are consistent', function () {

    it('tx_index 9 actions include SEND at action_index 9', async function () {
        // tx_index 9 has two actions: 9 (SEND) and 23 (ORDER)
        const txRes = await request.get('/RBTC/api/transaction/9/tx_index');
        expect(txRes.status).to.equal(200);
        expect(txRes.body.actions).to.be.an('array');

        const actionIndexes = txRes.body.actions.map(a => Number(a.action_index));
        expect(actionIndexes).to.include(9);
        expect(actionIndexes).to.include(23);
    });

    it('send at action_index 9 shares tx_hash with its transaction', async function () {
        // Get transaction details
        const txRes = await request.get('/RBTC/api/transaction/9/tx_index');
        expect(txRes.status).to.equal(200);

        // Get the send (action_index 9 is in block 5)
        const sendRes = await request.get('/RBTC/api/sends/5/block');
        expect(sendRes.status).to.equal(200);

        const send = sendRes.body.data.find(r => Number(r.action_index) === 9);
        expect(send).to.exist;

        // tx_hash and block_index must match
        expect(send.tx_hash).to.equal(txRes.body.tx_hash);
        expect(Number(send.block_index)).to.equal(Number(txRes.body.block_index));
    });
});

// ===========================================================================
// E2E-40: Block action counts match action endpoint totals
// ===========================================================================

describe('E2E-40: Block-scoped action counts are consistent', function () {

    it('block 2 has exactly 2 sends', async function () {
        // Block 2 seeded actions: 3 (SEND), 4 (SEND)
        const res = await request.get('/RBTC/api/sends/2/block');
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(2);
    });

    it('block 4 has exactly 3 orders', async function () {
        // Block 4 seeded actions: 7 (ORDER), 8 (ORDER), 22 (ORDER)
        const res = await request.get('/RBTC/api/orders/4/block');
        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(3);
    });

    it('block 6 has dispensers and dispenses', async function () {
        // Block 6 actions: 11 (DISPENSER), 12 (DISPENSER), 25 (DISPENSE/DISPENSER), 26 (DISPENSE)
        // action_index 25 exists in both dispensers and dispenses tables
        const dispensers = await request.get('/RBTC/api/dispensers/6/block');
        expect(dispensers.status).to.equal(200);
        expect(Number(dispensers.body.total)).to.equal(3);

        const dispenses = await request.get('/RBTC/api/dispenses/6/block');
        expect(dispenses.status).to.equal(200);
        expect(Number(dispenses.body.total)).to.equal(2);
    });

    it('E2E block 201 has 1 send, 1 mint, 1 broadcast, 1 issue', async function () {
        const sends = await request.get('/RBTC/api/sends/201/block');
        expect(sends.status).to.equal(200);
        expect(Number(sends.body.total)).to.equal(1);

        const mints = await request.get('/RBTC/api/mints/201/block');
        expect(mints.status).to.equal(200);
        expect(Number(mints.body.total)).to.equal(1);

        const broadcasts = await request.get('/RBTC/api/broadcasts/201/block');
        expect(broadcasts.status).to.equal(200);
        expect(Number(broadcasts.body.total)).to.equal(1);

        const issues = await request.get('/RBTC/api/issues/201/block');
        expect(issues.status).to.equal(200);
        expect(Number(issues.body.total)).to.equal(1);
    });
});
