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
 * Stress-sweep unit tests for src/ws/WebSocketServer.js:
 *   - ws-1: per-IP cap key must not trust a spoofable X-Forwarded-For token
 *   - ws-2: snapshot-on-subscribe must not re-fire for already-subscribed entities
 */

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const WebSocketServer = require('../../../src/ws/WebSocketServer.js');

function makeServer(opts = {}) {
    return new WebSocketServer({ explorer: { db: {} }, broadcaster: null, ...opts });
}

function makeReq(headers, remoteAddress) {
    return { headers: headers || {}, socket: { remoteAddress: remoteAddress || '203.0.113.9' } };
}

// A client shaped like _onConnection builds, with a closed ws so _send is a no-op.
function makeClient(coin) {
    return {
        id: 1, coin: coin || 'BTC', chain: 'BTC', network: 'mainnet',
        ws: { readyState: 0, send: () => {} },
        subscriptions: new Set(),
        snapshotInProgress: false,
        catchUpInProgress: false
    };
}

describe('WebSocketServer#_clientIp (ws-1: XFF spoof)', function () {

    it('ignores X-Forwarded-For entirely with 0 trusted hops (uses TCP peer)', function () {
        const s = makeServer({ trustProxyHops: 0 });
        const ip = s._clientIp(makeReq({ 'x-forwarded-for': 'attacker-spoof' }, '198.51.100.7'));
        expect(ip).to.equal('198.51.100.7');
    });

    it('never keys on the leftmost (client-supplied) XFF token', function () {
        const s = makeServer({ trustProxyHops: 1 });
        // Real proxy APPENDS the observed peer to the right; the leftmost is spoofed.
        const ip = s._clientIp(makeReq({ 'x-forwarded-for': 'spoof-uuid-1, 198.51.100.7' }));
        expect(ip).to.equal('198.51.100.7');
        expect(ip).to.not.equal('spoof-uuid-1');
    });

    it('a unique spoofed leftmost token per request resolves to the SAME real IP', function () {
        const s = makeServer({ trustProxyHops: 1 });
        const a = s._clientIp(makeReq({ 'x-forwarded-for': 'uuid-a, 198.51.100.7' }));
        const b = s._clientIp(makeReq({ 'x-forwarded-for': 'uuid-b, 198.51.100.7' }));
        // The bypass was that these keyed to different buckets; now they collapse.
        expect(a).to.equal(b);
    });

    it('falls back to the TCP peer when XFF is absent', function () {
        const s = makeServer({ trustProxyHops: 1 });
        expect(s._clientIp(makeReq({}, '203.0.113.42'))).to.equal('203.0.113.42');
    });

    it('takes the Nth-from-right entry for trustProxyHops=2', function () {
        const s = makeServer({ trustProxyHops: 2 });
        const ip = s._clientIp(makeReq({ 'x-forwarded-for': 'spoof, 198.51.100.7, 10.0.0.1' }));
        expect(ip).to.equal('198.51.100.7');
    });
});

