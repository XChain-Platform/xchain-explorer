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
 * Unit tests for Broadcaster (src/ws/Broadcaster.js)
 */

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const EventEmitter = require('events');
const ChannelManager = require('../../../src/ws/ChannelManager.js');
const Broadcaster    = require('../../../src/ws/Broadcaster.js');

// Helper: create a mock WebSocket
function createMockWs() {
    return {
        readyState:     1, // OPEN
        bufferedAmount: 0,
        send:           sinon.stub()
    };
}

// Helper: create a mock client
function createClient(id, coin, ws) {
    return {
        id:            id,
        coin:          coin || 'BTC',
        chain:         'BTC',
        network:       'mainnet',
        subscriptions: new Set(),
        ws:            ws || createMockWs()
    };
}

// Helper: create a mock change detector (EventEmitter)
function createMockChangeDetector() {
    return new EventEmitter();
}

// Helper: create a mock WS server with channel manager and clients
function createMockWsServer() {
    const cm = new ChannelManager({ maxSubscriptions: 25 });
    const clients = new Map();
    return {
        channelManager: cm,
        getClients:     () => clients,
        clients:        clients,
        addClient: function(client) {
            clients.set(client.id, client);
        }
    };
}

describe('Broadcaster', function () {

    let wsServer, changeDetector, broadcaster;

    beforeEach(function () {
        wsServer       = createMockWsServer();
        changeDetector = createMockChangeDetector();
        broadcaster    = new Broadcaster({
            wsServer:       wsServer,
            changeDetector: changeDetector,
            maxBackpressure: 65536
        });
    });

    // -----------------------------------------------------------------
    // Block broadcasting
    // -----------------------------------------------------------------

    describe('block events', function () {

        it('broadcasts NEW_BLOCK to blocks subscribers', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['blocks']);

            changeDetector.emit('block', 'BTC', {
                block_index: 100, block_hash: 'abc', block_time: 1234, tx_count: 5, action_count: 2
            });

            expect(client.ws.send.calledOnce).to.be.true;
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('NEW_BLOCK');
            expect(msg.data.block_index).to.equal(100);
        });

        it('stamps every outbound frame with the envelope schema_version', function () {
            const { WS_SCHEMA_VERSION } = require('../../../src/ws/schema-version.js');
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['blocks']);
            changeDetector.emit('block', 'BTC', { block_index: 100, block_hash: 'abc', block_time: 1, tx_count: 0, action_count: 0 });
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.schema_version).to.equal(WS_SCHEMA_VERSION);
        });

        it('the schema_version stamp survives a fields projection', function () {
            const { WS_SCHEMA_VERSION } = require('../../../src/ws/schema-version.js');
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['blocks'], { fields: ['block_index'] });
            changeDetector.emit('block', 'BTC', { block_index: 100, block_hash: 'abc', block_time: 1, tx_count: 0, action_count: 0 });
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.schema_version).to.equal(WS_SCHEMA_VERSION);
        });

        it('also broadcasts NETWORK_STATS to network subscribers', async function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['network']);

            changeDetector.emit('block', 'BTC', {
                block_index: 100, block_hash: 'abc', block_time: 1234, tx_count: 5, action_count: 2
            });
            await broadcaster._statsTails.get('BTC');

            expect(client.ws.send.calledOnce).to.be.true;
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('NETWORK_STATS');
        });

        it('NETWORK_STATS frames stay in block order when DB reads resolve out of order (catch-up burst)', async function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['network']);

            // First read is slow, second is fast: without per-coin serialization
            // the frame for block 101 would overtake the frame for block 100.
            let calls = 0;
            wsServer.explorer = { db: { getMaxActionIndex: () => {
                calls++;
                return calls === 1
                    ? new Promise(res => setTimeout(() => res(500), 20))
                    : Promise.resolve(510);
            } } };

            changeDetector.emit('block', 'BTC', { block_index: 100, action_count: 1 });
            changeDetector.emit('block', 'BTC', { block_index: 101, action_count: 1 });
            await broadcaster._statsTails.get('BTC');

            // Block 100 was superseded by 101 before its turn on the chain, so
            // exactly one stats frame goes out, for the newest height.
            const stats = client.ws.send.getCalls()
                .map(c => JSON.parse(c.args[0]))
                .filter(m => m.type === 'NETWORK_STATS');
            expect(stats).to.have.length(1);
            expect(stats[0].data.block_height).to.equal('101');
        });

        it('sequential blocks each emit a NETWORK_STATS frame in ascending height order', async function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['network']);
            wsServer.explorer = { db: { getMaxActionIndex: sinon.stub().resolves(7) } };

            changeDetector.emit('block', 'BTC', { block_index: 100, action_count: 1 });
            await broadcaster._statsTails.get('BTC');
            changeDetector.emit('block', 'BTC', { block_index: 101, action_count: 1 });
            await broadcaster._statsTails.get('BTC');

            const stats = client.ws.send.getCalls()
                .map(c => JSON.parse(c.args[0]))
                .filter(m => m.type === 'NETWORK_STATS');
            expect(stats.map(m => m.data.block_height)).to.deep.equal(['100', '101']);
        });

        it('a catch-up burst collapses to a single getMaxActionIndex read (newest height only)', async function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['network']);
            const getMax = sinon.stub().resolves(999);
            wsServer.explorer = { db: { getMaxActionIndex: getMax } };

            for (let i = 1; i <= 50; i++)
                changeDetector.emit('block', 'BTC', { block_index: 100 + i, action_count: 1 });
            await broadcaster._statsTails.get('BTC');

            expect(getMax.callCount).to.equal(1);
            const stats = client.ws.send.getCalls()
                .map(c => JSON.parse(c.args[0]))
                .filter(m => m.type === 'NETWORK_STATS');
            expect(stats).to.have.length(1);
            expect(stats[0].data.block_height).to.equal('150');
        });

        it('a rejected stats emission does not poison the chain for later blocks', async function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['network']);
            wsServer.explorer = { db: { getMaxActionIndex: sinon.stub().rejects(new Error('db down')) } };

            changeDetector.emit('block', 'BTC', { block_index: 100, action_count: 3 });
            await broadcaster._statsTails.get('BTC');
            changeDetector.emit('block', 'BTC', { block_index: 101, action_count: 4 });
            await broadcaster._statsTails.get('BTC');

            // DB failing falls back to the per-block count; both frames still emit.
            const stats = client.ws.send.getCalls()
                .map(c => JSON.parse(c.args[0]))
                .filter(m => m.type === 'NETWORK_STATS');
            expect(stats.map(m => m.data.block_height)).to.deep.equal(['100', '101']);
            expect(stats.map(m => m.data.total_actions)).to.deep.equal(['3', '4']);
        });

        it('does not send to clients on different coin', function () {
            const client = createClient(1, 'LTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['blocks']);

            changeDetector.emit('block', 'BTC', { block_index: 100 });

            expect(client.ws.send.callCount).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Action broadcasting with filter pipeline
    // -----------------------------------------------------------------

    describe('action events: filter pipeline', function () {

        it('broadcasts NEW_ACTION to actions subscribers', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['actions']);

            changeDetector.emit('action', 'BTC', {
                action_index: 501, action: 'SEND', source: '1abc', status: 'valid'
            });

            expect(client.ws.send.called).to.be.true;
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('NEW_ACTION');
            expect(msg.data.action).to.equal('SEND');
        });

        it('omits the destination field from NEW_ACTION (honesty contract)', function () {
            // api-contracts finding: the block-derived actions feed never selects
            // a destination column, so the field was always null while the
            // catch-up replay path already omits it. The live event shape must not
            // advertise destination routing it cannot honor - even when the raw
            // action carries one, the emitted event omits the key.
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['actions']);

            changeDetector.emit('action', 'BTC', {
                action_index: 502, action: 'SEND', source: '1abc', destination: '1xyz', status: 'valid'
            });

            expect(client.ws.send.called).to.be.true;
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.data).to.not.have.property('destination');
        });

        it('types filter passes matching action', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['actions'], { types: ['SEND'] });

            changeDetector.emit('action', 'BTC', {
                action_index: 501, action: 'SEND', source: '1abc', status: 'valid'
            });

            expect(client.ws.send.called).to.be.true;
        });

        it('types filter blocks non-matching action', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['actions'], { types: ['ORDER_MATCH'] });

            changeDetector.emit('action', 'BTC', {
                action_index: 501, action: 'SEND', source: '1abc', status: 'valid'
            });

            expect(client.ws.send.callCount).to.equal(0);
        });

        it('statuses filter blocks non-matching status', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['actions'], { statuses: ['pending_coinpay'] });

            changeDetector.emit('action', 'BTC', {
                action_index: 501, action: 'SEND', source: '1abc', status: 'valid'
            });

            expect(client.ws.send.callCount).to.equal(0);
        });

        it('fields projection strips payload to requested keys', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['actions'], { fields: ['action_index', 'action'] });

            changeDetector.emit('action', 'BTC', {
                action_index: 501, action: 'SEND', source: '1abc', status: 'valid', tx_hash: 'def'
            });

            expect(client.ws.send.called).to.be.true;
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.data.action_index).to.equal(501);
            expect(msg.data.action).to.equal('SEND');
            expect(msg.data.source).to.be.undefined;
            expect(msg.data.tx_hash).to.be.undefined;
        });
    });

    // -----------------------------------------------------------------
    // Address channel routing
    // -----------------------------------------------------------------

    describe('address channel routing', function () {

        it('broadcasts to subscribed address when source matches', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['address'], { address: '1abc' });

            changeDetector.emit('action', 'BTC', {
                action_index: 501, action: 'SEND', source: '1abc', status: 'valid'
            });

            // Client should receive the event via address channel
            expect(client.ws.send.called).to.be.true;
        });

        it('does not broadcast to unsubscribed address', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['address'], { address: '1xyz' });

            changeDetector.emit('action', 'BTC', {
                action_index: 501, action: 'SEND', source: '1abc', status: 'valid'
            });

            expect(client.ws.send.callCount).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Once auto-unsubscribe
    // -----------------------------------------------------------------

    describe('once auto-unsubscribe', function () {

        it('removes subscription after first matching event and sends UNSUBSCRIBED', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['actions'], { once: true });

            changeDetector.emit('action', 'BTC', {
                action_index: 501, action: 'SEND', source: '1abc', status: 'valid'
            });

            // First call: the event, second call: UNSUBSCRIBED
            expect(client.ws.send.callCount).to.equal(2);
            const unsubMsg = JSON.parse(client.ws.send.secondCall.args[0]);
            expect(unsubMsg.type).to.equal('UNSUBSCRIBED');
            expect(unsubMsg.data.reason).to.equal('once');

            // Subscription should be gone
            expect(client.subscriptions.size).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Backpressure
    // -----------------------------------------------------------------

    describe('backpressure', function () {

        it('skips client when bufferedAmount exceeds threshold', function () {
            const ws = createMockWs();
            ws.bufferedAmount = 100000; // over 65536
            const client = createClient(1, 'BTC', ws);
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['actions']);

            changeDetector.emit('action', 'BTC', {
                action_index: 501, action: 'SEND', source: '1abc', status: 'valid'
            });

            expect(ws.send.callCount).to.equal(0);
        });
    });

    // -----------------------------------------------------------------
    // Lifecycle events
    // -----------------------------------------------------------------

    describe('lifecycle events', function () {

        it('broadcasts lifecycle event to actions subscribers', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['actions'], { types: ['ORDER_MATCH'] });

            changeDetector.emit('lifecycle_event', 'BTC', {
                type: 'ORDER_MATCH',
                action: 'ORDER_MATCH',
                data: { action_index: 501, settlement_type: 'instant', status: 'valid', source: '1abc' }
            });

            expect(client.ws.send.called).to.be.true;
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('ORDER_MATCH');
        });

        it('broadcasts COINPAY_REQUIRED to address subscribers', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['address'], {
                address: '1buyer',
                types: ['COINPAY_REQUIRED']
            });

            changeDetector.emit('lifecycle_event', 'BTC', {
                type: 'COINPAY_REQUIRED',
                action: 'COINPAY_REQUIRED',
                data: {
                    obligation_action_index: 501,
                    payer_address: '1buyer',
                    payee_address: '1seller',
                    coin_amount: '0.01',
                    expiration: 1234567890
                }
            });

            expect(client.ws.send.called).to.be.true;
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('COINPAY_REQUIRED');
            expect(msg.data.payer_address).to.equal('1buyer');
        });

        it('routes DISPENSE to the dispenser channel keyed on the parent dispenser', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            // SDK onDispenser subscribes to the dispenser channel keyed on the
            // dispenser's opening action_index.
            wsServer.channelManager.subscribe(client, ['dispenser'], { action_index: 777 });

            changeDetector.emit('lifecycle_event', 'BTC', {
                type: 'DISPENSE',
                action: 'DISPENSE',
                channel: 'dispenser',
                data: { action_index: 900, dispenser_action_index: 777, status: 'valid' }
            });

            expect(client.ws.send.called).to.be.true;
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('DISPENSE');
            expect(msg.data.dispenser_action_index).to.equal(777);
        });

        it('routes DISPENSER_CLOSED / DISPENSER_EXPIRED to the dispenser channel', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['dispenser'], { action_index: 55 });

            changeDetector.emit('lifecycle_event', 'BTC', {
                type: 'DISPENSER_CLOSED',
                action: 'DISPENSER_CLOSE',
                channel: 'dispenser',
                data: { action_index: 910, dispenser_action_index: 55, status: 'valid' }
            });

            expect(client.ws.send.called).to.be.true;
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('DISPENSER_CLOSED');
        });

        it('routes a placed BET to the bet_feed channel keyed on the parent market', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            // A market page subscribes to one feed by its creating action_index.
            wsServer.channelManager.subscribe(client, ['bet_feed'], { action_index: 4242 });

            changeDetector.emit('lifecycle_event', 'BTC', {
                type: 'BET',
                action: 'BET',
                channel: 'bet_feed',
                data: { action_index: 5000, feed_action_index: 4242, action_format: 2, status: 'valid' }
            });

            expect(client.ws.send.called).to.be.true;
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('BET');
            expect(msg.data.feed_action_index).to.equal(4242);
        });

        it('routes BET_EXPIRED (the system refund pass) to the bet_feed channel', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['bet_feed'], { action_index: 88 });

            changeDetector.emit('lifecycle_event', 'BTC', {
                type: 'BET_EXPIRED',
                action: 'BET_EXPIRE',
                channel: 'bet_feed',
                data: { action_index: 88, feed_action_index: 88, status: 'valid' }
            });

            expect(client.ws.send.called).to.be.true;
            expect(JSON.parse(client.ws.send.firstCall.args[0]).type).to.equal('BET_EXPIRED');
        });

        it('does not deliver a bet_feed event to a subscriber watching a different market', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['bet_feed'], { action_index: 1 });

            changeDetector.emit('lifecycle_event', 'BTC', {
                type: 'BET',
                action: 'BET',
                channel: 'bet_feed',
                data: { action_index: 5000, feed_action_index: 2, status: 'valid' }
            });

            expect(client.ws.send.called).to.be.false;
        });

        it('does not deliver a dispenser lifecycle event to a non-matching dispenser subscriber', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['dispenser'], { action_index: 111 });

            changeDetector.emit('lifecycle_event', 'BTC', {
                type: 'DISPENSE',
                action: 'DISPENSE',
                channel: 'dispenser',
                data: { action_index: 900, dispenser_action_index: 222, status: 'valid' }
            });

            expect(client.ws.send.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------
    // Entity update events
    // -----------------------------------------------------------------

    describe('entity update events', function () {

        it('broadcasts ADDRESS_UPDATE to address subscribers', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['address'], { address: '1abc' });

            changeDetector.emit('entity_update', 'BTC', {
                type: 'ADDRESS_UPDATE',
                channel: 'address',
                data: { address: '1abc', balances: [{ tick: 'XCHAIN', amount: '100' }], last_action_index: 501 }
            });

            expect(client.ws.send.called).to.be.true;
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('ADDRESS_UPDATE');
        });

        it('broadcasts MARKET_UPDATE to market subscribers', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['market'], { tick1: 'PEPE', tick2: 'BTC' });

            changeDetector.emit('entity_update', 'BTC', {
                type: 'MARKET_UPDATE',
                channel: 'market',
                data: { tick1: 'PEPE', tick2: 'BTC', last_price: '0.00000020' }
            });

            expect(client.ws.send.called).to.be.true;
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('MARKET_UPDATE');
        });

        it('stamps data.channel on every live entity frame, matching the SNAPSHOT discriminator', function () {
            // WebSocketServer._sendSnapshots puts `channel` inside data for address,
            // token, market and dispenser. The live frame for the same entity carried
            // it only as an internal routing field, so the snapshot and the live update
            // for one entity were keyed differently and a consumer that unified them on
            // data.channel dropped every live update.
            const cases = [
                { channel: 'address',   type: 'ADDRESS_UPDATE',   params: { address: '1abc' },                data: { address: '1abc', balances: [] } },
                { channel: 'token',     type: 'TOKEN_UPDATE',     params: { tick: 'PEPE' },                   data: { tick: 'PEPE', supply: '1' } },
                { channel: 'market',    type: 'MARKET_UPDATE',    params: { tick1: 'PEPE', tick2: 'BTC' },    data: { tick1: 'PEPE', tick2: 'BTC' } },
                { channel: 'dispenser', type: 'DISPENSER_UPDATE', params: { action_index: 777 },              data: { action_index: 777 } }
            ];
            // One client per case, each subscribed only to its own entity, so a
            // frame can only have been delivered by the channel under test.
            cases.forEach((c, i) => {
                const client = createClient(i + 1, 'BTC');
                wsServer.addClient(client);
                wsServer.channelManager.subscribe(client, [c.channel], c.params);

                changeDetector.emit('entity_update', 'BTC', { type: c.type, channel: c.channel, data: c.data });

                expect(client.ws.send.called, c.type + ' was sent').to.be.true;
                const msg = JSON.parse(client.ws.send.firstCall.args[0]);
                expect(msg.type).to.equal(c.type);
                expect(msg.data.channel, c.type + ' carries its channel').to.equal(c.channel);
            });
        });

        it('does not mutate the emitted event when stamping the channel', function () {
            // The same data object reaches every other listener on this event.
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['address'], { address: '1abc' });
            const data = { address: '1abc', balances: [] };

            changeDetector.emit('entity_update', 'BTC', { type: 'ADDRESS_UPDATE', channel: 'address', data });

            expect(data).to.not.have.property('channel');
        });
    });
});
