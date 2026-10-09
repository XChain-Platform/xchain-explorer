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
 * Unit tests for the token channel's ledger-driven refresh in
 * src/ws/change_detector/entities.js and its reader in
 * src/db/readers/action_detail_io/ledger_ticks.js
 */

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const { mk } = require('../change_detector_methods.test/support/helpers.js');
const ledgerTicks = require('../../../../src/db/readers/action_detail_io/ledger_ticks.js');

// A detector polling one batch, with `ticks` subscribed and the ledger reader
// answering `ledger` (action_index -> tick list) or rejecting when it is an Error.
function pollWith(actions, ticks, ledger) {
    const det = mk();
    det.channelManager.getSubscribedTicks.returns(new Set(ticks));
    det.db.getTokenInfo.callsFake(async (config, tick) => ({ tick: tick.toUpperCase(), holders: 7 }));
    det.db.getActionLedgerTicks = ledger instanceof Error
        ? sinon.stub().rejects(ledger)
        : sinon.stub().resolves(new Map(Object.entries(ledger).map(([k, v]) => [k, new Set(v)])));
    det.state.BTC = { blockIndex: 0, actionIndex: 0n, initialized: true };
    det.db.getMaxActionIndex.resolves(BigInt(actions.length));
    det.db.getActionsSince.resolves(actions);
    const frames = [];
    det.on('entity_update', (c, e) => { if (e.type === 'TOKEN_UPDATE') frames.push(e.data); });
    return { det, frames };
}

describe('change detector token refresh from ledger rows', function () {
    afterEach(() => sinon.restore());

    it('refreshes the tick a DISPENSE moved', async function () {
        const { det, frames } = pollWith([{ action: 'DISPENSE', action_index: 1n }], ['GOLD'], { 1: ['GOLD'] });
        await det.checkCoin('BTC');
        expect(frames).to.have.lengthOf(1);
        expect(frames[0]).to.include({ tick: 'GOLD', holders: 7, last_action_index: 1n });
    });

    it('refreshes ticks moved by ORDER_MATCH and STAKE, and only those ticks', async function () {
        const actions = [{ action: 'ORDER_MATCH', action_index: 1n }, { action: 'STAKE', action_index: 2n }];
        const { det, frames } = pollWith(actions, ['GOLD', 'SILVER', 'LEAD'], { 1: ['GOLD'], 2: ['SILVER'] });
        await det.checkCoin('BTC');
        expect(frames.map((f) => [f.tick, f.last_action_index])).to.deep.equal([['GOLD', 1n], ['SILVER', 2n]]);
    });

    it('matches a subscription spelled in another case and keeps that spelling', async function () {
        const { det, frames } = pollWith([{ action: 'DISPENSE', action_index: 1n }], ['gold'], { 1: ['GOLD'] });
        await det.checkCoin('BTC');
        expect(frames.map((f) => f.tick)).to.deep.equal(['gold']);
    });

    it('falls back to the listed types when the ledger read fails', async function () {
        const actions = [{ action: 'MINT', action_index: 1n }, { action: 'DISPENSE', action_index: 2n }];
        const { det, frames } = pollWith(actions, ['GOLD'], new Error('read failed'));
        await det.checkCoin('BTC');
        expect(frames.map((f) => f.last_action_index)).to.deep.equal([1n]);
        expect(det.state.BTC.actionIndex).to.equal(2n);
    });

    it('reads the ledger once per poll and getTokenInfo once per tick', async function () {
        const actions = [{ action: 'DISPENSE', action_index: 1n }, { action: 'ORDER_MATCH', action_index: 2n }];
        const { det, frames } = pollWith(actions, ['GOLD'], { 1: ['GOLD'], 2: ['GOLD'] });
        await det.checkCoin('BTC');
        expect(det.db.getActionLedgerTicks.callCount).to.equal(1);
        expect(det.db.getActionLedgerTicks.firstCall.args[1]).to.deep.equal([1n, 2n]);
        expect(det.db.getTokenInfo.callCount).to.equal(1);
        expect(frames).to.have.lengthOf(2);
    });

    it('skips the ledger read when no tick is subscribed or every action is listed', async function () {
        const idle = pollWith([{ action: 'DISPENSE', action_index: 1n }], [], { 1: ['GOLD'] });
        await idle.det.checkCoin('BTC');
        const listed = pollWith([{ action: 'SEND', action_index: 1n }], ['GOLD'], { 1: ['GOLD'] });
        await listed.det.checkCoin('BTC');
        expect(idle.det.db.getActionLedgerTicks.called).to.equal(false);
        expect(listed.det.db.getActionLedgerTicks.called).to.equal(false);
        expect(listed.frames).to.have.lengthOf(1);
    });
});

describe('getActionLedgerTicks', function () {
    function reader(rows) {
        const db = Object.create(ledgerTicks);
        db.util = { isNull: (v) => v === null || v === undefined };
        db.doQuery = sinon.stub().resolves(rows);
        return db;
    }

    it('issues no query for an empty batch', async function () {
        const db = reader([]);
        expect((await db.getActionLedgerTicks({ coin: 'BTC' }, [])).size).to.equal(0);
        expect(db.doQuery.called).to.equal(false);
    });

    it('groups ticks by action over credits, debits and escrows, binding every index', async function () {
        const db = reader([
            { action_index: 5n, tick: 'GOLD' }, { action_index: 5n, tick: 'XCHAIN' },
            { action_index: 5n, tick: 'GOLD' }, { action_index: 6n, tick: 'SILVER' }
        ]);
        const map = await db.getActionLedgerTicks({ coin: 'BTC' }, [5n, 6n]);
        expect([...map.get('5')]).to.deep.equal(['GOLD', 'XCHAIN']);
        expect([...map.get('6')]).to.deep.equal(['SILVER']);
        const [sql, args] = db.doQuery.firstCall.args.slice(1);
        for (const table of ['credits', 'debits', 'escrows']) expect(sql).to.match(new RegExp('FROM\\s+' + table + ' m\\s'));
        expect(args).to.deep.equal([5n, 6n, 5n, 6n, 5n, 6n]);
    });
});
