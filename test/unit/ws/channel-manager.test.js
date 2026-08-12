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
            // action_index is normalized to a canonical decimal STRING at subscription so
            // SUBSCRIBED/SUBSCRIPTION_LIST/UNSUBSCRIBED all agree (v2 BIGINT-as-string).
            expect(result.subscribed[0].action_index).to.equal('12345');
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

        // A noncanonical index used to become a subscription identity of its own
        // while the snapshot read coerced it back to the real row, so the client got
        // one dispenser-7 snapshot and then no live frames (Broadcaster routes on the
        // canonical index). Reject it at the resolver instead.
        ['7junk', '007', '7.5', '-1', '', ' 7', '0x7', '1e3'].forEach((bad) => {
            it(`rejects noncanonical dispenser action_index ${JSON.stringify(bad)}`, function () {
                const client = createClient(1);
                const singular = cm.subscribe(client, ['dispenser'], { action_index: bad });
                expect(singular.success, 'singular path').to.be.false;
                expect(singular.error.code).to.equal('INVALID_CHANNEL');
                expect(client.subscriptions.size).to.equal(0);

                const batch = cm.subscribe(client, ['dispenser'], { action_indexes: [bad] });
                expect(batch.success, 'batch path').to.be.false;
                expect(batch.error.code).to.equal('INVALID_CHANNEL');
                expect(client.subscriptions.size).to.equal(0);
            });
        });

        it('rejects a noncanonical entry anywhere in an action_indexes batch (bet_feed too)', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['bet_feed'], { action_indexes: [100, '7junk', 300] });
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_CHANNEL');
            expect(client.subscriptions.size).to.equal(0);
        });

        it('still accepts canonical indexes as number or string, including 0', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['dispenser'], { action_indexes: [7, '7', 0] });
            expect(result.success).to.be.true;
            // 7 and '7' collapse to the same key, so two distinct entities survive.
            expect(client.subscriptions.size).to.equal(2);
            expect(result.subscribed.map((s) => s.action_index)).to.include('7');
        });
    });

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

    describe('subscribe – filters', function () {

        it('stores types filter', function () {
            const client = createClient(1);
            cm.subscribe(client, ['actions'], { types: ['SEND', 'ORDER_MATCH'] });
            const subs = cm.listSubscriptions(client);
            expect(subs[0].filters.types).to.deep.equal(['SEND', 'ORDER_MATCH']);
        });

        it('omits statuses from the subscription list (no-op filter, matching SUBSCRIBED)', function () {
            const client = createClient(1);
            cm.subscribe(client, ['actions'], { statuses: ['pending_coinpay'] });
            const subs = cm.listSubscriptions(client);
            // statuses is deliberately not surfaced: the actions feed cannot honor it, so
            // SUBSCRIPTION_LIST must not re-advertise a filter SUBSCRIBED already disowns.
            expect(subs[0].filters.statuses).to.be.undefined;
        });

        it('omits ticks from the subscription list (no-op filter, matching SUBSCRIBED)', function () {
            const client = createClient(1);
            cm.subscribe(client, ['actions'], { ticks: ['PEPE'] });
            const subs = cm.listSubscriptions(client);
            // No action frame carries a tick column, so re-advertising the filter here
            // would let a client rely on a stream that never narrows. It is still stored.
            expect(subs[0].filters.ticks).to.be.undefined;
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

        // A non-iterable `fields` reached `new Set(params.fields)` and threw a
        // synchronous TypeError out of the ws handler (unauthenticated crash).
        it('rejects a non-array fields filter instead of throwing (crash-DoS guard)', function () {
            const client = createClient(1);
            for (const bad of [1, {}, 'abc', true]) {
                const result = cm.subscribe(client, ['blocks'], { fields: bad });
                expect(result.success, 'fields=' + JSON.stringify(bad) + ' must be rejected').to.be.false;
                expect(result.error.code).to.equal('INVALID_PARAMS');
            }
        });

        it('rejects a fields array with non-string members', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['blocks'], { fields: ['ok', 5] });
            expect(result.success).to.be.false;
            expect(result.error.code).to.equal('INVALID_PARAMS');
        });

        it('accepts a valid string fields array', function () {
            const client = createClient(1);
            const result = cm.subscribe(client, ['blocks'], { fields: ['height', 'hash'] });
            expect(result.success).to.be.true;
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
            // statuses is not surfaced in the subscription list at all (see above).
            expect(subs[0].filters.statuses).to.be.undefined;
        });
    });

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

        // Regression: subscribe() and listSubscriptions() must echo action_index in the
        // SAME representation, else a client reconciling the two frames with === or a Map
        // key silently reports the subscription as missing. Both are normalized to the
        // canonical decimal STRING (v2 BIGINT-as-string), including for a numeric-input
        // client, so the value also survives above 2^53 without precision loss.
        it('returns action_index as a string for dispenser subscriptions, matching subscribe()', function () {
            const client = createClient(1);
            const subscribeResult = cm.subscribe(client, ['dispenser'], { action_index: 45678 });
            expect(subscribeResult.subscribed[0].action_index).to.equal('45678');
            expect(subscribeResult.subscribed[0].action_index).to.be.a('string');

            const list = cm.listSubscriptions(client);
            const entry = list.find(s => s.channel === 'dispenser');
            expect(entry.action_index).to.equal('45678');
            expect(entry.action_index).to.be.a('string');
        });
    });

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

