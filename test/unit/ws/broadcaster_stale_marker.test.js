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
 * Live frames for a coin whose indexed tip is stale are SENT, not
 * suppressed (a wallet watching an address during an indexer stall must
 * still see the rows land), and every one carries the same additive
 * `stale: true` marker WELCOME, CATCH_UP and SNAPSHOT do, so a subscriber
 * never mistakes a lagging or replayed row for the chain tip. ChangeDetector
 * owns the per-coin set; Broadcaster stamps at its single send sink.
 ********************************************************************/

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
    changeDetector.staleCoins = new Set();
    const broadcaster    = new Broadcaster({ wsServer, changeDetector, maxBackpressure: 65536 });
    const client         = createClient(1);
    wsServer.addClient(client);
    channelManager.subscribe(client, ['blocks']);
    return { changeDetector, broadcaster, client };
}

const frames = (client) => client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]));

describe('Broadcaster stale marker on live frames', function () {

    it('stamps stale: true on every frame for a coin ChangeDetector recorded as stale', function () {
        const v = mkVenue();
        v.changeDetector.staleCoins.add('BTC');
        v.changeDetector.emit('block', 'BTC', { block_index: 500, block_hash: 'h', block_time: 1 });
        const sent = frames(v.client);
        expect(sent).to.have.lengthOf(1);
        expect(sent[0].type).to.equal('NEW_BLOCK');
        expect(sent[0].stale).to.equal(true);
    });

    it('leaves the marker off entirely (not false) while the coin is fresh', function () {
        const v = mkVenue();
        v.changeDetector.emit('block', 'BTC', { block_index: 500, block_hash: 'h', block_time: 1 });
        const sent = frames(v.client);
        expect(sent).to.have.lengthOf(1);
        expect(sent[0]).to.not.have.property('stale');
    });

    it('stops marking as soon as the coin leaves the set', function () {
        const v = mkVenue();
        v.changeDetector.staleCoins.add('BTC');
        v.changeDetector.emit('block', 'BTC', { block_index: 500, block_hash: 'h', block_time: 1 });
        v.changeDetector.staleCoins.delete('BTC');
        v.changeDetector.emit('block', 'BTC', { block_index: 501, block_hash: 'i', block_time: 2 });
        const sent = frames(v.client);
        expect(sent).to.have.lengthOf(2);
        expect(sent[0].stale).to.equal(true);
        expect(sent[1]).to.not.have.property('stale');
    });

    it('tolerates a ChangeDetector without the set (older doubles), sending unmarked', function () {
        const v = mkVenue();
        delete v.changeDetector.staleCoins;
        v.changeDetector.emit('block', 'BTC', { block_index: 500, block_hash: 'h', block_time: 1 });
        expect(frames(v.client)[0]).to.not.have.property('stale');
    });
});
