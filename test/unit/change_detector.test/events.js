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
 * Unit tests for src/ws/change_detector.js: the indexer-DB poller that turns
 * new blocks/actions into WebSocket events. All collaborators are injected, so
 * no real DB or timers are needed (fake timers used only for the poll loop).
 */

'use strict';

const sinon = require('sinon');
const { expect } = require('chai');
const { mk } = require('./helpers.js');

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('_emitLifecycleEvents()', function () {
        it('maps a known action type to a lifecycle event', async function () {
            let det = mk();
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det.emitLifecycleEvents('BTC', { coin: 'BTC' }, { action: 'DISPENSE', action_index: 1 });
            expect(evs).to.have.length(1);
            expect(evs[0].type).to.equal('DISPENSE');
        });

        it('ignores actions with no type or no mapping', async function () {
            let det = mk();
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det.emitLifecycleEvents('BTC', {}, { action: null });
            await det.emitLifecycleEvents('BTC', {}, { action: 'NOT_MAPPED' });
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
            await det.emitLifecycleEvents('BTC', { coin: 'BTC' }, { action: 'ORDER_MATCH', action_index: 5 });

            let types = evs.map(e => e.type);
            expect(types).to.include('COINPAY_REQUIRED');
            expect(types).to.include('ORDER_MATCH');
            expect(evs.find(e => e.type === 'ORDER_MATCH').data.settlement_type).to.equal('coinpay');
        });
    });
});

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('_emitLifecycleEvents()', function () {
        it('enriches DISPENSE with the parent dispenser_action_index the SDK reads', async function () {
            let det = mk();
            det.db.getDispenseDispenserIndex.resolves(42);
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det.emitLifecycleEvents('BTC', { coin: 'BTC' }, { action: 'DISPENSE', action_index: 7 });
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
            await det.emitLifecycleEvents('BTC', {}, { action: 'DISPENSE', action_index: 7 });
            expect(evs.map(e => e.type)).to.include('DISPENSE');
            expect(evs[0].data.dispenser_action_index).to.equal(null);
        });

        it('ORDER_MATCH enrichment failure still emits the base event', async function () {
            let det = mk();
            det.db.getOrderMatchSettlement.rejects(new Error('db'));
            let evs = [];
            det.on('lifecycle_event', (c, e) => evs.push(e));
            await det.emitLifecycleEvents('BTC', {}, { action: 'ORDER_MATCH', action_index: 5 });
            expect(evs.map(e => e.type)).to.include('ORDER_MATCH');
        });
    });
});

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('_emitEntityUpdates()', function () {
        it('returns immediately with no channel manager', async function () {
            let det = mk({ channelManager: null });
            await det.emitEntityUpdates('BTC', {}, {}); // must not throw
        });

        it('emits ADDRESS_UPDATE for an involved subscribed address', async function () {
            let det = mk();
            det.channelManager.getSubscribedAddresses.returns(new Set(['addrA']));
            det.db.getAddressBalances.resolves([{ tick: 'X', amount: '1' }]);
            let evs = [];
            det.on('entity_update', (c, e) => evs.push(e));
            await det.emitEntityUpdates('BTC', { coin: 'BTC' }, { source: 'addrA', action_index: 3 });
            expect(evs[0].type).to.equal('ADDRESS_UPDATE');
            expect(evs[0].data.address).to.equal('addrA');
        });

        it('emits TOKEN_UPDATE for a subscribed tick on a token action', async function () {
            let det = mk();
            det.channelManager.getSubscribedTicks.returns(new Set(['GOLD']));
            det.db.getTokenInfo.resolves({ supply: '100', holders: 5 });
            let evs = [];
            det.on('entity_update', (c, e) => evs.push(e));
            await det.emitEntityUpdates('BTC', {}, { action: 'MINT', action_index: 4 });
            expect(evs[0].type).to.equal('TOKEN_UPDATE');
            expect(evs[0].data.tick).to.equal('GOLD');
        });
    });
});

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('_emitEntityUpdates()', function () {
        it('TOKEN_UPDATE carries the full getTokenInfo projection plus last_action_index (snapshot/live frame parity)', async function () {
            // The token SNAPSHOT frame spreads getTokenInfo verbatim
            // (WebSocketServer.sendSnapshots case 'token'), so the live frame
            // must be a superset of the same projection or replace-model
            // consumers lose decimals/description as silent undefined.
            let det = mk();
            det.channelManager.getSubscribedTicks.returns(new Set(['GOLD']));
            const tokenInfo = { tick: 'GOLD', supply: '100', decimals: 8, description: 'au', holders: 5 };
            det.db.getTokenInfo.resolves(tokenInfo);
            let evs = [];
            det.on('entity_update', (c, e) => evs.push(e));
            await det.emitEntityUpdates('BTC', {}, { action: 'MINT', action_index: 4 });
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
            await det.emitEntityUpdates('BTC', {}, { action: 'DISPENSE', action_index: 8 });
            expect(evs[0].type).to.equal('DISPENSER_UPDATE');
        });

        it('emits MARKET_UPDATE for a subscribed market on an order action', async function () {
            let det = mk();
            det.channelManager.getSubscribedMarkets.returns([{ tick1: 'A', tick2: 'B' }]);
            det.db.getMarketInfo.resolves({ pair: 'A/B' });
            let evs = [];
            det.on('entity_update', (c, e) => evs.push(e));
            await det.emitEntityUpdates('BTC', {}, { action: 'ORDER_MATCH', action_index: 9 });
            expect(evs[0].type).to.equal('MARKET_UPDATE');
        });
    });
});

describe('ChangeDetector', function () {
    afterEach(() => sinon.restore());

    describe('_emitEntityUpdates()', function () {
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
            await det.emitEntityUpdates('BTC', {}, { source: 'addrA', action: 'MINT', action_index: 3 });      // address + token
            await det.emitEntityUpdates('BTC', {}, { action: 'DISPENSE', action_index: 4 });                   // dispenser
            await det.emitEntityUpdates('BTC', {}, { action: 'ORDER_MATCH', action_index: 5 });                // market
            expect(evs).to.deep.equal([]); // every enrichment failed silently
        });
    });
});
