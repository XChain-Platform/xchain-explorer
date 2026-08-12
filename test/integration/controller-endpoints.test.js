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
 * Integration tests: Controller + Permissions-Manifest surfaces
 * (protocol/Controller_Bound_Tokens.md)
 *
 * Covers:
 *   - /{COIN}/api/contract/{idx}: `permissions` (parsed JSON array | null)
 *     and `max_take_bps` (number | null) from the permissions manifest
 *   - /{COIN}/api/token/{tick}: `controllers[]` (gating token bindings)
 *   - /{COIN}/api/address/{addr}: `controllers[]` (gating address bindings)
 *   - Read-time cooldown: a `bind` always gates; an `unbind` gates only while
 *     the chain tip is below cooldown_end_block; latest event per class wins
 *   - Defaults: null manifest fields, [] when nothing gates
 *
 * Boots a real Express app against a test MariaDB on port 3307.
 *
 * Run: npm run test:integration  (or: mocha --timeout 0 test/integration/controller-endpoints.test.js)
 *********************************************************************/

'use strict';

const { expect }    = require('chai');
const supertest     = require('supertest');
const db            = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

let request;

// The baseline seed loads blocks 1..10, so the chain tip (MAX(block_index)) is
// 10. Cooldown gating is resolved against this tip.
const TIP = 10;

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();

    // DEPLOY action type (not in the baseline index_actions set) + the actions/
    // transactions chain the contract SELECT joins through.
    await db.query(`INSERT IGNORE INTO index_actions (id, action) VALUES (20,'DEPLOY')`);
    await db.query(`INSERT IGNORE INTO index_addresses (id, address) VALUES (60,'bc1qdeployerxxxxxxxxxxxxxxxxxxxxxxx')`);
    await db.query(`INSERT IGNORE INTO index_transactions (id, hash) VALUES (60,'contract_deploy_tx_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`);
    await db.query(`INSERT IGNORE INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES (60, 5, 60, 60)`);
    await db.query(`INSERT IGNORE INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES (90, 5, 60, 0, 20, 0)`);

    // --- Manifested contract (action_index 90) -----------------------------
    await db.query(`INSERT IGNORE INTO contracts (action_index, source_id, code, code_hash, api_version, status_id, block_index) VALUES
        (90, 60, 'module.exports={}', 'cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe', 1, 1, 5)`);
    await db.query(`INSERT IGNORE INTO contract_permissions (action_index, contract_index, permissions, max_take_bps, block_index) VALUES
        (90, 90, '["send","mint"]', 300, 5)`);

    // --- Unmanifested contract (action_index 91): no permissions row -------
    await db.query(`INSERT IGNORE INTO index_transactions (id, hash) VALUES (61,'contract_deploy_tx2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')`);
    await db.query(`INSERT IGNORE INTO transactions (tx_index, block_index, tx_hash_id, source_id) VALUES (61, 6, 61, 60)`);
    await db.query(`INSERT IGNORE INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES (91, 6, 61, 0, 20, 0)`);
    await db.query(`INSERT IGNORE INTO contracts (action_index, source_id, code, code_hash, api_version, status_id, block_index) VALUES
        (91, 60, 'module.exports={}', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef0', 1, 1, 6)`);

    // --- Token controller bindings (TOKENONE = tick_id 2) -------------------
    // transfer → guard 90 (active bind)
    await db.query(`INSERT IGNORE INTO token_controllers
        (action_index, tick_id, action_class, contract_index, bound_by_id, is_unbind, cooldown_blocks, cooldown_end_block, block_index) VALUES
        (100, 2, 'transfer', 90, 1, 0, 0, NULL, 3)`);
    // trade → bind then a later bind to a different guard (latest wins → 91)
    await db.query(`INSERT IGNORE INTO token_controllers
        (action_index, tick_id, action_class, contract_index, bound_by_id, is_unbind, cooldown_blocks, cooldown_end_block, block_index) VALUES
        (101, 2, 'trade', 90, 1, 0, 0, NULL, 3),
        (102, 2, 'trade', 91, 1, 0, 0, NULL, 4)`);
    // burn → bind then unbind PAST cooldown (cooldown_end_block 8 <= tip 10 → no longer gates)
    await db.query(`INSERT IGNORE INTO token_controllers
        (action_index, tick_id, action_class, contract_index, bound_by_id, is_unbind, cooldown_blocks, cooldown_end_block, block_index) VALUES
        (103, 2, 'burn', 90, 1, 0, 5, NULL, 2),
        (104, 2, 'burn', 90, 1, 1, 5, 8, 5)`);
    // mint → bind then unbind STILL in cooldown (cooldown_end_block 15 > tip 10 → gating, Unbinding)
    await db.query(`INSERT IGNORE INTO token_controllers
        (action_index, tick_id, action_class, contract_index, bound_by_id, is_unbind, cooldown_blocks, cooldown_end_block, block_index) VALUES
        (105, 2, 'mint', 91, 1, 0, 5, NULL, 3),
        (106, 2, 'mint', 91, 1, 1, 5, 15, 9)`);

    // --- A token with NO bindings (TOKENTWO = tick_id 3): no rows ----------

    // --- Address controller bindings (addr id 1) ---------------------------
    await db.query(`INSERT IGNORE INTO address_controllers
        (action_index, address_id, action_class, contract_index, is_unbind, cooldown_blocks, cooldown_end_block, block_index) VALUES
        (110, 1, 'stake', 90, 0, 0, NULL, 4)`);
    // address with an expired unbind only → not gating
    await db.query(`INSERT IGNORE INTO address_controllers
        (action_index, address_id, action_class, contract_index, is_unbind, cooldown_blocks, cooldown_end_block, block_index) VALUES
        (111, 2, 'transfer', 90, 0, 3, NULL, 2),
        (112, 2, 'transfer', 90, 1, 3, 7, 4)`);

    const { app } = await createApp();
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