describe('WebSocketServer#_handleSubscribe (ws-2: snapshot amplification)', function () {

    afterEach(() => sinon.restore());

    async function tick() { await new Promise((r) => setImmediate(r)); }

    it('snapshots only NEWLY-subscribed entities, not a re-subscribe of the same set', async function () {
        const s = makeServer();
        const snap = sinon.stub(s, '_sendSnapshots').resolves();
        const client = makeClient('BTC');
        const msg = { channels: ['address'], params: { snapshot: true, addresses: ['addr1', 'addr2'] } };

        s._handleSubscribe(client, msg);
        expect(snap.callCount).to.equal(1);
        expect(snap.firstCall.args[1]).to.have.lengthOf(2); // both fresh
        await tick(); // let the in-progress guard clear

        // Re-send the identical batch: every entity is already subscribed, so there is
        // nothing fresh to snapshot -> _sendSnapshots must NOT run again.
        s._handleSubscribe(client, { ...msg });
        expect(snap.callCount).to.equal(1);
        await tick();

        // Adding one NEW address snapshots only that one.
        s._handleSubscribe(client, { channels: ['address'], params: { snapshot: true, addresses: ['addr1', 'addr3'] } });
        expect(snap.callCount).to.equal(2);
        expect(snap.secondCall.args[1]).to.have.lengthOf(1);
        expect(snap.secondCall.args[1][0].address).to.equal('addr3');
    });

    it('SUBSCRIBED active_filters does not echo a statuses filter (honesty contract)', function () {
        // api-contracts finding: the actions feed cannot honor a status filter,
        // so confirming one back in SUBSCRIBED would let a client rely on a no-op.
        // A client may still send `statuses` (it is stored + works for events that
        // carry a status), but the confirmation must not advertise it.
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        s._handleSubscribe(client, { channels: ['actions'], params: { statuses: ['valid'] } });

        const subscribed = client.ws.send.getCalls()
            .map((c) => JSON.parse(c.args[0]))
            .find((m) => m.type === 'SUBSCRIBED');
        expect(subscribed, 'a SUBSCRIBED frame was sent').to.exist;
        expect(subscribed.data.active_filters).to.not.have.property('statuses');
    });

    it('SUBSCRIBED echoes ignored_filters: ["statuses"] when a raw client sends one', function () {
        // The `statuses` filter is still accepted (non-breaking) but is a no-op on
        // every event this server produces, so the confirmation must make that
        // no-op observable instead of silently dropping the client's request.
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        s._handleSubscribe(client, { channels: ['actions'], params: { statuses: ['valid'] } });

        const subscribed = client.ws.send.getCalls()
            .map((c) => JSON.parse(c.args[0]))
            .find((m) => m.type === 'SUBSCRIBED');
        expect(subscribed, 'a SUBSCRIBED frame was sent').to.exist;
        expect(subscribed.data.ignored_filters).to.deep.equal(['statuses']);
    });

    it('a ticks filter comes back under ignored_filters, never under filters', function () {
        // getActionsSince selects no tick column, so a ticks filter can never narrow
        // the stream. Accept it (non-breaking) but never confirm it as active.
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        s._handleSubscribe(client, { channels: ['actions'], params: { ticks: ['PEPE'] } });

        const subscribed = client.ws.send.getCalls()
            .map((c) => JSON.parse(c.args[0]))
            .find((m) => m.type === 'SUBSCRIBED');
        expect(subscribed, 'a SUBSCRIBED frame was sent').to.exist;
        expect(subscribed.data.ignored_filters).to.deep.equal(['ticks']);
        expect(subscribed.data.filters).to.not.have.property('ticks');
        expect(subscribed.data.active_filters).to.not.have.property('ticks');
    });

    it('SUBSCRIBED has no ignored_filters key when no statuses filter was sent', function () {
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        s._handleSubscribe(client, { channels: ['actions'], params: { types: ['SEND'] } });

        const subscribed = client.ws.send.getCalls()
            .map((c) => JSON.parse(c.args[0]))
            .find((m) => m.type === 'SUBSCRIBED');
        expect(subscribed, 'a SUBSCRIBED frame was sent').to.exist;
        expect(subscribed.data).to.not.have.property('ignored_filters');
    });

    it('does not start a second snapshot fan-out while one is in progress', async function () {
        const s = makeServer();
        // A snapshot that never resolves within the test keeps the guard set.
        const snap = sinon.stub(s, '_sendSnapshots').returns(new Promise(() => {}));
        const client = makeClient('BTC');

        s._handleSubscribe(client, { channels: ['address'], params: { snapshot: true, addresses: ['a'] } });
        expect(snap.callCount).to.equal(1);
        expect(client.snapshotInProgress).to.equal(true);

        // New entity, but a fan-out is still running -> skipped by the guard.
        s._handleSubscribe(client, { channels: ['address'], params: { snapshot: true, addresses: ['b'] } });
        expect(snap.callCount).to.equal(1);
    });
});

