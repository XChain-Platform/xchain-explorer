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
 * WS-03 (server side): the message bucket takes one full resubscribe at once
 * (its burst allowance, maxSubscriptions + 2, drained at the sustained rate),
 * and a RATE_LIMITED refusal past it carries the dropped request's id, so a
 * client knows which subscribe to send again. WS-10: an unsubscribe
 * naming an unknown channel, or an entity channel whose params name no
 * entity, is answered with an error frame, and an address that is not a
 * non-empty string is refused rather than keyed by its string form.
 *
 ********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const { chainDb, feed, connect, frames, settle } = require('./support/chain.js');

function server() {
    const db = chainDb();
    db.commit(1, 1);
    return feed(db).s;
}

const send = (s, client, msg) => s.onMessage(client, Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)));
const codes = (client) => frames(client, 'error').map((m) => [m.id === undefined ? null : m.id, m.data.code]);

describe('WS-03: RATE_LIMITED names the request it dropped', function () {
    afterEach(() => sinon.restore());

    // Burst: maxSubscriptions (25) + 2 = 27 messages at once, so the 28th on is refused.
    it('echoes the id of every subscribe refused past the burst allowance', async function () {
        const s = server();
        const client = connect(s, 1);
        for (let i = 0; i < 30; i++) send(s, client, { action: 'subscribe', channels: ['token'], params: { tick: 'T' + i }, id: 'r' + i });
        await settle();

        const limited = frames(client, 'error').filter((m) => m.data.code === 'RATE_LIMITED');
        expect(limited.map((m) => m.id)).to.deep.equal(['r27', 'r28', 'r29']);
    });

    it('takes a full resubscribe at once: every subscription plus a catch-up and a ping', async function () {
        const s = server();
        const client = connect(s, 1);
        for (let i = 0; i < 25; i++) send(s, client, { action: 'subscribe', channels: ['token'], params: { tick: 'T' + i }, id: 'r' + i });
        send(s, client, { action: 'ping' });
        send(s, client, { action: 'ping' });
        await settle();

        expect(codes(client)).to.deep.equal([]);
        expect(s.messageBurst()).to.equal(27);
    });

    it('still refuses an over-burst frame that is not JSON, with no id', async function () {
        const s = server();
        const client = connect(s, 1);
        for (let i = 0; i < 27; i++) send(s, client, { action: 'ping' });
        send(s, client, '{');
        await settle();

        expect(codes(client)).to.deep.equal([[null, 'RATE_LIMITED']]);
    });
});

describe('WS-10: unsubscribe and address params are answered', function () {
    afterEach(() => sinon.restore());

    it('answers an unsubscribe of an unknown channel with INVALID_CHANNEL and the request id', async function () {
        const s = server();
        const client = connect(s, 1);
        send(s, client, { action: 'unsubscribe', channels: ['nope'], id: 'u1' });
        send(s, client, { action: 'unsubscribe', channels: [null], id: 'u2' });
        await settle();

        expect(codes(client)).to.deep.equal([['u1', 'INVALID_CHANNEL'], ['u2', 'INVALID_CHANNEL']]);
    });

    it('still honours the valid channels of a mixed unsubscribe', async function () {
        const s = server();
        const client = connect(s, 1);
        send(s, client, { action: 'subscribe', channels: ['actions'], id: 's1' });
        send(s, client, { action: 'unsubscribe', channels: ['actions', 'nope'], id: 'u1' });
        await settle();

        expect(frames(client, 'UNSUBSCRIBED').map((m) => [m.data.channel, m.data.was_subscribed])).to.deep.equal([['actions', true]]);
        expect(codes(client)).to.deep.equal([['u1', 'INVALID_CHANNEL']]);
    });

    it('answers an entity unsubscribe whose params name no entity', async function () {
        const s = server();
        const client = connect(s, 1);
        send(s, client, { action: 'unsubscribe', channels: ['address'], params: {}, id: 'u3' });
        await settle();

        expect(codes(client)).to.deep.equal([['u3', 'INVALID_CHANNEL']]);
    });

    it('refuses a non-string address and an addresses list holding one', async function () {
        const s = server();
        const client = connect(s, 1);
        send(s, client, { action: 'subscribe', channels: ['address'], params: { address: { x: 1 } }, id: 'a1' });
        send(s, client, { action: 'subscribe', channels: ['address'], params: { addresses: ['bc1q', 5] }, id: 'a2' });
        await settle();

        expect(codes(client)).to.deep.equal([['a1', 'INVALID_CHANNEL'], ['a2', 'INVALID_CHANNEL']]);
        expect(frames(client, 'SUBSCRIBED')).to.have.lengthOf(0);
        expect([...client.subscriptions]).to.deep.equal([]);
    });
});
