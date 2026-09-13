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
 * A `types` filter and the mempool pair (spec wallet-unconfirmed-and-sounds).
 *
 * _passesFilter resolves an action name and falls back to the literal event
 * type. MEMPOOL_ACTION carries the name, so types:['MINT'] admits it; a
 * removal frame with no name is matched only by the literal MEMPOOL_REMOVED,
 * which is not even a subscribable type name (ChannelManager's VALID_TYPES
 * holds action names only). A filtering subscriber therefore had one frame of
 * the pair and no way to ask for the other, leaving a pending entry on screen
 * that nothing reconciles away. The removal names its action family so the two
 * frames of a pair pass or fail the same filter.
 *
 * The pair is produced by the REAL ChangeDetector over scripted mempool
 * windows, not hand-built and emitted, so the name has to survive the seen-map
 * that outlives the row (the detector is where a removal's only evidence of
 * what the transaction was lives).
 */

'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const ChannelManager = require('../../../src/ws/ChannelManager.js');
const ChangeDetector = require('../../../src/ws/ChangeDetector.js');
const Broadcaster    = require('../../../src/ws/Broadcaster.js');
const Database       = require('../../../src/db.js');
const Utility        = require('../../../src/utility.js');

const SOURCE = 'srcAddr';

// Rows in the shape the decoder DB stores them; the detector decodes them.
const MINT_ROW  = { tx_hash: 'aa11', source: SOURCE, data: 'MINT|0|TOK|9', first_seen: 1756200000 };
const TRASH_ROW = { tx_hash: 'bb22', source: SOURCE, data: 'zz-not-an-action-!!' };

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

// A venue whose detector reads the scripted windows, one per poll.
function mkVenue(windows) {
    const db = Object.create(Database.prototype);
    db.util  = new Utility();
    db.getExactAddressId     = sinon.stub().resolves(null);
    db.getDecoderMempoolRows = sinon.stub();
    windows.forEach((rows, i) => db.getDecoderMempoolRows.onCall(i).resolves(rows));
    db.getDecoderMempoolRows.resolves([]);

    const channelManager = new ChannelManager({ maxSubscriptions: 25 });
    const clients        = new Map();
    const wsServer       = {
        channelManager: channelManager,
        explorer:       { db: db },
        getClients:     () => clients,
        addClient:      (client) => clients.set(client.id, client)
    };
    const changeDetector = new ChangeDetector({ db, pollInterval: 999999 });
    changeDetector.mempoolState.RBTC = { seenHashes: new Map(), initialized: false };
    const broadcaster = new Broadcaster({ wsServer, changeDetector, maxBackpressure: 65536 });
    return { wsServer, changeDetector, broadcaster, clients };
}

// Subscribe one client to the source's address channel under `types`.
function subscribe(venue, id, types) {
    const client = createClient(id);
    venue.wsServer.addClient(client);
    const params = { address: SOURCE };
    if (types) params.types = types;
    const res = venue.wsServer.channelManager.subscribe(client, ['address'], params);
    expect(res.success).to.equal(true);
    return client;
}

// Run the scripted windows through the detector, then let the Broadcaster's
// per-coin frame tail settle.
async function run(venue, polls) {
    for (let i = 0; i < polls; i++)
        await venue.changeDetector._checkMempoolForCoin('RBTC');
    for (let i = 0; i < 5; i++)
        await (venue.broadcaster._mempoolTails.get('RBTC') || Promise.resolve());
}

const types  = (client) => client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]).type);
const frames = (client) => client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]));

// Seed empty, admit the MINT, then let it leave the mempool.
const MINT_PAIR = [[], [MINT_ROW], []];

describe('Broadcaster mempool frames under a types filter', () => {

    it('gives a types:[MINT] subscriber BOTH frames of a MINT', async () => {
        const venue = mkVenue(MINT_PAIR);
        const mint  = subscribe(venue, 1, ['MINT']);

        await run(venue, 3);

        expect(types(mint)).to.deep.equal(['MEMPOOL_ACTION', 'MEMPOOL_REMOVED']);
        // The delivered removal says which family it belongs to, so a subscriber
        // that asked for one family can read the frame it was admitted on.
        expect(frames(mint).map((f) => f.data.action)).to.deep.equal(['MINT', 'MINT']);
    });

    it('gives a types:[SEND] subscriber NEITHER frame of that MINT', async () => {
        const venue = mkVenue(MINT_PAIR);
        const send  = subscribe(venue, 1, ['SEND']);

        await run(venue, 3);

        expect(send.ws.send.called).to.equal(false);
    });

    it('still gives an unfiltered subscriber both frames', async () => {
        const venue = mkVenue(MINT_PAIR);
        const all   = subscribe(venue, 1, null);

        await run(venue, 3);

        expect(types(all)).to.deep.equal(['MEMPOOL_ACTION', 'MEMPOOL_REMOVED']);
    });

    it('names the removed action family on the frame itself', async () => {
        const venue = mkVenue(MINT_PAIR);
        const all   = subscribe(venue, 1, null);

        await run(venue, 3);

        const removal = frames(all)[1];
        expect(removal.type).to.equal('MEMPOOL_REMOVED');
        expect(removal.data.action).to.equal('MINT');
        expect(removal.data.tx_hash).to.equal('aa11');
        expect(removal.data.source).to.equal(SOURCE);
    });

    // The global mempool channel filters the same way, so a client watching all
    // unconfirmed MINTs is not told about half of them.
    it('filters the global mempool channel the same way', async () => {
        const venue  = mkVenue(MINT_PAIR);
        const client = createClient(9);
        venue.wsServer.addClient(client);
        venue.wsServer.channelManager.subscribe(client, ['mempool'], { types: ['MINT'] });

        await run(venue, 3);

        expect(types(client)).to.deep.equal(['MEMPOOL_ACTION', 'MEMPOOL_REMOVED']);
    });

    // An undecodable row announced no action and claims no family, so its
    // removal reaches whoever filtered on nothing and nobody who named a family.
    it('withholds a nameless removal from a types-filtered subscriber, not from an unfiltered one', async () => {
        const venue = mkVenue([[], [TRASH_ROW], []]);
        const mint  = subscribe(venue, 1, ['MINT']);
        const all   = subscribe(venue, 2, null);

        await run(venue, 3);

        expect(mint.ws.send.called).to.equal(false);
        expect(types(all)).to.deep.equal(['MEMPOOL_REMOVED']);
        expect(frames(all)[0].data.action).to.equal(null);
    });
});