describe('WebSocketServer#_sendWelcome (ws-3: types self-description conformance)', function () {

    afterEach(() => sinon.restore());

    it('advertises exactly the set of types ChannelManager.VALID_TYPES accepts', async function () {
        const ChannelManager = require('../../../src/ws/ChannelManager.js');
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        await s._sendWelcome(client);

        expect(client.ws.send.callCount).to.equal(1);
        const welcome = JSON.parse(client.ws.send.firstCall.args[0]);
        expect(welcome.type).to.equal('WELCOME');
        // Set-equality: no extras, no omissions (this is the regression guard --
        // WELCOME's types list previously under-advertised the ten lifecycle
        // event types, e.g. ORDER_COMPLETED, DISPENSER_CANCELLED).
        expect(new Set(welcome.data.types)).to.deep.equal(ChannelManager.VALID_TYPES);
    });

    it('does NOT advertise a "statuses" feature (actions feed cannot honor it)', async function () {
        // Honesty contract (api-contracts finding): the block-derived actions
        // feed never populates a per-action status, so a statuses filter on the
        // actions channel is a silent no-op. WELCOME must not list it.
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        await s._sendWelcome(client);

        const welcome = JSON.parse(client.ws.send.firstCall.args[0]);
        expect(welcome.data.features).to.not.include('statuses');
    });

    it('does NOT advertise a "ticks" feature (no action frame carries a tick)', async function () {
        // Same honesty contract as statuses: getActionsSince selects no tick column,
        // so the ticks check in Broadcaster._passesFilter can never reject anything.
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        await s._sendWelcome(client);

        const welcome = JSON.parse(client.ws.send.firstCall.args[0]);
        expect(welcome.data.features).to.not.include('ticks');
        expect(welcome.data.features).to.include('fields');
    });

    it('advertises exactly the set of channels ChannelManager.VALID_CHANNELS accepts', async function () {
        // api-contracts finding: the `channels` list was a hardcoded literal that
        // could silently drift from what ChannelManager actually validates
        // (unlike `types`, which is already derived). Set-equality regression guard.
        const ChannelManager = require('../../../src/ws/ChannelManager.js');
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        await s._sendWelcome(client);

        const welcome = JSON.parse(client.ws.send.firstCall.args[0]);
        expect(new Set(welcome.data.channels)).to.deep.equal(ChannelManager.VALID_CHANNELS);
    });
});

