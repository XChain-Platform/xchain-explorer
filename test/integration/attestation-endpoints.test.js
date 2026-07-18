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
 * Integration tests: attestation endpoints 
 *
 * Covers the consolidated `attests` table surfaces: the REST list
 * (/api/attestations with block/address/contract filters), the explorer
 * DataTables route, and the attestations HTML page. Seeds one v0 request
 * row (correlated to contract 40 from the baseline seed) and its v1
 * response row, correlated by request_id.
 *
 * Requires: a MariaDB instance on port 3307 (see fixtures/docker-compose.test.yml)
 */

const { expect }    = require('chai');
const supertest     = require('supertest');
const db            = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

let request;

const ADDR1 = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR2 = 'bc1qaddr2bbbbbbbbbbbbbbbbbbbbbbbbbbb';

const REQUEST_ID = 'ab'.repeat(32);

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();

    // ATTEST action type + the actions/transactions chain the attests SELECT
    // joins through. Request lands in block 8 (tx source ADDR1), response in
    // block 9 (tx source ADDR2).
    await db.query(`INSERT IGNORE INTO index_actions (id, action) VALUES (30,'ATTEST')`);
    await db.query(`INSERT IGNORE INTO index_transactions (id, hash) VALUES
        (70,'attest_request_tx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        (71,'attest_response_tx_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')`);
    await db.query(`INSERT IGNORE INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES
        (70, 8, 70, 1),
        (71, 9, 71, 2)`);
    await db.query(`INSERT IGNORE INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES
        (200, 8, 70, 0, 30, 0),
        (201, 9, 71, 0, 30, 1)`);

    // v0 request row (emitted by contract 40, fee escrowed in XCHAIN)
    await db.query(`INSERT IGNORE INTO attests
        (action_index, version, request_id, provider_id, contract_index, fee_payer_id, payload,
         callback_method, callback_params_json, redundancy, deadline_block, gas_escrow,
         fee_tick_id, fee_amount, request_status, resolved_block, status_id, block_index) VALUES
        (200, 0, '${REQUEST_ID}', 'http_get', 40, 1, 'https://example.com/data.json',
         'onData', '["ctx"]', 3, 100, '1.00000000',
         1, '0.50000000', 'fulfilled', 9, 1, 8)`);

    // v1 response row for the same request_id
    await db.query(`INSERT IGNORE INTO attests
        (action_index, version, request_id, provider_id, response_hash, response_payload,
         response_status, meta, validator_signatures, status_id, block_index) VALUES
        (201, 1, '${REQUEST_ID}', 'http_get', '${'cd'.repeat(32)}', '{"price":42}',
         'ok', '200', '[{"pubkey":"${'ee'.repeat(32)}","sig":"${'ff'.repeat(32)}"}]', 1, 9)`);

    const { app } = await createApp();
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

// ===========================================================================
// REST list: /api/attestations
// ===========================================================================

describe('Attestation API (/api/attestations)', function () {

    it('lists both lifecycle rows, newest first', async function () {
        const res = await request.get('/RBTC/api/attestations');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(2);
        expect(res.body.data).to.be.an('array').with.lengthOf(2);

        // Default sort is DESC by action_index: response (201) then request (200)
        expect(Number(res.body.data[0].action_index)).to.equal(201);
        expect(Number(res.body.data[1].action_index)).to.equal(200);
    });

    it('surfaces the v0 request fields (provider, contract, fee, lifecycle)', async function () {
        const res = await request.get('/RBTC/api/attestations/8/block');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);

        const row = res.body.data[0];
        expect(Number(row.action_index)).to.equal(200);
        expect(Number(row.version)).to.equal(0);
        expect(row.request_id).to.equal(REQUEST_ID);
        expect(row.provider_id).to.equal('http_get');
        expect(Number(row.contract_index)).to.equal(40);
        expect(row.source).to.equal(ADDR1);
        expect(row.fee_payer).to.equal(ADDR1);
        expect(row.fee_tick).to.equal('XCHAIN');
        expect(row.request_status).to.equal('fulfilled');
        expect(row.payload).to.equal('https://example.com/data.json');
    });

    it('surfaces the v1 response fields correlated by request_id', async function () {
        const res = await request.get('/RBTC/api/attestations/9/block');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);

        const row = res.body.data[0];
        expect(Number(row.action_index)).to.equal(201);
        expect(Number(row.version)).to.equal(1);
        expect(row.request_id).to.equal(REQUEST_ID);
        expect(row.response_status).to.equal('ok');
        expect(row.response_payload).to.equal('{"price":42}');
        expect(row.source).to.equal(ADDR2);
    });

    it('filters by broadcasting address', async function () {
        const res = await request.get(`/RBTC/api/attestations/${ADDR1}/address`);

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);
        expect(Number(res.body.data[0].action_index)).to.equal(200);
    });

    it('filters by emitting contract (v0 rows only carry contract_index)', async function () {
        const res = await request.get('/RBTC/api/attestations/40/contract');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);
        expect(Number(res.body.data[0].action_index)).to.equal(200);
    });

    it('returns an empty result for a block with no attestations', async function () {
        const res = await request.get('/RBTC/api/attestations/1/block');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(0);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });

});

// ===========================================================================
// Explorer DataTables route + HTML page
// ===========================================================================

describe('Attestation explorer surfaces', function () {

    it('GET /RBTC/explorer/attestations/{block}/block returns DataTables format', async function () {
        const res = await request.get('/RBTC/explorer/attestations/8/block');

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('recordsTotal');
        expect(res.body).to.have.property('recordsFiltered');
        expect(res.body).to.have.property('data').that.is.an('array');
        expect(Number(res.body.recordsTotal)).to.equal(1);
        expect(res.body.data[0]).to.be.an('array');
    });

    it('GET /RBTC/attestations serves the attestations HTML page', async function () {
        const res = await request.get('/RBTC/attestations');

        expect(res.status).to.equal(200);
        expect(res.type).to.match(/text\/html/);
    });

});
