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
 *
 * The handshake block tip meets the live NEW_BLOCK feed without overlap: a
 * real ChangeDetector, Broadcaster and WebSocketServer over one fake
 * database, with block N committed but not yet polled when the client
 * connects. WELCOME and the blocks SNAPSHOT must name the last block the
 * live feed sent, so the NEW_BLOCK that follows is strictly above it.
 *
 ********************************************************************/

'use strict';

const sinon           = require('sinon');
const { expect }      = require('chai');
const WebSocketServer = require('../../../../src/ws/websocket_server.js');
const Broadcaster     = require('../../../../src/ws/broadcaster.js');
const ChangeDetector  = require('../../../../src/ws/change_detector.js');

function block(index) {
    return { block_index: index, block_hash: 'h' + index, block_time: 1, tx_count: 0, action_count: 0 };
}

// A database holding `tip` blocks; push to `blocks` to commit one the detector has not polled.
function fakeDb(tip) {
    const blocks = [];
    for (let i = 1; i <= tip; i++) blocks.push(block(i));
    return {
        blocks,
        isCoinTipStale:    async () => false,
        getMaxBlockIndex:  async () => (blocks.length ? blocks[blocks.length - 1].block_index : 0),
        getBlocksSince:    async (config, since, limit) => blocks.filter((b) => b.block_index > since).slice(0, limit),
        getMaxActionIndex: async () => 0n,
        getActionsSince:   async () => []
    };
}

function makeClient(id) {
    return {
        id, coin: 'BTC', chain: 'BTC', network: 'mainnet',
        ws: { readyState: 1, bufferedAmount: 0, send: sinon.spy() },
        subscriptions: new Set(), snapshotInProgress: false, catchUpInProgress: false
    };
}

function setup(db, withDetector = true) {
    const s = new WebSocketServer({ explorer: { db }, broadcaster: null });
    let detector = null;
    if (withDetector) {
        detector = new ChangeDetector({ db });
        detector.state.BTC = { blockIndex: 0, actionIndex: 0, closedBlock: 0, xcallBlock: 0, initialized: false };
        sinon.stub(detector, 'checkBetLatches').resolves();
        sinon.stub(detector, 'checkXcallPhases').resolves();
        s.broadcaster = new Broadcaster({ wsServer: s, changeDetector: detector });
    }
    const client = makeClient(1);
    s.clients.set(client.id, client);
    return { s, detector, client };
}

const frames = (client, type) => client.ws.send.getCalls().map(c => JSON.parse(c.args[0])).filter(m => m.type === type);

async function settle() { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); }

async function subscribeBlocksWithSnapshot(s, client) {
    s.handleSubscribe(client, { action: 'subscribe', channels: ['blocks'], params: { snapshot: true }, id: 'r1' });
    await settle();
}

describe('handshake block tip stops at the live NEW_BLOCK boundary', function () {
    afterEach(() => sinon.restore());

    it('WELCOME names the last block sent live, not a committed but unpolled tip', async function () {
        const db = fakeDb(9);
        const { s, detector, client } = setup(db);
        await detector.checkCoin('BTC');
        db.blocks.push(block(10));

        await s.sendWelcome(client);

        expect(frames(client, 'WELCOME')[0].data.latest_block_index).to.equal('9');
    });

    it('the blocks SNAPSHOT names the same tip, and the next NEW_BLOCK is strictly above it', async function () {
        const db = fakeDb(9);
        const { s, detector, client } = setup(db);
        await detector.checkCoin('BTC');
        db.blocks.push(block(10));

        await s.sendWelcome(client);
        await subscribeBlocksWithSnapshot(s, client);

        const snapshot = frames(client, 'SNAPSHOT')[0];
        expect(snapshot.data.block_index).to.equal('9');
        expect(snapshot.data.latest_block_index).to.equal('9');

        await detector.checkCoin('BTC');
        await settle();

        const handshakeTip = Number(frames(client, 'WELCOME')[0].data.latest_block_index);
        const live = frames(client, 'NEW_BLOCK').map(m => Number(m.data.block_index));
        expect(live).to.deep.equal([10]);
        for (const index of live) expect(index).to.be.greaterThan(handshakeTip);
        for (const index of live) expect(index).to.be.greaterThan(Number(snapshot.data.block_index));
    });
});

describe('handshake block tip stops at the live NEW_BLOCK boundary', function () {
    afterEach(() => sinon.restore());

    it('a connection before the first poll seeds the coin and the next block still goes out live', async function () {
        const db = fakeDb(7);
        const { s, detector, client } = setup(db);

        await s.sendWelcome(client);
        await subscribeBlocksWithSnapshot(s, client);
        expect(frames(client, 'WELCOME')[0].data.latest_block_index).to.equal('7');
        expect(frames(client, 'SNAPSHOT')[0].data.block_index).to.equal('7');

        db.blocks.push(block(8));
        await detector.checkCoin('BTC');
        await settle();
        expect(frames(client, 'NEW_BLOCK').map(m => Number(m.data.block_index))).to.deep.equal([8]);
    });

    it('a reorg rewind lowers the reported tip with the block cursor', async function () {
        const db = fakeDb(10);
        const { s, detector, client } = setup(db);
        await detector.checkCoin('BTC');

        db.blocks.splice(8);
        db.blocks.push({ ...block(9), block_hash: 'r9' });
        db.checkReorgAndInvalidate = async () => true;
        // The rewind runs, then the replacement block 9 is fetched and sent live.
        await detector.checkCoin('BTC');
        delete db.checkReorgAndInvalidate;
        db.blocks.push(block(10));

        await s.sendWelcome(client);
        expect(frames(client, 'WELCOME')[0].data.latest_block_index).to.equal('9');
    });

    it('with no detector, WELCOME and the blocks SNAPSHOT fall back to the database tip', async function () {
        const db = fakeDb(12);
        const { s, client } = setup(db, false);

        await s.sendWelcome(client);
        await subscribeBlocksWithSnapshot(s, client);

        expect(frames(client, 'WELCOME')[0].data.latest_block_index).to.equal('12');
        expect(frames(client, 'SNAPSHOT')[0].data.block_index).to.equal('12');
    });
});
