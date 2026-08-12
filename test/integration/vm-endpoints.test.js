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
 * Integration tests: VM list endpoints
 *
 * Covers the executions / deposits / withdrawals REST surfaces around
 * contract 40 (deployed by the baseline seed with a constructor
 * execution), the explorer DataTables route, and the VM HTML pages.
 * The contract page itself + read-only simulation are covered by
 * contract-endpoints.test.js.
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
const ADDR3 = 'bc1qaddr3ccccccccccccccccccccccccccc';

const CONTRACT_IDX = 40; // deployed by the baseline seed

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();

    // EXECUTE / DEPOSIT / WITHDRAW action types + the actions/transactions
    // chain the VM list SELECTs join through. All target contract 40.
    await db.query(`INSERT IGNORE INTO index_actions (id, action) VALUES (33,'EXECUTE'), (34,'DEPOSIT'), (35,'WITHDRAW')`);
    await db.query(`INSERT IGNORE INTO index_transactions (id, hash) VALUES
        (85,'vm_execute_tx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        (86,'vm_deposit_tx_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
        (87,'vm_withdraw_tx_ccccccccccccccccccccccccccccccccccccccccccccccccc')`);
    await db.query(`INSERT IGNORE INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES
        (85, 9, 85, 2),
        (86, 9, 86, 3),
        (87, 10, 87, 2)`);
    await db.query(`INSERT IGNORE INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES
        (220, 9, 85, 0, 33, 0),
        (221, 9, 86, 0, 34, 0),
        (222, 10, 87, 0, 35, 0)`);

    // A post-deploy method call on contract 40 (the baseline seed already
    // wrote the constructor execution at action_index 40).
    await db.query(`INSERT IGNORE INTO contract_executions
        (action_index, contract_index, caller_id, method_name, input_params, gas_used, gas_limit, status_id, error_message, emitted_count, block_index) VALUES
        (220, ${CONTRACT_IDX}, 2, 'greet', NULL, 900, 50000, 1, NULL, 0, 9)`);

    // Custody movements: ADDR3 deposits XCHAIN, ADDR2 withdraws XCHAIN
    await db.query(`INSERT IGNORE INTO deposits
        (action_index, contract_index, source_id, tick_id, amount, status_id, block_index) VALUES
        (221, ${CONTRACT_IDX}, 3, 1, '25.00000000', 1, 9)`);
    await db.query(`INSERT IGNORE INTO withdrawals
        (action_index, contract_index, source_id, tick_id, amount, status_id, block_index) VALUES
        (222, ${CONTRACT_IDX}, 2, 1, '10.00000000', 1, 10)`);

    const { app } = await createApp();
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

describe('VM API (/api/executions)', function () {

    it('lists constructor + method executions, newest first', async function () {
        const res = await request.get('/RBTC/api/executions');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(2);
        expect(Number(res.body.data[0].action_index)).to.equal(220);
        expect(Number(res.body.data[1].action_index)).to.equal(40);
    });

    it('surfaces the execution fields (caller, method, gas)', async function () {
        const res = await request.get('/RBTC/api/executions/9/block');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);

        const row = res.body.data[0];
        expect(Number(row.action_index)).to.equal(220);
        expect(Number(row.contract_index)).to.equal(CONTRACT_IDX);
        expect(row.caller).to.equal(ADDR2);
        expect(row.method_name).to.equal('greet');
        expect(Number(row.gas_used)).to.equal(900);
        expect(Number(row.gas_limit)).to.equal(50000);
        expect(row.status).to.equal('valid');
    });

    it('filters executions by contract', async function () {
        const res = await request.get(`/RBTC/api/executions/${CONTRACT_IDX}/contract`);

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(2);
        for (const row of res.body.data) {
            expect(Number(row.contract_index)).to.equal(CONTRACT_IDX);
        }
    });

});

describe('VM API (/api/deposits)', function () {

    it('filters deposits by contract and surfaces tick + amount', async function () {
        const res = await request.get(`/RBTC/api/deposits/${CONTRACT_IDX}/contract`);

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);

        const row = res.body.data[0];
        expect(Number(row.action_index)).to.equal(221);
        expect(row.source).to.equal(ADDR3);
        expect(row.tick).to.equal('XCHAIN');
        expect(row.amount).to.equal('25.00000000');
        expect(row.status).to.equal('valid');
    });

    it('filters deposits by source address', async function () {
        const res = await request.get(`/RBTC/api/deposits/${ADDR3}/source`);

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);
        expect(Number(res.body.data[0].action_index)).to.equal(221);
    });

});

describe('VM API (/api/withdrawals)', function () {

    it('filters withdrawals by block and surfaces tick + amount', async function () {
        const res = await request.get('/RBTC/api/withdrawals/10/block');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);

        const row = res.body.data[0];
        expect(Number(row.action_index)).to.equal(222);
        expect(Number(row.contract_index)).to.equal(CONTRACT_IDX);
        expect(row.source).to.equal(ADDR2);
        expect(row.tick).to.equal('XCHAIN');
        expect(row.amount).to.equal('10.00000000');
    });

    it('returns an empty result for an address with no withdrawals', async function () {
        const res = await request.get(`/RBTC/api/withdrawals/${ADDR1}/source`);

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(0);
        expect(res.body.data).to.be.an('array').with.lengthOf(0);
    });

});

describe('VM explorer surfaces', function () {

    it('GET /RBTC/explorer/executions/{contract}/contract returns DataTables format', async function () {
        const res = await request.get(`/RBTC/explorer/executions/${CONTRACT_IDX}/contract`);

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('recordsTotal');
        expect(res.body).to.have.property('recordsFiltered');
        expect(res.body).to.have.property('data').that.is.an('array');
        expect(Number(res.body.recordsTotal)).to.equal(2);
        expect(res.body.data[0]).to.be.an('array');
    });

    it('serves the VM HTML pages', async function () {
        for (const page of ['executions', 'deposits', 'withdrawals']) {
            const res = await request.get(`/RBTC/${page}`);
            expect(res.status, page).to.equal(200);
            expect(res.type, page).to.match(/text\/html/);
        }
    });

});
