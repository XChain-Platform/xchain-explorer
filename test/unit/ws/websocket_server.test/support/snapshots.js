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
 * Stress-sweep unit tests for src/ws/websocket_server.js:
 *   - ws-1: per-IP cap key must not trust a spoofable X-Forwarded-For token
 *   - ws-2: snapshot-on-subscribe must not re-fire for already-subscribed entities
 */

'use strict';

const EventEmitter = require('events');
const { expect, sinon } = require('../../websocket_server.test.js');

const ChannelManager  = require('../../../../../src/ws/channel_manager.js');
const WebSocketServer = require('../../../../../src/ws/websocket_server.js');
const Broadcaster     = require('../../../../../src/ws/broadcaster.js');

// One subscription entry per entity channel, carrying whatever key
// ChannelManager.subscribe puts on it (canonical decimal STRING for the
// action_index-keyed pair).
const ENTITY_SUB = {
    address:   { channel: 'address',   address: '1abc' },
    token:     { channel: 'token',     tick: 'XCP' },
    market:    { channel: 'market',    tick1: 'XCP', tick2: 'BTC' },
    dispenser: { channel: 'dispenser', action_index: '7' },
    bet_feed:  { channel: 'bet_feed',  action_index: '900' },
    xcall:     { channel: 'xcall',     call_id: 'a'.repeat(64) }
};

function serverWithEntityDb() {
    return new WebSocketServer({ broadcaster: null, explorer: { db: {
        getMaxBlockIndex:   sinon.stub().resolves(880123),
        getMaxActionIndex:  sinon.stub().resolves(4567890),
        getAddressBalances: sinon.stub().resolves([]),
        getTokenInfo:       sinon.stub().resolves({ tick: 'XCP', supply: '21' }),
        getMarketInfo:      sinon.stub().resolves({ last_price: '1.5' }),
        getDispenserInfo:   sinon.stub().resolves({ action_index: '7', status: 'open' }),
        getBetFeedInfo:     sinon.stub().resolves({
            action_index: '900', label: 'who wins', feed_status: 'open',
            outcome_labels: ['a', 'b'], pools: [{ outcome: 0, total: '10' }], timeline: []
        }),
        getXcallInfo:       sinon.stub().resolves({
            call_id: 'a'.repeat(64), action_index: '4100', target_chain: 'LTC',
            method: 'ping', request_status: 'pending', result_status: null,
            deadline_block: 880500, resolved_block: null
        })
    } } });
}

function spyClient() {
    return {
        id: 1, coin: 'BTC', chain: 'BTC', network: 'mainnet',
        ws: { readyState: 1, send: sinon.spy() },
        subscriptions: new Set(), snapshotInProgress: false, catchUpInProgress: false
    };
}

function framesOf(client, type) {
    return client.ws.send.getCalls().map((c) => JSON.parse(c.args[0])).filter((m) => m.type === type);
}

function liveAddressHarness() {
    const server = serverWithEntityDb();
    const client = spyClient();
    const changeDetector = new EventEmitter();
    server.clients.set(client.id, client);
    server.channelManager.subscribe(client, ['address'], { address: '1abc' });
    const broadcaster = new Broadcaster({ wsServer: server, changeDetector, maxBackpressure: 65536 });
    return { server, client, changeDetector, broadcaster };
}

function emitAddressUpdate(h, amount) {
    h.changeDetector.emit('entity_update', 'BTC', {
        type: 'ADDRESS_UPDATE', channel: 'address',
        data: { address: '1abc', balances: [{ tick: 'XCP', amount }], last_action_index: '2' }
    });
}

