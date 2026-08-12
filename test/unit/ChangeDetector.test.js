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
        getDispenseDispenserIndex:   sinon.stub().resolves(null),
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

// Inclusive integer range [a..b].
function range(a, b) { let r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

describe('ChangeDetector', function () {

    afterEach(() => sinon.restore());

    describe('start() / stop()', function () {
        it('seeds per-coin state, polls immediately, and schedules the interval', function () {
            let clock = sinon.useFakeTimers();
            let det = mk();
            let poll = sinon.stub(det, '_poll').resolves();
            det.start(['BTC', 'TBTC']);

            expect(det.running).to.be.true;
            expect(det.state.BTC).to.deep.equal({ blockIndex: 0, actionIndex: 0, closedBlock: 0, initialized: false });
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

        // Regression: a burst larger than fetchLimit used to advance the cursor
        // straight to the observed tip after a capped fetch, permanently skipping
        // every action past the first fetchLimit in that interval.
        it('drains an action burst larger than fetchLimit across polls without skipping any', async function () {
            let det = mk();  // fetchLimit 100
            det.state.BTC = { blockIndex: 0, actionIndex: 5, initialized: true };
            det.db.getMaxBlockIndex.resolves(0);
            det.db.getMaxActionIndex.resolves(255);   // 250 new actions, > fetchLimit
            det.db.getActionsSince.callsFake(async (cfg, since, limit) => {
                let rows = [];
                for (let i = since + 1; i <= Math.min(since + limit, 255); i++)
                    rows.push({ action: 'SEND', action_index: i });
                return rows;
            });
            let seen = [];
            det.on('action', (c, a) => seen.push(a.action_index));

            await det._checkCoin('BTC');
            expect(det.state.BTC.actionIndex).to.equal(105);   // last fetched, NOT the tip 255
            await det._checkCoin('BTC');
            expect(det.state.BTC.actionIndex).to.equal(205);
            await det._checkCoin('BTC');
            expect(det.state.BTC.actionIndex).to.equal(255);   // fully drained
            expect(seen).to.deep.equal(range(6, 255));          // every action emitted once, none skipped
        });

        // Number() collapsed two consecutive action indices above 2^53 onto one
        // value, so a capped fetch could hand back a cursor at or past an action that
        // was never emitted, and the `last < currentMax` backlog test read equal.
        it('advances a >2^53 action cursor exactly instead of through a collapsed Number', function () {
            let det = mk();  // fetchLimit 100
            let rows = [];
            for (let i = 0n; i < 100n; i++) rows.push({ action: 'SEND', action_index: 9007199254740000n + i });

            let next = det._nextCursor(rows, 'action_index', 9007199254741000n);
            expect(String(next)).to.equal('9007199254740099');
            expect(typeof next).to.equal('bigint');
        });

        it('leaves the block cursor a Number (only the action cursor went BigInt)', function () {
            let det = mk();  // fetchLimit 100
            let rows = [];
            for (let i = 1; i <= 100; i++) rows.push({ block_index: i });

            let next = det._nextCursor(rows, 'block_index', 500);
            expect(next).to.equal(100);
            expect(typeof next).to.equal('number');
        });

        it('drains a block burst larger than fetchLimit across polls', async function () {
            let det = mk();
            det.state.BTC = { blockIndex: 0, actionIndex: 0, initialized: true };
            det.db.getMaxBlockIndex.resolves(150);
            det.db.getBlocksSince.callsFake(async (cfg, since, limit) => {
                let rows = [];
                for (let i = since + 1; i <= Math.min(since + limit, 150); i++) rows.push({ block_index: i });
                return rows;
            });
            let seen = [];
            det.on('block', (c, b) => seen.push(b.block_index));
            await det._checkCoin('BTC');
            expect(det.state.BTC.blockIndex).to.equal(100);   // capped at fetchLimit, not tip 150
            await det._checkCoin('BTC');
            expect(det.state.BTC.blockIndex).to.equal(150);
            expect(seen).to.deep.equal(range(1, 150));
        });

        // Regression: the reorg flag was computed but discarded, so a reorg that
        // lowered the tip left the cursor above it and the feed stalled (or skipped
        // the replaced tail) until the chain re-passed the old high-water mark.
        it('rewinds the cursor to the new tip on a reorg that lowers the height', async function () {
            let det = mk();
            det.db.checkReorgAndInvalidate = sinon.stub().resolves(true);
            det.state.BTC = { blockIndex: 100, actionIndex: 100, initialized: true };
            det.db.getMaxBlockIndex.resolves(95);
            det.db.getMaxActionIndex.resolves(95);
            let count = 0;
            det.on('block', () => count++);
            det.on('action', () => count++);

            await det._checkCoin('BTC');
            expect(det.state.BTC.blockIndex).to.equal(95);    // clamped down, not stuck at 100
            expect(det.state.BTC.actionIndex).to.equal(95);
            expect(count).to.equal(0);

            // A single new block/action above the new tip now emits immediately,
            // instead of waiting for the chain to climb back above 100.
            det.db.checkReorgAndInvalidate.resolves(false);
            det.db.getMaxBlockIndex.resolves(96);
            det.db.getMaxActionIndex.resolves(96);
            det.db.getBlocksSince.resolves([{ block_index: 96 }]);
            det.db.getActionsSince.resolves([{ action: 'SEND', action_index: 96 }]);
            await det._checkCoin('BTC');
            expect(count).to.equal(2);
        });

        it('does not lower the cursor on a reorg whose new tip is higher', async function () {
            let det = mk();
            det.db.checkReorgAndInvalidate = sinon.stub().resolves(true);
            det.state.BTC = { blockIndex: 10, actionIndex: 10, initialized: true };
            det.db.getMaxBlockIndex.resolves(12);
            det.db.getMaxActionIndex.resolves(12);
            det.db.getBlocksSince.resolves([{ block_index: 11 }, { block_index: 12 }]);
            det.db.getActionsSince.resolves([{ action: 'SEND', action_index: 11 }, { action: 'SEND', action_index: 12 }]);
            let blocks = 0;
            det.on('block', () => blocks++);
            await det._checkCoin('BTC');
            expect(det.state.BTC.blockIndex).to.equal(12);
            expect(blocks).to.equal(2);
        });
    });

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

        it('enriches DISPENSE with the parent dispenser_action_index the SDK reads', async function () {
            let det = mk();
            det.db.getDispenseDispenserIndex.resolves(42);
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det._emitLifecycleEvents('BTC', { coin: 'BTC' }, { action: 'DISPENSE', action_index: 7 });
            expect(evs).to.have.length(1);
            expect(evs[0].type).to.equal('DISPENSE');
            expect(evs[0].data.dispenser_action_index).to.equal(42);
            expect(det.db.getDispenseDispenserIndex.calledOnceWith({ coin: 'BTC' }, 7)).to.equal(true);
        });

        it('DISPENSE enrichment failure still emits the base event with a null parent index', async function () {
            let det = mk();
            det.db.getDispenseDispenserIndex.rejects(new Error('db'));
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det._emitLifecycleEvents('BTC', {}, { action: 'DISPENSE', action_index: 7 });
            expect(evs.map(e => e.type)).to.include('DISPENSE');
            expect(evs[0].data.dispenser_action_index).to.equal(null);
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

        it('TOKEN_UPDATE carries the full getTokenInfo projection plus last_action_index (snapshot/live frame parity)', async function () {
            // The token SNAPSHOT frame spreads getTokenInfo verbatim
            // (WebSocketServer._sendSnapshots case 'token'), so the live frame
            // must be a superset of the same projection or replace-model
            // consumers lose decimals/description as silent undefined.
            let det = mk();
            det.channelManager.getSubscribedTicks.returns(new Set(['GOLD']));
            const tokenInfo = { tick: 'GOLD', supply: '100', decimals: 8, description: 'au', holders: 5 };
            det.db.getTokenInfo.resolves(tokenInfo);
            let evs = [];
            det.on('entity_update', (c, e) => evs.push(e));
            await det._emitEntityUpdates('BTC', {}, { action: 'MINT', action_index: 4 });
            for (const key of Object.keys(tokenInfo)) {
                expect(evs[0].data[key], `live frame must carry snapshot field "${key}"`).to.deep.equal(tokenInfo[key]);
            }
            expect(evs[0].data.last_action_index).to.equal(4);
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
            // Each action type only triggers one enrichment branch, so exercise
            // address+token, dispenser, and market with separate calls.
            await det._emitEntityUpdates('BTC', {}, { source: 'addrA', action: 'MINT', action_index: 3 });      // address + token
            await det._emitEntityUpdates('BTC', {}, { action: 'DISPENSE', action_index: 4 });                   // dispenser
            await det._emitEntityUpdates('BTC', {}, { action: 'ORDER_MATCH', action_index: 5 });                // market
            expect(evs).to.deep.equal([]); // every enrichment failed silently
        });
    });

    // Enrichment reads are cached once per distinct entity per poll, but the
    // same per-action events are still emitted.
    describe('per-poll entity-read batching', function () {
        function seedPoll(det, actions) {
            det.state['BTC'] = { blockIndex: 0, actionIndex: 0, initialized: true };
            det.db.getMaxBlockIndex.resolves(0);
            det.db.getMaxActionIndex.resolves(actions.length);
            det.db.getActionsSince.resolves(actions);
        }

        it('reads getTokenInfo once per distinct tick per poll but emits one TOKEN_UPDATE per action', async function () {
            let det = mk();
            det.channelManager.getSubscribedTicks.returns(new Set(['GOLD']));
            det.db.getTokenInfo.resolves({ supply: '100', holders: 5 });
            const actions = [
                { action: 'MINT', action_index: 1 },
                { action: 'MINT', action_index: 2 },
                { action: 'MINT', action_index: 3 }
            ];
            seedPoll(det, actions);
            let evs = [];
            det.on('entity_update', (c, e) => { if (e.type === 'TOKEN_UPDATE') evs.push(e); });

            await det._checkCoin('BTC');

            // One DB read for GOLD across the whole poll (was one per action).
            expect(det.db.getTokenInfo.callCount).to.equal(1);
            // But still one TOKEN_UPDATE per action, each carrying its own last_action_index.
            expect(evs.map((e) => e.data.last_action_index)).to.deep.equal([1, 2, 3]);
            expect(evs.every((e) => e.data.tick === 'GOLD' && e.data.supply === '100')).to.equal(true);
        });

        it('reads getAddressBalances once per distinct address per poll but emits one ADDRESS_UPDATE per action', async function () {
            let det = mk();
            det.channelManager.getSubscribedAddresses.returns(new Set(['addrA']));
            det.db.getAddressBalances.resolves([{ tick: 'X', amount: '1' }]);
            const actions = [
                { source: 'addrA', action: 'SEND', action_index: 10 },
                { source: 'addrA', action: 'SEND', action_index: 11 }
            ];
            seedPoll(det, actions);
            let evs = [];
            det.on('entity_update', (c, e) => { if (e.type === 'ADDRESS_UPDATE') evs.push(e); });

            await det._checkCoin('BTC');

            expect(det.db.getAddressBalances.callCount).to.equal(1);
            expect(evs.map((e) => e.data.last_action_index)).to.deep.equal([10, 11]);
            expect(evs.every((e) => e.data.address === 'addrA')).to.equal(true);
        });

        it('re-reads an entity on the NEXT poll (cache is per-poll, not persistent)', async function () {
            let det = mk();
            det.channelManager.getSubscribedTicks.returns(new Set(['GOLD']));
            det.db.getTokenInfo.resolves({ supply: '100', holders: 5 });

            det.state['BTC'] = { blockIndex: 0, actionIndex: 0, initialized: true };
            det.db.getMaxBlockIndex.resolves(0);
            det.db.getMaxActionIndex.onFirstCall().resolves(1).onSecondCall().resolves(2);
            det.db.getActionsSince
                .onFirstCall().resolves([{ action: 'MINT', action_index: 1 }])
                .onSecondCall().resolves([{ action: 'MINT', action_index: 2 }]);

            await det._checkCoin('BTC');
            await det._checkCoin('BTC');

            // One read per poll -> two reads across two polls (no stale cross-poll cache).
            expect(det.db.getTokenInfo.callCount).to.equal(2);
        });
    });

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

    describe('getState()', function () {
        it('returns the coin state or a zeroed default', function () {
            let det = mk();
            det.state.BTC = { blockIndex: 5, actionIndex: 6, initialized: true };
            expect(det.getState('BTC').blockIndex).to.equal(5);
            expect(det.getState('NOPE')).to.deep.equal({ blockIndex: 0, actionIndex: 0, closedBlock: 0 });
        });
    });
});
