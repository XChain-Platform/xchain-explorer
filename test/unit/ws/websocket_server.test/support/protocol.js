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

const { expect, sinon, makeServer, makeClient } = require('../../websocket_server.test.js');

// Every BigInt-backed index on a v2 frame is a decimal string
// (ws/schema_version.js). WELCOME and the SNAPSHOT frames read theirs from
// db.getMax*Index, which return Number, so these cases prove those frames
// convert too. Without it one connection would see latest_action_index as a
// number in WELCOME and as a string in CATCH_UP_COMPLETE and NEW_ACTION, and
// any value above 2^53 would be truncated.
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

function makeBroadcaster() {
    // Real filter/projection logic borrowed from ws/broadcaster.js so the test
    // exercises the actual shared pipeline, not a stand-in.
    const { EventEmitter } = require('events');
    const Broadcaster = require('../../../../../src/ws/broadcaster.js');
    return new Broadcaster({ wsServer: null, changeDetector: new EventEmitter() });
}

describe('WebSocketServer#_sendWelcome (ws-3: types self-description conformance)', function () {

    afterEach(() => sinon.restore());

    it('advertises exactly the set of types ChannelManager.VALID_TYPES accepts', async function () {
        const ChannelManager = require('../../../../../src/ws/channel_manager.js');
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        await s.sendWelcome(client);

        expect(client.ws.send.callCount).to.equal(1);
        const welcome = JSON.parse(client.ws.send.firstCall.args[0]);
        expect(welcome.type).to.equal('WELCOME');
        // Set-equality: no extras, no omissions (this is the regression guard --
        // a WELCOME types list that under-advertises the ten lifecycle
        // event types, e.g. ORDER_COMPLETED, DISPENSER_CANCELLED, fails here).
        expect(new Set(welcome.data.types)).to.deep.equal(ChannelManager.VALID_TYPES);
    });

    it('does NOT advertise a "statuses" feature (actions feed cannot honor it)', async function () {
        // Honesty contract (api-contracts finding): the block-derived actions
        // feed never populates a per-action status, so a statuses filter on the
        // actions channel is a silent no-op. WELCOME must not list it.
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        await s.sendWelcome(client);

        const welcome = JSON.parse(client.ws.send.firstCall.args[0]);
        expect(welcome.data.features).to.not.include('statuses');
    });

    it('does NOT advertise a "ticks" feature (no action frame carries a tick)', async function () {
        // Same honesty contract as statuses: getActionsSince selects no tick column,
        // so the ticks check in Broadcaster.passesFilter can never reject anything.
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        await s.sendWelcome(client);

        const welcome = JSON.parse(client.ws.send.firstCall.args[0]);
        expect(welcome.data.features).to.not.include('ticks');
        expect(welcome.data.features).to.include('fields');
    });

    it('advertises exactly the set of channels ChannelManager.VALID_CHANNELS accepts', async function () {
        // api-contracts finding: the `channels` list was a hardcoded literal that
        // could silently drift from what ChannelManager actually validates
        // (unlike `types`, which is already derived). Set-equality regression guard.
        const ChannelManager = require('../../../../../src/ws/channel_manager.js');
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        await s.sendWelcome(client);

        const welcome = JSON.parse(client.ws.send.firstCall.args[0]);
        expect(new Set(welcome.data.channels)).to.deep.equal(ChannelManager.VALID_CHANNELS);
    });
});

