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
 * Unit tests for ChannelManager (src/ws/ChannelManager.js)
 */

'use strict';

const { expect } = require('chai');
const ChannelManager = require('../../../src/ws/ChannelManager.js');

// Helper: create a mock client object
function createClient(id, coin) {
    return {
        id:            id || 1,
        coin:          coin || 'BTC',
        chain:         'BTC',
        network:       'mainnet',
        subscriptions: new Set()
    };
}

describe('ChannelManager', function () {

    let cm;

    beforeEach(function () {
        cm = new ChannelManager({ maxSubscriptions: 25 });
    });

    // -----------------------------------------------------------------
    // Subscribe: global channels
    // -----------------------------------------------------------------

    describe('subscribe – global channels', function () {

        it('subscribes to blocks channel', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['blocks']);
            expect(result.success).to.be.true;
            expect(result.subscribed).to.have.lengthOf(1);
            expect(result.subscribed[0].channel).to.equal('blocks');
            expect(client.subscriptions.size).to.equal(1);
        });

        it('subscribes to multiple global channels', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['blocks', 'actions', 'network']);
            expect(result.success).to.be.true;
            expect(result.subscribed).to.have.lengthOf(3);
            expect(client.subscriptions.size).to.equal(3);
        });

        it('rejects invalid channel name', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['invalid_channel']);
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_CHANNEL');
        });

        it('rejects empty channels array', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, []);
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_CHANNEL');
        });

        it('rejects non-array channels', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, 'blocks');
            expect(result.success).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // Subscribe: entity channels
    // -----------------------------------------------------------------

    describe('subscribe – entity channels', function () {

        it('subscribes to address channel', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['address'], { address: '1abc' });
            expect(result.success).to.be.true;
            expect(result.subscribed[0].address).to.equal('1abc');
        });

        it('subscribes to token channel', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['token'], { tick: 'PEPE' });
            expect(result.success).to.be.true;
            expect(result.subscribed[0].tick).to.equal('PEPE');
        });

        it('subscribes to market channel', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['market'], { tick1: 'PEPE', tick2: 'BTC' });
            expect(result.success).to.be.true;
            expect(result.subscribed[0].tick1).to.equal('PEPE');
            expect(result.subscribed[0].tick2).to.equal('BTC');
        });

        it('subscribes to dispenser channel', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['dispenser'], { action_index: 12345 });
            expect(result.success).to.be.true;
            expect(result.subscribed[0].action_index).to.equal(12345);
        });

        it('rejects address channel without address param', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['address']);
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_CHANNEL');
        });

        it('rejects market channel without both ticks', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['market'], { tick1: 'PEPE' });
            expect(result.success).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // Subscribe: batch entity subscriptions
    // -----------------------------------------------------------------

    describe('subscribe – batch', function () {

        it('subscribes to multiple addresses', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['address'], {
                addresses: ['1abc', '1def', '1ghi']
            });
            expect(result.success).to.be.true;
            expect(result.subscribed).to.have.lengthOf(3);
            expect(client.subscriptions.size).to.equal(3);
        });

        it('subscribes to multiple market pairs', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['market'], {
                pairs: [['PEPE', 'BTC'], ['XCHAIN', 'BTC']]
            });
            expect(result.success).to.be.true;
            expect(result.subscribed).to.have.lengthOf(2);
        });

        it('subscribes to multiple dispensers', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['dispenser'], {
                action_indexes: [100, 200, 300]
            });
            expect(result.success).to.be.true;
            expect(result.subscribed).to.have.lengthOf(3);
        });
    });

    // -----------------------------------------------------------------
    // Subscribe: filters
    // -----------------------------------------------------------------

    describe('subscribe – filters', function () {

        it('stores types filter', function () {
            const client = createClient(1);
            cm.subscribe(client, ['actions'], { types: ['SEND', 'ORDER_MATCH'] });
            const subs = cm.listSubscriptions(client);
            expect(subs[0].filters.types).to.deep.equal(['SEND', 'ORDER_MATCH']);
        });

        it('stores statuses filter', function () {
            const client = createClient(1);
            cm.subscribe(client, ['actions'], { statuses: ['pending_coinpay'] });
            const subs = cm.listSubscriptions(client);
            expect(subs[0].filters.statuses).to.deep.equal(['pending_coinpay']);
        });

        it('stores once flag', function () {
            const client = createClient(1);
            cm.subscribe(client, ['actions'], { once: true });
            const subs = cm.listSubscriptions(client);
            expect(subs[0].filters.once).to.be.true;
        });

        it('rejects invalid types', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['actions'], { types: ['INVALID_TYPE'] });
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_TYPE');
        });

        it('accepts the federation / cross-chain / oracle action types (PRICE, ANCHOR, XCALL, NODEPROOF)', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['actions'], { types: ['PRICE', 'ANCHOR', 'XCALL', 'NODEPROOF'] });
            expect(result.success).to.be.true;
            const subs = cm.listSubscriptions(client);
            expect(subs[0].filters.types).to.deep.equal(['PRICE', 'ANCHOR', 'XCALL', 'NODEPROOF']);
        });

        it('still rejects CONTROLLER (a field on ISSUE/ADDRESS, not an action type)', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['actions'], { types: ['CONTROLLER'] });
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_TYPE');
        });

        it('null filters when omitted', function () {
            const client = createClient(1);
            cm.subscribe(client, ['actions']);
            const subs = cm.listSubscriptions(client);
            expect(subs[0].filters.types).to.be.null;
            expect(subs[0].filters.statuses).to.be.null;
        });
    });

    // -----------------------------------------------------------------
    // Subscription limits
    // -----------------------------------------------------------------

    describe('subscription limits', function () {

        it('enforces max subscriptions', function () {
            const cm2 = new ChannelManager({ maxSubscriptions: 3 });
            const client = createClient(1);
            cm2.subscribe(client, ['blocks']);
            cm2.subscribe(client, ['actions']);
            cm2.subscribe(client, ['network']);
            const result = cm2.subscribe(client, ['mempool']);
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('SUBSCRIPTION_LIMIT');
        });

        it('allows re-subscribing to same channel (idempotent)', function () {
            const cm2 = new ChannelManager({ maxSubscriptions: 2 });
            const client = createClient(1);
            cm2.subscribe(client, ['blocks']);
            cm2.subscribe(client, ['actions']);
            // Re-subscribe to blocks: should update, not count as new
            const result = cm2.subscribe(client, ['blocks']);
            expect(result.success).to.be.true;
        });
    });

    // -----------------------------------------------------------------
    // Unsubscribe
    // -----------------------------------------------------------------

    describe('unsubscribe', function () {

        it('removes a global subscription', function () {
            const client = createClient(1);
            cm.subscribe(client, ['blocks']);
            expect(client.subscriptions.size).to.equal(1);
            cm.unsubscribe(client, ['blocks']);
            expect(client.subscriptions.size).to.equal(0);
        });

        it('removes an entity subscription', function () {
            const client = createClient(1);
            cm.subscribe(client, ['address'], { address: '1abc' });
            expect(client.subscriptions.size).to.equal(1);
            cm.unsubscribe(client, ['address'], { address: '1abc' });
            expect(client.subscriptions.size).to.equal(0);
        });

        it('no-op for channel not subscribed to', function () {
            const client = createClient(1);
            cm.unsubscribe(client, ['blocks']); // should not throw
            expect(client.subscriptions.size).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // removeClient
    // -----------------------------------------------------------------

    describe('removeClient', function () {

        it('removes all subscriptions for a client', function () {
            const client = createClient(1);
            cm.subscribe(client, ['blocks', 'actions']);
            cm.subscribe(client, ['address'], { address: '1abc' });
            expect(client.subscriptions.size).to.equal(3);
            cm.removeClient(client);
            expect(client.subscriptions.size).to.equal(0);
        });

        it('cleans up channel maps when last subscriber leaves', function () {
            const client = createClient(1);
            cm.subscribe(client, ['blocks']);
            expect(cm.subscriptions.size).to.be.greaterThan(0);
            cm.removeClient(client);
            expect(cm.subscriptions.size).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // listSubscriptions
    // -----------------------------------------------------------------

    describe('listSubscriptions', function () {

        it('returns all subscriptions with filters', function () {
            const client = createClient(1);
            cm.subscribe(client, ['blocks']);
            cm.subscribe(client, ['address'], { address: '1abc', types: ['SEND'] });
            const list = cm.listSubscriptions(client);
            expect(list).to.have.lengthOf(2);
            expect(list[0].channel).to.equal('blocks');
            expect(list[1].channel).to.equal('address');
            expect(list[1].address).to.equal('1abc');
            expect(list[1].filters.types).to.deep.equal(['SEND']);
        });

        it('returns empty array for client with no subscriptions', function () {
            const client = createClient(1);
            const list = cm.listSubscriptions(client);
            expect(list).to.deep.equal([]);
        });

        // Regression: subscribe() echoes action_index as a NUMBER (see the
        // 'subscribes to dispenser channel' test above), but listSubscriptions()
        // used to reconstruct it from the channel key via string split, returning
        // a STRING. A client reconciling the two frames with === or a Map key
        // would silently report the subscription as missing.
        it('returns action_index as a number for dispenser subscriptions, matching subscribe()', function () {
            const client = createClient(1);
            const subscribeResult = cm.subscribe(client, ['dispenser'], { action_index: 45678 });
            expect(subscribeResult.subscribed[0].action_index).to.equal(45678);
            expect(subscribeResult.subscribed[0].action_index).to.be.a('number');

            const list = cm.listSubscriptions(client);
            const entry = list.find(s => s.channel === 'dispenser');
            expect(entry.action_index).to.equal(45678);
            expect(entry.action_index).to.be.a('number');
        });
    });

    // -----------------------------------------------------------------
    // Subscriber queries
    // -----------------------------------------------------------------

    describe('subscriber queries', function () {

        it('hasSubscribers returns true when subscribed', function () {
            const client = createClient(1);
            cm.subscribe(client, ['blocks']);
            expect(cm.hasSubscribers('BTC', 'blocks')).to.be.true;
        });

        it('hasSubscribers returns false when not subscribed', function () {
            expect(cm.hasSubscribers('BTC', 'blocks')).to.be.false;
        });

        it('getSubscribedAddresses returns subscribed addresses', function () {
            const client = createClient(1);
            cm.subscribe(client, ['address'], { addresses: ['1abc', '1def'] });
            const addrs = cm.getSubscribedAddresses('BTC');
            expect(addrs.has('1abc')).to.be.true;
            expect(addrs.has('1def')).to.be.true;
            expect(addrs.size).to.equal(2);
        });

        it('getSubscribedTicks returns subscribed ticks', function () {
            const client = createClient(1);
            cm.subscribe(client, ['token'], { tick: 'PEPE' });
            const ticks = cm.getSubscribedTicks('BTC');
            expect(ticks.has('PEPE')).to.be.true;
        });

        it('getSubscribedMarkets returns subscribed pairs', function () {
            const client = createClient(1);
            cm.subscribe(client, ['market'], { tick1: 'PEPE', tick2: 'BTC' });
            const markets = cm.getSubscribedMarkets('BTC');
            expect(markets).to.have.lengthOf(1);
            expect(markets[0]).to.deep.equal({ tick1: 'PEPE', tick2: 'BTC' });
        });

        it('getSubscribedDispensers returns subscribed dispensers', function () {
            const client = createClient(1);
            cm.subscribe(client, ['dispenser'], { action_index: 12345 });
            const dispensers = cm.getSubscribedDispensers('BTC');
            expect(dispensers.has('12345')).to.be.true;
        });
    });
});
