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
});
