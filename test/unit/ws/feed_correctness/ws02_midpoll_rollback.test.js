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
 * WS-02: a rollback that lands inside one poll, between the tip read and the
 * fetch, must not leave a permanent gap. The cursor stops at the last row
 * fetched, so the replacement rows the indexer commits at the freed indexes
 * are read on the next poll, and a block the poll announced and the rollback
 * replaced is found by the next poll's fork search and announced again.
 *
 ********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const { chainDb, feed, connect, frames, actionIndexes, range, subscribe, settle } = require('./support/chain.js');

const blockHeights = (client) => frames(client, 'NEW_BLOCK').map((m) => String(m.data.block_index));

async function seededFeed() {
    const db = chainDb();
    db.commit(10, 10);                                  // blocks 1..10, actions 1..100
    const { s, detector } = feed(db);
    await detector.checkCoin('BTC');                    // seeds at 100
    const client = connect(s, 1);
    subscribe(s, client, ['actions', 'blocks']);
    await settle();
    return { db, s, detector, client };
}

describe('WS-02: a rollback inside one poll leaves no gap', function () {
    afterEach(() => sinon.restore());

    it('holds both cursors at the last row fetched when the fetch comes back short of the tip', async function () {
        const { db, detector, client } = await seededFeed();
        db.commit(5, 10);                               // blocks 11..15, actions 101..150
        db.hooks.afterMaxAction = () => db.rollbackTo(13);
        await detector.checkCoin('BTC');                // tip read 150; 131..150 gone before the fetch

        expect(detector.state.BTC.actionIndex).to.equal(130n);
        expect(detector.state.BTC.blockIndex).to.equal(13);

        db.epoch = 1;
        db.commit(3, 10);                               // 14', 15', 16' hold 131..160
        await detector.checkCoin('BTC');
        await detector.checkCoin('BTC');

        expect(actionIndexes(client)).to.deep.equal(range(101, 160));
        expect(blockHeights(client)).to.deep.equal(range(11, 16));
    });

    it('holds the cursor when every row above it was rolled back before the fetch', async function () {
        const { db, detector, client } = await seededFeed();
        db.commit(2, 10);                               // 101..120
        db.hooks.afterMaxAction = () => db.rollbackTo(10);
        await detector.checkCoin('BTC');                // empty fetch below a tip of 120

        expect(detector.state.BTC.actionIndex).to.equal(100n);

        db.epoch = 1;
        db.commit(3, 10);                               // 101..130 on the new chain
        await detector.checkCoin('BTC');

        expect(actionIndexes(client)).to.deep.equal(range(101, 130));
    });

    it('retracts and re-announces a block replaced between the block and action fetches of one poll', async function () {
        const { db, detector, client } = await seededFeed();
        db.commit(5, 10);                               // blocks 11..15, actions 101..150
        db.hooks.beforeActionsSince = () => db.rollbackTo(13);
        await detector.checkCoin('BTC');                // announces 11..15, then fetches 101..130

        db.epoch = 1;
        db.commit(3, 10);                               // 14', 15', 16' with new hashes
        // The db layer's own verdict misses it (it read its tip before the rollback).
        await detector.checkCoin('BTC');
        await detector.checkCoin('BTC');

        const reorg = frames(client, 'REORG');
        expect(reorg).to.have.lengthOf(1);
        expect(reorg[0].data).to.deep.equal({ fork_block_index: '14', first_invalid_action_index: '131' });
        const hashes = frames(client, 'NEW_BLOCK').filter((m) => m.data.block_index >= 14).map((m) => m.data.block_index + ':' + m.data.block_hash);
        expect(hashes).to.deep.equal(['14:h14e0', '15:h15e0', '14:h14e1', '15:h15e1', '16:h16e1']);
        expect(actionIndexes(client)).to.deep.equal(range(101, 160));
    });
});
