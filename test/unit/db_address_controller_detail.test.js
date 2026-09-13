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
 * An ADDRESS v1 controller bind had no readable verdict.
 *
 * ADDRESS has two unrelated subjects. Format 0 edits an address's preferences and
 * writes the `addresses` row; format 1 self-gates one action class of the account
 * behind a guard contract and writes `address_controllers` instead. The detail
 * handler INNER JOINed the preferences table, so for a v1 the join matched nothing,
 * getActionData fell through to its de-blank baseline, and `/api/action/<v1>` served
 * an action name, a source and a tx hash with no status, no controller, no action
 * class and no unbind flag. Measured on LTC regtest.
 *
 * What these tests pin:
 *   1. the join shape: the detail query is rooted at `actions` with the OPTIONAL
 *      preferences row LEFT joined, so no ADDRESS format can degrade the endpoint;
 *   2. a valid bind reads back what it bound (controller / action_class / unbind /
 *      cooldown), and an unbind reads back the block its drop lands on;
 *   3. a REFUSED bind reads back its `invalid: ...` reason, which is the half the
 *      indexer now persists (an `addresses` audit row for every ADDRESS action);
 *   4. format 0 is untouched: no controller fields, preferences intact.
 *
 * doQuery is stubbed with a keyword router, so no MariaDB pool is needed.
 ********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const Utility    = require('../../src/utility.js');
const { expect } = require('chai');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

function makeDb() { return new Database(mockExplorer); }
function cfg() { return makeConfig({ coin: 'BTC' }); }

// Route on SQL substrings and record every statement, so a test can assert both the
// shaped result and the query text that produced it.
//   mainRow       -> the ADDRESS detail row (null = the join matched nothing)
//   controllerRow -> the address_controllers event for this action (null = none)
function makeDoQuery(opts, seen) {
    const o = Object.assign({ mainRow: null, controllerRow: null }, opts);
    return async function(config, sql, args) {
        const q = String(sql);
        if(seen) seen.push(q);
        if(q.includes('a2.action') && q.includes('actions a1') && !q.includes('block_index'))
            return [{ action: 'ADDRESS' }];
        if(q.includes('address_controllers'))
            return o.controllerRow ? [o.controllerRow] : [];
        if(q.includes('fee_preference') && q.includes('dispenser_preference'))
            return o.mainRow ? [o.mainRow] : [];
        return [];
    };
}

// The row the detail query returns for a controller bind: every preference column is
// NULL (a v1 sets none of them), which is exactly the row that used to be absent.
function bindMainRow(overrides) {
    return Object.assign({
        action: 'ADDRESS', action_format: 1, action_index: 1787,
        source: 'bcrt1qsource', fee_preference: null, require_memo: null,
        dispenser_preference: null, block_index: 900, timestamp: 1700000000,
        tx_hash: 'bb'.repeat(32), tx_index: 500, memo: null, status: 'valid'
    }, overrides || {});
}

describe('getActionData: ADDRESS v1 controller bind detail @regression', function() {

    describe('the preferences row is joined as OPTIONAL', function() {
        it('roots the detail query at actions and LEFT joins addresses', async function() {
            const seen = [];
            const db   = makeDb();
            db.doQuery = makeDoQuery({ mainRow: bindMainRow() }, seen);
            await db.getActionData(cfg(), 1787);
            const detail = seen.find((q) => q.includes('fee_preference') && q.includes('dispenser_preference'));
            expect(detail, 'the ADDRESS detail query ran').to.be.a('string');
            expect(detail).to.match(/FROM\s+actions\s+a2/);
            expect(detail).to.match(/LEFT\s+JOIN\s+addresses/);
            expect(detail, 'an optional table must never be the FROM table')
                .to.not.match(/FROM\s+addresses/);
        });

        it('asks address_controllers for the binding, keyed by this action', async function() {
            const seen = [];
            const db   = makeDb();
            db.doQuery = makeDoQuery({ mainRow: bindMainRow() }, seen);
            await db.getActionData(cfg(), 1787);
            const lookup = seen.find((q) => q.includes('address_controllers'));
            expect(lookup, 'the controller lookup ran').to.be.a('string');
            expect(lookup).to.match(/c1\.action_index=\?/);
        });
    });

    describe('a valid bind reads back what it bound', function() {
        it('surfaces status, controller, action class, unbind and cooldown', async function() {
            const db = makeDb();
            db.doQuery = makeDoQuery({
                mainRow: bindMainRow(),
                controllerRow: { action_class: 'transfer', contract_index: 1500, is_unbind: 0,
                                 cooldown_blocks: 144, cooldown_end_block: null }
            });
            const data = await db.getActionData(cfg(), 1787);
            expect(data.status).to.equal('valid');
            expect(data.action_format).to.equal(1);
            expect(data.action_class).to.equal('transfer');
            expect(data.controller).to.equal(1500);
            expect(data.unbind).to.equal(0);
            expect(data.cooldown_blocks).to.equal(144);
            expect(data.cooldown_end_block).to.equal(null);
        });

        it('an unbind reports the block its drop lands on', async function() {
            const db = makeDb();
            db.doQuery = makeDoQuery({
                mainRow: bindMainRow({ action_index: 1801 }),
                controllerRow: { action_class: 'transfer', contract_index: 1500, is_unbind: 1,
                                 cooldown_blocks: 144, cooldown_end_block: 1044 }
            });
            const data = await db.getActionData(cfg(), 1801);
            expect(data.unbind).to.equal(1);
            expect(data.cooldown_end_block).to.equal(1044);
            expect(data.controller).to.equal(1500);
        });
    });

    describe('a refused bind is no longer silent', function() {
        it('reads back its invalid reason with no binding attached', async function() {
            const db = makeDb();
            db.doQuery = makeDoQuery({
                mainRow: bindMainRow({ action_index: 1790, status: 'invalid: ACTION_CLASS (already bound)' }),
                controllerRow: null
            });
            const data = await db.getActionData(cfg(), 1790);
            expect(data.status).to.equal('invalid: ACTION_CLASS (already bound)');
            expect(data.action).to.equal('ADDRESS');
            expect(data.action_format).to.equal(1);
            // The enforcement log carries valid events only, so a refused bind has no
            // controller to describe; the status is the whole verdict.
            expect(data.action_class).to.equal(undefined);
            expect(data.controller).to.equal(undefined);
        });
    });

    describe('format 0 (preferences) is unchanged', function() {
        it('keeps its preference fields and gains no controller fields', async function() {
            const db = makeDb();
            db.doQuery = makeDoQuery({
                mainRow: bindMainRow({ action_index: 1200, action_format: 0, fee_preference: 1,
                                       require_memo: 1, dispenser_preference: 2 }),
                controllerRow: null
            });
            const data = await db.getActionData(cfg(), 1200);
            expect(data.status).to.equal('valid');
            expect(data.fee_preference).to.equal(1);
            expect(data.require_memo).to.equal(1);
            expect(data.dispenser_preference).to.equal(2);
            expect(data.action_class).to.equal(undefined);
            expect(data.unbind).to.equal(undefined);
        });
    });
});