describe('WS schema v2 conformance: chain indices are decimal strings', function () {
    afterEach(() => sinon.restore());

    it('WELCOME emits latest_block_index / latest_action_index as decimal strings', async function () {
        const s = serverWithIndices(880123, 4567890);
        const client = spyClient();

        await s.sendWelcome(client);

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

        await s.sendWelcome(client);

        const welcome = framesOf(client, 'WELCOME')[0];
        expect(welcome.data.latest_block_index).to.equal('9007199254740993');
        expect(welcome.data.latest_action_index).to.equal('9007199254740995');
    });

    it('WELCOME still sends string zeros when the db read fails', async function () {
        const s = makeServer({ explorer: { db: { getMaxBlockIndex: sinon.stub().rejects(new Error('db down')) } } });
        const client = spyClient();

        await s.sendWelcome(client);

        const welcome = framesOf(client, 'WELCOME')[0];
        expect(welcome.data.latest_block_index).to.equal('0');
        expect(welcome.data.latest_action_index).to.equal('0');
    });

    it('SNAPSHOT frames emit their indices as decimal strings on every channel that carries one', async function () {
        const s = serverWithIndices(880123, 4567890);
        const client = spyClient();

        await s.sendSnapshots(client, [
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
});

describe('WS schema v2 conformance: chain indices are decimal strings', function () {
    afterEach(() => sinon.restore());

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
        const Broadcaster = require('../../../../../src/ws/broadcaster.js');
        const s = makeServer({ explorer: { db }, broadcaster: new Broadcaster({ wsServer: null, changeDetector: new EventEmitter() }) });
        const client = spyClient();

        await s.sendWelcome(client);
        await s.handleCatchUp(client, 4567000, {}, 'req-1');

        const welcome  = framesOf(client, 'WELCOME')[0];
        const complete = framesOf(client, 'CATCH_UP_COMPLETE')[0];
        expect(typeof complete.data.latest_action_index).to.equal(typeof welcome.data.latest_action_index);
        expect(complete.data.latest_action_index).to.match(DECIMAL);
    });

    // A catch-up cursor that is Number()-coerced on arrival rounds
    // an above-2^53 decimal string UP. The SQL cursor then asks for rows after an
    // action the client has never seen, and the CATCH_UP_COMPLETE echo tells the client
    // it is one index further along than it is.
    it('catch-up keeps an above-2^53 since_action_index exact at the cursor and the echo', async function () {
        const db = {
            getMaxBlockIndex:  sinon.stub().resolves(9007199254740999n),
            getMaxActionIndex: sinon.stub().resolves(9007199254740999n),
            getActionsSince:   sinon.stub().resolves([])
        };
        const { EventEmitter } = require('events');
        const Broadcaster = require('../../../../../src/ws/broadcaster.js');
        const s = makeServer({ explorer: { db }, broadcaster: new Broadcaster({ wsServer: null, changeDetector: new EventEmitter() }) });
        const client = spyClient();

        await s.handleCatchUp(client, '9007199254740995', {}, 'req-1');

        const cursor = db.getActionsSince.firstCall.args[1];
        expect(String(cursor)).to.equal('9007199254740995');
        expect(typeof cursor).to.not.equal('number');

        const complete = framesOf(client, 'CATCH_UP_COMPLETE')[0];
        expect(complete.data.latest_action_index).to.equal('9007199254740995');
    });
});

describe('WS schema v2 conformance: chain indices are decimal strings', function () {
    afterEach(() => sinon.restore());

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
        const Broadcaster = require('../../../../../src/ws/broadcaster.js');
        const s = makeServer({ explorer: { db }, broadcaster: new Broadcaster({ wsServer: null, changeDetector: new EventEmitter() }), catchUpMaxDepth: 3 });
        const client = spyClient();

        await s.handleCatchUp(client, '9007199254740995', {}, 'req-2');

        const errors = framesOf(client, 'error');
        expect(errors).to.have.lengthOf(1);
        expect(errors[0].data.code).to.equal('CATCH_UP_TOO_OLD');
        expect(errors[0].data.message).to.include('9007199254740995');
        expect(db.getActionsSince.called).to.equal(false);
    });
});

describe('WebSocketServer#_handleCatchUp (ws-4: catch-up/live filter parity)', function () {
    afterEach(() => sinon.restore());

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

        await s.handleCatchUp(client, 0, filter, 'req-1');

        const replayed = client.ws.send.getCalls()
            .map((c) => JSON.parse(c.args[0]))
            .filter((m) => m.type === 'NEW_ACTION');
        expect(replayed).to.have.lengthOf(2);
        expect(replayed.map((m) => m.data.action_index)).to.deep.equal([1, 2]);
    });
});

describe('WebSocketServer#_handleCatchUp (ws-4: catch-up/live filter parity)', function () {
    afterEach(() => sinon.restore());

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

        await s.handleCatchUp(client, 0, {}, 'req-1');

        const replayed = client.ws.send.getCalls()
            .map((c) => JSON.parse(c.args[0]))
            .filter((m) => m.type === 'NEW_ACTION');
        expect(replayed).to.have.lengthOf(2);
        expect(replayed[0].data.destinations).to.deep.equal(['dest-one', 'dest-two']);
        expect(replayed[1].data.destinations).to.deep.equal([]);
        // The retired singular must stay gone on the replay path too.
        expect(replayed[0].data).to.not.have.property('destination');
    });
});

describe('WebSocketServer#_handleCatchUp (ws-4: catch-up/live filter parity)', function () {
    afterEach(() => sinon.restore());

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

        await s.handleCatchUp(client, 0, {}, 'req-1');

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

        await s.handleCatchUp(client, 0, filter, 'req-1');

        const replayed = client.ws.send.getCalls()
            .map((c) => JSON.parse(c.args[0]))
            .find((m) => m.type === 'NEW_ACTION');
        expect(replayed.data).to.deep.equal({ action_index: 1 });
    });
});
