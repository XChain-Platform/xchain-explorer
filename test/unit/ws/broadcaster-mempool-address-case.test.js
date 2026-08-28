/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Case-exactness of the mempool address matcher's id resolution, WS side
 * (spec wallet-unconfirmed-and-sounds). The REST half lives in
 * test/unit/db.mempool-address-case.test.js.
 *
 * index_addresses is a case-INSENSITIVE table, so the ci resolver behind
 * explorer search hands a wrong-case address the id of the address it
 * resembles. On this fan-out that id then matches a `^<id>` destination and
 * delivers a stranger's pending payment to whoever subscribed with the wrong
 * case. The db double below exposes BOTH resolvers with their real-world
 * semantics (ci one case-folds, exact one does not), so a fan-out that reaches
 * for the ci resolver fails these tests rather than passing them quietly.
 */

'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const EventEmitter   = require('events');
const ChannelManager = require('../../../src/ws/ChannelManager.js');
const Broadcaster    = require('../../../src/ws/Broadcaster.js');
const Database       = require('../../../src/db.js');
const Utility        = require('../../../src/utility.js');

// The regtest address the defect was measured against, plus the two spellings
// that must resolve to nothing.
const ADDRESS    = 'moV6MFmHTNQF1cwoXiPjeEMbkSAKwBz9Li';
const ADDRESS_ID = 397;
const FLIPPED    = 'MoV6MFmHTNQF1cwoXiPjeEMbkSAKwBz9Li';
const LOWERED    = ADDRESS.toLowerCase();

const ACTION_ROW = {
    tx_hash:    'aa11',
    source:     'srcAddr',
    action:     'SEND',
    data:       'SEND|0|TOK|5|^' + ADDRESS_ID + '|memo',
    first_seen: 1756200000
};
const REMOVED_ROW = { tx_hash: 'aa11', source: 'srcAddr', action: 'SEND', data: ACTION_ROW.data };

// A db exposing the REAL shared matcher over two id resolvers that behave the
// way the ci table makes them behave.
function mkDb() {
    const db = Object.create(Database.prototype);
    db.util  = new Utility();
    db.getAddressId = sinon.stub().callsFake(async (config, address) =>
        (String(address).toLowerCase() === LOWERED) ? ADDRESS_ID : null);
    db.getExactAddressId = sinon.stub().callsFake(async (config, address) =>
        (address === ADDRESS) ? ADDRESS_ID : null);
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

function mkVenue() {
    const channelManager = new ChannelManager({ maxSubscriptions: 25 });
    const clients        = new Map();
    const db             = mkDb();
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

function subscribeAddress(venue, id, address) {
    const client = createClient(id);
    venue.wsServer.addClient(client);
    venue.wsServer.channelManager.subscribe(client, ['address'], { address });
    return client;
}

// Mempool frames are queued on the per-coin promise tail (_mempoolTails).
async function settle(venue) {
    for (let i = 0; i < 5; i++)
        await (venue.broadcaster._mempoolTails.get('RBTC') || Promise.resolve());
}

const frames = (client) => client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]));

describe('Broadcaster mempool fan-out resolves addresses byte-exactly', () => {

    it('delivers a compacted ^<id> destination to the address itself', async () => {
        const venue = mkVenue();
        const exact = subscribeAddress(venue, 1, ADDRESS);

        venue.changeDetector.emit('mempool_action', 'RBTC', ACTION_ROW);
        await settle(venue);

        const got = frames(exact);
        expect(got).to.have.lengthOf(1);
        expect(got[0].type).to.equal('MEMPOOL_ACTION');
        expect(got[0].data.destinations).to.deep.equal([ADDRESS]);
    });

    it('delivers NOTHING to a case-flipped or all-lowercase spelling', async () => {
        const venue   = mkVenue();
        const flipped = subscribeAddress(venue, 1, FLIPPED);
        const lowered = subscribeAddress(venue, 2, LOWERED);

        venue.changeDetector.emit('mempool_action', 'RBTC', ACTION_ROW);
        await settle(venue);

        expect(flipped.ws.send.called).to.equal(false);
        expect(lowered.ws.send.called).to.equal(false);
    });

    it('applies the same exactness to the removal frame', async () => {
        const venue   = mkVenue();
        const exact   = subscribeAddress(venue, 1, ADDRESS);
        const flipped = subscribeAddress(venue, 2, FLIPPED);

        venue.changeDetector.emit('mempool_removed', 'RBTC', REMOVED_ROW);
        await settle(venue);

        expect(frames(exact).map((f) => f.type)).to.deep.equal(['MEMPOOL_REMOVED']);
        expect(flipped.ws.send.called).to.equal(false);
    });

    it('never reaches for the case-insensitive resolver', async () => {
        const venue = mkVenue();
        subscribeAddress(venue, 1, FLIPPED);

        venue.changeDetector.emit('mempool_action', 'RBTC', ACTION_ROW);
        await settle(venue);

        expect(venue.db.getExactAddressId.callCount).to.equal(1);
        expect(venue.db.getAddressId.called).to.equal(false);
    });

    // The memo has to cover the exact resolver's nulls too: a wrong-case (so
    // never-indexed) subscription resolves null on every call, and without the
    // memo that is one DB read per mempool row per subscriber.
    it('costs one id read per subscribed spelling, not one per mempool row', async () => {
        const venue = mkVenue();
        subscribeAddress(venue, 1, FLIPPED);
        subscribeAddress(venue, 2, LOWERED);

        for (let i = 0; i < 500; i++) {
            venue.changeDetector.emit('mempool_action', 'RBTC', {
                tx_hash: 'h' + i, source: 'srcAddr', action: 'MINT', data: 'MINT|0|TOK|1'
            });
        }
        await settle(venue);

        expect(venue.db.getExactAddressId.callCount).to.equal(2);
    });
});
