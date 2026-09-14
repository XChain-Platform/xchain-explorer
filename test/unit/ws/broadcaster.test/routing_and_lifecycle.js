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
 * Unit tests for Broadcaster (src/ws/broadcaster.js)
 */

'use strict';

const {
    sinon, expect, createMockWs, createClient, createHarness
} = require('../broadcaster.test.js');

let wsServer, changeDetector, broadcaster;

function setupBroadcaster() {
    ({ wsServer, changeDetector, broadcaster } = createHarness());
}

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('address channel routing', function () {
        it('broadcasts to subscribed address when source matches', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['address'], { address: '1abc' });

            changeDetector.emit('action', 'BTC', {
                action_index: 501, action: 'SEND', source: '1abc', status: 'valid'
            });

            // This client subscribed to one address, not to the global actions feed, so
            // the frame reached it only because the action named that address.
            expect(client.ws.send.called).to.be.true;
        });
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('address channel routing', function () {
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
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

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

            // A once-subscription is spent by the first frame that matches it, so the
            // client is left holding none and will receive nothing further.
            expect(client.subscriptions.size).to.equal(0);
        });
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

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
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('lifecycle events', function () {
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
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('lifecycle events', function () {
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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('lifecycle events', function () {
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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('lifecycle events', function () {
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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('lifecycle events', function () {
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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('lifecycle events', function () {
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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('lifecycle events', function () {
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
});
