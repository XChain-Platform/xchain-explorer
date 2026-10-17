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
 * WS-07: the catch-up replay honours the live feed's backpressure cap. Over the
 * cap at a row's start it waits for the socket to drain, so what the server
 * buffers stays bounded to about one row and a slow link still gets every
 * row; a socket that never drains is shed with 4008 at a row boundary once
 * the drain window passes, with no CATCH_UP_COMPLETE. WS-08: NEW_BLOCK frames are not replayed, and a catch-up
 * whose request names the blocks channel says so in not_replayed.
 *
 ********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const { chainDb, feed, connect, frames, actionIndexes, subscribe, settle } = require('./support/chain.js');

async function seeded(options) {
    const db = chainDb();
    db.commit(10, 10);
    const { s, detector } = feed(db, options);
    await detector.checkCoin('BTC');
    return { db, s, detector };
}

describe('WS-07: the replay applies backpressure', function () {
    afterEach(() => sinon.restore());

    it('waits for a slow socket to drain, keeping buffering to about one row, and replays every row', async function () {
        const { s } = await seeded();
        const client = connect(s, 1);
        // A slow link: each frame stays buffered, and 2 KB leaves the buffer every 5 ms.
        let peak = 0, rowBytes = 0;
        client.ws.send = sinon.spy((data) => {
            client.ws.bufferedAmount += data.length;
            rowBytes = Math.max(rowBytes, data.length);
            peak = Math.max(peak, client.ws.bufferedAmount);
        });
        const drain = setInterval(() => { client.ws.bufferedAmount = Math.max(0, client.ws.bufferedAmount - 2048); }, 5);
        subscribe(s, client, ['actions'], { since_action_index: '50' }, 'c');
        while (!frames(client, 'CATCH_UP_COMPLETE').length && !client.ws.close.called) await new Promise((r) => setTimeout(r, 10));
        clearInterval(drain);

        expect(actionIndexes(client)).to.have.lengthOf(50);
        expect(client.ws.close.called).to.equal(false);
        expect(frames(client, 'CATCH_UP_COMPLETE')).to.have.lengthOf(1);
        // Never more than the cap plus the one row admitted below it.
        expect(peak).to.be.at.most(s.broadcaster.maxBackpressure + rowBytes);
        expect(peak).to.be.greaterThan(s.broadcaster.maxBackpressure);
    });

    it('sheds a socket that never drains once the drain window passes, at a row boundary, with no COMPLETE', async function () {
        const { s } = await seeded({ catchUpDrainMs: 60 });
        const client = connect(s, 1);
        // Nothing drains: every frame stays buffered, as on a client that stopped reading.
        let rowBytes = 0;
        client.ws.send = sinon.spy((data) => { client.ws.bufferedAmount += data.length; rowBytes = Math.max(rowBytes, data.length); });
        subscribe(s, client, ['actions'], { since_action_index: '50' }, 'c');
        await settle();
        expect(client.ws.close.called).to.equal(false);
        // Poll for the shed rather than sleeping past the 60 ms window (bounded so a missed shed fails, not hangs).
        const shedBy = Date.now() + 2000;
        while (!client.ws.close.called && Date.now() < shedBy) await new Promise((r) => setTimeout(r, 10));

        const got = actionIndexes(client);
        expect(client.ws.close.calledWith(4008, 'backpressure')).to.equal(true);
        expect(got.length).to.be.greaterThan(0);
        expect(got.length).to.be.lessThan(50);
        expect(client.ws.bufferedAmount).to.be.at.most(s.broadcaster.maxBackpressure + rowBytes);
        expect(frames(client, 'CATCH_UP_COMPLETE')).to.have.lengthOf(0);
    });

    it('replays in full to a client that keeps up', async function () {
        const { s } = await seeded();
        const client = connect(s, 1);
        subscribe(s, client, ['actions'], { since_action_index: '50' }, 'c');
        await settle();

        expect(actionIndexes(client)).to.have.lengthOf(50);
        expect(client.ws.close.called).to.equal(false);
        expect(frames(client, 'CATCH_UP_COMPLETE')).to.have.lengthOf(1);
    });
});

describe('WS-08: NEW_BLOCK is named as not replayed', function () {
    afterEach(() => sinon.restore());

    it('lists NEW_BLOCK in not_replayed when the catch-up request names blocks', async function () {
        const { s } = await seeded();
        const client = connect(s, 1);
        subscribe(s, client, ['actions', 'blocks'], { since_action_index: '95' }, 'c');
        await settle();

        const complete = frames(client, 'CATCH_UP_COMPLETE');
        expect(complete).to.have.lengthOf(1);
        expect(complete[0].data.not_replayed).to.include('NEW_BLOCK');
        expect(frames(client, 'NEW_BLOCK')).to.have.lengthOf(0);
    });

    it('leaves NEW_BLOCK out when the request does not name blocks', async function () {
        const { s } = await seeded();
        const client = connect(s, 1);
        subscribe(s, client, ['actions'], { since_action_index: '95' }, 'c');
        await settle();

        expect(frames(client, 'CATCH_UP_COMPLETE')[0].data.not_replayed).to.not.include('NEW_BLOCK');
    });
});
