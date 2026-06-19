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
 * Integration tests: Single-Item API Endpoints
 *
 * Tests the /{COIN}/api/* endpoints that return a single record or a
 * focused summary (block, token, transaction, balances, holders,
 * credits, debits, address).
 *
 * Requires: a MariaDB instance on port 3307 (see fixtures/docker-compose.test.yml)
 * Run via: npm test (or npx mocha --timeout 0 test/integration/api-single-item.test.js)
 */

const { expect }    = require('chai');
const supertest     = require('supertest');
const db            = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

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
// Tests
// ---------------------------------------------------------------------------

describe('Single-Item API Endpoints', function () {

    // -----------------------------------------------------------------------
    // Block
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/block/{N}: returns block info', async function () {
        const res = await request.get('/RBTC/api/block/5');
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        expect(Number(res.body.block_index)).to.equal(5);
        // block 5 is inserted with block_time 1700002400 (seed: 1700000000 + 4*600)
        expect(Number(res.body.timestamp)).to.equal(1700002400);
        // ledger_hash comes from index_transactions id=25
        expect(res.body.ledger_hash).to.be.a('string').and.have.length.greaterThan(0);
    });

    // -----------------------------------------------------------------------
    // Balances
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/balances/{address}: returns all token balances', async function () {
        const addr = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const res  = await request.get(`/RBTC/api/balances/${addr}`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        // Address is echoed back at the top level
        expect(res.body.address).to.equal(addr);
        // addr1 holds TOKENONE, TOKENTWO, XCHAIN → 3 tokens
        expect(Number(res.body.total)).to.equal(3);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);
        // Each record must carry the expected fields
        const first = res.body.data[0];
        expect(first).to.have.all.keys(['tick', 'amount', 'supply', 'decimals', 'coin_price']);
        // Default sort is ASC on tick; TOKENONE < TOKENTWO < XCHAIN alphabetically
        expect(res.body.data[0].tick).to.equal('TOKENONE');
    });

    // -----------------------------------------------------------------------
    // Holders
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/holders/{tick}: returns token holders', async function () {
        const res = await request.get('/RBTC/api/holders/XCHAIN');
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        // Top-level summary fields lifted from first record
        expect(res.body.tick).to.equal('XCHAIN');
        expect(res.body.supply).to.be.a('string');
        expect(Number(res.body.decimals)).to.equal(8);
        // addr1(500000), addr2(200000), addr3(100000) all hold XCHAIN
        expect(Number(res.body.total)).to.be.at.least(3);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);
        const first = res.body.data[0];
        expect(first).to.have.property('address').that.is.a('string');
        expect(first).to.have.property('amount').that.is.a('string');
        // Default sort is DESC by ABS(amount), so addr1 (500000) should be first
        expect(first.address).to.equal('bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });

    // -----------------------------------------------------------------------
    // Token: standard fields and locks
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/token/{tick}: returns token detail', async function () {
        const res = await request.get('/RBTC/api/token/TOKENONE');
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');

        // Top-level sections (projects/registry are the Project_Registry.md
        // display surfaces added 2026-06)
        expect(res.body).to.have.all.keys(['callback', 'info', 'lists', 'locks', 'market', 'mints', 'projects', 'registry', 'runtime', 'supply']);

        // info section
        expect(res.body.info).to.be.an('object');
        expect(res.body.info.tick).to.equal('TOKENONE');
        expect(res.body.info.description).to.equal('Test Token One');
        expect(res.body.info.owner).to.be.a('string');
        expect(res.body.info.coin).to.be.a('string');

        // locks section: TOKENONE has lock_max_supply=1, rest are 0
        expect(res.body.locks).to.be.an('object');
        expect(res.body.locks.max_supply).to.equal(true);
        expect(res.body.locks.mint).to.equal(false);

        // supply section: values are formatted strings
        expect(res.body.supply.current).to.be.a('string');
        expect(res.body.supply.max).to.be.a('string');
    });

    it('GET /RBTC/api/token/{tick}: token with all locks', async function () {
        const res = await request.get('/RBTC/api/token/TOKENTHREE');
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');

        const locks = res.body.locks;
        expect(locks).to.be.an('object');

        // TOKENTHREE seed: lock_max_supply=1, lock_mint=1, lock_mint_supply=1,
        //                  lock_max_mint=1, lock_description=1, lock_sleep=0, lock_callback=0
        expect(locks.callback).to.equal(false);
        expect(locks.description).to.equal(true);
        expect(locks.max_mint).to.equal(true);
        expect(locks.max_supply).to.equal(true);
        expect(locks.mint).to.equal(true);
        expect(locks.mint_supply).to.equal(true);
        expect(locks.sleep).to.equal(false);
    });

    // -----------------------------------------------------------------------
    // Transaction: by hash
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/transaction/{hash}/tx_hash: returns transaction by hash', async function () {
        // tx_index=1 uses hash 'aaa1111...111' (index_transactions id=1)
        const hash = 'aaa1111111111111111111111111111111111111111111111111111111111111';
        const res  = await request.get(`/RBTC/api/transaction/${hash}/tx_hash`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        expect(Number(res.body.tx_index)).to.equal(1);
        expect(Number(res.body.block_index)).to.equal(1);
        expect(res.body.source).to.be.a('string');
        expect(res.body.actions).to.be.an('array');
    });

    // -----------------------------------------------------------------------
    // Transaction: by index
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/transaction/{index}/tx_index: returns transaction by index', async function () {
        const res = await request.get('/RBTC/api/transaction/1/tx_index');
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        expect(Number(res.body.tx_index)).to.equal(1);
        expect(Number(res.body.block_index)).to.equal(1);
        expect(res.body.source).to.be.a('string');
        expect(res.body.actions).to.be.an('array');
    });

    // -----------------------------------------------------------------------
    // Credits
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/credits/{address}/address: returns credits for address', async function () {
        const addr = 'bc1qaddr2bbbbbbbbbbbbbbbbbbbbbbbbbbb';
        const res  = await request.get(`/RBTC/api/credits/${addr}/address`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        // addr2 has credit rows at action_index 3, 10, 18, 19
        expect(Number(res.body.total)).to.be.at.least(3);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);
        const first = res.body.data[0];
        const expectedFields = [
            'action_index', 'tx_index', 'address', 'tick',
            'amount', 'action', 'block_index', 'timestamp', 'tx_hash'
        ];
        expect(first).to.have.all.keys(expectedFields);
    });

    // -----------------------------------------------------------------------
    // Debits
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/debits/{address}/address: returns debits for address', async function () {
        const addr = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const res  = await request.get(`/RBTC/api/debits/${addr}/address`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        // addr1 has debit rows at action_index 3, 6, 9, 19
        expect(Number(res.body.total)).to.be.at.least(3);
        expect(res.body.data).to.be.an('array').with.length.greaterThan(0);
    });

    // -----------------------------------------------------------------------
    // Error cases
    // -----------------------------------------------------------------------

    it('nonexistent block returns 400', async function () {
        const res = await request.get('/RBTC/api/block/999999');
        expect(res.status).to.equal(400);
        expect(res.body).to.be.an('object');
        expect(res.body.error).to.be.a('string');
    });

    it('nonexistent token returns 400', async function () {
        const res = await request.get('/RBTC/api/token/DOESNOTEXIST');
        expect(res.status).to.equal(400);
        expect(res.body).to.be.an('object');
        expect(res.body.error).to.be.a('string');
    });

    // -----------------------------------------------------------------------
    // Address summary (stub)
    // -----------------------------------------------------------------------

    it('GET /RBTC/api/address/{addr}: returns address summary', async function () {
        const addr = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
        const res  = await request.get(`/RBTC/api/address/${addr}`);
        expect(res.status).to.equal(200);
        expect(res.body).to.be.an('object');
        // getAddress() currently returns a hardcoded stub; the address field is always present
        expect(res.body.address).to.exist;
    });

});
