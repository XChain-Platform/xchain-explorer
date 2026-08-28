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
 * Unit tests for the mempool destination fan-out on the Broadcaster
 * (spec wallet-unconfirmed-and-sounds, M1.1).
 *
 * The headline bug these pin: the SDK compacts destination addresses to
 * `^<id>` index references BY DEFAULT, so before this row a pending incoming
 * payment reached the SENDER's address channel and nobody else. The recipient
 * saw nothing until the tx confirmed.
 *
 * Everything here runs against a real ChannelManager and mock sockets; the
 * only stub is the db layer's address -> id lookup.
 */

'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const EventEmitter   = require('events');
const ChannelManager = require('../../../src/ws/ChannelManager.js');
const Broadcaster    = require('../../../src/ws/Broadcaster.js');
const Database       = require('../../../src/db.js');
const Utility        = require('../../../src/utility.js');

// A db exposing the REAL shared matcher (db.mempoolRowMatchesAddress) over a
// stubbed address -> id map, so these tests exercise the same predicate the
// REST prefilter uses rather than a re-implementation of it.
function mkDb(idMap) {
    const db = Object.create(Database.prototype);
    db.util  = new Utility();
    db.getAddressId = sinon.stub().callsFake(async (config, address) =>
        Object.prototype.hasOwnProperty.call(idMap || {}, address) ? idMap[address] : null);
    return db;
}

function createClient(id) {
    return {
        id:            id,
        coin:          'RBTC',
        chain:         'BTC',
        network:       'regtest',
        subscriptions: new Set(),
        ws:            { readyState: 1, bufferedAmount: 0, send: sinon.stub() }
    };
}

function mkVenue(idMap) {
    const channelManager = new ChannelManager({ maxSubscriptions: 25 });
    const clients        = new Map();
    const db             = mkDb(idMap);
    const wsServer       = {
        channelManager: channelManager,
        explorer:       { db: db },
        getClients:     () => clients,
        addClient:      (client) => clients.set(client.id, client)
    };
    const changeDetector = new EventEmitter();
    const broadcaster    = new Broadcaster({ wsServer, changeDetector, maxBackpressure: 65536 });
    return { wsServer, changeDetector, broadcaster, db, clients };
}

// Subscribe a fresh client to one address channel and hand back the client.
function subscribeAddress(venue, id, address) {
    const client = createClient(id);
    venue.wsServer.addClient(client);
    venue.wsServer.channelManager.subscribe(client, ['address'], { address });
    return client;
}

// Mempool frames are queued on the per-coin promise tail (_mempoolTails), so a
// test must let the tail settle before asserting on sends.
async function settle(venue, coin) {
    for (let i = 0; i < 5; i++)
        await (venue.broadcaster._mempoolTails.get(coin || 'RBTC') || Promise.resolve());
}

const frames = (client) => client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]));

const ACTION_ROW = {
    tx_hash:    'aa11',
    source:     'srcAddr',
    action:     'SEND',
    data:       'SEND|0|TOK|5|^42|memo',
    first_seen: 1756200000
};

