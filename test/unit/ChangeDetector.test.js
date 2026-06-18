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
 * Unit tests for src/ws/ChangeDetector.js: the indexer-DB poller that turns
 * new blocks/actions into WebSocket events. All collaborators are injected, so
 * no real DB or timers are needed (fake timers used only for the poll loop).
 */

'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const ChangeDetector = require('../../src/ws/ChangeDetector.js');

function mk(over) {
    over = over || {};
    let db = {
        getMaxBlockIndex:            sinon.stub().resolves(0),
        getMaxActionIndex:           sinon.stub().resolves(0),
        getBlocksSince:              sinon.stub().resolves([]),
        getActionsSince:             sinon.stub().resolves([]),
        getOrderMatchSettlement:     sinon.stub().resolves(null),
        getCoinpayObligation:        sinon.stub().resolves(null),
        getAddressBalances:          sinon.stub().resolves([]),
        getTokenInfo:                sinon.stub().resolves(null),
        getDispenserInfo:            sinon.stub().resolves(null),
        getMarketInfo:               sinon.stub().resolves(null),
        getAttestationByActionIndex: sinon.stub().resolves(null)
    };
    let channelManager = over.channelManager === null ? null : {
        getSubscribedAddresses:  sinon.stub().returns(new Set()),
        getSubscribedTicks:      sinon.stub().returns(new Set()),
        getSubscribedDispensers: sinon.stub().returns(new Set()),
        getSubscribedMarkets:    sinon.stub().returns([])
    };
    return new ChangeDetector({ db, channelManager, pollInterval: 5000, fetchLimit: 100 });
}

