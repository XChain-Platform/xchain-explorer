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
 * The dispenser LIST lane served no escrow at all - neither the
 * create-time give_escrow nor a live remainder - so a client listing an
 * address's dispensers could not say how full any of them was. The wallet
 * papered over it with an "Escrow pending" line that told every owner their
 * fully-funded dispenser had not funded yet.
 *
 * Escrow is consensus-sensitive arithmetic (create escrow + valid refills -
 * valid payouts, mirroring the indexer's getDispenserAmountRemaining), so the
 * fix is ONE shared derivation - getDispenserEscrowBatch - used by the list
 * lane, the per-action detail lane and the WebSocket dispenser channel alike.
 * These tests pin that: the field is served, the arithmetic matches the
 * indexer's, and no lane re-derives escrow with SQL of its own.
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

function makeDb(){ return new Database(mockExplorer); }
function cfg(overrides = {}){ return makeConfig({ coin: 'BTC', ...overrides }); }

// Route a stubbed doQuery by the table the query reads.
function stubEscrowQueries(db, { dispensers = [], edits = [], dispenses = [] } = {}){
    return sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
        if(/FROM\s+dispenser_edits/i.test(q)) return edits;
        if(/FROM\s+dispenses/i.test(q))       return dispenses;
        if(/FROM\s+dispensers/i.test(q))      return dispensers;
        return [];
    });
}