describe('WS schema v2 conformance: chain indices are decimal strings', function () {

    afterEach(() => sinon.restore());

    // Every BigInt-backed index on a v2 frame is a decimal string
    // (ws/schema-version.js). WELCOME and the SNAPSHOT frames read theirs from
    // db.getMax*Index, which return Number, so they used to be the only v2
    // frames emitting these fields as JSON numbers: one connection saw
    // latest_action_index as a number in WELCOME and as a string in
    // CATCH_UP_COMPLETE and NEW_ACTION, and any value above 2^53 was truncated.
    const DECIMAL = /^[0-9]+$/;

    function serverWithIndices(maxBlock, maxAction) {
        return makeServer({ explorer: { db: {
            getMaxBlockIndex:   sinon.stub().resolves(maxBlock),
            getMaxActionIndex:  sinon.stub().resolves(maxAction),
            getAddressBalances: sinon.stub().resolves([])
        } } });
    }

    function spyClient() {
        return { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };
    }

    function framesOf(client, type) {
        return client.ws.send.getCalls().map((c) => JSON.parse(c.args[0])).filter((m) => m.type === type);
    }

    it('WELCOME emits latest_block_index / latest_action_index as decimal strings', async function () {
        const s = serverWithIndices(880123, 4567890);
        const client = spyClient();

        await s._sendWelcome(client);

        const welcome = framesOf(client, 'WELCOME')[0];
        expect(welcome.schema_version).to.equal(2);
        expect(welcome.data.latest_block_index).to.equal('880123');
        expect(welcome.data.latest_action_index).to.equal('4567890');
        expect(welcome.data.latest_block_index).to.match(DECIMAL);
        expect(welcome.data.latest_action_index).to.match(DECIMAL);
    });

    it('WELCOME keeps full precision for an index above 2^53', async function () {
        // The regression this contract exists to prevent: a JSON number silently
        // rounds 9007199254740993 to ...992.
        const s = serverWithIndices(9007199254740993n, 9007199254740995n);
        const client = spyClient();

        await s._sendWelcome(client);

        const welcome = framesOf(client, 'WELCOME')[0];
        expect(welcome.data.latest_block_index).to.equal('9007199254740993');
        expect(welcome.data.latest_action_index).to.equal('9007199254740995');
    });

    it('WELCOME still sends string zeros when the db read fails', async function () {
        const s = makeServer({ explorer: { db: { getMaxBlockIndex: sinon.stub().rejects(new Error('db down')) } } });
        const client = spyClient();

        await s._sendWelcome(client);

        const welcome = framesOf(client, 'WELCOME')[0];
        expect(welcome.data.latest_block_index).to.equal('0');
        expect(welcome.data.latest_action_index).to.equal('0');
    });

    it('SNAPSHOT frames emit their indices as decimal strings on every channel that carries one', async function () {
        const s = serverWithIndices(880123, 4567890);
        const client = spyClient();

        await s._sendSnapshots(client, [
            { channel: 'blocks' },
            { channel: 'network' },
            { channel: 'address', address: '1abc' }
        ]);

        const byChannel = new Map(framesOf(client, 'SNAPSHOT').map((m) => [m.data.channel, m.data]));
        expect(byChannel.get('blocks').latest_block_index).to.equal('880123');
        expect(byChannel.get('network').block_height).to.equal('880123');
        expect(byChannel.get('network').total_actions).to.equal('4567890');
        expect(byChannel.get('address').last_action_index).to.equal('4567890');
    });

    it('CATCH_UP_COMPLETE reports the same type as the WELCOME it follows', async function () {
        // Both frames answer "how far along is the chain"; a subscriber that
        // compares one against the other must not be comparing a string to a
        // number.
        const db = {
            getMaxBlockIndex:  sinon.stub().resolves(880123),
            getMaxActionIndex: sinon.stub().resolves(4567890),
            getActionsSince:   sinon.stub().resolves([])
        };
        const { EventEmitter } = require('events');
        const Broadcaster = require('../../../src/ws/Broadcaster.js');
        const s = makeServer({ explorer: { db }, broadcaster: new Broadcaster({ wsServer: null, changeDetector: new EventEmitter() }) });
        const client = spyClient();

        await s._sendWelcome(client);
        await s._handleCatchUp(client, 4567000, {}, 'req-1');

        const welcome  = framesOf(client, 'WELCOME')[0];
        const complete = framesOf(client, 'CATCH_UP_COMPLETE')[0];
        expect(typeof complete.data.latest_action_index).to.equal(typeof welcome.data.latest_action_index);
        expect(complete.data.latest_action_index).to.match(DECIMAL);
    });

    // The catch-up cursor used to be Number()-coerced on arrival, which rounded
    // an above-2^53 decimal string UP. The SQL cursor then asked for rows after an
    // action the client had never seen, and the CATCH_UP_COMPLETE echo told the client
    // it was one index further along than it was.
    it('catch-up keeps an above-2^53 since_action_index exact at the cursor and the echo', async function () {
        const db = {
            getMaxBlockIndex:  sinon.stub().resolves(9007199254740999n),
            getMaxActionIndex: sinon.stub().resolves(9007199254740999n),
            getActionsSince:   sinon.stub().resolves([])
        };
        const { EventEmitter } = require('events');
        const Broadcaster = require('../../../src/ws/Broadcaster.js');
        const s = makeServer({ explorer: { db }, broadcaster: new Broadcaster({ wsServer: null, changeDetector: new EventEmitter() }) });
        const client = spyClient();

        await s._handleCatchUp(client, '9007199254740995', {}, 'req-1');

        const cursor = db.getActionsSince.firstCall.args[1];
        expect(String(cursor)).to.equal('9007199254740995');
        expect(typeof cursor).to.not.equal('number');

        const complete = framesOf(client, 'CATCH_UP_COMPLETE')[0];
        expect(complete.data.latest_action_index).to.equal('9007199254740995');
    });

    it('the catch-up depth gate stays exact above 2^53', async function () {
        // currentMax - since must not be computed on two collapsed Numbers: the pair
        // below is 6 apart, well inside the default depth, but both round to the same
        // Number, which made the gate read a difference of 0 either way.
        const db = {
            getMaxBlockIndex:  sinon.stub().resolves(9007199254741001n),
            getMaxActionIndex: sinon.stub().resolves(9007199254741001n),
            getActionsSince:   sinon.stub().resolves([])
        };
        const { EventEmitter } = require('events');
        const Broadcaster = require('../../../src/ws/Broadcaster.js');
        const s = makeServer({ explorer: { db }, broadcaster: new Broadcaster({ wsServer: null, changeDetector: new EventEmitter() }), catchUpMaxDepth: 3 });
        const client = spyClient();

        await s._handleCatchUp(client, '9007199254740995', {}, 'req-2');

        const errors = framesOf(client, 'error');
        expect(errors).to.have.lengthOf(1);
        expect(errors[0].data.code).to.equal('CATCH_UP_TOO_OLD');
        expect(errors[0].data.message).to.include('9007199254740995');
        expect(db.getActionsSince.called).to.equal(false);
    });
});

