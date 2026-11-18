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
 *
 * Actions the indexer mints itself (order and swap matches, expiry passes) carry
 * no source and no destination rows, so ADDRESS_UPDATE reaches the addresses they
 * moved only through the credit, debit and escrow rows the action wrote.
 * Unit tests for src/ws/change_detector/entities.js and the reader in
 * src/db/readers/action_detail_io/ledger_ticks.js.
 */

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const { mk } = require('../change_detector_methods.test/support/helpers.js');
const ledgerTicks = require('../../../../src/db/readers/action_detail_io/ledger_ticks.js');

// A detector polling one batch with `watched` addresses subscribed and the ledger
// reader answering `ledger` (action_index -> address list), or rejecting on an Error.
function pollWith(actions, watched, ledger) {
    const det = mk();
    det.channelManager.getSubscribedAddresses.returns(new Set(watched));
    det.db.getAddressBalances.callsFake(async (config, addr) => [{ tick: 'GOLD', addr }]);
    det.db.getActionLedgerAddresses = ledger instanceof Error
        ? sinon.stub().rejects(ledger)
        : sinon.stub().resolves(new Map(Object.entries(ledger).map(([k, v]) => [k, new Set(v)])));
    det.state.BTC = { blockIndex: 0, actionIndex: 0n, initialized: true };
    det.db.getMaxActionIndex.resolves(BigInt(actions.length));
    det.db.getActionsSince.resolves(actions);
    const frames = [];
    det.on('entity_update', (c, e) => { if (e.type === 'ADDRESS_UPDATE') frames.push(e.data); });
    return { det, frames };
}

describe('change detector ADDRESS_UPDATE for source-less system actions', function () {
    afterEach(() => sinon.restore());

    it('refreshes a watched address the ledger rows of a source-less ORDER_MATCH touched', async function () {
        const action = { action: 'ORDER_MATCH', action_index: 1n, source: null, destinations: [] };
        const { det, frames } = pollWith([action], ['1maker'], { 1: ['1maker', '1taker'] });
        await det.checkCoin('BTC');
        expect(frames.map((f) => [f.address, f.last_action_index])).to.deep.equal([['1maker', 1n]]);
    });

    it('sends nothing to an address the action did not touch', async function () {
        const action = { action: 'ORDER_EXPIRE', action_index: 2n, source: null, destinations: [] };
        const { det, frames } = pollWith([action], ['1bystander'], { 2: ['1maker'] });
        await det.checkCoin('BTC');
        expect(frames).to.deep.equal([]);
    });

    it('sends one frame for an address that is source and ledger party at once', async function () {
        const action = { action: 'SEND', action_index: 3n, source: '1maker', destinations: [] };
        const { det, frames } = pollWith([action], ['1maker'], { 3: ['1maker'] });
        await det.checkCoin('BTC');
        expect(frames).to.have.lengthOf(1);
    });

    it('falls back to source and destinations when the ledger read fails', async function () {
        const actions = [
            { action: 'ORDER_MATCH', action_index: 1n, source: null, destinations: [] },
            { action: 'SEND', action_index: 2n, source: '1maker', destinations: [] }
        ];
        const { det, frames } = pollWith(actions, ['1maker'], new Error('read failed'));
        await det.checkCoin('BTC');
        expect(frames.map((f) => f.last_action_index)).to.deep.equal([2n]);
        expect(det.state.BTC.actionIndex).to.equal(2n);
    });

    it('reads the ledger once per poll and never when no address is watched', async function () {
        const actions = [
            { action: 'ORDER_MATCH', action_index: 1n, source: null, destinations: [] },
            { action: 'SWAP_MATCH', action_index: 2n, source: null, destinations: [] }
        ];
        const busy = pollWith(actions, ['1maker'], { 1: ['1maker'], 2: ['1maker'] });
        await busy.det.checkCoin('BTC');
        const idle = pollWith(actions, [], { 1: ['1maker'] });
        await idle.det.checkCoin('BTC');
        expect(busy.det.db.getActionLedgerAddresses.callCount).to.equal(1);
        expect(busy.det.db.getActionLedgerAddresses.firstCall.args[1]).to.deep.equal([1n, 2n]);
        expect(busy.frames).to.have.lengthOf(2);
        expect(idle.det.db.getActionLedgerAddresses.called).to.equal(false);
    });
});

describe('getActionLedgerAddresses', function () {
    function reader(rows) {
        const db = Object.create(ledgerTicks);
        db.util = { isNull: (v) => v === null || v === undefined };
        db.doQuery = sinon.stub().resolves(rows);
        return db;
    }

    it('issues no query for an empty batch', async function () {
        const db = reader([]);
        expect((await db.getActionLedgerAddresses({ coin: 'BTC' }, [])).size).to.equal(0);
        expect(db.doQuery.called).to.equal(false);
    });

    it('groups addresses by action over credits, debits and escrows, binding every index', async function () {
        const db = reader([
            { action_index: 5n, address: '1a' }, { action_index: 5n, address: '1b' },
            { action_index: 5n, address: '1a' }, { action_index: 6n, address: '1c' },
            { action_index: 6n, address: null }
        ]);
        const map = await db.getActionLedgerAddresses({ coin: 'BTC' }, [5n, 6n]);
        expect([...map.get('5')]).to.deep.equal(['1a', '1b']);
        expect([...map.get('6')]).to.deep.equal(['1c']);
        const [sql, args] = db.doQuery.firstCall.args.slice(1);
        for (const table of ['credits', 'debits', 'escrows']) expect(sql).to.match(new RegExp('FROM\\s+' + table + ' m\\s'));
        expect(args).to.deep.equal([5n, 6n, 5n, 6n, 5n, 6n]);
    });
});
