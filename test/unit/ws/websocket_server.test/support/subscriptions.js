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

const { expect, sinon, makeServer, makeReq, makeClient } = require('../../websocket_server.test.js');

async function tick() { await new Promise((r) => setImmediate(r)); }

describe('WebSocketServer#_clientIp (ws-1: XFF spoof)', function () {

    it('ignores X-Forwarded-For entirely with 0 trusted hops (uses TCP peer)', function () {
        const s = makeServer({ trustProxyHops: 0 });
        const ip = s.clientIp(makeReq({ 'x-forwarded-for': 'attacker-spoof' }, '198.51.100.7'));
        expect(ip).to.equal('198.51.100.7');
    });

    it('never keys on the leftmost (client-supplied) XFF token', function () {
        const s = makeServer({ trustProxyHops: 1 });
        // Real proxy APPENDS the observed peer to the right; the leftmost is spoofed.
        const ip = s.clientIp(makeReq({ 'x-forwarded-for': 'spoof-uuid-1, 198.51.100.7' }));
        expect(ip).to.equal('198.51.100.7');
        expect(ip).to.not.equal('spoof-uuid-1');
    });

    it('a unique spoofed leftmost token per request resolves to the SAME real IP', function () {
        const s = makeServer({ trustProxyHops: 1 });
        const a = s.clientIp(makeReq({ 'x-forwarded-for': 'uuid-a, 198.51.100.7' }));
        const b = s.clientIp(makeReq({ 'x-forwarded-for': 'uuid-b, 198.51.100.7' }));
        // The bypass was that these keyed to different buckets; now they collapse.
        expect(a).to.equal(b);
    });

    it('falls back to the TCP peer when XFF is absent', function () {
        const s = makeServer({ trustProxyHops: 1 });
        expect(s.clientIp(makeReq({}, '203.0.113.42'))).to.equal('203.0.113.42');
    });

    it('takes the Nth-from-right entry for trustProxyHops=2', function () {
        const s = makeServer({ trustProxyHops: 2 });
        const ip = s.clientIp(makeReq({ 'x-forwarded-for': 'spoof, 198.51.100.7, 10.0.0.1' }));
        expect(ip).to.equal('198.51.100.7');
    });
});

describe('WebSocketServer#_handleSubscribe (ws-2: snapshot amplification)', function () {
    afterEach(() => sinon.restore());

    it('snapshots only NEWLY-subscribed entities, not a re-subscribe of the same set', async function () {
        const s = makeServer();
        const snap = sinon.stub(s, 'sendSnapshots').resolves();
        const client = makeClient('BTC');
        const msg = { channels: ['address'], params: { snapshot: true, addresses: ['addr1', 'addr2'] } };

        s.handleSubscribe(client, msg);
        expect(snap.callCount).to.equal(1);
        expect(snap.firstCall.args[1]).to.have.lengthOf(2); // both fresh
        await tick(); // let the in-progress guard clear

        // Re-send the identical batch: every entity is already subscribed, so there is
        // nothing fresh to snapshot -> sendSnapshots must NOT run again.
        s.handleSubscribe(client, { ...msg });
        expect(snap.callCount).to.equal(1);
        await tick();

        // Adding one NEW address snapshots only that one.
        s.handleSubscribe(client, { channels: ['address'], params: { snapshot: true, addresses: ['addr1', 'addr3'] } });
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

        s.handleSubscribe(client, { channels: ['actions'], params: { statuses: ['valid'] } });

        const subscribed = client.ws.send.getCalls()
            .map((c) => JSON.parse(c.args[0]))
            .find((m) => m.type === 'SUBSCRIBED');
        expect(subscribed, 'a SUBSCRIBED frame was sent').to.exist;
        expect(subscribed.data.active_filters).to.not.have.property('statuses');
    });
});

describe('WebSocketServer#_handleSubscribe (ws-2: snapshot amplification)', function () {
    afterEach(() => sinon.restore());

    it('SUBSCRIBED echoes ignored_filters: ["statuses"] when a raw client sends one', function () {
        // The `statuses` filter is still accepted (non-breaking) but is a no-op on
        // every event this server produces, so the confirmation must make that
        // no-op observable instead of silently dropping the client's request.
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        s.handleSubscribe(client, { channels: ['actions'], params: { statuses: ['valid'] } });

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

        s.handleSubscribe(client, { channels: ['actions'], params: { ticks: ['PEPE'] } });

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

        s.handleSubscribe(client, { channels: ['actions'], params: { types: ['SEND'] } });

        const subscribed = client.ws.send.getCalls()
            .map((c) => JSON.parse(c.args[0]))
            .find((m) => m.type === 'SUBSCRIBED');
        expect(subscribed, 'a SUBSCRIBED frame was sent').to.exist;
        expect(subscribed.data).to.not.have.property('ignored_filters');
    });
});