describe('WebSocketServer#_handleCatchUp (ws-4: catch-up/live filter parity)', function () {

    afterEach(() => sinon.restore());

    function makeBroadcaster() {
        // Real filter/projection logic borrowed from Broadcaster.js so the test
        // exercises the actual shared pipeline, not a stand-in.
        const { EventEmitter } = require('events');
        const Broadcaster = require('../../../src/ws/Broadcaster.js');
        return new Broadcaster({ wsServer: null, changeDetector: new EventEmitter() });
    }

    it('a ticks filter cannot narrow replayed actions - the producer emits no tick column', async function () {
        // Rows match db.getActionsSince's real column list (action_index, action,
        // action_format, tx_hash, block_index, source, NULL as status): no tick.
        // The old fixture invented a `tick` key and made the dead filter read as live.
        const broadcaster = makeBroadcaster();
        const db = {
            getMaxActionIndex: sinon.stub().resolves(3),
            getActionsSince: sinon.stub().resolves([
                { action_index: 1, action: 'SEND', tx_hash: 'a', block_index: 1, source: 's', status: null },
                { action_index: 2, action: 'SEND', tx_hash: 'b', block_index: 1, source: 's', status: null }
            ])
        };
        const s = makeServer({ explorer: { db }, broadcaster });
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };
        const filter = { ticks: new Set(['PEPE']) };

        await s._handleCatchUp(client, 0, filter, 'req-1');

        const replayed = client.ws.send.getCalls()
            .map((c) => JSON.parse(c.args[0]))
            .filter((m) => m.type === 'NEW_ACTION');
        expect(replayed).to.have.lengthOf(2);
        expect(replayed.map((m) => m.data.action_index)).to.deep.equal([1, 2]);
    });

    it('replays NEW_ACTION destinations, so a reconnecting client sees the live shape', async function () {
        // M1.4 parity guard. The rows come from the same getActionsSince the live
        // feed reads, so the destinations are already on them; a replay that
        // dropped the field would hand a reconnecting client a NARROWER frame than
        // the live channel sends, which is exactly the live-versus-replay
        // divergence the retired singular `destination` was removed to prevent.
        const broadcaster = makeBroadcaster();
        const db = {
            getMaxActionIndex: sinon.stub().resolves(2),
            getActionsSince: sinon.stub().resolves([
                { action_index: 1, action: 'SEND', tx_hash: 'a', block_index: 1, source: 's',
                  status: null, destinations: ['dest-one', 'dest-two'] },
                // A row with no recipients still carries the key as an empty array,
                // so a subscriber never has to tell "none" from "field missing".
                { action_index: 2, action: 'ISSUE', tx_hash: 'b', block_index: 1, source: 's',
                  status: null, destinations: [] }
            ])
        };
        const s = makeServer({ explorer: { db }, broadcaster });
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        await s._handleCatchUp(client, 0, {}, 'req-1');

        const replayed = client.ws.send.getCalls()
            .map((c) => JSON.parse(c.args[0]))
            .filter((m) => m.type === 'NEW_ACTION');
        expect(replayed).to.have.lengthOf(2);
        expect(replayed[0].data.destinations).to.deep.equal(['dest-one', 'dest-two']);
        expect(replayed[1].data.destinations).to.deep.equal([]);
        // The retired singular must stay gone on the replay path too.
        expect(replayed[0].data).to.not.have.property('destination');
    });

    it('replays destinations as [] when the producer omits the field entirely', async function () {
        const broadcaster = makeBroadcaster();
        const db = {
            getMaxActionIndex: sinon.stub().resolves(1),
            getActionsSince: sinon.stub().resolves([
                { action_index: 1, action: 'SEND', tx_hash: 'a', block_index: 1, source: 's', status: null }
            ])
        };
        const s = makeServer({ explorer: { db }, broadcaster });
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        await s._handleCatchUp(client, 0, {}, 'req-1');

        const replayed = client.ws.send.getCalls()
            .map((c) => JSON.parse(c.args[0]))
            .filter((m) => m.type === 'NEW_ACTION');
        expect(replayed[0].data.destinations).to.deep.equal([]);
    });

    it('applies fields projection to replayed events (parity with the live Broadcaster path)', async function () {
        const broadcaster = makeBroadcaster();
        const db = {
            getMaxActionIndex: sinon.stub().resolves(1),
            getActionsSince: sinon.stub().resolves([
                { action_index: 1, action: 'SEND', tx_hash: 'a', block_index: 1, source: 's', status: null }
            ])
        };
        const s = makeServer({ explorer: { db }, broadcaster });
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };
        const filter = { fields: ['action_index'] };

        await s._handleCatchUp(client, 0, filter, 'req-1');

        const replayed = client.ws.send.getCalls()
            .map((c) => JSON.parse(c.args[0]))
            .find((m) => m.type === 'NEW_ACTION');
        expect(replayed.data).to.deep.equal({ action_index: 1 });
    });
});

