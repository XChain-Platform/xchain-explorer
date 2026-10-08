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
 **********************************************************************/

'use strict';

const EventEmitter = require('events');
const sinon = require('sinon');
const { expect } = require('chai');
const Broadcaster = require('../../../src/ws/broadcaster.js');
const ChannelManager = require('../../../src/ws/channel_manager.js');
const coinPass = require('../../../src/ws/change_detector/coin.js');

function socket() {
    const ws = {
        readyState: 1,
        bufferedAmount: 0,
        send: sinon.stub()
    };
    ws.close = sinon.spy(() => { ws.readyState = 2; });
    return ws;
}

function harness() {
    const changeDetector = new EventEmitter();
    const channelManager = new ChannelManager({ maxSubscriptions: 25 });
    const clients = new Map();
    const wsServer = {
        channelManager,
        getClients: () => clients
    };
    const broadcaster = new Broadcaster({ wsServer, changeDetector, maxBackpressure: 64 });
    return { broadcaster, changeDetector, channelManager, clients };
}

function client(id, ws) {
    return {
        id,
        coin: 'BTC',
        chain: 'BTC',
        network: 'mainnet',
        subscriptions: new Set(),
        ws
    };
}

function action(index) {
    return {
        action_index: index,
        action: 'ORDER_MATCH',
        block_index: 10,
        tx_hash: `tx-${index}`,
        source: '1source',
        destinations: ['1destination']
    };
}

function lifecycle(index) {
    return {
        type: 'ORDER_MATCH',
        action: 'ORDER_MATCH',
        data: {
            action_index: index,
            source: '1source'
        }
    };
}

describe('Broadcaster row-atomic backpressure', function () {
    afterEach(() => sinon.restore());

    it('keeps every wanted frame in a row after admitting its first frame', function () {
        const { changeDetector, channelManager, clients } = harness();
        const ws = socket();
        const connected = client(1, ws);
        clients.set(connected.id, connected);
        channelManager.subscribe(connected, ['actions']);
        channelManager.subscribe(connected, ['address'], { address: '1source' });
        ws.send.callsFake(() => { ws.bufferedAmount = 1000; });

        const row = action(501);
        changeDetector.emit('action_row_start', 'BTC', row);
        changeDetector.emit('action', 'BTC', row);
        changeDetector.emit('lifecycle_event', 'BTC', lifecycle(501));
        changeDetector.emit('action_row_end', 'BTC', row);

        const types = ws.send.getCalls().map((call) => JSON.parse(call.args[0]).type);
        expect(types).to.deep.equal(['NEW_ACTION', 'NEW_ACTION', 'ORDER_MATCH', 'ORDER_MATCH']);
        expect(ws.close.callCount).to.equal(0);
        expect(connected.backpressureSkips || 0).to.equal(0);
    });

    it('rejects a backed-up row once instead of reconsidering each frame', function () {
        const { changeDetector, channelManager, clients } = harness();
        const ws = socket();
        ws.bufferedAmount = 1000;
        const connected = client(1, ws);
        clients.set(connected.id, connected);
        channelManager.subscribe(connected, ['actions']);
        channelManager.subscribe(connected, ['address'], { address: '1source' });

        const row = action(501);
        changeDetector.emit('action_row_start', 'BTC', row);
        changeDetector.emit('action', 'BTC', row);
        changeDetector.emit('lifecycle_event', 'BTC', lifecycle(501));
        changeDetector.emit('action_row_end', 'BTC', row);

        expect(ws.send.callCount).to.equal(0);
        expect(ws.close.callCount).to.equal(1);
        expect(connected.backpressureSkips).to.equal(1);
    });
});

describe('Broadcaster row-atomic backpressure', function () {
    afterEach(() => sinon.restore());

    it('keeps attestation fanout in the admission chosen for its action row', function () {
        const { changeDetector, channelManager, clients } = harness();
        const ws = socket();
        const connected = client(1, ws);
        clients.set(connected.id, connected);
        channelManager.subscribe(connected, ['actions', 'attestation']);
        ws.send.callsFake(() => { ws.bufferedAmount = 1000; });

        const row = { ...action(502), action: 'ATTEST' };
        const attestation = {
            type: 'ATTESTATION_REQUEST',
            action: 'ATTEST',
            channel: 'attestation',
            data: { action_index: 502, source: '1source' }
        };
        changeDetector.emit('action_row_start', 'BTC', row);
        changeDetector.emit('action', 'BTC', row);
        changeDetector.emit('lifecycle_event', 'BTC', attestation);
        changeDetector.emit('action_row_end', 'BTC', row);

        const types = ws.send.getCalls().map((call) => JSON.parse(call.args[0]).type);
        expect(types).to.deep.equal([
            'NEW_ACTION', 'ATTESTATION_REQUEST', 'ATTESTATION_REQUEST'
        ]);
        expect(ws.close.callCount).to.equal(0);
        expect(connected.backpressureSkips || 0).to.equal(0);
    });
});

