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
 * Catch-up replay driven through handleSubscribe, over a real ChannelManager
 * and a real Broadcaster: the replay reaches exactly the channels the live
 * fan-out would, and one client runs at most one replay at a time.
 *
 ********************************************************************/

'use strict';

const { EventEmitter } = require('events');
const sinon           = require('sinon');
const { expect }      = require('chai');
const WebSocketServer = require('../../../src/ws/websocket_server.js');
const Broadcaster     = require('../../../src/ws/broadcaster.js');

// Four actions over three parties: X sends to Y, Z to X, Y to Z, X to itself.
const ROWS = [
    { action_index: 1, action: 'SEND',  block_index: 10, source: 'X', destinations: ['Y'] },
    { action_index: 2, action: 'SEND',  block_index: 10, source: 'Z', destinations: ['X'] },
    { action_index: 3, action: 'SEND',  block_index: 10, source: 'Y', destinations: ['Z'] },
    { action_index: 4, action: 'SWEEP', block_index: 10, source: 'X', destinations: ['X'] }
];

function setup(db) {
    const changeDetector = new EventEmitter();
    const s = new WebSocketServer({ explorer: { db }, broadcaster: null });
    s.broadcaster = new Broadcaster({ wsServer: s, changeDetector });
    return { s, changeDetector };
}

function addClient(s, id) {
    const client = {
        id, coin: 'BTC', chain: 'BTC', network: 'mainnet',
        ws: { readyState: 1, bufferedAmount: 0, send: sinon.spy() },
        subscriptions: new Set(), snapshotInProgress: false, catchUpInProgress: false
    };
    s.clients.set(id, client);
    return client;
}

function mkDb(over) {
    return {
        getMaxActionIndex: sinon.stub().resolves(4),
        getActionsSince:   sinon.stub().resolves(ROWS),
        ...(over || {})
    };
}

const frames = (client, type) => client.ws.send.getCalls().map(c => JSON.parse(c.args[0])).filter(m => m.type === type);

// Let the un-awaited handleCatchUp that handleSubscribe fires run to completion.
async function settle() { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); }

function subscribe(s, client, channels, params, id) {
    s.handleSubscribe(client, { action: 'subscribe', channels, params, id });
}

describe('catch-up replay routes like the live fan-out', function () {
    afterEach(() => sinon.restore());

    it('a blocks/network subscribe replays no NEW_ACTION and reads nothing', async function () {
        const db = mkDb();
        const { s } = setup(db);
        const client = addClient(s, 1);

        subscribe(s, client, ['blocks', 'network'], { since_action_index: '0' }, 'r1');
        await settle();

        expect(frames(client, 'NEW_ACTION')).to.have.lengthOf(0);
        const complete = frames(client, 'CATCH_UP_COMPLETE');
        expect(complete).to.have.lengthOf(1);
        expect(complete[0].data).to.deep.equal({ events_replayed: 0, latest_action_index: '0', truncated: false });
        expect(complete[0].id).to.equal('r1');
        expect(db.getActionsSince.called).to.equal(false);
        expect(client.catchUpInProgress).to.equal(false);
    });

    it('an address subscribe replays only the actions naming that address, once each', async function () {
        const { s } = setup(mkDb());
        const client = addClient(s, 1);

        subscribe(s, client, ['address'], { address: 'X', since_action_index: '0' }, 'r1');
        await settle();

        expect(frames(client, 'NEW_ACTION').map(m => m.data.action_index)).to.deep.equal([1, 2, 4]);
        expect(frames(client, 'CATCH_UP_COMPLETE')[0].data.events_replayed).to.equal(3);
    });

    it('an actions subscribe still replays every action', async function () {
        const { s } = setup(mkDb());
        const client = addClient(s, 1);

        subscribe(s, client, ['actions'], { since_action_index: '0' }, 'r1');
        await settle();

        expect(frames(client, 'NEW_ACTION').map(m => m.data.action_index)).to.deep.equal([1, 2, 3, 4]);
    });
});