describe('Database#getDispenserEscrowBatch', function () {

    afterEach(() => sinon.restore());

    it('returns the create escrow when nothing has refilled or drained it', async () => {
        const db = makeDb();
        stubEscrowQueries(db, { dispensers: [{ action_index: 35, give_escrow: '500' }] });
        const map = await db.getDispenserEscrowBatch(cfg(), [35]);
        expect(map['35']).to.deep.equal({ give_escrow: '500', escrow_remaining: '500' });
    });

    it('adds every valid refill and subtracts every valid payout', async () => {
        const db = makeDb();
        stubEscrowQueries(db, {
            dispensers: [{ action_index: 35, give_escrow: '500' }],
            edits:      [{ dispenser_action_index: 35, give_escrow: '500' }],
            dispenses:  [{ dispenser_action_index: 35, give_amount: '100' },
                         { dispenser_action_index: 35, give_amount: '150' }]
        });
        const map = await db.getDispenserEscrowBatch(cfg(), [35]);
        // 500 create + 500 refill - 250 dispensed = 750 (the live regtest dispenser #35)
        expect(map['35'].escrow_remaining).to.equal('750');
        // give_escrow stays the CREATE escrow; the refill only moves the remainder
        expect(map['35'].give_escrow).to.equal('500');
    });

    it('[REGRESSION] keeps fractional amounts exact instead of rounding them away', async () => {
        const db = makeDb();
        stubEscrowQueries(db, {
            dispensers: [{ action_index: 7, give_escrow: '100.5' }],
            dispenses:  [{ dispenser_action_index: 7, give_amount: '0.25' }]
        });
        const map = await db.getDispenserEscrowBatch(cfg(), [7]);
        // bcsub defaults to 0 decimals, which rounded 100.25 to '100'. The
        // derivation runs at the indexer's 64-digit precision instead.
        expect(map['7'].escrow_remaining).to.equal('100.25');
    });

    it('[REGRESSION] renders dust as a decimal, never as exponential notation', async () => {
        const db = makeDb();
        stubEscrowQueries(db, {
            dispensers: [{ action_index: 8, give_escrow: '0.00000005' }],
            dispenses:  [{ dispenser_action_index: 8, give_amount: '0.00000002' }]
        });
        const map = await db.getDispenserEscrowBatch(cfg(), [8]);
        // A mathjs bignumber stringifies to '3e-8' below 1e-7, which no client parses
        expect(map['8'].escrow_remaining).to.equal('0.00000003');
    });

    it('skips refills that carry no escrow (a list-only DISPENSER_EDIT)', async () => {
        const db = makeDb();
        stubEscrowQueries(db, {
            dispensers: [{ action_index: 9, give_escrow: '10' }],
            edits:      [{ dispenser_action_index: 9, give_escrow: null },
                         { dispenser_action_index: 9, give_escrow: '5' }]
        });
        const map = await db.getDispenserEscrowBatch(cfg(), [9]);
        expect(map['9'].escrow_remaining).to.equal('15');
    });

    it('reports no escrow for an ownership dispenser, which escrows no amount', async () => {
        const db = makeDb();
        stubEscrowQueries(db, { dispensers: [{ action_index: 11, give_escrow: null }] });
        const map = await db.getDispenserEscrowBatch(cfg(), [11]);
        expect(map['11']).to.deep.equal({ give_escrow: null, escrow_remaining: null });
    });

    it('omits a dispenser whose create row is not valid', async () => {
        const db = makeDb();
        // The status filter is in SQL, so an invalid create returns no row at all
        stubEscrowQueries(db, { dispensers: [], dispenses: [{ dispenser_action_index: 12, give_amount: '1' }] });
        const map = await db.getDispenserEscrowBatch(cfg(), [12]);
        expect(map).to.deep.equal({});
    });

    it('keys Number and String action_index alike, and binds each index once', async () => {
        const db = makeDb();
        const doQuery = stubEscrowQueries(db, { dispensers: [{ action_index: '35', give_escrow: '500' }] });
        const map = await db.getDispenserEscrowBatch(cfg(), [35, '35']);
        expect(map['35'].escrow_remaining).to.equal('500');
        // de-duped: one placeholder + the trailing status arg
        expect(doQuery.firstCall.args[2]).to.deep.equal(['35', 'valid']);
    });

    it('separates two dispensers in one batched pass (three queries, not three per row)', async () => {
        const db = makeDb();
        const doQuery = stubEscrowQueries(db, {
            dispensers: [{ action_index: 1, give_escrow: '10' }, { action_index: 2, give_escrow: '20' }],
            edits:      [{ dispenser_action_index: 2, give_escrow: '5' }],
            dispenses:  [{ dispenser_action_index: 1, give_amount: '4' }]
        });
        const map = await db.getDispenserEscrowBatch(cfg(), [1, 2]);
        expect(map['1'].escrow_remaining).to.equal('6');
        expect(map['2'].escrow_remaining).to.equal('25');
        expect(doQuery.callCount).to.equal(3);
    });

    it('queries nothing for an empty or all-null index list', async () => {
        const db = makeDb();
        const doQuery = stubEscrowQueries(db, {});
        expect(await db.getDispenserEscrowBatch(cfg(), [])).to.deep.equal({});
        expect(await db.getDispenserEscrowBatch(cfg(), [null, undefined])).to.deep.equal({});
        expect(await db.getDispenserEscrowBatch(cfg(), null)).to.deep.equal({});
        expect(doQuery.callCount).to.equal(0);
    });
});

