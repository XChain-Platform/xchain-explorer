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
 * The catch-up replay meets the live feed at a per-key ceiling: a real
 * ChangeDetector, Broadcaster and WebSocketServer over one fake database,
 * with rows committed but not yet polled when the client subscribes. Each
 * matching NEW_ACTION must reach the client once, from replay or live.
 *
 ********************************************************************/

'use strict';

const sinon           = require('sinon');
const { expect }      = require('chai');
const WebSocketServer = require('../../../src/ws/websocket_server.js');
const Broadcaster     = require('../../../src/ws/broadcaster.js');
const ChangeDetector  = require('../../../src/ws/change_detector.js');

function row(index) {
    return { action_index: BigInt(index), action: 'SEND', block_index: 10, source: 'X', destinations: [] };
}

// A database holding `rows`, with the replay's stale check held until `release()`.
function fakeDb(rows) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const db = {
        rows,
        release: () => release(false),
        isCoinTipStale:    () => gate,
        getMaxBlockIndex:  async () => 10,
        getBlocksSince:    async () => [],
        getMaxActionIndex: async () => rows.reduce((max, r) => (r.action_index > max ? r.action_index : max), 0n),
        getActionsSince:   sinon.spy(async (config, since, limit, upTo) => rows
            .filter((r) => r.action_index > BigInt(since) && (upTo === undefined || r.action_index <= upTo))
            .slice(0, limit))
    };
    return db;
}

function setup(db) {
    const s = new WebSocketServer({ explorer: { db }, broadcaster: null });
    const detector = new ChangeDetector({ db });
    detector.state.BTC = { blockIndex: 0, actionIndex: 0, closedBlock: 0, xcallBlock: 0, initialized: false };
    sinon.stub(detector, 'checkBetLatches').resolves();
    sinon.stub(detector, 'checkXcallPhases').resolves();
    s.broadcaster = new Broadcaster({ wsServer: s, changeDetector: detector });
    const client = {
        id: 1, coin: 'BTC', chain: 'BTC', network: 'mainnet',
        ws: { readyState: 1, bufferedAmount: 0, send: sinon.spy() },
        subscriptions: new Set(), snapshotInProgress: false, catchUpInProgress: false
    };
    s.clients.set(client.id, client);
    return { s, detector, client };
}

const frames = (client, type) => client.ws.send.getCalls().map(c => JSON.parse(c.args[0])).filter(m => m.type === type);
const actionIndexes = (client) => frames(client, 'NEW_ACTION').map(m => m.data.action_index).sort();

async function settle() { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); }

function subscribe(s, client, params) {
    s.handleSubscribe(client, { action: 'subscribe', channels: ['actions'], params, id: 'r1' });
}

describe('catch-up replay stops at the live-start ceiling', function () {
    afterEach(() => sinon.restore());

    it('a live poll during the replay does not repeat a committed but unpolled row', async function () {
        const db = fakeDb([row(1)]);
        const { s, detector, client } = setup(db);
        await detector.checkCoin('BTC');
        db.rows.push(row(2), row(3));

        subscribe(s, client, { since_action_index: '0' });
        await detector.checkCoin('BTC');
        db.release();
        await settle();

        expect(actionIndexes(client)).to.deep.equal(['1', '2', '3']);
        expect(frames(client, 'CATCH_UP_COMPLETE')[0].data.latest_action_index).to.equal('1');
    });

    it('a replay that finishes before the next poll does not repeat those rows either', async function () {
        const db = fakeDb([row(1)]);
        const { s, detector, client } = setup(db);
        await detector.checkCoin('BTC');
        db.rows.push(row(2), row(3));

        subscribe(s, client, { since_action_index: '0' });
        db.release();
        await settle();
        await detector.checkCoin('BTC');

        expect(actionIndexes(client)).to.deep.equal(['1', '2', '3']);
    });

    it('a key the client already holds keeps the ceiling it went live at', async function () {
        const db = fakeDb([row(1)]);
        const { s, detector, client } = setup(db);
        await detector.checkCoin('BTC');
        subscribe(s, client, {});
        db.rows.push(row(2), row(3));
        await detector.checkCoin('BTC');

        subscribe(s, client, { since_action_index: '0' });
        db.release();
        await settle();

        expect(actionIndexes(client)).to.deep.equal(['1', '2', '3']);
    });
});

describe('catch-up replay stops at the live-start ceiling', function () {
    afterEach(() => sinon.restore());

    it('a key that went live before the first poll is bounded by the seed', async function () {
        const db = fakeDb([row(1), row(2)]);
        const { s, detector, client } = setup(db);

        subscribe(s, client, { since_action_index: '0' });
        await detector.checkCoin('BTC');
        db.rows.push(row(3));
        await detector.checkCoin('BTC');
        db.release();
        await settle();

        expect(actionIndexes(client)).to.deep.equal(['1', '2', '3']);
    });

    it('a reorg rewind lowers the live mark to the rewound cursor', async function () {
        const db = fakeDb([row(1), row(2), row(3), row(4), row(5)]);
        const { detector } = setup(db);
        await detector.checkCoin('BTC');
        expect(detector.liveActionMark('BTC')).to.equal(5n);

        db.rows.splice(3);
        db.checkReorgAndInvalidate = async () => true;
        await detector.checkCoin('BTC');

        expect(detector.liveActionMark('BTC')).to.equal(3n);
    });

    it('the live detector reads its own feed with no upper bound', async function () {
        const db = fakeDb([row(1)]);
        const { detector } = setup(db);
        await detector.checkCoin('BTC');
        db.rows.push(row(2));
        await detector.checkCoin('BTC');

        expect(db.getActionsSince.called).to.equal(true);
        for (const call of db.getActionsSince.getCalls()) expect(call.args[3]).to.equal(undefined);
    });
});

describe('catch-up replay stops at the live-start ceiling', function () {
    afterEach(() => sinon.restore());

    it('a subscribe landing mid-row gets that row\'s lifecycle frames once, after its NEW_ACTION', async function () {
        // The row's ORDER_MATCH waits on a settlement read; the subscribe lands inside
        // that wait, so its ceiling freezes at the row and the replay owns the row whole.
        const db = fakeDb([row(1)]);
        let settle2;
        const settlement = new Promise((resolve) => { settle2 = resolve; });
        db.getOrderMatchSettlement = () => settlement;
        db.getCoinpayObligation = async () => null;
        const { s, detector, client } = setup(db);
        await detector.checkCoin('BTC');
        db.rows.push(Object.assign(row(2), { action: 'ORDER_MATCH', status: 'valid' }));

        const poll = detector.checkCoin('BTC');
        await settle();
        subscribe(s, client, { since_action_index: '1' });
        settle2({ settlement_type: 'native' });
        await poll;
        db.release();
        await settle();

        const sent = client.ws.send.getCalls().map(c => JSON.parse(c.args[0]))
            .filter(m => m.type === 'NEW_ACTION' || m.type === 'ORDER_MATCH');
        expect(sent.map(m => m.type + (m.catch_up ? ' replay' : ' live')))
            .to.deep.equal(['NEW_ACTION replay', 'ORDER_MATCH replay']);
    });
});
