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
 * Integration tests: Project Registry surfaces (protocol/Project_Registry.md)
 *
 * Covers:
 *   - /{COIN}/api/project/{TICK}: current roster resolution (latest
 *     owner-valid TICK-type LIST linked to the project's ISSUE wins)
 *   - /{COIN}/api/token/{TICK}: `projects` (membership banners) and
 *     `registry` (own-roster metadata) fields
 *   - /{COIN}/explorer/projects/{TICK}/roster: datatable rows
 *   - Ignore rules: superseded rosters, unlinked lists, invalid links,
 *     reverse-orientation links, ADDRESS-type lists
 *
 * Boots a real Express app against a test MariaDB on port 3307.
 *
 * Run: npm run test:integration  (or: mocha --timeout 0 test/integration/project-endpoints.test.js)
 *********************************************************************/

'use strict';

const { expect }    = require('chai');
const supertest     = require('supertest');
const db            = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

let request;

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();

    // --- Project tick PROJECTX (id/action 70) ------------------------------
    await db.query(`INSERT IGNORE INTO index_tickers (id, tick) VALUES (70,'PROJECTX')`);
    await db.query(`INSERT IGNORE INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format) VALUES (70,5,9,0,2,0)`);
    await db.query(`INSERT IGNORE INTO issues (action_index, tick_id, max_supply, decimals, description, lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_sleep, lock_callback, status_id) VALUES
        (70, 70, '1', '0', 'Project registry tick', '1','0','0','0','0','0','0', 1)`);
    await db.query(`INSERT IGNORE INTO tokens (id, tick_id, action_index, last_action_index, supply, max_supply, decimals, description,
        lock_max_supply, lock_mint, lock_mint_supply, lock_max_mint, lock_description, lock_sleep, lock_callback, owner_id, coin_price, coin_floor) VALUES
        (70, 70, 70, 70, '1', '1', 0, 'Project registry tick', 1,0,0,0,0,0,0, 1, '0', '0')`);

    // --- Roster A (superseded): LIST 71 = [TOKENONE], LINK 72 ---------------
    await db.query(`INSERT IGNORE INTO lists (action_index, type, edit, list_action_index, status_id) VALUES (71,'1',NULL,NULL,1)`);
    await db.query(`INSERT IGNORE INTO list_items (action_index, item_id) VALUES (71,2)`);
    await db.query(`INSERT IGNORE INTO links (action_index, coin1_id, coin1_action_index, coin2_id, coin2_action_index, memo_id, status_id) VALUES
        (72, 1, 71, 1, 70, NULL, 1)`);

    // --- Roster B (current): LIST 73 = [TOKENONE, TOKENTWO], LINK 74 --------
    await db.query(`INSERT IGNORE INTO lists (action_index, type, edit, list_action_index, status_id) VALUES (73,'1','1',71,1)`);
    await db.query(`INSERT IGNORE INTO list_items (action_index, item_id) VALUES (73,2),(73,3)`);
    await db.query(`INSERT IGNORE INTO links (action_index, coin1_id, coin1_action_index, coin2_id, coin2_action_index, memo_id, status_id) VALUES
        (74, 1, 73, 1, 70, NULL, 1)`);

    // --- Noise that MUST be ignored -----------------------------------------
    // LIST 75 = [TOKENTHREE], never owner-linked (no authority)
    await db.query(`INSERT IGNORE INTO lists (action_index, type, edit, list_action_index, status_id) VALUES (75,'1',NULL,NULL,1)`);
    await db.query(`INSERT IGNORE INTO list_items (action_index, item_id) VALUES (75,4)`);
    // INVALID link (status_id 2) pointing LIST 75 at the project; no authority
    await db.query(`INSERT IGNORE INTO links (action_index, coin1_id, coin1_action_index, coin2_id, coin2_action_index, memo_id, status_id) VALUES
        (76, 1, 75, 1, 70, NULL, 2)`);
    // Reverse-orientation link (ISSUE on coin1, LIST on coin2): consensus-valid
    // but NOT an attestation (only the COIN2 side is owner-validated)
    await db.query(`INSERT IGNORE INTO links (action_index, coin1_id, coin1_action_index, coin2_id, coin2_action_index, memo_id, status_id) VALUES
        (77, 1, 70, 1, 75, NULL, 1)`);
    // ADDRESS-type LIST 78 validly linked to the project (not a roster)
    await db.query(`INSERT IGNORE INTO lists (action_index, type, edit, list_action_index, status_id) VALUES (78,'2',NULL,NULL,1)`);
    await db.query(`INSERT IGNORE INTO list_items (action_index, item_id) VALUES (78,1)`);
    await db.query(`INSERT IGNORE INTO links (action_index, coin1_id, coin1_action_index, coin2_id, coin2_action_index, memo_id, status_id) VALUES
        (79, 1, 78, 1, 70, NULL, 1)`);

    const { app } = await createApp();
    request = supertest(app);
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

// ===========================================================================
// Project detail endpoint
// ===========================================================================

describe('Project API (/api/project/{tick})', function () {

    it('resolves the CURRENT roster (latest owner-valid tick-LIST link wins)', async function () {
        const res = await request.get('/RBTC/api/project/PROJECTX');
        expect(res.status).to.equal(200);
        expect(res.body.tick).to.equal('PROJECTX');
        expect(res.body.roster_action_index).to.equal(73); // roster B, not superseded A (71)
        expect(res.body.link_action_index).to.equal(74);
        expect(res.body.total).to.equal(2);
        const ticks = res.body.members.map(m => m.tick).sort();
        expect(ticks).to.deep.equal(['TOKENONE', 'TOKENTWO']);
    });

    it('ignores unlinked, invalidly-linked, reverse-linked, and ADDRESS-type lists', async function () {
        const res = await request.get('/RBTC/api/project/PROJECTX');
        // LIST 75 (TOKENTHREE) reached the project only through an invalid link,
        // a reverse-orientation link, and never as a tick roster; must not count
        const ticks = res.body.members.map(m => m.tick);
        expect(ticks).to.not.include('TOKENTHREE');
        expect(res.body.roster_action_index).to.not.equal(75);
        expect(res.body.roster_action_index).to.not.equal(78);
    });

    it('returns 404 for a token with no roster', async function () {
        const res = await request.get('/RBTC/api/project/TOKENTHREE');
        expect(res.status).to.equal(404);
    });

});

// ===========================================================================
// Token-page membership + registry fields
// ===========================================================================

describe('Token membership fields (/api/token/{tick})', function () {

    it('members of the current roster carry a projects[] entry', async function () {
        const res = await request.get('/RBTC/api/token/TOKENTWO');
        expect(res.status).to.equal(200);
        expect(res.body.projects).to.be.an('array').with.lengthOf(1);
        expect(res.body.projects[0]).to.deep.include({
            project:             'PROJECTX',
            roster_action_index: 73,
            link_action_index:   74
        });
    });

    it('non-members (and members of superseded rosters only) carry no projects', async function () {
        const res = await request.get('/RBTC/api/token/TOKENTHREE');
        expect(res.status).to.equal(200);
        expect(res.body.projects).to.be.an('array').with.lengthOf(0);
    });

    it('the project tick itself reports its registry metadata', async function () {
        const res = await request.get('/RBTC/api/token/PROJECTX');
        expect(res.status).to.equal(200);
        expect(res.body.registry).to.deep.include({ roster_action_index: 73, link_action_index: 74, total: 2 });
    });

    it('ordinary tokens report registry null', async function () {
        const res = await request.get('/RBTC/api/token/TOKENTHREE');
        expect(res.body.registry).to.equal(null);
    });

});

// ===========================================================================
// Roster datatable (token-page Official Tokens tab)
// ===========================================================================

describe('Roster datatable (/explorer/projects/{tick}/roster)', function () {

    it('returns the roster members shaped like token rows (decimals before trailing id)', async function () {
        const res = await request.get('/RBTC/explorer/projects/PROJECTX/roster?start=0&length=10&action=first');
        expect(res.status).to.equal(200);
        expect(res.body.recordsTotal).to.equal(2);
        expect(res.body.data).to.have.length(2);
        for (const row of res.body.data) {
            // [count, block, time, tick, supply, max_supply, max_mint, locks, decimals, id]
            expect(row).to.have.length(10);
            expect(['TOKENONE', 'TOKENTWO']).to.include(row[3]);
        }
    });

    it('returns an empty datatable for a token with no roster', async function () {
        const res = await request.get('/RBTC/explorer/projects/TOKENTHREE/roster?start=0&length=10&action=first');
        expect(res.status).to.equal(200);
        expect(res.body.recordsTotal).to.equal(0);
        expect(res.body.data).to.have.length(0);
    });

});