describe('Broadcaster mempool destination fan-out (M1.1)', () => {

    it('delivers MEMPOOL_ACTION to a destination that arrived COMPACTED as ^<id>', async () => {
        const venue = mkVenue({ destAddr: 42 });
        const dest  = subscribeAddress(venue, 2, 'destAddr');

        venue.changeDetector.emit('mempool_action', 'RBTC', ACTION_ROW);
        await settle(venue);

        const got = frames(dest);
        expect(got).to.have.lengthOf(1);
        expect(got[0].type).to.equal('MEMPOOL_ACTION');
        expect(got[0].data.tx_hash).to.equal('aa11');
        expect(got[0].data.destinations).to.deep.equal(['destAddr']);
        expect(got[0].data.first_seen).to.equal(1756200000);
    });

    it('delivers MEMPOOL_ACTION to a LITERAL destination segment (never-indexed address)', async () => {
        const venue = mkVenue({});                                  // no id for anyone
        const dest  = subscribeAddress(venue, 2, 'literalDest');

        venue.changeDetector.emit('mempool_action', 'RBTC', {
            tx_hash: 'bb22', source: 'srcAddr', action: 'SEND',
            data: 'SEND|0|TOK|5|literalDest|memo', first_seen: 1756200001
        });
        await settle(venue);

        const got = frames(dest);
        expect(got).to.have.lengthOf(1);
        expect(got[0].data.destinations).to.deep.equal(['literalDest']);
    });

    it('still delivers to the SOURCE address channel, with the matched destinations attached', async () => {
        const venue = mkVenue({ destAddr: 42 });
        const src   = subscribeAddress(venue, 1, 'srcAddr');
        subscribeAddress(venue, 2, 'destAddr');

        venue.changeDetector.emit('mempool_action', 'RBTC', ACTION_ROW);
        await settle(venue);

        const got = frames(src);
        expect(got).to.have.lengthOf(1);
        expect(got[0].data.source).to.equal('srcAddr');
        expect(got[0].data.destinations).to.deep.equal(['destAddr']);
    });

    it('does not match an unrelated subscriber, and never lists the source as its own destination', async () => {
        const venue     = mkVenue({ destAddr: 42, otherAddr: 99, srcAddr: 7 });
        const src       = subscribeAddress(venue, 1, 'srcAddr');
        const unrelated = subscribeAddress(venue, 3, 'otherAddr');

        venue.changeDetector.emit('mempool_action', 'RBTC', ACTION_ROW);
        await settle(venue);

        expect(unrelated.ws.send.called).to.equal(false);
        expect(frames(src)[0].data.destinations).to.deep.equal([]);
    });

    it('the GLOBAL mempool frame carries first_seen and NOT destinations (I-43)', async () => {
        const venue  = mkVenue({ destAddr: 42 });
        subscribeAddress(venue, 2, 'destAddr');
        const global = createClient(9);
        venue.wsServer.addClient(global);
        venue.wsServer.channelManager.subscribe(global, ['mempool']);

        venue.changeDetector.emit('mempool_action', 'RBTC', ACTION_ROW);
        await settle(venue);

        const got = frames(global);
        expect(got).to.have.lengthOf(1);
        expect(got[0].data.first_seen).to.equal(1756200000);
        expect(got[0].data).to.not.have.property('destinations');
        expect(got[0].data.source).to.equal('srcAddr');
    });

    it('MEMPOOL_REMOVED reaches the same address channels, carrying source + destinations', async () => {
        const venue = mkVenue({ destAddr: 42 });
        const src   = subscribeAddress(venue, 1, 'srcAddr');
        const dest  = subscribeAddress(venue, 2, 'destAddr');

        // Shape the ChangeDetector's seenHashes Map hands back at removal time.
        venue.changeDetector.emit('mempool_removed', 'RBTC', {
            tx_hash: 'aa11', source: 'srcAddr', data: 'SEND|0|TOK|5|^42|memo'
        });
        await settle(venue);

        for (const client of [src, dest]) {
            const got = frames(client);
            expect(got).to.have.lengthOf(1);
            expect(got[0].type).to.equal('MEMPOOL_REMOVED');
            expect(got[0].data.tx_hash).to.equal('aa11');
            expect(got[0].data.source).to.equal('srcAddr');
            expect(got[0].data.destinations).to.deep.equal(['destAddr']);
        }
    });

    it('the global MEMPOOL_REMOVED frame carries source and NOT destinations', async () => {
        const venue  = mkVenue({ destAddr: 42 });
        subscribeAddress(venue, 2, 'destAddr');
        const global = createClient(9);
        venue.wsServer.addClient(global);
        venue.wsServer.channelManager.subscribe(global, ['mempool']);

        venue.changeDetector.emit('mempool_removed', 'RBTC', {
            tx_hash: 'aa11', source: 'srcAddr', data: 'SEND|0|TOK|5|^42|memo'
        });
        await settle(venue);

        const got = frames(global);
        expect(got).to.have.lengthOf(1);
        expect(got[0].data.source).to.equal('srcAddr');
        expect(got[0].data).to.not.have.property('destinations');
    });

    // The removal path re-runs the matcher against CURRENT subscribers rather
    // than a set remembered at action time (I-44), so a client that subscribed
    // between the two frames still gets the removal.
    it('fans a removal out to a client that subscribed AFTER the action', async () => {
        const venue = mkVenue({ destAddr: 42 });
        venue.changeDetector.emit('mempool_action', 'RBTC', ACTION_ROW);
        await settle(venue);

        const dest = subscribeAddress(venue, 2, 'destAddr');
        venue.changeDetector.emit('mempool_removed', 'RBTC', {
            tx_hash: 'aa11', source: 'srcAddr', data: 'SEND|0|TOK|5|^42|memo'
        });
        await settle(venue);

        expect(frames(dest).map((f) => f.type)).to.deep.equal(['MEMPOOL_REMOVED']);
    });

    // Both handlers are async now, and ChangeDetector's emit awaits nothing, so
    // without the per-coin tail a burst could deliver the removal first (I-45).
    //
    // The stub makes the FIRST id lookup slow and every later one instant, which
    // is the shape that separates a serialized chain from concurrent handlers:
    // serialized, the action's slow lookup finishes before the removal is even
    // started (and the removal then hits the memo); concurrent, both handlers
    // start together and the removal, whose lookup returns instantly, overtakes
    // the action it belongs to.
    it('keeps ACTION before REMOVED for a burst emitted synchronously', async () => {
        const venue = mkVenue({ destAddr: 42 });
        const dest  = subscribeAddress(venue, 2, 'destAddr');
        let calls = 0;
        venue.db.getAddressId = async () => {
            calls++;
            if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 20));
            return 42;
        };

        venue.changeDetector.emit('mempool_action', 'RBTC', ACTION_ROW);
        venue.changeDetector.emit('mempool_removed', 'RBTC', {
            tx_hash: 'aa11', source: 'srcAddr', data: 'SEND|0|TOK|5|^42|memo'
        });
        await settle(venue);
        await new Promise((resolve) => setTimeout(resolve, 60));    // let a stray concurrent frame land

        expect(frames(dest).map((f) => f.type)).to.deep.equal(['MEMPOOL_ACTION', 'MEMPOOL_REMOVED']);
    });

    describe('address-id memoization', () => {

        it('does NOT issue a DB read per row for a never-indexed subscribed address', async () => {
            const venue = mkVenue({});                              // every lookup resolves null
            subscribeAddress(venue, 1, 'watchedA');
            subscribeAddress(venue, 2, 'watchedB');

            for (let i = 0; i < 500; i++) {
                venue.changeDetector.emit('mempool_action', 'RBTC', {
                    tx_hash: 'h' + i, source: 'srcAddr', action: 'MINT', data: 'MINT|0|TOK|1'
                });
            }
            await settle(venue);

            // O(N subscribed addresses), not O(N * 500 rows). getAddressId caches
            // only non-null results, so the null memo is what makes this bounded.
            expect(venue.db.getAddressId.callCount).to.equal(2);
        });

        it('costs zero DB reads when the coin has no address subscribers', async () => {
            const venue  = mkVenue({ destAddr: 42 });
            const global = createClient(9);
            venue.wsServer.addClient(global);
            venue.wsServer.channelManager.subscribe(global, ['mempool']);

            venue.changeDetector.emit('mempool_action', 'RBTC', ACTION_ROW);
            await settle(venue);

            expect(venue.db.getAddressId.called).to.equal(false);
            expect(frames(global)).to.have.lengthOf(1);
        });

        it('drops the memo on a block, so a newly indexed address resolves again', async () => {
            const ids   = {};
            const venue = mkVenue(ids);
            const dest  = subscribeAddress(venue, 2, 'destAddr');

            venue.changeDetector.emit('mempool_action', 'RBTC', ACTION_ROW);
            await settle(venue);
            expect(dest.ws.send.called).to.equal(false);            // no id yet: ^42 cannot match
            expect(venue.db.getAddressId.callCount).to.equal(1);

            // The address gets indexed; the block that did it also clears the memo.
            ids.destAddr = 42;
            venue.changeDetector.emit('block', 'RBTC', { block_index: 101 });

            venue.changeDetector.emit('mempool_action', 'RBTC', ACTION_ROW);
            await settle(venue);
            expect(venue.db.getAddressId.callCount).to.equal(2);
            expect(frames(dest).map((f) => f.data.destinations)).to.deep.equal([['destAddr']]);
        });
    });

    it('survives a db-layer id lookup failure by falling back to literal matching', async () => {
        const venue = mkVenue({});
        venue.db.getAddressId = sinon.stub().rejects(new Error('db down'));
        const literal = subscribeAddress(venue, 1, 'literalDest');
        const compact = subscribeAddress(venue, 2, 'destAddr');

        venue.changeDetector.emit('mempool_action', 'RBTC', {
            tx_hash: 'cc33', source: 'srcAddr', action: 'SEND',
            data: 'SEND|0|TOK|5|literalDest|^42', first_seen: null
        });
        await settle(venue);

        expect(frames(literal)).to.have.lengthOf(1);
        expect(compact.ws.send.called).to.equal(false);
    });
});
