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

const { expect, sinon } = require('../../websocket_server.test.js');

const ChannelManager  = require('../../../../../src/ws/channel_manager.js');
const WebSocketServer = require('../../../../../src/ws/websocket_server.js');

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
});
