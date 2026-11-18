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
 *
 * A `types` filter narrows action and lifecycle frames. State frames (blocks,
 * network stats and the four entity updates) carry no action name and are not
 * subscribable type names, so they pass it; a narrowed subscription on a
 * channel that carries only state frames must still be served.
 *
 ********************************************************************/

'use strict';

const sinon          = require('sinon');
const { expect }     = require('chai');
const EventEmitter   = require('events');
const ChannelManager = require('../../../../src/ws/channel_manager.js');
const Broadcaster    = require('../../../../src/ws/broadcaster.js');

function createClient(id) {
    const ws = { readyState: 1, bufferedAmount: 0, send: sinon.stub() };
    ws.close = sinon.spy(() => { ws.readyState = 2; });
    return { id, coin: 'BTC', chain: 'BTC', network: 'mainnet', subscriptions: new Set(), ws };
}

function harness() {
    const clients = new Map();
    const wsServer = {
        channelManager: new ChannelManager({ maxSubscriptions: 25 }),
        explorer:       { db: { getMaxActionIndex: async () => 42 } },
        getClients:     () => clients
    };
    const changeDetector = new EventEmitter();
    const broadcaster = new Broadcaster({ wsServer, changeDetector, maxBackpressure: 65536 });
    return { wsServer, changeDetector, broadcaster, clients };
}

function subscribed(h, channels, params, id = 1) {
    const client = createClient(id);
    h.clients.set(client.id, client);
    const res = h.wsServer.channelManager.subscribe(client, channels, params);
    expect(res.success, JSON.stringify(res)).to.equal(true);
    return client;
}

function framesOf(client) {
    return client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]).type);
}

const NARROW = ['SEND', 'ORDER_MATCH'];

// Emit one block, one entity update or one action from 1abc through the detector.
function emitBlock(h) {
    h.changeDetector.emit('block', 'BTC', { block_index: 5, tx_count: 1, action_count: 1 });
}

function emitEntity(h, type, channel, data) {
    h.changeDetector.emit('entity_update', 'BTC', { type, channel, data });
}

function emitAction(h, index, action) {
    h.changeDetector.emit('action', 'BTC', { action_index: index, action, source: '1abc', destinations: [] });
}

describe('types filter and state frames', function () {
    it('a blocks subscription narrowed by types still gets NEW_BLOCK', function () {
        const h = harness();
        const client = subscribed(h, ['blocks', 'actions'], { types: NARROW });
        emitBlock(h);
        expect(framesOf(client)).to.deep.equal(['NEW_BLOCK']);
    });

    it('a network subscription narrowed by types still gets NETWORK_STATS', async function () {
        const h = harness();
        const client = subscribed(h, ['network'], { types: NARROW });
        emitBlock(h);
        await new Promise((resolve) => setImmediate(resolve));
        expect(framesOf(client)).to.deep.equal(['NETWORK_STATS']);
    });

    it('token and market subscriptions narrowed by types get their update frames', function () {
        const h = harness();
        const token  = subscribed(h, ['token'], { tick: 'PEPE', types: NARROW });
        const market = subscribed(h, ['market'], { tick1: 'PEPE', tick2: 'BTC', types: NARROW }, 2);
        emitEntity(h, 'TOKEN_UPDATE', 'token', { tick: 'PEPE' });
        emitEntity(h, 'MARKET_UPDATE', 'market', { tick1: 'PEPE', tick2: 'BTC' });
        expect(framesOf(token)).to.deep.equal(['TOKEN_UPDATE']);
        expect(framesOf(market)).to.deep.equal(['MARKET_UPDATE']);
    });

    it('a narrowed address subscription gets ADDRESS_UPDATE and still drops other action families', function () {
        const h = harness();
        const client = subscribed(h, ['address'], { address: '1abc', types: ['SEND'] });
        emitEntity(h, 'ADDRESS_UPDATE', 'address', { address: '1abc' });
        emitAction(h, 9, 'ORDER');
        emitAction(h, 10, 'SEND');
        expect(framesOf(client)).to.deep.equal(['ADDRESS_UPDATE', 'NEW_ACTION']);
    });

    it('a narrowed dispenser subscription gets DISPENSER_UPDATE', function () {
        const h = harness();
        const client = subscribed(h, ['dispenser'], { action_index: '7', types: ['DISPENSE'] });
        emitEntity(h, 'DISPENSER_UPDATE', 'dispenser', { action_index: '7' });
        expect(framesOf(client)).to.deep.equal(['DISPENSER_UPDATE']);
    });

    it('a once subscription narrowed by types is not spent by a state frame that only passed the filter', function () {
        const h = harness();
        const client = subscribed(h, ['address'], { address: '1abc', types: ['SEND'], once: true });
        emitEntity(h, 'ADDRESS_UPDATE', 'address', { address: '1abc' });
        expect(client.subscriptions.size).to.equal(1);
        emitAction(h, 10, 'SEND');
        expect(framesOf(client)).to.deep.equal(['ADDRESS_UPDATE', 'NEW_ACTION', 'UNSUBSCRIBED']);
        expect(client.subscriptions.size).to.equal(0);
    });

    it('a once subscription on a state-only channel is spent by its first frame', function () {
        const h = harness();
        const client = subscribed(h, ['blocks'], { types: NARROW, once: true });
        emitBlock(h);
        expect(framesOf(client)).to.deep.equal(['NEW_BLOCK', 'UNSUBSCRIBED']);
    });
});
