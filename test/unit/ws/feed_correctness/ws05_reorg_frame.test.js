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
 * WS-05 and WS-01: a detected rollback is announced to every subscriber with a
 * REORG frame (fork height and first invalidated action_index) before any
 * replacement row, and a catch-up from a cursor a logged rollback may have
 * invalidated is refused with the stable CATCH_UP_REORGED code instead of a
 * replay that would skip the replaced rows at or below the cursor.
 *
 ********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const { chainDb, feed, connect, sent, frames, actionIndexes, range, subscribe, settle } = require('./support/chain.js');

// Seeded at 100 (blocks 1..10), one live subscriber that saw 101..120 (blocks 11, 12),
// then a rollback to height 10 replaced by `blocks` blocks of `perBlock` rows.
async function reorged(blocks, perBlock) {
    const db = chainDb();
    db.commit(10, 10);
    const { s, detector } = feed(db);
    await detector.checkCoin('BTC');
    const live = connect(s, 1);
    subscribe(s, live, ['actions', 'blocks']);
    const idle = connect(s, 2);                         // connected, holding no subscription
    await settle();
    db.commit(2, 10);
    await detector.checkCoin('BTC');
    const before = sent(live).length;
    db.rollbackTo(10);
    db.epoch = 1;
    db.commit(blocks, perBlock);
    db.reorgVerdict = true;
    await detector.checkCoin('BTC');
    return { db, s, detector, live, idle, after: sent(live).slice(before) };
}

describe('WS-05: a rollback is announced before its replacement rows', function () {
    afterEach(() => sinon.restore());

    it('sends REORG with the fork height and first invalidated index ahead of every replacement frame', async function () {
        const { after, idle } = await reorged(3, 10);
        expect(after[0].type).to.equal('REORG');
        expect(after[0].data).to.deep.equal({ fork_block_index: '11', first_invalid_action_index: '101' });
        expect(after.slice(1).every((m) => m.type !== 'REORG')).to.equal(true);
        expect(after.filter((m) => m.type === 'NEW_ACTION').map((m) => m.data.tx_hash)).to.deep.equal(range(101, 130).map((i) => 't' + i + 'e1'));
        // A connection holding no subscription is not told.
        expect(frames(idle, 'REORG')).to.have.lengthOf(0);
    });

    it('announces a shorter replacement, so the deleted rows above its tip are void too', async function () {
        const { after } = await reorged(1, 5);
        expect(after[0].type).to.equal('REORG');
        expect(after[0].data.first_invalid_action_index).to.equal('101');
        expect(after.filter((m) => m.type === 'NEW_ACTION').map((m) => String(m.data.action_index))).to.deep.equal(range(101, 105));
    });
});

describe('WS-01: a catch-up across a rollback asks for a resync', function () {
    afterEach(() => sinon.restore());

    it('refuses a cursor inside the rolled-back range with CATCH_UP_REORGED and the fork fields', async function () {
        const { s } = await reorged(3, 10);
        const back = connect(s, 3);                     // last saw 120 on the old chain
        subscribe(s, back, ['actions'], { since_action_index: '120' }, 'c1');
        await settle();

        const errors = frames(back, 'error');
        expect(errors).to.have.lengthOf(1);
        expect(errors[0].id).to.equal('c1');
        expect(errors[0].data).to.include({ code: 'CATCH_UP_REORGED', fork_block_index: '11', first_invalid_action_index: '101' });
        expect(frames(back, 'NEW_ACTION')).to.have.lengthOf(0);
        expect(frames(back, 'CATCH_UP_COMPLETE')).to.have.lengthOf(0);
    });

    it('replays normally from a cursor below the first invalidated index', async function () {
        const { s } = await reorged(3, 10);
        const back = connect(s, 3);
        subscribe(s, back, ['actions'], { since_action_index: '100' }, 'c2');
        await settle();

        expect(frames(back, 'error')).to.have.lengthOf(0);
        expect(actionIndexes(back)).to.deep.equal(range(101, 130));
    });

    it('replays normally from a cursor above the old tip, which only the new chain reached', async function () {
        const { s } = await reorged(3, 10);
        const back = connect(s, 3);
        subscribe(s, back, ['actions'], { since_action_index: '125' }, 'c3');
        await settle();

        expect(frames(back, 'error')).to.have.lengthOf(0);
        expect(actionIndexes(back)).to.deep.equal(range(126, 130));
    });
});
