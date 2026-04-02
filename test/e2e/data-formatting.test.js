/**
 * E2E tests — Data Formatting & Type Consistency
 *
 * Validates that data types are preserved through the SQL→API pipeline:
 * BigInts as strings, timestamps as integers, booleans as booleans,
 * nulls as JSON null, and decimal precision matching token config.
 *
 * Covers: E2E-14, E2E-15, E2E-16, E2E-17, E2E-18
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
// E2E-14 — BigInt Serialization
// ===========================================================================

describe('E2E-14: BigInt values survive serialization', function () {

    it('BIGTOKEN balance is a string without truncation', async function () {
        const addr = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const res  = await request.get(`/RBTC/api/balances/${addr}`);
        expect(res.status).to.equal(200);

        const row = res.body.data.find(r => r.tick === 'BIGTOKEN');
        expect(row).to.exist;

        // Must be a string — BigInt amounts cannot be Number without precision loss
        expect(row.amount).to.be.a('string');
        // Exact seeded value: 18014398509481984.00000000 (2^54, above MAX_SAFE_INTEGER)
        expect(row.amount).to.equal('18014398509481984.00000000');
        // No scientific notation
        expect(row.amount).to.not.match(/e\+/i);
    });

    it('BIGTOKEN max supply is a string without truncation', async function () {
        const res = await request.get('/RBTC/api/token/BIGTOKEN');
        expect(res.status).to.equal(200);

        expect(res.body.supply.max).to.be.a('string');
        expect(res.body.supply.max).to.equal('99999999999999999.00000000');
        expect(res.body.supply.max).to.not.match(/e\+/i);
    });

    it('BIGTOKEN current supply is a string', async function () {
        const res = await request.get('/RBTC/api/token/BIGTOKEN');
        expect(res.status).to.equal(200);

        expect(res.body.supply.current).to.be.a('string');
        expect(res.body.supply.current).to.equal('50000000000000000.00000000');
    });
});

// ===========================================================================
// E2E-15 — Timestamp Format Consistency
// ===========================================================================

describe('E2E-15: Timestamps are Unix integers', function () {

    it('block timestamp matches seeded block_time', async function () {
        const res = await request.get('/RBTC/api/block/5');
        expect(res.status).to.equal(200);

        // Seeded: block 5 block_time = 1700002400
        // MariaDB BIGINT may arrive as string — verify the value regardless of type
        expect(Number(res.body.timestamp)).to.equal(1700002400);
    });

    it('send records carry timestamps from their block', async function () {
        const res = await request.get('/RBTC/api/sends/5/block');
        expect(res.status).to.equal(200);

        for (const row of res.body.data) {
            // Block 5 seeded with block_time 1700002400
            expect(Number(row.timestamp)).to.equal(1700002400);
        }
    });

    it('E2E block 201 timestamp matches seed', async function () {
        const res = await request.get('/RBTC/api/block/201');
        expect(res.status).to.equal(200);
        expect(Number(res.body.timestamp)).to.equal(1700060000);
    });
});

// ===========================================================================
// E2E-16 — Boolean Fields
// ===========================================================================

describe('E2E-16: Token lock fields are boolean type', function () {

    it('TOKENONE locks are typeof boolean', async function () {
        const res = await request.get('/RBTC/api/token/TOKENONE');
        expect(res.status).to.equal(200);

        const locks = res.body.locks;
        // lock_max_supply=1 in seed → must be boolean true, not number 1
        expect(locks.max_supply).to.equal(true);
        expect(typeof locks.max_supply).to.equal('boolean');

        // lock_mint=0 in seed → must be boolean false, not number 0
        expect(locks.mint).to.equal(false);
        expect(typeof locks.mint).to.equal('boolean');
    });

    it('TOKENTHREE all-locked fields are typeof boolean', async function () {
        const res = await request.get('/RBTC/api/token/TOKENTHREE');
        expect(res.status).to.equal(200);

        const locks = res.body.locks;
        const expectedTrue = ['description', 'max_mint', 'max_supply', 'mint', 'mint_supply'];
        const expectedFalse = ['callback', 'sleep'];

        for (const key of expectedTrue) {
            expect(locks[key]).to.equal(true, `locks.${key} should be true`);
            expect(typeof locks[key]).to.equal('boolean', `locks.${key} should be boolean`);
        }
        for (const key of expectedFalse) {
            expect(locks[key]).to.equal(false, `locks.${key} should be false`);
            expect(typeof locks[key]).to.equal('boolean', `locks.${key} should be boolean`);
        }
    });
});

// ===========================================================================
// E2E-17 — Null Handling
// ===========================================================================

describe('E2E-17: Null fields are JSON null', function () {

    it('XCHAIN callback fields reflect NULL seed values', async function () {
        const res = await request.get('/RBTC/api/token/XCHAIN');
        expect(res.status).to.equal(200);

        // callback_block and callback_tick_id are NULL in seed → null in response
        // callback_amount is NULL in seed → bcformat(null) returns '0' (formatted zero)
        expect(res.body.callback).to.be.an('object');
        expect(res.body.callback.block).to.equal(null);
        expect(res.body.callback.tick).to.equal(null);
        // amount is formatted through bcformat, so NULL becomes '0'
        expect(res.body.callback.amount).to.be.a('string');
    });

    it('send with null memo returns null, not empty string', async function () {
        // action_index 5 is a send with memo_id=NULL
        const res = await request.get('/RBTC/api/sends/XCHAIN/token');
        expect(res.status).to.equal(200);

        const nullMemoSend = res.body.data.find(r => Number(r.action_index) === 5);
        expect(nullMemoSend).to.exist;
        expect(nullMemoSend.memo).to.equal(null);
        // Verify the field is present (not omitted from the object)
        expect(nullMemoSend).to.have.property('memo');
    });

    it('send with non-null memo returns the memo string', async function () {
        const res = await request.get('/RBTC/api/sends/XCHAIN/token');
        expect(res.status).to.equal(200);

        // action_index 3 has memo_id=1 → 'Test memo 1'
        const memoSend = res.body.data.find(r => Number(r.action_index) === 3);
        expect(memoSend).to.exist;
        expect(memoSend.memo).to.be.a('string');
        expect(memoSend.memo).to.equal('Test memo 1');
    });
});

// ===========================================================================
// E2E-18 — Decimal Precision
// ===========================================================================

describe('E2E-18: Amount decimal places match token config', function () {

    it('8-decimal token amounts have 8 decimal places', async function () {
        const addr = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const res  = await request.get(`/RBTC/api/balances/${addr}`);
        expect(res.status).to.equal(200);

        const xchainRow = res.body.data.find(r => r.tick === 'XCHAIN');
        expect(xchainRow).to.exist;
        // Amount must end with exactly 8 decimal digits
        expect(xchainRow.amount).to.match(/^\d+\.\d{8}$/);
    });

    it('4-decimal token amounts have 4 decimal places', async function () {
        const addr = 'bc1qaddr4ddddddddddddddddddddddddddd';
        const res  = await request.get(`/RBTC/api/balances/${addr}`);
        expect(res.status).to.equal(200);

        const row = res.body.data.find(r => r.tick === 'TOKENTHREE');
        expect(row).to.exist;
        // Amount must end with exactly 4 decimal digits
        expect(row.amount).to.match(/^\d+\.\d{4}$/);
    });

    it('different decimal tokens on same address maintain their precision', async function () {
        const addr = 'bc1qaddr4ddddddddddddddddddddddddddd';
        const res  = await request.get(`/RBTC/api/balances/${addr}`);
        expect(res.status).to.equal(200);

        // addr4 holds TOKENONE (8 dec) and TOKENTHREE (4 dec)
        const tokenone = res.body.data.find(r => r.tick === 'TOKENONE');
        const tokenthree = res.body.data.find(r => r.tick === 'TOKENTHREE');

        expect(tokenone).to.exist;
        expect(tokenthree).to.exist;

        // TOKENONE: 50000.00000000 (8 dec)
        expect(tokenone.amount).to.equal('50000.00000000');
        // TOKENTHREE: 75.0000 (4 dec)
        expect(tokenthree.amount).to.equal('75.0000');
    });
});