describe('WebSocketServer#_onMessage rate limiter (sliding decay, not tumbling window)', function () {

    afterEach(() => sinon.restore());

    // Client shaped like _onConnection builds, with the rate-limit fields.
    function makeRateClient() {
        return {
            ...makeClient('BTC'),
            lastActivity:  Date.now(),
            msgCount:      0,
            msgLastRefill: Date.now()
        };
    }

    // Feed one valid ping frame through _onMessage; returns true if it was
    // rate-limited (RATE_LIMITED error sent) and false if it went through.
    function sendPing(s, client) {
        const before = s._sendError.callCount;
        s._onMessage(client, Buffer.from(JSON.stringify({ action: 'ping' })));
        return s._sendError.callCount > before &&
               s._sendError.lastCall.args[1] === 'RATE_LIMITED';
    }

    function setup(maxMsgPerSec) {
        const clock = sinon.useFakeTimers({ now: 1000000, toFake: ['Date'] });
        const s = makeServer({ maxMsgPerSec });
        sinon.stub(s, '_send');
        sinon.spy(s, '_sendError');
        const client = makeRateClient();
        return { clock, s, client };
    }

    it('allows up to the limit and blocks the next message within the same second', function () {
        const { s, client } = setup(10);
        for (let i = 0; i < 10; i++) expect(sendPing(s, client)).to.equal(false);
        expect(sendPing(s, client)).to.equal(true);
    });

    it('a burst straddling the old 1s boundary cannot double the rate (tumbling-window exploit)', function () {
        const { clock, s, client } = setup(10);
        // Old exploit: 10 msgs at t=999ms, then 10 more at t=1001ms all passed
        // because the window reset. With decay, only ~0 credit refills in 2ms.
        clock.tick(999);
        for (let i = 0; i < 10; i++) expect(sendPing(s, client)).to.equal(false);
        clock.tick(2);
        expect(sendPing(s, client)).to.equal(true);
    });

    it('refills credit gradually in proportion to elapsed time', function () {
        const { clock, s, client } = setup(10);
        for (let i = 0; i < 10; i++) sendPing(s, client);
        expect(sendPing(s, client)).to.equal(true);   // saturated
        clock.tick(500);                               // refills 5 credits
        for (let i = 0; i < 4; i++) expect(sendPing(s, client)).to.equal(false);
        // 5th within the half-second exceeds the drained allowance again
        // (one credit was consumed by the rejected message above).
        expect(sendPing(s, client)).to.equal(true);
    });

    it('fully idle for >= 1s restores the full allowance and never goes negative', function () {
        const { clock, s, client } = setup(10);
        for (let i = 0; i < 10; i++) sendPing(s, client);
        clock.tick(60000); // long idle: count clamps at 0, not a huge negative credit
        for (let i = 0; i < 10; i++) expect(sendPing(s, client)).to.equal(false);
        expect(sendPing(s, client)).to.equal(true);
    });
});