describe('catch-up replay matches the live fan-out frame for frame', function () {
    afterEach(() => sinon.restore());

    it('replays the same frames the live fan-out sends for actions plus address X', async function () {
        const { s, changeDetector } = setup(mkDb());
        const replayed = addClient(s, 1);
        const live     = addClient(s, 2);

        subscribe(s, live, ['actions'], {}, 'l1');
        subscribe(s, live, ['address'], { address: 'X' }, 'l2');
        for (const row of ROWS) changeDetector.emit('action', 'BTC', row);

        subscribe(s, replayed, ['actions', 'address'], { address: 'X', since_action_index: '0' }, 'r1');
        await settle();

        const liveIdx   = frames(live, 'NEW_ACTION').map(m => m.data.action_index);
        const replayIdx = frames(replayed, 'NEW_ACTION').map(m => m.data.action_index);
        expect(liveIdx).to.deep.equal([1, 1, 2, 2, 3, 4, 4]);
        expect(replayIdx).to.deep.equal(liveIdx);
        expect(frames(replayed, 'CATCH_UP_COMPLETE')[0].data.events_replayed).to.equal(7);
    });

    it('a once address subscription is spent by its first replayed frame', async function () {
        const { s } = setup(mkDb());
        const client = addClient(s, 1);

        subscribe(s, client, ['address'], { address: 'X', once: true, since_action_index: '0' }, 'r1');
        await settle();

        expect(frames(client, 'NEW_ACTION').map(m => m.data.action_index)).to.deep.equal([1]);
        const unsub = frames(client, 'UNSUBSCRIBED');
        expect(unsub).to.have.lengthOf(1);
        expect(unsub[0].data).to.deep.equal({ channel: 'address', address: 'X', reason: 'once' });
        expect(client.subscriptions.has('BTC:address:X')).to.equal(false);
    });
});

// A promise and the function that resolves it.
function held() {
    let release;
    const p = new Promise(r => { release = r; });
    return { p, release: (v) => release(v) };
}

describe('catch-up in-progress latch', function () {
    afterEach(() => sinon.restore());

    for (const gate of ['isCoinTipStale', 'getMaxActionIndex']) {
        it('refuses a second catch-up that arrives while the first waits on ' + gate, async function () {
            const h  = held();
            const db = mkDb({ isCoinTipStale: sinon.stub().resolves(false) });
            db[gate] = sinon.stub().returns(h.p);
            const { s } = setup(db);
            const client = addClient(s, 1);

            subscribe(s, client, ['actions'], { since_action_index: '0' }, 'r1');
            expect(client.catchUpInProgress).to.equal(true);   // latched before any await
            subscribe(s, client, ['address'], { address: 'X', since_action_index: '0' }, 'r2');
            h.release(gate === 'isCoinTipStale' ? false : 4);
            await settle();

            const errors = frames(client, 'error');
            expect(errors).to.have.lengthOf(1);
            expect(errors[0].data.code).to.equal('CATCH_UP_IN_PROGRESS');
            expect(errors[0].id).to.equal('r2');
            expect(frames(client, 'CATCH_UP_COMPLETE').map(m => m.id)).to.deep.equal(['r1']);
            expect(db.getActionsSince.callCount).to.equal(1);
            expect(client.catchUpInProgress).to.equal(false);
        });
    }
});

describe('catch-up in-progress latch release', function () {
    afterEach(() => sinon.restore());

    const exits = {
        'COIN_DATA_STALE':               () => mkDb({ isCoinTipStale: sinon.stub().resolves(true), staleFailClosed: () => true }),
        'CATCH_UP_TOO_OLD (depth)':      () => mkDb({ getMaxActionIndex: sinon.stub().resolves(1000000) }),
        'getMaxActionIndex throwing':    () => mkDb({ getMaxActionIndex: sinon.stub().rejects(new Error('db')) }),
        'getActionsSince throwing':      () => mkDb({ getActionsSince: sinon.stub().rejects(new Error('db')) })
    };
    for (const [name, makeDb] of Object.entries(exits)) {
        it('releases the latch after the ' + name + ' exit, so a later request is not wedged', async function () {
            const db = makeDb();
            const { s } = setup(db);
            const client = addClient(s, 1);

            subscribe(s, client, ['actions'], { since_action_index: '0' }, 'r1');
            await settle();

            expect(client.catchUpInProgress).to.equal(false);
            expect(frames(client, 'error').filter(e => e.data.code === 'CATCH_UP_IN_PROGRESS')).to.have.lengthOf(0);
        });
    }

    it('answers a blocks-only catch-up even while another replay holds the latch', async function () {
        const h  = held();
        const db = mkDb({ getMaxActionIndex: sinon.stub().returns(h.p) });
        const { s } = setup(db);
        const client = addClient(s, 1);

        subscribe(s, client, ['actions'], { since_action_index: '0' }, 'r1');
        subscribe(s, client, ['blocks'], { since_action_index: '0' }, 'r2');
        h.release(4);
        await settle();

        expect(frames(client, 'error')).to.have.lengthOf(0);
        expect(frames(client, 'CATCH_UP_COMPLETE').map(m => m.id).sort()).to.deep.equal(['r1', 'r2']);
    });
});