describe('Broadcaster row-atomic backpressure', function () {
    afterEach(() => sinon.restore());

    it('defers a non-row backpressure close until the admitted row ends', function () {
        const { broadcaster, changeDetector, channelManager, clients } = harness();
        const ws = socket();
        const connected = client(1, ws);
        clients.set(connected.id, connected);
        channelManager.subscribe(connected, ['actions']);
        channelManager.subscribe(connected, ['blocks']);
        ws.send.callsFake(() => { ws.bufferedAmount = 1000; });

        const row = action(501);
        changeDetector.emit('action_row_start', 'BTC', row);
        changeDetector.emit('action', 'BTC', row);
        broadcaster.broadcastToChannel('BTC', 'blocks', { type: 'NEW_BLOCK', data: {} }, null);

        expect(ws.close.callCount).to.equal(0);
        expect(connected.backpressureClosePending).to.equal(true);

        changeDetector.emit('lifecycle_event', 'BTC', lifecycle(501));
        expect(ws.send.callCount).to.equal(2);
        changeDetector.emit('action_row_end', 'BTC', row);

        expect(ws.close.callCount).to.equal(1);
        expect(ws.close.firstCall.args).to.deep.equal([4008, 'backpressure']);
        expect(connected.backpressureClosePending).to.equal(false);
    });

    it("defers a non-row backpressure close before the client's first row frame until row end", function () {
        const { broadcaster, changeDetector, channelManager, clients } = harness();
        const ws = socket();
        ws.bufferedAmount = 1000;
        const connected = client(1, ws);
        clients.set(connected.id, connected);
        channelManager.subscribe(connected, ['actions']);
        channelManager.subscribe(connected, ['blocks']);

        const row = action(502);
        changeDetector.emit('action_row_start', 'BTC', row);
        broadcaster.broadcastToChannel('BTC', 'blocks', { type: 'NEW_BLOCK', data: {} }, null);

        expect(ws.close.callCount).to.equal(0);
        expect(connected.backpressureClosePending).to.equal(true);

        changeDetector.emit('action', 'BTC', row);

        expect(ws.send.callCount).to.equal(0);
        expect(ws.close.callCount).to.equal(0);
        expect(connected.backpressureSkips).to.equal(2);

        changeDetector.emit('action_row_end', 'BTC', row);

        expect(ws.close.callCount).to.equal(1);
        expect(ws.close.firstCall.args).to.deep.equal([4008, 'backpressure']);
        expect(connected.backpressureClosePending).to.equal(false);
    });
});

describe('Broadcaster row-atomic backpressure', function () {
    afterEach(() => sinon.restore());

    it('ends a detector row even when enrichment fails', async function () {
        const detector = Object.create(coinPass);
        detector.fetchLimit = 100;
        detector.state = {
            BTC: { initialized: true, blockIndex: 10, actionIndex: 500n, closedBlock: 10, xcallBlock: 10 }
        };
        detector.db = {
            checkReorgAndInvalidate: sinon.stub().resolves(false),
            getMaxBlockIndex: sinon.stub().resolves(10),
            getMaxActionIndex: sinon.stub().resolves(501n),
            getActionsSince: sinon.stub().resolves([action(501n)])
        };
        detector.emit = sinon.spy();
        detector.emitLifecycleEvents = sinon.stub().rejects(new Error('enrichment failed'));
        detector.emitEntityUpdates = sinon.stub().resolves();
        detector.emitAttestationEvents = sinon.stub().resolves();
        detector.checkBetLatches = sinon.stub().resolves();
        detector.checkXcallPhases = sinon.stub().resolves();

        let failure;
        try {
            await detector.checkCoin('BTC');
        } catch (e) {
            failure = e;
        }

        expect(failure).to.have.property('message', 'enrichment failed');
        expect(detector.emit.getCalls().map((call) => call.args[0])).to.deep.equal([
            'action_row_start', 'action', 'action_row_end'
        ]);
    });
});