// Drive a real upgrade and a real oversized frame, because the previous
// cap was installed as `ws._maxPayload` on the WebSocket, which reads fine to any
// property-asserting test while the ws Receiver (the only reader of maxPayload) ran
// on the 100 MB library default. Only the wire says whether the cap is armed.
describe('WebSocketServer maxPayload (ws-5: the cap has to reach the receiver)', function () {
    const http     = require('http');
    const WSClient = require('ws');

    let server, wsServer;

    function listen() {
        return new Promise((resolve) => {
            server   = http.createServer();
            wsServer = makeServer({ maxMessageSize: 1024 });
            wsServer.attach([server]);
            server.listen(0, '127.0.0.1', () => resolve(server.address().port));
        });
    }

    // Send one frame and report how the server answered.
    function sendFrame(port, payload) {
        return new Promise((resolve) => {
            const ws = new WSClient('ws://127.0.0.1:' + port + '/BTC/api/websocket');
            ws.on('open',  () => ws.send(payload));
            ws.on('error', () => resolve({ outcome: 'error' }));
            ws.on('close', (code) => resolve({ outcome: 'closed', code }));
            ws.on('message', (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'WELCOME') return;   // sent unprompted on connect
                ws.close();
                resolve({ outcome: 'reply', type: msg.type });
            });
        });
    }

    afterEach(function (done) {
        if (wsServer) wsServer.stop();
        if (server && server.listening) return server.close(() => done());
        done();
    });

    it('closes a >1024-byte frame with 1009 instead of parsing it', async function () {
        const port = await listen();
        const oversized = JSON.stringify({ action: 'ping', pad: 'a'.repeat(2000) });
        expect(oversized.length).to.be.greaterThan(1024);
        const res = await sendFrame(port, oversized);
        expect(res.outcome).to.equal('closed');
        expect(res.code).to.equal(1009);   // 1009 = message too big
    });

    it('still serves a normal under-cap frame', async function () {
        const port = await listen();
        const res = await sendFrame(port, JSON.stringify({ action: 'ping' }));
        expect(res.outcome).to.equal('reply');
        expect(res.type).to.equal('pong');
    });

    it('installs the configured size on the ws server options, where the receiver reads it', async function () {
        await listen();
        expect(wsServer.wss.options.maxPayload).to.equal(1024);
    });
});

