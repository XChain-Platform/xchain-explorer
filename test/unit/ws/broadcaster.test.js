/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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

        it('also broadcasts NETWORK_STATS to network subscribers', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['network']);

            changeDetector.emit('block', 'BTC', {
                block_index: 100, block_hash: 'abc', block_time: 1234, tx_count: 5, action_count: 2
            });

            expect(client.ws.send.calledOnce).to.be.true;
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('NETWORK_STATS');
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

    describe('action events — filter pipeline', function () {

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
    });
});
