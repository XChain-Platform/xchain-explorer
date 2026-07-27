/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * : DISPENSER allow/block-list edits do not take effect the moment
 * they confirm. Consensus holds them back by DISPENSER_LIST_DELAY seconds
 * of block time so a dispenser owner cannot flip a list on top of a buyer
 * who is already paying.
 *
 * getActionData() gated on that delay, but the DISPENSER edit query it
 * gated with never selected block_time: it read dispenser_edits alone with
 * no path to a block. row.block_time was undefined, bcadd() coerces null /
 * undefined to 0, and the comparison became "is the chain tip later than
 * 3600" - true for every real chain. So the read path applied every list
 * edit instantly and DISPENSER_LIST_DELAY did nothing on the explorer.
 *
 * These tests pin both halves of the fix: the query has to carry the
 * edit's own block_time (via actions -> blocks, the same join the indexer's
 * getDispenserEdits uses), and the loop has to withhold a list edit that is
 * still inside the delay window.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

// Matches test/fixtures/mock-config.js
const DELAY = 3600;
// Chain tip used as "now" for every activation comparison
const TIP   = 1700000000;

function cfg() {
    return makeConfig({ coin: 'BTC' });
}

function dispenserRow(extra = {}) {
    return {
        action: 'DISPENSER',
        action_format: 0,
        action_index: 100,
        source: 'addr1',
        block_index: 500,
        timestamp: TIP,
        tx_hash: 'abc123',
        tx_index: 1,
        memo: null,
        status: 'valid',
        current_status: 'open',
        give_tick: 'XCHAIN',
        get_tick: 'BTC',
        give_amount: '100',
        get_amount: '0.001',
        give_escrow: '100',
        expiration: 0,
        allow_list: null,
        block_list: null,
        ...extra
    };
}

// Runs getActionData() for a DISPENSER whose edit lane returns `edits`, and
// hands back both the result and the SQL the edit lane actually ran.
async function runDispenser(db, edits) {
    let editQuery = null;
    sinon.stub(db, 'getActionType').resolves('DISPENSER');
    sinon.stub(db, 'getActionFeeData').resolves(null);
    sinon.stub(db, 'getTransactionData').resolves(null);
    sinon.stub(db, 'getMaxBlockTime').resolves(TIP);
    sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
        if(q && /\b(credits|debits|escrows)\b/i.test(q)) return [];
        if(q && /dispenser_edits/i.test(q)){
            editQuery = q;
            return edits;
        }
        if(q && /\bdispenses\b/i.test(q)) return [];
        return [dispenserRow()];
    });
    const result = await db.getActionData(cfg(), 100);
    return { result, editQuery };
}

describe('db.getActionData - DISPENSER list-edit activation delay ', () => {
    let db;

    beforeEach(() => { db = new Database(mockExplorer); });
    afterEach(() => { sinon.restore(); });

    it('the edit query selects block_time through actions -> blocks', async () => {
        const { editQuery } = await runDispenser(db, []);
        expect(editQuery, 'edit lane never ran').to.be.a('string');
        expect(editQuery).to.match(/block_time/i);
        expect(editQuery).to.match(/INNER\s+JOIN\s+actions\b/i);
        expect(editQuery).to.match(/INNER\s+JOIN\s+blocks\b/i);
    });

    it('the edit query qualifies ORDER BY (actions also has an action_index)', async () => {
        const { editQuery } = await runDispenser(db, []);
        expect(editQuery).to.match(/ORDER\s+BY\s+m\.action_index/i);
    });

    it('withholds a list edit that is still inside the delay window', async () => {
        // Confirmed 60s ago: DELAY has not elapsed, consensus has not applied it yet.
        const edit = {
            dispenser_action_index: 100, give_escrow: null, expiration: null,
            allow_list: 7, block_list: null, block_time: TIP - 60
        };
        const { result } = await runDispenser(db, [edit]);
        expect(result.state.allow_list).to.equal(null);
    });

    it('applies a list edit once the delay has elapsed', async () => {
        const edit = {
            dispenser_action_index: 100, give_escrow: null, expiration: null,
            allow_list: 7, block_list: null, block_time: TIP - (DELAY + 1)
        };
        const { result } = await runDispenser(db, [edit]);
        expect(result.state.allow_list).to.equal(7);
    });

    it('withholds a block_list edit inside the window and applies it after', async () => {
        const pending = {
            dispenser_action_index: 100, give_escrow: null, expiration: null,
            allow_list: null, block_list: 9, block_time: TIP - DELAY
        };
        const { result: withheld } = await runDispenser(db, [pending]);
        expect(withheld.state.block_list).to.equal(null);

        sinon.restore();
        db = new Database(mockExplorer);
        const matured = { ...pending, block_time: TIP - DELAY - 1 };
        const { result: applied } = await runDispenser(db, [matured]);
        expect(applied.state.block_list).to.equal(9);
    });

    it('boundary: the delay must fully elapse, an exactly-aged edit stays withheld', async () => {
        // bcgt is strict, mirroring the indexer's own bcgt gate.
        const edit = {
            dispenser_action_index: 100, give_escrow: null, expiration: null,
            allow_list: 7, block_list: null, block_time: TIP - DELAY
        };
        const { result } = await runDispenser(db, [edit]);
        expect(result.state.allow_list).to.equal(null);
    });

    it('expiration edits are immediately active, they are not delay-gated', async () => {
        const edit = {
            dispenser_action_index: 100, give_escrow: null, expiration: 900001,
            allow_list: 7, block_list: null, block_time: TIP - 60
        };
        const { result } = await runDispenser(db, [edit]);
        expect(result.state.expiration).to.equal(900001);
        expect(result.state.allow_list).to.equal(null);
    });

    it('a row with no block_time is withheld, never treated as aged since the epoch', async () => {
        // Fail closed: a missing block_time used to bcadd() to 0 and read as active.
        const edit = {
            dispenser_action_index: 100, give_escrow: null, expiration: null,
            allow_list: 7, block_list: 9, block_time: null
        };
        const { result } = await runDispenser(db, [edit]);
        expect(result.state.allow_list).to.equal(null);
        expect(result.state.block_list).to.equal(null);
    });

    it('a later matured edit still overwrites an earlier one', async () => {
        const edits = [
            { dispenser_action_index: 100, give_escrow: null, expiration: null,
              allow_list: 7, block_list: null, block_time: TIP - 100000 },
            { dispenser_action_index: 100, give_escrow: null, expiration: null,
              allow_list: 8, block_list: null, block_time: TIP - 50000 }
        ];
        const { result } = await runDispenser(db, edits);
        expect(result.state.allow_list).to.equal(8);
    });

    it('a pending edit does not clobber the last matured list value', async () => {
        const edits = [
            { dispenser_action_index: 100, give_escrow: null, expiration: null,
              allow_list: 7, block_list: null, block_time: TIP - 100000 },
            { dispenser_action_index: 100, give_escrow: null, expiration: null,
              allow_list: 8, block_list: null, block_time: TIP - 60 }
        ];
        const { result } = await runDispenser(db, edits);
        expect(result.state.allow_list).to.equal(7);
    });
});
