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
 * Unit tests for the confirmed-side NEW_ACTION destination fan-out
 * (spec wallet-unconfirmed-and-sounds M1.4, ruling I-15b).
 *
 * Twin of test/unit/ws/broadcaster-mempool-fanout.test.js on the confirmed
 * side. Until this landed, getActionsSince selected no destination column, so
 * NEW_ACTION never carried one and the routing branch in _onAction was
 * permanently inert: the wallet's incoming-receipt notification had never
 * fired for anyone.
 *
 * The one deliberate DIFFERENCE from the mempool frames: `destinations` here
 * comes from the indexer DB, not from this server's subscriber list, so I-43
 * does not apply and the field belongs on EVERY channel the frame reaches,
 * including the global `actions` channel.
 */

'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const EventEmitter   = require('events');
const ChannelManager = require('../../../src/ws/ChannelManager.js');
const Broadcaster    = require('../../../src/ws/Broadcaster.js');

function createClient(id) {
    return {
        id:            id,
        coin:          'BTC',
        chain:         'BTC',
        network:       'mainnet',
        subscriptions: new Set(),
        ws:            { readyState: 1, bufferedAmount: 0, send: sinon.stub() }
    };
}

function mkVenue() {
    const channelManager = new ChannelManager({ maxSubscriptions: 25 });
    const clients        = new Map();
    const wsServer       = {
        channelManager: channelManager,
        getClients:     () => clients,
        addClient:      (client) => clients.set(client.id, client)
    };
    const changeDetector = new EventEmitter();
    const broadcaster    = new Broadcaster({ wsServer, changeDetector, maxBackpressure: 65536 });
    return { wsServer, changeDetector, broadcaster, clients };
}

function subscribeAddress(venue, id, address) {
    const client = createClient(id);
    venue.wsServer.addClient(client);
    venue.wsServer.channelManager.subscribe(client, ['address'], { address });
    return client;
}

function subscribeActions(venue, id) {
    const client = createClient(id);
    venue.wsServer.addClient(client);
    venue.wsServer.channelManager.subscribe(client, ['actions']);
    return client;
}

const frames = (client) => client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]));

// A row shaped as db.getActionsSince now returns it.
const action = (over) => Object.assign({
    action_index: '501',
    action:       'SEND',
    tx_hash:      'aa11',
    block_index:  100,
    source:       'srcAddr',
    status:       null,
    destinations: []
}, over);

describe('Broadcaster NEW_ACTION destination fan-out (M1.4)', () => {

    it('routes a single-destination SEND to the DESTINATION address channel', () => {
        const venue = mkVenue();
        const dest  = subscribeAddress(venue, 2, 'destAddr');

        venue.changeDetector.emit('action', 'BTC', action({ destinations: ['destAddr'] }));

        const got = frames(dest);
        expect(got).to.have.lengthOf(1);
        expect(got[0].type).to.equal('NEW_ACTION');
        expect(got[0].data.tx_hash).to.equal('aa11');
        expect(got[0].data.destinations).to.deep.equal(['destAddr']);
    });

    it('still routes to the SOURCE address channel, with destinations attached', () => {
        const venue = mkVenue();
        const src   = subscribeAddress(venue, 1, 'srcAddr');

        venue.changeDetector.emit('action', 'BTC', action({ destinations: ['destAddr'] }));

        const got = frames(src);
        expect(got).to.have.lengthOf(1);
        expect(got[0].data.source).to.equal('srcAddr');
        expect(got[0].data.destinations).to.deep.equal(['destAddr']);
    });

    it('carries destinations on the GLOBAL actions channel too (I-43 does not apply here)', () => {
        // Unlike the mempool frames, this set is public chain data read from the
        // indexer DB, not a projection of who is subscribed to this server.
        const venue  = mkVenue();
        const global = subscribeActions(venue, 3);

        venue.changeDetector.emit('action', 'BTC', action({ destinations: ['destA', 'destB'] }));

        const got = frames(global);
        expect(got).to.have.lengthOf(1);
        expect(got[0].data.destinations).to.deep.equal(['destA', 'destB']);
    });

    it('delivers a MULTI-OUTPUT send to EVERY destination channel', () => {
        const venue = mkVenue();
        const a     = subscribeAddress(venue, 2, 'destA');
        const b     = subscribeAddress(venue, 3, 'destB');
        const c     = subscribeAddress(venue, 4, 'destC');

        venue.changeDetector.emit('action', 'BTC', action({ destinations: ['destA', 'destB', 'destC'] }));

        for (const client of [a, b, c]) {
            const got = frames(client);
            expect(got).to.have.lengthOf(1);
            expect(got[0].data.destinations).to.deep.equal(['destA', 'destB', 'destC']);
        }
    });

    it('sends an action with NO destination only to its source, with destinations []', () => {
        const venue = mkVenue();
        const src   = subscribeAddress(venue, 1, 'srcAddr');
        const other = subscribeAddress(venue, 2, 'destAddr');

        venue.changeDetector.emit('action', 'BTC', action({ action: 'BURN', destinations: [] }));

        expect(frames(src)).to.have.lengthOf(1);
        expect(frames(src)[0].data.destinations).to.deep.equal([]);
        expect(other.ws.send.callCount).to.equal(0);
    });

    it('does NOT double-broadcast when a destination equals the source', () => {
        const venue = mkVenue();
        const src   = subscribeAddress(venue, 1, 'srcAddr');

        // A sweep back to yourself, or a SEND whose change output is your own address.
        venue.changeDetector.emit('action', 'BTC', action({ destinations: ['srcAddr', 'destAddr'] }));

        expect(src.ws.send.callCount).to.equal(1);
    });

    it('does NOT double-broadcast when the same destination repeats', () => {
        const venue = mkVenue();
        const dest  = subscribeAddress(venue, 2, 'destAddr');

        venue.changeDetector.emit('action', 'BTC', action({ destinations: ['destAddr', 'destAddr'] }));

        expect(dest.ws.send.callCount).to.equal(1);
    });

    it('leaves the retired SINGULAR `destination` field absent from the frame', () => {
        const venue = mkVenue();
        const dest  = subscribeAddress(venue, 2, 'destAddr');

        venue.changeDetector.emit('action', 'BTC',
            action({ destination: 'destAddr', destinations: ['destAddr'] }));

        const got = frames(dest);
        expect(got).to.have.lengthOf(1);
        expect(got[0].data).to.not.have.property('destination');
        expect(got[0].data).to.have.property('destinations');
    });

    it('emits destinations [] for a raw action that carries no destinations key at all', () => {
        // Defensive: db.getActionsSince always sets the key, but a frame must never
        // reach a subscriber with a null or missing `destinations`.
        const venue  = mkVenue();
        const global = subscribeActions(venue, 3);
        const raw    = action();
        delete raw.destinations;

        venue.changeDetector.emit('action', 'BTC', raw);

        expect(frames(global)[0].data.destinations).to.deep.equal([]);
    });

    it('keeps every pre-existing NEW_ACTION field (additive only, spec §7)', () => {
        const venue  = mkVenue();
        const global = subscribeActions(venue, 3);

        venue.changeDetector.emit('action', 'BTC', action({ destinations: ['destAddr'] }));

        const data = frames(global)[0].data;
        expect(Object.keys(data).sort()).to.deep.equal(
            ['action', 'action_index', 'block_index', 'destinations', 'source', 'status', 'tx_hash']);
    });
});