describe('WS SNAPSHOT: every entity channel answers snapshot:true with a frame', function () {
    afterEach(() => sinon.restore());

    it('bet_feed emits a SNAPSHOT carrying the market state, not silence', async function () {
        const s = serverWithEntityDb();
        const client = spyClient();

        await s.sendSnapshots(client, [ENTITY_SUB.bet_feed]);

        const frames = framesOf(client, 'SNAPSHOT');
        expect(frames).to.have.lengthOf(1);
        expect(frames[0].data.channel).to.equal('bet_feed');
        expect(frames[0].data.action_index).to.equal('900');
        expect(frames[0].data.feed_status).to.equal('open');
        expect(frames[0].data.pools).to.deep.equal([{ outcome: 0, total: '10' }]);
    });

    it('the bet_feed snapshot reads by index, not through the router-built config', async function () {
        // db.getBetFeed(config) resolves its WHERE out of config.data.sql, which the
        // HTTP router builds and sendSnapshots (config = { coin }) does not have.
        const s = serverWithEntityDb();
        await s.sendSnapshots(spyClient(), [ENTITY_SUB.bet_feed]);

        const call = s.explorer.db.getBetFeedInfo.firstCall;
        expect(call.args[0]).to.deep.equal({ coin: 'BTC' });
        expect(call.args[1]).to.equal('900');
    });

    it('a bet_feed with no matching market still answers, rather than going silent', async function () {
        const s = serverWithEntityDb();
        s.explorer.db.getBetFeedInfo = sinon.stub().resolves(null);
        const client = spyClient();

        await s.sendSnapshots(client, [ENTITY_SUB.bet_feed]);

        const frames = framesOf(client, 'SNAPSHOT');
        expect(frames).to.have.lengthOf(1);
        expect(frames[0].data).to.deep.equal({ channel: 'bet_feed', action_index: '900' });
    });
});

describe('WS SNAPSHOT: every entity channel answers snapshot:true with a frame', function () {
    afterEach(() => sinon.restore());

    it('EVERY channel in ChannelManager.ENTITY_CHANNELS emits exactly one SNAPSHOT', async function () {
        // The invariant, not the instance: a future entity channel added without a
        // sendSnapshots case fails here instead of shipping a silent no-op.
        for (const channel of ChannelManager.ENTITY_CHANNELS) {
            const sub = ENTITY_SUB[channel];
            expect(sub, 'no fixture for entity channel ' + channel + '; add one').to.be.an('object');

            const s = serverWithEntityDb();
            const client = spyClient();
            await s.sendSnapshots(client, [sub]);

            const frames = framesOf(client, 'SNAPSHOT');
            expect(frames.length, channel + ' sent no SNAPSHOT for snapshot:true').to.equal(1);
            expect(frames[0].data.channel).to.equal(channel);
        }
    });

    it("the blocks SNAPSHOT carries the live NEW_BLOCK tip key as well as WELCOME's", async function () {
        // Broadcaster.onBlock names the tip block_index; the snapshot named it only
        // latest_block_index, so a subscriber seeding from the snapshot read undefined
        // off its first live frame. Same value, same decimal-string type, both keys.
        const s = serverWithEntityDb();
        const client = spyClient();

        await s.sendSnapshots(client, [{ channel: 'blocks' }]);

        const data = framesOf(client, 'SNAPSHOT')[0].data;
        expect(data.latest_block_index).to.equal('880123');
        expect(data.block_index).to.equal('880123');
        expect(data.block_index).to.equal(data.latest_block_index);
    });

    it('the token SNAPSHOT keeps the subscribed tick spelling, as TOKEN_UPDATE does', async function () {
        const s = serverWithEntityDb();
        s.explorer.db.getTokenInfo = sinon.stub().resolves({ tick: 'PEPE', supply: '1' });
        const client = spyClient();

        await s.sendSnapshots(client, [{ channel: 'token', tick: 'pepe' }]);

        const data = framesOf(client, 'SNAPSHOT')[0].data;
        expect(data).to.include({ channel: 'token', tick: 'pepe', supply: '1' });
    });

    it('the market SNAPSHOT keeps the subscribed pair spelling, as MARKET_UPDATE does', async function () {
        const s = serverWithEntityDb();
        s.explorer.db.getMarketInfo = sinon.stub().resolves({ tick1: 'PEPE', tick2: 'BTC', last_price: '1.5' });
        const client = spyClient();

        await s.sendSnapshots(client, [{ channel: 'market', tick1: 'pepe', tick2: 'btc' }]);

        const data = framesOf(client, 'SNAPSHOT')[0].data;
        expect(data).to.include({ channel: 'market', tick1: 'pepe', tick2: 'btc', last_price: '1.5' });
    });
});