describe('ChangeDetector', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------
    // start() / stop()
    // -----------------------------------------------------------------

    describe('start() / stop()', function () {
        it('seeds per-coin state, polls immediately, and schedules the interval', function () {
            let clock = sinon.useFakeTimers();
            let det = mk();
            let poll = sinon.stub(det, '_poll').resolves();
            det.start(['BTC', 'TBTC']);

            expect(det.running).to.be.true;
            expect(det.state.BTC).to.deep.equal({ blockIndex: 0, actionIndex: 0, initialized: false });
            expect(poll.calledOnce).to.be.true;            // immediate poll
            clock.tick(5001);
            expect(poll.callCount).to.equal(2);            // interval poll

            det.stop();
            expect(det.running).to.be.false;
            expect(det.timer).to.be.null;
            clock.restore();
        });

        it('is idempotent when already running', function () {
            let det = mk();
            det.running = true;
            let poll = sinon.stub(det, '_poll');
            det.start(['BTC']);
            expect(poll.called).to.be.false;
        });

        it('preserves existing coin state across a restart', function () {
            let clock = sinon.useFakeTimers();
            let det = mk();
            sinon.stub(det, '_poll').resolves();
            det.state.BTC = { blockIndex: 9, actionIndex: 9, initialized: true };
            det.start(['BTC']);
            expect(det.state.BTC.blockIndex).to.equal(9); // not reset
            det.stop();
            clock.restore();
        });
    });

    // -----------------------------------------------------------------
    // _poll()
    // -----------------------------------------------------------------

    describe('_poll()', function () {
        it('does nothing when not running', async function () {
            let det = mk();
            det.state = { BTC: {} };
            let check = sinon.stub(det, '_checkCoin');
            await det._poll();
            expect(check.called).to.be.false;
        });

        it('swallows per-coin errors', async function () {
            let det = mk();
            det.running = true;
            det.state = { BTC: {} };
            sinon.stub(det, '_checkCoin').rejects(new Error('boom'));
            await det._poll(); // must not throw
        });
    });

    // -----------------------------------------------------------------
    // _checkCoin()
    // -----------------------------------------------------------------

    describe('_checkCoin()', function () {
        it('seeds state on the first poll without emitting', async function () {
            let det = mk();
            det.state.BTC = { blockIndex: 0, actionIndex: 0, initialized: false };
            det.db.getMaxBlockIndex.resolves(10);
            det.db.getMaxActionIndex.resolves(20);
            let events = [];
            det.on('block', () => events.push('b'));
            det.on('action', () => events.push('a'));

            await det._checkCoin('BTC');

            expect(det.state.BTC).to.include({ blockIndex: 10, actionIndex: 20, initialized: true });
            expect(events).to.deep.equal([]);
        });

        it('emits block and action events for new data and advances state', async function () {
            let det = mk();
            det.state.BTC = { blockIndex: 5, actionIndex: 5, initialized: true };
            det.db.getMaxBlockIndex.resolves(7);
            det.db.getMaxActionIndex.resolves(8);
            det.db.getBlocksSince.resolves([{ block_index: 6 }, { block_index: 7 }]);
            det.db.getActionsSince.resolves([{ action: 'SEND', action_index: 6 }]);
            let blocks = [], actions = [];
            det.on('block', (c, b) => blocks.push(b));
            det.on('action', (c, a) => actions.push(a));

            await det._checkCoin('BTC');

            expect(blocks).to.have.length(2);
            expect(actions).to.have.length(1);
            expect(det.state.BTC.blockIndex).to.equal(7);
            expect(det.state.BTC.actionIndex).to.equal(8);
        });

        it('does not emit when the max indexes are unchanged', async function () {
            let det = mk();
            det.state.BTC = { blockIndex: 5, actionIndex: 5, initialized: true };
            det.db.getMaxBlockIndex.resolves(5);
            det.db.getMaxActionIndex.resolves(5);
            let count = 0;
            det.on('block', () => count++);
            det.on('action', () => count++);
            await det._checkCoin('BTC');
            expect(count).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // _emitLifecycleEvents()
    // -----------------------------------------------------------------

    describe('_emitLifecycleEvents()', function () {
        it('maps a known action type to a lifecycle event', async function () {
            let det = mk();
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det._emitLifecycleEvents('BTC', { coin: 'BTC' }, { action: 'DISPENSE', action_index: 1 });
            expect(evs).to.have.length(1);
            expect(evs[0].type).to.equal('DISPENSE');
        });

        it('ignores actions with no type or no mapping', async function () {
            let det = mk();
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det._emitLifecycleEvents('BTC', {}, { action: null });
            await det._emitLifecycleEvents('BTC', {}, { action: 'NOT_MAPPED' });
            expect(evs).to.deep.equal([]);
        });

        it('enriches ORDER_MATCH with settlement type and emits COINPAY_REQUIRED', async function () {
            let det = mk();
            det.db.getOrderMatchSettlement.resolves({ settlement_type: 'coinpay' });
            det.db.getCoinpayObligation.resolves({
                obligation_action_index: 9, order_match_action_index: 5,
                payer_address: 'a', payee_address: 'b', coin_amount: '1', expiration: 100
            });
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det._emitLifecycleEvents('BTC', { coin: 'BTC' }, { action: 'ORDER_MATCH', action_index: 5 });

            let types = evs.map(e => e.type);
            expect(types).to.include('COINPAY_REQUIRED');
            expect(types).to.include('ORDER_MATCH');
            expect(evs.find(e => e.type === 'ORDER_MATCH').data.settlement_type).to.equal('coinpay');
        });

        it('ORDER_MATCH enrichment failure still emits the base event', async function () {
            let det = mk();
            det.db.getOrderMatchSettlement.rejects(new Error('db'));
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det._emitLifecycleEvents('BTC', {}, { action: 'ORDER_MATCH', action_index: 5 });
            expect(evs.map(e => e.type)).to.include('ORDER_MATCH');
        });
    });

    // -----------------------------------------------------------------
    // _emitEntityUpdates()
    // -----------------------------------------------------------------

    describe('_emitEntityUpdates()', function () {
        it('returns immediately with no channel manager', async function () {
            let det = mk({ channelManager: null });
            await det._emitEntityUpdates('BTC', {}, {}); // must not throw
        });

        it('emits ADDRESS_UPDATE for an involved subscribed address', async function () {
            let det = mk();
            det.channelManager.getSubscribedAddresses.returns(new Set(['addrA']));
            det.db.getAddressBalances.resolves([{ tick: 'X', amount: '1' }]);
            let evs = [];
            det.on('entity_update', (c, e) => evs.push(e));
            await det._emitEntityUpdates('BTC', { coin: 'BTC' }, { source: 'addrA', action_index: 3 });
            expect(evs[0].type).to.equal('ADDRESS_UPDATE');
            expect(evs[0].data.address).to.equal('addrA');
        });

        it('emits TOKEN_UPDATE for a subscribed tick on a token action', async function () {
            let det = mk();
            det.channelManager.getSubscribedTicks.returns(new Set(['GOLD']));
            det.db.getTokenInfo.resolves({ supply: '100', holders: 5 });
            let evs = [];
            det.on('entity_update', (c, e) => evs.push(e));
            await det._emitEntityUpdates('BTC', {}, { action: 'MINT', action_index: 4 });
            expect(evs[0].type).to.equal('TOKEN_UPDATE');
            expect(evs[0].data.tick).to.equal('GOLD');
        });

        it('emits DISPENSER_UPDATE for a subscribed dispenser on a dispense action', async function () {
            let det = mk();
            det.channelManager.getSubscribedDispensers.returns(new Set([7]));
            det.db.getDispenserInfo.resolves({ dispenser_index: 7 });
            let evs = [];
            det.on('entity_update', (c, e) => evs.push(e));
            await det._emitEntityUpdates('BTC', {}, { action: 'DISPENSE', action_index: 8 });
            expect(evs[0].type).to.equal('DISPENSER_UPDATE');
        });

        it('emits MARKET_UPDATE for a subscribed market on an order action', async function () {
            let det = mk();
            det.channelManager.getSubscribedMarkets.returns([{ tick1: 'A', tick2: 'B' }]);
            det.db.getMarketInfo.resolves({ pair: 'A/B' });
            let evs = [];
            det.on('entity_update', (c, e) => evs.push(e));
            await det._emitEntityUpdates('BTC', {}, { action: 'ORDER_MATCH', action_index: 9 });
            expect(evs[0].type).to.equal('MARKET_UPDATE');
        });

        it('swallows db errors during address/token/dispenser/market enrichment', async function () {
            let det = mk();
            det.channelManager.getSubscribedAddresses.returns(new Set(['addrA']));
            det.channelManager.getSubscribedTicks.returns(new Set(['GOLD']));
            det.channelManager.getSubscribedDispensers.returns(new Set([7]));
            det.channelManager.getSubscribedMarkets.returns([{ tick1: 'A', tick2: 'B' }]);
            det.db.getAddressBalances.rejects(new Error('db'));
            det.db.getTokenInfo.rejects(new Error('db'));
            det.db.getDispenserInfo.rejects(new Error('db'));
            det.db.getMarketInfo.rejects(new Error('db'));
            let evs = [];
            det.on('entity_update', (c, e) => evs.push(e));
            // ORDER_MATCH touches token? No. Use an action that hits all four branches
            // separately: source addr (address), and ORDER_MATCH (market). Token/dispenser
            // need their own action types, so fire one of each.
            await det._emitEntityUpdates('BTC', {}, { source: 'addrA', action: 'MINT', action_index: 3 });      // address + token
            await det._emitEntityUpdates('BTC', {}, { action: 'DISPENSE', action_index: 4 });                   // dispenser
            await det._emitEntityUpdates('BTC', {}, { action: 'ORDER_MATCH', action_index: 5 });                // market
            expect(evs).to.deep.equal([]); // every enrichment failed silently
        });
    });

    // -----------------------------------------------------------------
    // _emitAttestationEvents()
    // -----------------------------------------------------------------

    describe('_emitAttestationEvents()', function () {
        it('ignores non-ATTEST actions', async function () {
            let det = mk();
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det._emitAttestationEvents('BTC', {}, { action: 'SEND' });
            expect(evs).to.deep.equal([]);
        });

        it('emits ATTESTATION_REQUEST for a v0 attest', async function () {
            let det = mk();
            det.db.getAttestationByActionIndex.resolves({ version: 0, action_index: 1, request_id: 'r' });
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det._emitAttestationEvents('BTC', {}, { action: 'ATTEST', action_index: 1 });
            expect(evs[0].type).to.equal('ATTESTATION_REQUEST');
        });

        it('emits ATTESTATION_RESPONSE for a v1 attest', async function () {
            let det = mk();
            det.db.getAttestationByActionIndex.resolves({ version: 1, action_index: 1 });
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det._emitAttestationEvents('BTC', {}, { action: 'ATTEST', action_index: 1 });
            expect(evs[0].type).to.equal('ATTESTATION_RESPONSE');
        });

        it('is non-fatal on db error and silent when no row is found', async function () {
            let det = mk();
            det.db.getAttestationByActionIndex.rejects(new Error('db'));
            await det._emitAttestationEvents('BTC', {}, { action: 'ATTEST', action_index: 1 }); // no throw

            det.db.getAttestationByActionIndex.resolves(null);
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det._emitAttestationEvents('BTC', {}, { action: 'ATTEST', action_index: 2 });
            expect(evs).to.deep.equal([]);
        });
    });

    // -----------------------------------------------------------------
    // getState()
    // -----------------------------------------------------------------

    describe('getState()', function () {
        it('returns the coin state or a zeroed default', function () {
            let det = mk();
            det.state.BTC = { blockIndex: 5, actionIndex: 6, initialized: true };
            expect(det.getState('BTC').blockIndex).to.equal(5);
            expect(det.getState('NOPE')).to.deep.equal({ blockIndex: 0, actionIndex: 0 });
        });
    });
});
