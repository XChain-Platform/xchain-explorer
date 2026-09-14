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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('block events', function () {
        it('stamps every outbound frame with the envelope schema_version', function () {
            const { WS_SCHEMA_VERSION } = require('../../../../../src/ws/schema_version.js');
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['blocks']);
            changeDetector.emit('block', 'BTC', { block_index: 100, block_hash: 'abc', block_time: 1, tx_count: 0, action_count: 0 });
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.schema_version).to.equal(WS_SCHEMA_VERSION);
        });
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('block events', function () {
        it('the schema_version stamp survives a fields projection', function () {
            const { WS_SCHEMA_VERSION } = require('../../../../../src/ws/schema_version.js');
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['blocks'], { fields: ['block_index'] });
            changeDetector.emit('block', 'BTC', { block_index: 100, block_hash: 'abc', block_time: 1, tx_count: 0, action_count: 0 });
            const msg = JSON.parse(client.ws.send.firstCall.args[0]);
            expect(msg.schema_version).to.equal(WS_SCHEMA_VERSION);
        });
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('block events', function () {
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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('block events', function () {
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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('block events', function () {
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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('block events', function () {
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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('block events', function () {
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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('block events', function () {
        it('does not send to clients on different coin', function () {
            const client = createClient(1, 'LTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['blocks']);

            changeDetector.emit('block', 'BTC', { block_index: 100 });

            expect(client.ws.send.callCount).to.equal(0);
        });
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('action events: filter pipeline', function () {
        it('omits the destination field from NEW_ACTION (honesty contract)', function () {
            // The block-derived actions feed never selects a destination column, and the
            // catch-up replay path already omits the field, so the live shape must match
            // it: a raw action carrying a destination still emits an event without one.
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
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('action events: filter pipeline', function () {
        it('types filter passes matching action', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['actions'], { types: ['SEND'] });

            changeDetector.emit('action', 'BTC', {
                action_index: 501, action: 'SEND', source: '1abc', status: 'valid'
            });

            expect(client.ws.send.called).to.be.true;
        });
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('action events: filter pipeline', function () {
        it('types filter blocks non-matching action', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['actions'], { types: ['ORDER_MATCH'] });

            changeDetector.emit('action', 'BTC', {
                action_index: 501, action: 'SEND', source: '1abc', status: 'valid'
            });

            expect(client.ws.send.callCount).to.equal(0);
        });
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('action events: filter pipeline', function () {
        it('statuses filter blocks non-matching status', function () {
            const client = createClient(1, 'BTC');
            wsServer.addClient(client);
            wsServer.channelManager.subscribe(client, ['actions'], { statuses: ['pending_coinpay'] });

            changeDetector.emit('action', 'BTC', {
                action_index: 501, action: 'SEND', source: '1abc', status: 'valid'
            });

            expect(client.ws.send.callCount).to.equal(0);
        });
    });
});

describe('Broadcaster', function () {
    beforeEach(setupBroadcaster);

    describe('action events: filter pipeline', function () {
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
});
