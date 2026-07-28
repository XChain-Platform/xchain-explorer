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
 * An expired market must be able to say which block refunded everyone .
 *
 * Found driving the betting expiry path in a browser (wallet E2E session 24).
 * LTC market #1193 expired correctly on chain at block 2264 and refunded its
 * 400-XCHAIN bet in full, and its History then read:
 *
 *     Taking bets                                  block 2255
 *     Expired unresolved, everyone refunded        block n/a      <-- no block
 *     Betting closed, waiting on the result        block 2261     <-- and after it
 *
 * ONE NULL CAUSES BOTH SYMPTOMS. The timeline resolved each row's block by
 * routing through the action's TRANSACTION (actions -> transactions -> blocks).
 * BET_EXPIRE is emitted by the indexer's end-of-block pass and has NO
 * transaction, so tx_index is NULL, the join yields NULL, and the block is lost
 * even though actions.block_index holds it directly. The ordering then follows
 * mechanically: the synthetic `closed` latch is spliced in by comparing block
 * numbers, and `null > closedBlock` is false, so the latch lands AFTER the
 * expiry instead of before it.
 *
 * Every other BET status (create, resolve, cancel) is a user action WITH a
 * transaction, which is why all of them always rendered correctly and this
 * survived until the one path that needs no user at all was finally driven.
 ********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const FEED         = 1193;
const CLOSED_BLOCK = 2261;

function makeDb(rows) {
    const mockConfigInfo = createConfigInfoStub();
    const util           = new Utility(mockConfigInfo);
    const db             = new Database({ configInfo: mockConfigInfo, util });
    db.queries = [];
    db.doQuery = async (config, sql) => {
        db.queries.push(String(sql));
        for (const [needle, result] of rows)
            if (String(sql).includes(needle)) return result;
        return [];
    };
    return db;
}

// The two action-backed rows for a market that was left to expire: the create,
// and the system BET_EXPIRE at block 2264. Both carry a block here because the
// fixed query reads it off the action rather than off a transaction.
const STATUS_ROWS = ['bet_feed_statuses', [
    { action_index: 1193, status: 'open',    block_index: 2255, timestamp: 1785261617, tx_hash: 'a'.repeat(64) },
    { action_index: 1196, status: 'expired', block_index: 2264, timestamp: 1785266601, tx_hash: null },
]];
const CLOSED_TIME = ['block_time FROM blocks', [{ block_time: 1785262295 }]];

const config = { coin: 'LTC', data: {} };

describe('BET feed status timeline  @regression', function () {

    it('reads the block off the ACTION, so a transactionless BET_EXPIRE keeps its block', async function () {
        const db = makeDb([STATUS_ROWS, CLOSED_TIME]);
        await db.getBetFeedTimeline(config, FEED, CLOSED_BLOCK);
        const sql = db.queries.find(q => q.includes('bet_feed_statuses'));

        assert.ok(/JOIN\s+blocks\s+b1\s+ON\s+\(b1\.block_index=a1\.block_index\)/.test(sql),
            'the timeline no longer joins blocks on the action block_index, so a system action loses its block');
        assert.ok(!/JOIN\s+blocks\s+b1\s+ON\s+\(b1\.block_index=t1\.block_index\)/.test(sql),
            'the timeline is back to resolving the block through the transaction, which BET_EXPIRE does not have');
        // The transaction join must survive: it is still the only source of a tx hash.
        assert.ok(sql.includes('LEFT JOIN transactions'), 'the transaction join was dropped along with the bug');
    });

    it('places the synthetic closed latch BEFORE a later terminal row', async function () {
        const db  = makeDb([STATUS_ROWS, CLOSED_TIME]);
        const out = await db.getBetFeedTimeline(config, FEED, CLOSED_BLOCK);

        assert.deepStrictEqual(out.map(r => r.status), ['open', 'closed', 'expired'],
            'a market cannot expire before it closes');
        assert.deepStrictEqual(out.map(r => Number(r.block_index)), [2255, 2261, 2264],
            'the timeline is not in block order');
        // The expiry names its block, which is the number a bettor needs to find the refund.
        const expired = out.find(r => r.status === 'expired');
        assert.strictEqual(Number(expired.block_index), 2264);
        assert.strictEqual(Number(expired.timestamp), 1785266601);
        assert.strictEqual(expired.synthetic, false, 'BET_EXPIRE is action-backed, not synthesized');
    });

    it('still marks the latch synthetic and leaves action-backed rows alone', async function () {
        const db  = makeDb([STATUS_ROWS, CLOSED_TIME]);
        const out = await db.getBetFeedTimeline(config, FEED, CLOSED_BLOCK);
        const closed = out.find(r => r.status === 'closed');

        assert.strictEqual(closed.synthetic, true, 'the closed latch has no causing action and must say so');
        assert.strictEqual(closed.action_index, null);
        assert.strictEqual(Number(closed.timestamp), 1785262295, 'the latch timestamp is read from its block');
    });

    // The mechanism, pinned so the two symptoms stay visibly connected. The splice
    // logic below was never wrong; it was fed a NULL. This reproduces the shape the
    // OLD query returned and shows it printing the impossible order, which is why the
    // SQL assertion above is the real guard rather than the ordering assertion.
    it('shows a NULL block is what put the latch in the wrong place', async function () {
        const db = makeDb([['bet_feed_statuses', [
            { action_index: 1193, status: 'open',    block_index: 2255, timestamp: 1785261617, tx_hash: 'a'.repeat(64) },
            { action_index: 1196, status: 'expired', block_index: null, timestamp: null,       tx_hash: null },
        ]], CLOSED_TIME]);
        const out = await db.getBetFeedTimeline(config, FEED, CLOSED_BLOCK);

        assert.deepStrictEqual(out.map(r => r.status), ['open', 'expired', 'closed'],
            'a NULL block no longer reorders the latch, so this test has stopped describing the bug');
    });

    // A market that never closed (cancelled while still open) has no latch to place.
    it('adds no latch when the feed never latched closed', async function () {
        const db  = makeDb([['bet_feed_statuses', [
            { action_index: 1192, status: 'open',      block_index: 2253, timestamp: 1785261372, tx_hash: 'b'.repeat(64) },
            { action_index: 1195, status: 'cancelled', block_index: 2262, timestamp: 1785263762, tx_hash: 'c'.repeat(64) },
        ]]]);
        const out = await db.getBetFeedTimeline(config, 1192, null);

        assert.deepStrictEqual(out.map(r => r.status), ['open', 'cancelled']);
        assert.ok(out.every(r => r.synthetic === false));
    });
});
