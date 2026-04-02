/**
 * E2E tests — Pipeline Integrity
 *
 * Validates that specific seeded values round-trip correctly through
 * the full SQL pipeline: MariaDB → db.js query → API JSON response.
 *
 * Covers: E2E-01, E2E-02, E2E-03, E2E-04, E2E-07
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
// E2E-01 — Issue → Token Query (exact seeded values)
// ===========================================================================

describe('E2E-01: Token query returns exact seeded values', function () {

    it('XCHAIN token info matches seed data', async function () {
        const res = await request.get('/RBTC/api/token/XCHAIN');
        expect(res.status).to.equal(200);

        // Exact values from seed-baseline.sql tokens row 1
        // Note: decimals is excluded from the response by getToken() (used internally for formatting)
        expect(res.body.info.tick).to.equal('XCHAIN');
        expect(res.body.info.description).to.equal('XChain gas token');

        expect(res.body.supply.max).to.equal('21000000.00000000');
        expect(res.body.supply.current).to.equal('1000000.00000000');
    });

    it('TOKENONE token info matches seed data', async function () {
        const res = await request.get('/RBTC/api/token/TOKENONE');
        expect(res.status).to.equal(200);

        expect(res.body.info.tick).to.equal('TOKENONE');
        expect(res.body.info.description).to.equal('Test Token One');

        expect(res.body.supply.max).to.equal('1000000.00000000');
        expect(res.body.supply.current).to.equal('500000.00000000');
    });

    it('TOKENTHREE (4 decimals) token info matches seed data', async function () {
        const res = await request.get('/RBTC/api/token/TOKENTHREE');
        expect(res.status).to.equal(200);

        expect(res.body.info.tick).to.equal('TOKENTHREE');
        expect(res.body.supply.max).to.equal('100.0000');
        expect(res.body.supply.current).to.equal('100.0000');
    });
});

// ===========================================================================
// E2E-02 — Send → Balance (exact seeded amount)
// ===========================================================================

describe('E2E-02: Balance returns exact seeded amount', function () {

    it('addr1 XCHAIN balance matches seed', async function () {
        const addr = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const res  = await request.get(`/RBTC/api/balances/${addr}`);
        expect(res.status).to.equal(200);

        const xchainRow = res.body.data.find(r => r.tick === 'XCHAIN');
        expect(xchainRow).to.exist;
        // Exact value from seed-baseline.sql balances row 1
        expect(xchainRow.amount).to.equal('500000.00000000');
    });

    it('addr4 TOKENTHREE balance matches seed (4 decimals)', async function () {
        const addr = 'bc1qaddr4ddddddddddddddddddddddddddd';
        const res  = await request.get(`/RBTC/api/balances/${addr}`);
        expect(res.status).to.equal(200);

        const row = res.body.data.find(r => r.tick === 'TOKENTHREE');
        expect(row).to.exist;
        expect(row.amount).to.equal('75.0000');
    });
});

// ===========================================================================
// E2E-03 — Token supply field matches seeded tokens.supply
// ===========================================================================

describe('E2E-03: Token supply reflects seeded value', function () {

    it('XCHAIN current supply matches tokens table', async function () {
        const res = await request.get('/RBTC/api/token/XCHAIN');
        expect(res.status).to.equal(200);
        // tokens.supply = '1000000.00000000' in seed
        expect(res.body.supply.current).to.equal('1000000.00000000');
    });

    it('TOKENTWO current supply matches tokens table', async function () {
        const res = await request.get('/RBTC/api/token/TOKENTWO');
        expect(res.status).to.equal(200);
        // tokens.supply = '250000.00000000' in seed
        expect(res.body.supply.current).to.equal('250000.00000000');
    });
});

// ===========================================================================
// E2E-04 — Multi-action block returns diverse action types
// ===========================================================================

describe('E2E-04: Multi-action block 201', function () {

    it('block 201 exists with correct timestamp', async function () {
        const res = await request.get('/RBTC/api/block/201');
        expect(res.status).to.equal(200);
        expect(Number(res.body.block_index)).to.equal(201);
        expect(Number(res.body.timestamp)).to.equal(1700060000);
    });

    it('transactions in block 201 contain multiple action types', async function () {
        // Query the send in block 201 to verify it exists
        const sends = await request.get('/RBTC/api/sends/201/block');
        expect(sends.status).to.equal(200);
        expect(Number(sends.body.total)).to.be.at.least(1);

        // Query mints in block 201
        const mints = await request.get('/RBTC/api/mints/201/block');
        expect(mints.status).to.equal(200);
        expect(Number(mints.body.total)).to.be.at.least(1);

        // Query broadcasts in block 201
        const broadcasts = await request.get('/RBTC/api/broadcasts/201/block');
        expect(broadcasts.status).to.equal(200);
        expect(Number(broadcasts.body.total)).to.be.at.least(1);

        // Query issues in block 201
        const issues = await request.get('/RBTC/api/issues/201/block');
        expect(issues.status).to.equal(200);
        expect(Number(issues.body.total)).to.be.at.least(1);
    });

    it('send in block 201 has correct seeded values', async function () {
        const res = await request.get('/RBTC/api/sends/201/block');
        expect(res.status).to.equal(200);

        const send = res.body.data.find(r => Number(r.action_index) === 200);
        expect(send).to.exist;
        expect(send.tick).to.equal('XCHAIN');
        expect(send.amount).to.equal('100.00000000');
    });

    it('broadcast in block 201 has correct message', async function () {
        const res = await request.get('/RBTC/api/broadcasts/201/block');
        expect(res.status).to.equal(200);

        const bc = res.body.data.find(r => Number(r.action_index) === 203);
        expect(bc).to.exist;
        expect(bc.message).to.equal('E2E test broadcast');
        expect(bc.value).to.equal('42000.00');
    });
});

// ===========================================================================
// E2E-07 — Address profile
// ===========================================================================

describe('E2E-07: Address profile endpoint', function () {

    it('returns address field for known address', async function () {
        const addr = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const res  = await request.get(`/RBTC/api/address/${addr}`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        // getAddress() is currently a stub — this documents current behavior
        // and will need updating when the stub is replaced with real data
        expect(res.body.address).to.exist;
    });
});