describe('WebSocketServer#_handleSubscribe (ws-2: snapshot amplification)', function () {
    afterEach(() => sinon.restore());

    it('does not start a second snapshot fan-out while one is in progress', async function () {
        const s = makeServer();
        // A snapshot that never resolves within the test keeps the guard set.
        const snap = sinon.stub(s, 'sendSnapshots').returns(new Promise(() => {}));
        const client = makeClient('BTC');

        s.handleSubscribe(client, { channels: ['address'], params: { snapshot: true, addresses: ['a'] } });
        expect(snap.callCount).to.equal(1);
        expect(client.snapshotInProgress).to.equal(true);

        // New entity, but a fan-out is still running -> deferred, not concurrent.
        s.handleSubscribe(client, { channels: ['address'], params: { snapshot: true, addresses: ['b'] } });
        expect(snap.callCount).to.equal(1);
        expect(client.pendingSnapshots.map((x) => x.address)).to.deep.equal(['b']);
    });

    // D-E063: the second subscribe was subscribed by ChannelManager, skipped by the
    // in-progress guard, and then excluded from every later fresh filter, so its
    // SNAPSHOT never arrived and nothing told the client.
    it('delivers the SNAPSHOT of a subscribe that arrived mid fan-out (D-E063)', async function () {
        const s = makeServer();
        let releaseFirst;
        const snap = sinon.stub(s, 'sendSnapshots');
        snap.onFirstCall().returns(new Promise((r) => { releaseFirst = r; }));
        snap.onSecondCall().resolves();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: () => {} } };

        s.handleSubscribe(client, { channels: ['address'], params: { snapshot: true, addresses: ['a'] } });
        s.handleSubscribe(client, { channels: ['address'], params: { snapshot: true, addresses: ['b'] } });
        expect(snap.callCount, 'second fan-out must not run concurrently').to.equal(1);

        releaseFirst();
        await tick();

        expect(snap.callCount, 'the deferred entity was never snapshotted').to.equal(2);
        expect(snap.secondCall.args[1].map((x) => x.address)).to.deep.equal(['b']);
        expect(client.pendingSnapshots).to.have.lengthOf(0);
        expect(client.snapshotInProgress).to.equal(false);
    });
});

describe('WebSocketServer#_handleSubscribe (ws-2: snapshot amplification)', function () {
    afterEach(() => sinon.restore());

    it('drains several deferred subscribes in ONE follow-up fan-out, deduped', async function () {
        const s = makeServer();
        let releaseFirst;
        const snap = sinon.stub(s, 'sendSnapshots');
        snap.onFirstCall().returns(new Promise((r) => { releaseFirst = r; }));
        snap.onSecondCall().resolves();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: () => {} } };

        s.handleSubscribe(client, { channels: ['address'], params: { snapshot: true, addresses: ['a'] } });
        s.handleSubscribe(client, { channels: ['address'], params: { snapshot: true, addresses: ['b'] } });
        // 'b' is already subscribed by now, so only 'c' is fresh here.
        s.handleSubscribe(client, { channels: ['address'], params: { snapshot: true, addresses: ['b', 'c'] } });

        releaseFirst();
        await tick();

        expect(snap.callCount).to.equal(2);
        expect(snap.secondCall.args[1].map((x) => x.address)).to.deep.equal(['b', 'c']);
    });

    it('answers an overflowing snapshot queue with an explicit refusal frame', function () {
        // The queue cap is the per-client subscription limit, so dedupe normally
        // keeps it out of reach; drive the deferral helper directly to pin the
        // overflow branch, which must refuse loudly rather than drop silently.
        const s = makeServer({ maxSubscriptions: 2 });
        const sent = [];
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: (d) => sent.push(JSON.parse(d)) } };
        const subs = ['b', 'c', 'd'].map((address) => ({ channel: 'address', address }));

        s.queueSnapshots(client, subs, 7);

        const err = sent.find((m) => m.data && m.data.code === 'SNAPSHOT_QUEUE_FULL');
        expect(err, 'the client must be told, not silently dropped').to.exist;
        expect(err.id).to.equal(7);
        // Everything that fit is still queued for delivery.
        expect(client.pendingSnapshots.map((x) => x.address)).to.deep.equal(['b', 'c']);
    });

    it('drops the deferred queue instead of fanning out to a closed socket', async function () {
        const s = makeServer();
        let releaseFirst;
        const snap = sinon.stub(s, 'sendSnapshots');
        snap.onFirstCall().returns(new Promise((r) => { releaseFirst = r; }));
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: () => {} } };

        s.handleSubscribe(client, { channels: ['address'], params: { snapshot: true, addresses: ['a'] } });
        s.handleSubscribe(client, { channels: ['address'], params: { snapshot: true, addresses: ['b'] } });

        client.ws.readyState = 3; // CLOSED
        releaseFirst();
        await tick();

        expect(snap.callCount).to.equal(1);
        expect(client.pendingSnapshots).to.have.lengthOf(0);
    });
});