// ===========================================================================
// Contract permissions manifest
// ===========================================================================

// action_index is a DECIMAL STRING on the wire, not a number. These two cases
// asserted the number until : 9fe00ec had coerced getContract's BIGINT
// with Number() to satisfy them, three days before 38cc1d9 standardized
// BIGINT-as-string across REST and WS as an explicit BREAKING CHANGE. The
// coercion is the remnant, so the assertions move to the standardized type
// rather than the code moving back. block_index in this same response was
// always a string; test/unit/ws/serialize.test.js pins REST===WS.
describe('Contract API (/api/contract/{idx}): permissions manifest', function () {

    it('surfaces a parsed permissions array and numeric max_take_bps', async function () {
        const res = await request.get('/RBTC/api/contract/90');
        expect(res.status).to.equal(200);
        expect(res.body.action_index).to.equal('90');
        expect(res.body.permissions).to.deep.equal(['send', 'mint']);
        expect(res.body.max_take_bps).to.equal(300);
    });

    it('returns permissions=null / max_take_bps=null for a contract with no manifest', async function () {
        const res = await request.get('/RBTC/api/contract/91');
        expect(res.status).to.equal(200);
        expect(res.body.action_index).to.equal('91');
        expect(res.body.permissions).to.equal(null);
        expect(res.body.max_take_bps).to.equal(null);
    });
});

// ===========================================================================
// Token controller bindings
// ===========================================================================

describe('Token API (/api/token/{tick}): controllers[]', function () {

    it('lists only the bindings still gating at the chain tip', async function () {
        const res = await request.get('/RBTC/api/token/TOKENONE');
        expect(res.status).to.equal(200);
        expect(res.body.controllers).to.be.an('array');
        const byClass = {};
        for (const c of res.body.controllers) byClass[c.action_class] = c;

        // transfer: active bind
        expect(byClass.transfer).to.include({ contract_index: 90, is_unbind: 0 });
        // trade: latest bind (91) supersedes the earlier (90)
        expect(byClass.trade).to.include({ contract_index: 91, is_unbind: 0 });
        // mint: unbind still in cooldown → gating, flagged unbinding
        expect(byClass.mint).to.include({ contract_index: 91, is_unbind: 1 });
        // burn: unbind past cooldown → NOT present
        expect(byClass.burn).to.equal(undefined);
    });

    it('carries the shared binding shape', async function () {
        const res = await request.get('/RBTC/api/token/TOKENONE');
        const c = res.body.controllers.find(x => x.action_class === 'transfer');
        expect(c).to.have.keys(['action_class', 'contract_index', 'cooldown_blocks', 'is_unbind', 'bind_block', 'bound_by']);
    });

    it('returns an empty controllers array for a token with no bindings', async function () {
        const res = await request.get('/RBTC/api/token/TOKENTWO');
        expect(res.status).to.equal(200);
        expect(res.body.controllers).to.be.an('array').with.lengthOf(0);
    });
});

// ===========================================================================
// Address controller bindings
// ===========================================================================

describe('Address API (/api/address/{addr}): controllers[]', function () {

    const ADDR1 = 'bc1qaddr1aaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const ADDR2 = 'bc1qaddr2bbbbbbbbbbbbbbbbbbbbbbbbbbb';

    it('lists the address bindings still gating at the chain tip', async function () {
        const res = await request.get('/RBTC/api/address/' + ADDR1);
        expect(res.status).to.equal(200);
        expect(res.body.controllers).to.be.an('array').with.lengthOf(1);
        expect(res.body.controllers[0]).to.include({ action_class: 'stake', contract_index: 90, is_unbind: 0 });
    });

    it('returns [] when the only event is an unbind past its cooldown', async function () {
        const res = await request.get('/RBTC/api/address/' + ADDR2);
        expect(res.status).to.equal(200);
        expect(res.body.controllers).to.be.an('array').with.lengthOf(0);
    });

    it('returns [] for an address with no controller events', async function () {
        const res = await request.get('/RBTC/api/address/bc1qaddr5eeeeeeeeeeeeeeeeeeeeeeeeeee');
        expect(res.status).to.equal(200);
        expect(res.body.controllers).to.be.an('array').with.lengthOf(0);
    });
});