describe('WS SNAPSHOT: a key repeated inside one subscribe batch is snapshotted once', function () {
    afterEach(() => sinon.restore());

    it('150 copies of one address send one SUBSCRIBED frame and one snapshot fan-out', async function () {
        const s = serverWithEntityDb();
        const fanout = sinon.spy(s, 'startSnapshotFanout');
        const client = spyClient();
        const msg = { action: 'subscribe', id: 'p5', channels: ['address'],
            params: { snapshot: true, addresses: new Array(150).fill('L3d') } };

        s.handleSubscribe(client, msg);
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        expect(framesOf(client, 'SUBSCRIBED')).to.have.lengthOf(1);
        expect(fanout.callCount).to.equal(1);
        expect(fanout.firstCall.args[1]).to.have.lengthOf(1);
        expect(s.explorer.db.getAddressBalances.callCount).to.equal(1);
        expect(s.explorer.db.getMaxActionIndex.callCount).to.equal(1);

        // Re-sending once the key is held yields no fresh key.
        s.handleSubscribe(client, { ...msg });
        await new Promise((r) => setImmediate(r));
        expect(fanout.callCount).to.equal(1);
        expect(s.explorer.db.getAddressBalances.callCount).to.equal(1);
    });
});

describe('WS SNAPSHOT: live delivery cannot overtake an older address snapshot', function () {
    afterEach(() => sinon.restore());

    it('reads the address cursor before its balances', async function () {
        const s = serverWithEntityDb();
        await s.sendSnapshots(spyClient(), [ENTITY_SUB.address]);
        expect(s.explorer.db.getMaxActionIndex.calledBefore(s.explorer.db.getAddressBalances)).to.equal(true);
    });

    it('re-reads when a live address update arrives during the balance read', async function () {
        const h = liveAddressHarness();
        let release;
        h.server.explorer.db.getMaxActionIndex.onFirstCall().resolves(1).onSecondCall().resolves(2);
        h.server.explorer.db.getAddressBalances.onFirstCall()
            .returns(new Promise(resolve => { release = resolve; }));
        h.server.explorer.db.getAddressBalances.onSecondCall()
            .resolves([{ tick: 'XCP', amount: '2' }]);

        const pending = h.server.sendSnapshots(h.client, [ENTITY_SUB.address]);
        await new Promise(resolve => setImmediate(resolve));
        emitAddressUpdate(h, '2');
        release([{ tick: 'XCP', amount: '1' }]);
        await pending;

        const sent = h.client.ws.send.getCalls().map(c => JSON.parse(c.args[0]));
        expect(sent.map(m => m.type)).to.deep.equal(['ADDRESS_UPDATE', 'SNAPSHOT']);
        expect(sent[1].data.balances[0].amount).to.equal('2');
        expect(sent[1].data.last_action_index).to.equal('2');
    });

    it('sends an explicit error after three overtaken reads', async function () {
        const h = liveAddressHarness();
        h.server.explorer.db.getMaxActionIndex.resolves(2);
        h.server.explorer.db.getAddressBalances.callsFake(async () => {
            emitAddressUpdate(h, '2');
            return [{ tick: 'XCP', amount: '1' }];
        });

        await h.server.sendSnapshots(h.client, [ENTITY_SUB.address]);

        expect(framesOf(h.client, 'SNAPSHOT')).to.deep.equal([]);
        const errors = framesOf(h.client, 'error');
        expect(errors).to.have.lengthOf(1);
        expect(errors[0].data.code).to.equal('SNAPSHOT_OVERTAKEN');
        expect(h.server.explorer.db.getAddressBalances.callCount).to.equal(3);
    });
});
