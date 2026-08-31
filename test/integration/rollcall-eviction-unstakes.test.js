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
 * Integration tests: ROLLCALL eviction rows in the UNSTAKE surfaces.
 *
 * A validator that misses K roll-call epochs is evicted by the BTC indexer
 * (xchain-indexer/src/rollcall_close.js evictSource()), which writes:
 *   - an `actions` row with action_format=3, tx_index NULL, source_id NULL
 *     (no user broadcast it, so there is no transaction behind it)
 *   - an `unstakes` row (STATUS 'valid') keyed to that same action_index,
 *     naming the evicted source/pubkey directly (source_id/signing_pubkey_id
 *     are always set by the indexer, synthetic or not)
 *
 * db.js#getUnstakes previously joined transactions/blocks as
 * actions -> INNER transactions -> INNER blocks(t1.block_index). A NULL
 * tx_index satisfies neither INNER join, so the eviction row silently
 * vanished from both /api/unstakes (count and rows) and the DataTables
 * /explorer/unstakes feed - the exact defect this suite exercises against a
 * real MariaDB, since a mocked query (the unit-test tier) cannot fail on a
 * join it never executes.
 *
 * One ordinary (user-broadcast, real transaction) UNSTAKE is seeded as a
 * control alongside the synthetic eviction, so the fix is checked against
 * "both rows show up", not "the query merely stops throwing".
 *
 * Requires: a MariaDB instance on port 3307 (see fixtures/docker-compose.test.yml)
 */

const { expect }    = require('chai');
const supertest     = require('supertest');
const db            = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

let request;

const VALIDATOR_ADDR = 'bc1qvalidatoraaaaaaaaaaaaaaaaaaaaaaaaaaa';
const USER_ADDR      = 'bc1quseraddrbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const PUBKEY_EVICTED = 'ee'.repeat(32);
const PUBKEY_USER    = 'dd'.repeat(32);

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();

    // Baseline seed already owns index_addresses 1-5, index_actions 1-10,
    // index_statuses 1-2 ('valid'/'invalid'), blocks 1-10 and actions 1-40 -
    // every id/index below is picked clear of that range so this file's rows
    // never silently collide with (and get INSERT IGNOREd behind) the baseline's.
    await db.query(`INSERT IGNORE INTO index_actions (id, action) VALUES (33,'UNSTAKE')`);
    await db.query(`INSERT IGNORE INTO index_pubkeys (id, pubkey) VALUES (10,'${PUBKEY_EVICTED}'), (11,'${PUBKEY_USER}')`);
    await db.query(`INSERT IGNORE INTO index_addresses (id, address) VALUES (6,'${USER_ADDR}'), (7,'${VALIDATOR_ADDR}')`);

    // Fresh blocks: baseline only carries block_index 1-10. ledger/actions hash
    // ids are nullable and carry no real FK (schema.sql declares none), so NULL
    // is fine here - nothing under test reads them.
    await db.query(`INSERT IGNORE INTO blocks (id, block_index, block_time, ledger_hash_id, actions_hash_id) VALUES
        (11, 20, 1700100000, NULL, NULL),
        (12, 25, 1700100500, NULL, NULL)`);

    // Control row: an ordinary, user-broadcast UNSTAKE with a real transaction.
    await db.query(`INSERT IGNORE INTO index_transactions (id, hash) VALUES
        (90,'unstake_tx_1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`);
    await db.query(`INSERT IGNORE INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES
        (90, 20, 90, 6)`);
    await db.query(`INSERT IGNORE INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id) VALUES
        (300, 20, 90, 0, 33, 0, 6)`);
    await db.query(`INSERT IGNORE INTO unstakes
        (action_index, source_id, signing_pubkey_id, amount, cooldown_end_block, status_id, block_index) VALUES
        (300, 6, 11, '750.00000000', 1020, 1, 20)`);

    // ROLLCALL eviction: synthetic actions row (tx_index NULL, source_id NULL),
    // matching unstakes row carries the real source/pubkey/amount and status 'valid'.
    await db.query(`INSERT IGNORE INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id) VALUES
        (301, 25, NULL, NULL, 33, 3, NULL)`);
    await db.query(`INSERT IGNORE INTO unstakes
        (action_index, source_id, signing_pubkey_id, amount, cooldown_end_block, status_id, block_index) VALUES
        (301, 7, 10, '5000.00000000', 1025, 1, 25)`);

    const { app } = await createApp();
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

describe('ROLLCALL eviction: /api/unstakes surfaces a synthetic UNSTAKE with no transaction', function () {

    it('counts both the ordinary unstake and the eviction (tx_index NULL does not drop the row)', async function () {
        const res = await request.get('/RBTC/api/unstakes');

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(2);
    });

    it('lists the eviction row with its own block/timestamp, no tx_hash, and status valid', async function () {
        const res = await request.get('/RBTC/api/unstakes');

        expect(res.status).to.equal(200);
        const row = res.body.data.find((r) => Number(r.action_index) === 301);
        expect(row, 'eviction row present in the list').to.exist;
        expect(Number(row.action_format)).to.equal(3);
        expect(row.source).to.equal(VALIDATOR_ADDR);
        expect(row.signing_pubkey).to.equal(PUBKEY_EVICTED);
        expect(row.amount).to.equal('5000.00000000');
        // block_index/timestamp came off a1.block_index via the blocks join, not
        // through a transaction the synthetic action never has.
        expect(Number(row.block_index)).to.equal(25);
        expect(row.timestamp).to.not.be.undefined;
        expect(row.tx_hash).to.equal(null);
        expect(row.tx_index).to.equal(null);
        expect(row.status).to.equal('valid');
    });

    it('still lists the ordinary user-broadcast unstake, unaffected by the join change', async function () {
        const res = await request.get('/RBTC/api/unstakes');

        const row = res.body.data.find((r) => Number(r.action_index) === 300);
        expect(row, 'control row present').to.exist;
        expect(row.source).to.equal(USER_ADDR);
        expect(Number(row.block_index)).to.equal(20);
        expect(row.status).to.equal('valid');
    });

    it('filters by the evicted validator source address and still finds the eviction row', async function () {
        const res = await request.get(`/RBTC/api/unstakes/${VALIDATOR_ADDR}/source`);

        expect(res.status).to.equal(200);
        expect(Number(res.body.total)).to.equal(1);
        expect(Number(res.body.data[0].action_index)).to.equal(301);
    });

    it('serves the DataTables /explorer/unstakes feed with both rows', async function () {
        const res = await request.get('/RBTC/explorer/unstakes');

        expect(res.status).to.equal(200);
        expect(Number(res.body.recordsTotal)).to.equal(2);
    });

    it('the eviction action still renders on its own /api/action page (staking.js UNSTAKE detail was already correct)', async function () {
        const res = await request.get('/RBTC/api/action/301');

        expect(res.status).to.equal(200);
        expect(res.body.action).to.equal('UNSTAKE');
        expect(Number(res.body.action_format)).to.equal(3);
        expect(res.body.amount).to.equal('5000.00000000');
        expect(res.body.status).to.equal('valid');
    });

});