describe('WS SNAPSHOT: every entity channel answers snapshot:true with a frame', function () {

    const ChannelManager  = require('../../../src/ws/ChannelManager.js');
    const WebSocketServer = require('../../../src/ws/WebSocketServer.js');

    afterEach(() => sinon.restore());

    // One subscription entry per entity channel, carrying whatever key
    // ChannelManager.subscribe puts on it (canonical decimal STRING for the
    // action_index-keyed pair).
    const ENTITY_SUB = {
        address:   { channel: 'address',   address: '1abc' },
        token:     { channel: 'token',     tick: 'XCP' },
        market:    { channel: 'market',    tick1: 'XCP', tick2: 'BTC' },
        dispenser: { channel: 'dispenser', action_index: '7' },
        bet_feed:  { channel: 'bet_feed',  action_index: '900' }
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

    it('bet_feed emits a SNAPSHOT carrying the market state, not silence', async function () {
        const s = serverWithEntityDb();
        const client = spyClient();

        await s._sendSnapshots(client, [ENTITY_SUB.bet_feed]);

        const frames = framesOf(client, 'SNAPSHOT');
        expect(frames).to.have.lengthOf(1);
        expect(frames[0].data.channel).to.equal('bet_feed');
        expect(frames[0].data.action_index).to.equal('900');
        expect(frames[0].data.feed_status).to.equal('open');
        expect(frames[0].data.pools).to.deep.equal([{ outcome: 0, total: '10' }]);
    });

    it('the bet_feed snapshot reads by index, not through the router-built config', async function () {
        // db.getBetFeed(config) resolves its WHERE out of config.data.sql, which the
        // HTTP router builds and _sendSnapshots (config = { coin }) does not have.
        const s = serverWithEntityDb();
        await s._sendSnapshots(spyClient(), [ENTITY_SUB.bet_feed]);

        const call = s.explorer.db.getBetFeedInfo.firstCall;
        expect(call.args[0]).to.deep.equal({ coin: 'BTC' });
        expect(call.args[1]).to.equal('900');
    });

    it('a bet_feed with no matching market still answers, rather than going silent', async function () {
        const s = serverWithEntityDb();
        s.explorer.db.getBetFeedInfo = sinon.stub().resolves(null);
        const client = spyClient();

        await s._sendSnapshots(client, [ENTITY_SUB.bet_feed]);

        const frames = framesOf(client, 'SNAPSHOT');
        expect(frames).to.have.lengthOf(1);
        expect(frames[0].data).to.deep.equal({ channel: 'bet_feed', action_index: '900' });
    });

    it('EVERY channel in ChannelManager.ENTITY_CHANNELS emits exactly one SNAPSHOT', async function () {
        // The invariant, not the instance: a future entity channel added without a
        // _sendSnapshots case fails here instead of shipping a silent no-op.
        for (const channel of ChannelManager.ENTITY_CHANNELS) {
            const sub = ENTITY_SUB[channel];
            expect(sub, 'no fixture for entity channel ' + channel + '; add one').to.be.an('object');

            const s = serverWithEntityDb();
            const client = spyClient();
            await s._sendSnapshots(client, [sub]);

            const frames = framesOf(client, 'SNAPSHOT');
            expect(frames.length, channel + ' sent no SNAPSHOT for snapshot:true').to.equal(1);
            expect(frames[0].data.channel).to.equal(channel);
        }
    });

    it("the blocks SNAPSHOT carries the live NEW_BLOCK tip key as well as WELCOME's", async function () {
        // Broadcaster._onBlock names the tip block_index; the snapshot named it only
        // latest_block_index, so a subscriber seeding from the snapshot read undefined
        // off its first live frame. Same value, same decimal-string type, both keys.
        const s = serverWithEntityDb();
        const client = spyClient();

        await s._sendSnapshots(client, [{ channel: 'blocks' }]);

        const data = framesOf(client, 'SNAPSHOT')[0].data;
        expect(data.latest_block_index).to.equal('880123');
        expect(data.block_index).to.equal('880123');
        expect(data.block_index).to.equal(data.latest_block_index);
    });
});