describe('getDispensers list lane serves escrow', function () {

    afterEach(() => sinon.restore());

    it('[REGRESSION] every row carries give_escrow and a live escrow_remaining', async () => {
        const db  = makeDb();
        const row = { action: 'DISPENSER', action_index: 35, give_tick: 'XCHAIN',
                      give_amount: '100', give_escrow: '500', get_amount: '0.005', status: 'valid' };
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(/count\(\*\)/i.test(q))            return [{ total: 1 }];
            if(/FROM\s+dispenser_edits/i.test(q)) return [{ dispenser_action_index: 35, give_escrow: '500' }];
            if(/FROM\s+dispenses/i.test(q))       return [{ dispenser_action_index: 35, give_amount: '250' }];
            if(/FROM\s+dispensers\s+d\b/i.test(q))return [{ action_index: 35, give_escrow: '500' }];
            return [row];
        });
        const config = makeConfig({ coin: 'BTC', data: { method: 'getDispensers', type: 'source', search: 'bcrt1qsource' } });
        const [data] = await db.getData(config);
        expect(data).to.have.lengthOf(1);
        // The create escrow comes from the row itself...
        expect(data[0].give_escrow).to.equal('500');
        // ...and the remainder from the same derivation the detail lane uses
        expect(data[0].escrow_remaining).to.equal('750');
    });

    it('selects give_escrow in the list SQL rather than re-deriving it', async () => {
        const db     = makeDb();
        const config = makeConfig({ coin: 'BTC', data: { method: 'getDispensers', type: 'source', search: 'bcrt1qsource' } });
        const [query] = await db.getDispensers(config);
        expect(query).to.match(/m\.give_escrow/);
        // the list SQL must not grow its own escrow arithmetic
        expect(query).to.not.match(/dispenses/i);
        expect(query).to.not.match(/dispenser_edits/i);
    });

    it('reports null escrow_remaining for a row the derivation cannot resolve', async () => {
        const db  = makeDb();
        const row = { action: 'DISPENSER', action_index: 41, give_escrow: '10', status: 'invalid' };
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(/count\(\*\)/i.test(q)) return [{ total: 1 }];
            if(/FROM\s+dispensers\s+d\b/i.test(q)) return [];   // invalid create row
            if(/FROM\s+dispenser_edits/i.test(q))  return [];
            if(/FROM\s+dispenses/i.test(q))        return [];
            if(/FROM\s+dispenser_statuses/i.test(q)) return [];
            return [row];
        });
        const config = makeConfig({ coin: 'BTC', data: { method: 'getDispensers', type: 'source', search: 'bcrt1qsource' } });
        const [data] = await db.getData(config);
        expect(data[0].escrow_remaining).to.equal(null);
    });
});

describe('getDispensers list lane serves the lifecycle status', function () {

    afterEach(() => sinon.restore());

    // The row's own `status` is the CREATE action's validity, frozen at
    // 'valid' forever, so the list could not tell an open dispenser from a
    // cancelled one - and a cancelled dispenser (escrow refunded by the
    // terminal action) went on listing its full balance.

    function stubListQueries(db, { rows, statuses = [], edits = [], dispenses = [] }){
        return sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(/count\(\*\)/i.test(q))               return [{ total: rows.length }];
            if(/FROM\s+dispenser_statuses/i.test(q)) return statuses;
            if(/FROM\s+dispenser_edits/i.test(q))    return edits;
            if(/FROM\s+dispenses/i.test(q))          return dispenses;
            if(/FROM\s+dispensers\s+d\b/i.test(q))
                return rows.map((r) => ({ action_index: r.action_index, give_escrow: r.give_escrow }));
            return rows;
        });
    }

    it('every row carries current_status from the latest dispenser_statuses row', async () => {
        const db   = makeDb();
        const rows = [{ action: 'DISPENSER', action_index: 35, give_escrow: '50', status: 'valid' }];
        stubListQueries(db, {
            rows,
            // Two transitions, oldest first as the ORDER BY serves them: the
            // newest must win.
            statuses: [
                { dispenser_action_index: 35, action_index: 35, status: 'open' },
                { dispenser_action_index: 35, action_index: 40, status: 'cancelling' },
            ],
        });
        const config = makeConfig({ coin: 'BTC', data: { method: 'getDispensers', type: 'source', search: 'bcrt1qsource' } });
        const [data] = await db.getData(config);
        expect(data[0].current_status).to.equal('cancelling');
        // 'cancelling' is in flight, not terminal: escrow stays as derived.
        expect(data[0].escrow_remaining).to.equal('50');
    });

    it('[REGRESSION] a terminal status zeroes escrow_remaining, matching the detail lane', async () => {
        const db   = makeDb();
        const rows = [{ action: 'DISPENSER', action_index: 31, give_escrow: '50', status: 'valid' }];
        stubListQueries(db, {
            rows,
            statuses: [
                { dispenser_action_index: 31, action_index: 31, status: 'open' },
                { dispenser_action_index: 31, action_index: 44, status: 'cancelled' },
            ],
        });
        const config = makeConfig({ coin: 'BTC', data: { method: 'getDispensers', type: 'source', search: 'bcrt1qsource' } });
        const [data] = await db.getData(config);
        expect(data[0].current_status).to.equal('cancelled');
        // The cancel refunded the escrow; listing '50' told the owner a
        // dead dispenser was still funded.
        expect(data[0].escrow_remaining).to.equal('0');
    });

    it('serves current_status null for a dispenser with no status row at all', async () => {
        const db   = makeDb();
        const rows = [{ action: 'DISPENSER', action_index: 12, give_escrow: '5', status: 'invalid' }];
        stubListQueries(db, { rows, statuses: [] });
        const config = makeConfig({ coin: 'BTC', data: { method: 'getDispensers', type: 'source', search: 'bcrt1qsource' } });
        const [data] = await db.getData(config);
        expect(data[0].current_status).to.equal(null);
    });
});