describe('ChannelManager VALID_TYPES lifecycle conformance (api-contracts)', function () {
    // Every lifecycle name the types filter accepts must be one the producer
    // actually emits. A phantom name is advertised in WELCOME and accepted by
    // subscribe() yet silently matches zero events.
    // Emitted names come from three places, not one: the action-keyed LIFECYCLE_MAP,
    // NON_ACTION_LIFECYCLE_TYPES for events produced by a cursor of their own
    // (BET_CLOSED, whose latch has no action row), and INLINE_LIFECYCLE_TYPES for
    // the enrichment paths. All three are read from the producer rather than
    // restated here: a local copy of the inline names is what previously let the
    // two ATTESTATION types ship emitted-but-unfilterable.
    function emittedNames() {
        const ChangeDetector = require('../../../src/ws/ChangeDetector.js');
        return new Set(
            Object.values(ChangeDetector.LIFECYCLE_MAP).flat()
                .concat(ChangeDetector.NON_ACTION_LIFECYCLE_TYPES || [])
                .concat(ChangeDetector.INLINE_LIFECYCLE_TYPES || [])
        );
    }

    it('every lifecycle entry in VALID_TYPES is actually emitted by ChangeDetector', function () {
        const emitted = emittedNames();
        // Lifecycle names = VALID_TYPES entries that are not plain indexed
        // action types; identified as names ending in a lifecycle suffix.
        const lifecycle = [...ChannelManager.VALID_TYPES].filter((t) =>
            /(_COMPLETED|_EXPIRED|_CLOSED|_CANCELLED|_FULFILLED|_REQUIRED|_REQUEST|_RESPONSE)$/.test(t));
        const phantoms = lifecycle.filter((t) => !emitted.has(t));
        expect(phantoms, `VALID_TYPES advertises unemitted lifecycle types: ${phantoms.join(', ')}`).to.deep.equal([]);
    });

    // The OTHER direction, and the one that was missing. The check above only stops
    // VALID_TYPES advertising names nothing emits; it says nothing about a name the
    // producer emits that the filter refuses. That failure is worse than a phantom:
    // types is validated per entry and one unknown name fails the ENTIRE subscribe
    // with INVALID_TYPE, so a client narrowing to a real event type gets no channel
    // at all. Every BET name was in exactly that state (emitted, never accepted)
    // until the filter was fixed to admit them.
    it('every type ChangeDetector emits is accepted by the types filter', function () {
        const ChangeDetector = require('../../../src/ws/ChangeDetector.js');
        // Both halves matter: the filter matches on the event type OR the causing
        // action name (Broadcaster._passesFilter), so the map's keys are filterable
        // names too.
        const produced = [...emittedNames(), ...Object.keys(ChangeDetector.LIFECYCLE_MAP)];
        const rejected = [...new Set(produced)].filter((t) => !ChannelManager.VALID_TYPES.has(t));
        expect(rejected,
            `ChangeDetector emits types the subscribe filter rejects: ${rejected.join(', ')}`)
            .to.deep.equal([]);
    });
});
