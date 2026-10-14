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
 * WS-04 and WS-06: nothing the connection path hands out may come from a coin
 * whose first poll has not recorded a live mark, and WELCOME's
 * latest_action_index is that mark, not the DB tip. A catch-up or WELCOME on an
 * unseeded coin seeds it first, so a replay is bounded by the mark the live
 * feed starts above: no row is skipped between them and none is sent twice.
 *
 ********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const { chainDb, feed, connect, frames, actionIndexes, range, subscribe, settle } = require('./support/chain.js');

describe('WS-04: a catch-up on an unseeded coin', function () {
    afterEach(() => sinon.restore());

    it('seeds the coin and replays up to the seed, so rows committed after it arrive live', async function () {
        const db = chainDb();
        db.commit(3, 5);                                // 15 rows; the poll loop has not reached BTC
        const { s, detector } = feed(db);
        const client = connect(s, 1);
        subscribe(s, client, ['actions'], { since_action_index: '10' }, 'c');
        await settle();
        db.commit(1, 4);                                // 16..19, before the poll loop's first pass
        await detector.checkCoin('BTC');
        await detector.checkCoin('BTC');

        expect(actionIndexes(client)).to.deep.equal(range(11, 19));
    });

    it('does not replay rows the stalled first poll then sends live', async function () {
        const db = chainDb();
        db.commit(3, 5);
        const { s, detector } = feed(db);
        let release;
        db.hooks.afterMaxAction = () => new Promise((r) => { release = r; });
        const firstPoll = detector.checkCoin('BTC');   // read the tip (15), not yet seeded
        await settle();
        db.commit(1, 4);                                // 16..19 above the tip that poll read
        const client = connect(s, 1);
        subscribe(s, client, ['actions'], { since_action_index: '10' }, 'c');
        await settle();
        release();
        await firstPoll;
        await detector.checkCoin('BTC');

        expect(actionIndexes(client)).to.deep.equal(range(11, 19));
    });

    it('refuses with the retryable CATCH_UP_NOT_READY when the coin cannot be seeded', async function () {
        const db = chainDb();
        db.commit(3, 5);
        db.getMaxBlockIndex = async () => { throw new Error('db down'); };
        const { s } = feed(db);
        const client = connect(s, 1);
        subscribe(s, client, ['actions'], { since_action_index: '10' }, 'c');
        await settle();

        const errors = frames(client, 'error');
        expect(errors.map((m) => [m.id, m.data.code])).to.deep.equal([['c', 'CATCH_UP_NOT_READY']]);
        expect(frames(client, 'NEW_ACTION')).to.have.lengthOf(0);
    });
});

describe('WS-06: WELCOME hands out the live mark', function () {
    afterEach(() => sinon.restore());

    it('reports the detector mark, not a DB tip the feed has not sent yet', async function () {
        const db = chainDb();
        db.commit(2, 3);
        const { s, detector } = feed(db);
        await detector.checkCoin('BTC');                // mark 6
        db.commit(1, 5);                                // DB tip 11, not polled
        const client = connect(s, 1);
        await s.sendWelcome(client);

        expect(frames(client, 'WELCOME')[0].data.latest_action_index).to.equal('6');
    });

    it('seeds an unseeded coin before answering, and reports the seed', async function () {
        const db = chainDb();
        db.commit(3, 5);
        const { s, detector } = feed(db);
        const client = connect(s, 1);
        await s.sendWelcome(client);

        expect(detector.state.BTC.initialized).to.equal(true);
        expect(frames(client, 'WELCOME')[0].data.latest_action_index).to.equal('15');
        db.commit(1, 2);
        subscribe(s, client, ['actions']);
        await detector.checkCoin('BTC');
        expect(actionIndexes(client)).to.deep.equal(range(16, 17));
    });

    it('falls back to the DB tip on a server without a live detector', async function () {
        const db = chainDb();
        db.commit(3, 5);
        const { s } = feed(db);
        s.broadcaster = null;
        const client = connect(s, 1);
        await s.sendWelcome(client);

        expect(frames(client, 'WELCOME')[0].data.latest_action_index).to.equal('15');
    });
});