describe('Database#getDispenserCurrentStatusBatch', function () {

    afterEach(() => sinon.restore());

    it('resolves the newest transition per dispenser in one batched query', async () => {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery').resolves([
            { dispenser_action_index: 7, action_index: 7,  status: 'open' },
            { dispenser_action_index: 9, action_index: 9,  status: 'open' },
            { dispenser_action_index: 7, action_index: 15, status: 'complete' },
        ]);
        const map = await db.getDispenserCurrentStatusBatch(cfg(), [7, '9', 7, null]);
        expect(map).to.deep.equal({ 7: 'complete', 9: 'open' });
        // one query, with the de-duped indexes bound once each
        expect(stub.calledOnce).to.equal(true);
        expect(stub.firstCall.args[2]).to.deep.equal(['7', '9']);
    });

    it('queries nothing for an empty or all-null index list', async () => {
        const db   = makeDb();
        const stub = sinon.stub(db, 'doQuery');
        expect(await db.getDispenserCurrentStatusBatch(cfg(), [])).to.deep.equal({});
        expect(await db.getDispenserCurrentStatusBatch(cfg(), [null])).to.deep.equal({});
        expect(stub.called).to.equal(false);
    });
});

describe('per-action and WebSocket lanes read the same derivation', function () {

    afterEach(() => sinon.restore());

    it('getActionData delegates DISPENSER state.give_remaining to the shared method', async () => {
        const db = makeDb();
        sinon.stub(db, 'getActionType').resolves('DISPENSER');
        sinon.stub(db, 'getActionFeeData').resolves(null);
        sinon.stub(db, 'getTransactionData').resolves(null);
        sinon.stub(db, 'getMaxBlockTime').resolves(1700000000);
        const shared = sinon.stub(db, 'getDispenserEscrowBatch').resolves({ '100': { give_escrow: '500', escrow_remaining: '750' } });
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            if(/FROM\s+(credits|debits|escrows)\b/i.test(q)) return [];
            if(/FROM\s+dispenser_edits/i.test(q))            return [];
            return [{ action: 'DISPENSER', action_index: 100, give_amount: '100', give_escrow: '500',
                      get_amount: '0.005', expiration: 0, allow_list: null, block_list: null,
                      current_status: 'open', status: 'valid', tx_hash: 'abc' }];
        });
        const result = await db.getActionData(cfg(), 100);
        expect(shared.calledOnce).to.equal(true);
        expect(result.state.give_remaining).to.equal('750');
    });

    it('[REGRESSION] getDispenserInfo no longer selects a give_remaining column that does not exist', async () => {
        const db = makeDb();
        sinon.stub(db, 'getDispenserEscrowBatch').resolves({ '70': { give_escrow: '500', escrow_remaining: '750' } });
        let seen = null;
        sinon.stub(db, 'doQuery').callsFake(async (c, q) => {
            seen = q;
            return [{ action_index: 70, source: 'addr1', give_tick: 'XCHAIN', give_amount: '100', give_escrow: '500' }];
        });
        const info = await db.getDispenserInfo(cfg(), 70);
        // The dispensers table has no give_remaining column: selecting it threw
        // 'Unknown column' on every dispenser-channel subscribe and update.
        expect(seen).to.not.match(/d\.give_remaining/);
        expect(info.give_remaining).to.equal('750');
        expect(info.escrow_remaining).to.equal('750');
    });
});
