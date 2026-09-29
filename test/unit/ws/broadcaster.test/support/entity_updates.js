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
} = require('../../broadcaster.test.js');

let wsServer, changeDetector, broadcaster;

function setupBroadcaster() {
    ({ wsServer, changeDetector, broadcaster } = createHarness());
}

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('entity update events', function () {
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

        it('broadcasts a market update when the first ticker contains a colon', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['market'], { tick1: 'A:B', tick2: 'C' });

            changeDetector.emit('entity_update', 'BTC', {
                type: 'MARKET_UPDATE',
                channel: 'market',
                data: { tick1: 'A:B', tick2: 'C', last_price: '2' }
            });

            expect(client.ws.send.called).to.be.true;
            expect(JSON.parse(client.ws.send.firstCall.args[0]).type).to.equal('MARKET_UPDATE');
        });
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('entity update events', function () {
        it('stamps data.channel on every live entity frame, matching the SNAPSHOT discriminator', function () {
            // WebSocketServer.sendSnapshots puts `channel` inside data for address,
            // token, market and dispenser. The live frame must carry the same key,
            // or a consumer that unifies snapshot and live updates on data.channel
            // drops every live update.
            const cases = [
                { channel: 'address',   type: 'ADDRESS_UPDATE',   params: { address: '1abc' },                data: { address: '1abc', balances: [] } },
                { channel: 'token',     type: 'TOKEN_UPDATE',     params: { tick: 'PEPE' },                   data: { tick: 'PEPE', supply: '1' } },
                { channel: 'market',    type: 'MARKET_UPDATE',    params: { tick1: 'PEPE', tick2: 'BTC' },    data: { tick1: 'PEPE', tick2: 'BTC' } },
                { channel: 'dispenser', type: 'DISPENSER_UPDATE', params: { action_index: 777 },              data: { action_index: 777 } }
            ];
            // One client per case, subscribed only to its own entity, so a frame
            // can only have been delivered by the channel under test.
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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('entity update events', function () {
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

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('entity update events from the real ChangeDetector emitter', function () {
        const ChangeDetector = require('../../../../../src/ws/change_detector.js');

        // A real detector over the harness's real ChannelManager, its entity_update
        // events forwarded to the detector the Broadcaster listens on.
        function realDetector(db) {
            const det = new ChangeDetector({ db, channelManager: wsServer.channelManager, pollInterval: 1e9 });
            det.on('entity_update', (coin, ev) => changeDetector.emit('entity_update', coin, ev));
            return det;
        }

        it('delivers MARKET_UPDATE to a subscriber whose tick spelling differs from the canonical one', async function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['market'], { tick1: 'xcp', tick2: 'btc' });
            const det = realDetector({ getMarketInfo: sinon.stub().resolves({ tick1: 'XCP', tick2: 'BTC', last_price: '1' }) });

            await det.emitEntityUpdates('BTC', {}, { action: 'ORDER', action_index: 5 });

            expect(client.ws.send.callCount).to.equal(1);
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('MARKET_UPDATE');
            expect(msg.data.tick1).to.equal('xcp');
            expect(msg.data.last_price).to.equal('1');
        });

        it('does not route a canonical-tick MARKET_UPDATE to a lower-case subscriber (the routing the emitter must avoid)', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['market'], { tick1: 'xcp', tick2: 'btc' });
            changeDetector.emit('entity_update', 'BTC', {
                type: 'MARKET_UPDATE', channel: 'market', data: { tick1: 'XCP', tick2: 'BTC' }
            });
            expect(client.ws.send.called).to.be.false;
        });

        it('delivers ADDRESS_UPDATE to a subscribed receiving address named only in destinations', async function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['address'], { address: '1dest' });
            const det = realDetector({ getAddressBalances: sinon.stub().resolves([{ tick: 'XCHAIN', amount: '3' }]) });

            await det.emitEntityUpdates('BTC', {}, { action: 'SEND', source: '1src', destinations: ['1dest'], action_index: 6 });

            expect(client.ws.send.callCount).to.equal(1);
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.type).to.equal('ADDRESS_UPDATE');
            expect(msg.data.address).to.equal('1dest');
        });
    });
});
