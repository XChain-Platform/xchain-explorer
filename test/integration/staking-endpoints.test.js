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
 * Integration tests: capability staking endpoints 
 *
 * Covers the stakes / validators / delegations / rewards REST surfaces,
 * the explorer DataTables route, and the staking HTML pages. Seeds two
 * STAKE actions (one valid, one invalid: validators must list only the
 * valid one), one DELEGATE, and two validator_rewards accrual rows.
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

const PUBKEY1 = 'aa'.repeat(32);
const PUBKEY2 = 'bb'.repeat(32);

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();

    // STAKE / DELEGATE action types + signing pubkeys + the actions/
    // transactions chain the staking SELECTs join through.
    await db.query(`INSERT IGNORE INTO index_actions (id, action) VALUES (31,'STAKE'), (32,'DELEGATE')`);
    await db.query(`INSERT IGNORE INTO index_pubkeys (id, pubkey) VALUES (1,'${PUBKEY1}'), (2,'${PUBKEY2}')`);
    await db.query(`INSERT IGNORE INTO index_transactions (id, hash) VALUES
        (80,'stake_tx_1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
        (81,'stake_tx_2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
        (82,'delegate_tx_1_ccccccccccccccccccccccccccccccccccccccccccccccccccc')`);
    await db.query(`INSERT IGNORE INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES
        (80, 5, 80, 1),
        (81, 6, 81, 2),
        (82, 7, 82, 1)`);
    await db.query(`INSERT IGNORE INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES
        (210, 5, 80, 0, 31, 1),
        (211, 6, 81, 0, 31, 1),
        (212, 7, 82, 0, 32, 2)`);

    // Valid stake (ADDR1, pubkey 1) + invalid stake (ADDR2, pubkey 2)
    await db.query(`INSERT IGNORE INTO stakes
        (action_index, source_id, version, signing_pubkey_id, amount, status_id, block_index, activation_block, deactivation_block) VALUES
        (210, 1, 1, 1, '1000.00000000', 1, 5, 15, NULL),
        (211, 2, 1, 2, '500.00000000',  2, 6, 16, NULL)`);

    // Delegation: ADDR1 delegates signing to pubkey 2
    await db.query(`INSERT IGNORE INTO delegations
        (action_index, source_id, signing_pubkey_id, status_id, block_index, activation_block, deactivation_block) VALUES
        (212, 1, 2, 1, 7, 17, NULL)`);

    // Reward accrual ledger rows (id-keyed, no actions chain)
    await db.query(`INSERT IGNORE INTO validator_rewards
        (id, source_id, signing_pubkey_id, reward_type, round_reference, amount, block_index) VALUES
        (1, 1, 1, 'oracle_base', 42, '1.50000000', 8),
        (2, 2, 2, 'attest_fee',  43, '0.25000000', 9)`);

    const { app } = await createApp();
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

// ===========================================================================
// Stakes
// ===========================================================================

describe('Staking API (/api/stakes)', function () {

    it('lists all stake rows regardless of validity, newest first', async function () {
        const res = await request.get('/RBTC/api/stakes');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(2);
        expect(Number(res.body.data[0].action_index)).to.equal(211);
        expect(Number(res.body.data[1].action_index)).to.equal(210);
    });

    it('surfaces the capability-model fields (pubkey, version, activation window)', async function () {
        const res = await request.get('/RBTC/api/stakes/5/block');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);

        const row = res.body.data[0];
        expect(Number(row.action_index)).to.equal(210);
        expect(row.source).to.equal(ADDR1);
        expect(row.signing_pubkey).to.equal(PUBKEY1);
        expect(Number(row.version)).to.equal(1);
        expect(row.amount).to.equal('1000.00000000');
        expect(Number(row.activation_block)).to.equal(15);
        expect(row.deactivation_block).to.equal(null);
        expect(row.status).to.equal('valid');
    });

    it('filters by staking source address', async function () {
        const res = await request.get(`/RBTC/api/stakes/${ADDR2}/source`);

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);
        expect(Number(res.body.data[0].action_index)).to.equal(211);
        expect(res.body.data[0].status).to.equal('invalid');
    });

});

// ===========================================================================
// Validators (valid stakes only)
// ===========================================================================

describe('Staking API (/api/validators)', function () {

    it('lists only valid stake rows', async function () {
        const res = await request.get('/RBTC/api/validators');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);
        expect(Number(res.body.data[0].action_index)).to.equal(210);
        expect(res.body.data[0].signing_pubkey).to.equal(PUBKEY1);
        expect(res.body.data[0].status).to.equal('valid');
    });

});

// ===========================================================================
// Delegations
// ===========================================================================

describe('Staking API (/api/delegations)', function () {

    it('filters delegations by delegating address', async function () {
        const res = await request.get(`/RBTC/api/delegations/${ADDR1}/address`);

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);

        const row = res.body.data[0];
        expect(Number(row.action_index)).to.equal(212);
        expect(row.source).to.equal(ADDR1);
        expect(row.signing_pubkey).to.equal(PUBKEY2);
        expect(Number(row.activation_block)).to.equal(17);
    });

    it('filters delegations by block', async function () {
        const res = await request.get('/RBTC/api/delegations/7/block');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);
        expect(Number(res.body.data[0].action_index)).to.equal(212);
    });

});

// ===========================================================================
// Rewards (accrual ledger; id-keyed, no actions chain)
// ===========================================================================

describe('Staking API (/api/rewards)', function () {

    it('filters reward accruals by staking address', async function () {
        const res = await request.get(`/RBTC/api/rewards/${ADDR1}/address`);

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);

        const row = res.body.data[0];
        expect(row.source).to.equal(ADDR1);
        expect(row.signing_pubkey).to.equal(PUBKEY1);
        expect(row.reward_type).to.equal('oracle_base');
        expect(Number(row.round_reference)).to.equal(42);
        expect(row.amount).to.equal('1.50000000');
        expect(Number(row.block_index)).to.equal(8);
    });

});

// ===========================================================================
// Explorer DataTables routes + HTML pages
// ===========================================================================

describe('Staking explorer surfaces', function () {

    it('GET /RBTC/explorer/stakes/{address}/address returns DataTables format', async function () {
        const res = await request.get(`/RBTC/explorer/stakes/${ADDR1}/address`);

        expect(res.status).to.equal(200);
        expect(res.body).to.have.property('recordsTotal');
        expect(res.body).to.have.property('recordsFiltered');
        expect(res.body).to.have.property('data').that.is.an('array');
        expect(Number(res.body.recordsTotal)).to.equal(1);
        expect(res.body.data[0]).to.be.an('array');
    });

    it('serves the staking HTML pages', async function () {
        for (const page of ['stakes', 'validators', 'delegations', 'rewards']) {
            const res = await request.get(`/RBTC/${page}`);
            expect(res.status, page).to.equal(200);
            expect(res.type, page).to.match(/text\/html/);
        }
    });

});
