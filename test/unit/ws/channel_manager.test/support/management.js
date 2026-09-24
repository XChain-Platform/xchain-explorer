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
 * Unit tests for ChannelManager (src/ws/channel_manager.js)
 */

'use strict';

const { expect, ChannelManager, createClient } = require('./helpers.js');

let cm;

function resetChannelManager() {
    cm = new ChannelManager({ maxSubscriptions: 25 });
}
describe('ChannelManager', function () {
    beforeEach(resetChannelManager);
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
});

describe('ChannelManager', function () {
    beforeEach(resetChannelManager);
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
});

describe('ChannelManager', function () {
    beforeEach(resetChannelManager);
    describe('unsubscribe', function () {
        // the caller (WebSocketServer) needs to know what was targeted
        // so it can send back a frame naming it -- unsubscribe must not be a
        // silent void call.
        it('returns the unsubscribed global channel, naming it and honoured=true', function () {
            const client = createClient(1);
            cm.subscribe(client, ['blocks']);
            const result = cm.unsubscribe(client, ['blocks']);
            expect(result.unsubscribed).to.have.lengthOf(1);
            expect(result.unsubscribed[0]).to.deep.equal({ channel: 'blocks', was_subscribed: true });
        });

        it('returns the unsubscribed entity channel with its entity identifier', function () {
            const client = createClient(1);
            cm.subscribe(client, ['address'], { address: '1abc' });
            const result = cm.unsubscribe(client, ['address'], { address: '1abc' });
            expect(result.unsubscribed).to.have.lengthOf(1);
            expect(result.unsubscribed[0]).to.deep.equal({
                channel: 'address', address: '1abc', was_subscribed: true
            });
        });

        it('returns was_subscribed:false for a channel the client never held, still naming it', function () {
            const client = createClient(1);
            const result = cm.unsubscribe(client, ['blocks']);
            expect(result.unsubscribed).to.have.lengthOf(1);
            expect(result.unsubscribed[0]).to.deep.equal({ channel: 'blocks', was_subscribed: false });
        });

        it('reports each requested channel independently across a mixed batch', function () {
            const client = createClient(1);
            cm.subscribe(client, ['blocks']);
            const result = cm.unsubscribe(client, ['blocks', 'actions']);
            expect(result.unsubscribed).to.have.lengthOf(2);
            const byChannel = Object.fromEntries(result.unsubscribed.map((u) => [u.channel, u.was_subscribed]));
            expect(byChannel.blocks).to.equal(true);
            expect(byChannel.actions).to.equal(false);
        });
    });
});

describe('ChannelManager', function () {
    beforeEach(resetChannelManager);
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
});

describe('ChannelManager', function () {
    beforeEach(resetChannelManager);
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
});

describe('ChannelManager', function () {
    beforeEach(resetChannelManager);
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
    // restated here: a local copy of the inline names drifts from the producer and
    // leaves types such as the two ATTESTATION types emitted-but-unfilterable.
    function emittedNames() {
        const ChangeDetector = require('../../../../../src/ws/change_detector.js');
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
        const ChangeDetector = require('../../../../../src/ws/change_detector.js');
        // Both halves matter: the filter matches on the event type OR the causing
        // action name (Broadcaster.passesFilter), so the map's keys are filterable
        // names too.
        const produced = [...emittedNames(), ...Object.keys(ChangeDetector.LIFECYCLE_MAP)];
        const rejected = [...new Set(produced)].filter((t) => !ChannelManager.VALID_TYPES.has(t));
        expect(rejected,
            `ChangeDetector emits types the subscribe filter rejects: ${rejected.join(', ')}`)
            .to.deep.equal([]);
    });

    // Raw indexed actions reach the feed as NEW_ACTION under their own name, so every
    // action the indexer dispatches must be filterable too. The vendored manifest's
    // indexerHandled set is held equal to the dispatch switch by the indexer's guard.
    it('every action the indexer dispatches is accepted by the types filter', function () {
        const manifest = require('../../../../fixtures/action-manifest.json');
        const dispatched = Object.keys(manifest.actions)
            .filter((name) => manifest.actions[name].indexerHandled === true);
        expect(dispatched.length, 'read no indexerHandled actions from action-manifest.json')
            .to.be.greaterThan(0);
        const rejected = dispatched.filter((t) => !ChannelManager.VALID_TYPES.has(t));
        expect(rejected,
            `indexer-dispatched actions the subscribe filter rejects: ${rejected.join(', ')}; ` +
            'add them to VALID_TYPES in src/ws/channel_manager/channels.js')
            .to.deep.equal([]);
    });
});