describe('WebSocketServer#_handleUnsubscribe (client cannot tell honoured from dropped)', function () {


    it('sends an UNSUBSCRIBED frame naming a global channel that was subscribed', function () {
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        s.handleSubscribe(client, { channels: ['blocks'] });
        client.ws.send.resetHistory();
        s.handleUnsubscribe(client, { channels: ['blocks'] });

        const frames = client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]));
        const unsub = frames.find((m) => m.type === 'UNSUBSCRIBED');
        expect(unsub, 'an UNSUBSCRIBED frame was sent').to.exist;
        expect(unsub.data.channel).to.equal('blocks');
        expect(unsub.data.was_subscribed).to.equal(true);
    });

    it('sends an UNSUBSCRIBED frame naming an entity channel with its entity identifier', function () {
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        s.handleSubscribe(client, { channels: ['address'], params: { address: '1abc' } });
        client.ws.send.resetHistory();
        s.handleUnsubscribe(client, { channels: ['address'], params: { address: '1abc' } });

        const frames = client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]));
        const unsub = frames.find((m) => m.type === 'UNSUBSCRIBED');
        expect(unsub, 'an UNSUBSCRIBED frame was sent').to.exist;
        expect(unsub.data.channel).to.equal('address');
        expect(unsub.data.address).to.equal('1abc');
        expect(unsub.data.was_subscribed).to.equal(true);
    });

    it('still answers with was_subscribed:false for a channel the client never held', function () {
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        s.handleUnsubscribe(client, { channels: ['blocks'] });

        const frames = client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]));
        const unsub = frames.find((m) => m.type === 'UNSUBSCRIBED');
        expect(unsub, 'an UNSUBSCRIBED frame was sent even for a no-op unsubscribe').to.exist;
        expect(unsub.data.was_subscribed).to.equal(false);
    });
});

describe('WebSocketServer#_handleUnsubscribe (client cannot tell honoured from dropped)', function () {


    it('echoes the request id on the UNSUBSCRIBED frame when the client sent one', function () {
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        s.handleSubscribe(client, { channels: ['blocks'] });
        client.ws.send.resetHistory();
        s.handleUnsubscribe(client, { channels: ['blocks'], id: 'req-7' });

        const frames = client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]));
        const unsub = frames.find((m) => m.type === 'UNSUBSCRIBED');
        expect(unsub.id).to.equal('req-7');
    });

    it('sends one UNSUBSCRIBED frame per channel in a multi-channel batch', function () {
        const s = makeServer();
        const client = { ...makeClient('BTC'), ws: { readyState: 1, send: sinon.spy() } };

        s.handleSubscribe(client, { channels: ['blocks', 'actions'] });
        client.ws.send.resetHistory();
        s.handleUnsubscribe(client, { channels: ['blocks', 'actions'] });

        const frames = client.ws.send.getCalls().map((c) => JSON.parse(c.args[0]))
            .filter((m) => m.type === 'UNSUBSCRIBED');
        expect(frames).to.have.lengthOf(2);
        expect(frames.map((f) => f.data.channel).sort()).to.deep.equal(['actions', 'blocks']);
    });
});
