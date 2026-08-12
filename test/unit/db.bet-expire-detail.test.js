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
 * BET_EXPIRE is the only indexerHandled action that rendered nothing.
 *
 * A feed left unresolved past expire_at is refunded by the end-of-block pass,
 * which mints a BET_EXPIRE action. Its detail page read "No additional
 * information is available", because the action owns no table and nothing
 * carried the link to the feed it expired. The link exists anyway: the pass
 * writes one bet_feed_statuses row keyed by the minted action_index, and one
 * bet_statuses row per refunded bet. This pins that the handler drives off
 * both, and that the tally it derives is a payload value rather than a
 * bignumber object.
 ********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const EXPIRE = 1196;
const FEED   = 1193;

// One BET_EXPIRE at block 2264 over feed #1193, a 3-outcome LTC market.
const FEED_STATUS_ROW = {
    action:            'BET_EXPIRE',
    action_format:     0,
    action_index:      EXPIRE,
    feed_action_index: FEED,
    label:             'Will it rain?',
    outcomes:          'yes,no,maybe',
    tick:              'XCHAIN',
    deadline:          1785260000,
    refund_window:     86400,
    expire_at:         1785346400,
    terminal_block:    2264,
    block_index:       2264,
    timestamp:         1785266601,
    feed_status:       'expired'
};

// Build a db whose doQuery answers by table name, recording every statement.
function makeDb(routes) {
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    const db         = new Database({ configInfo, util });
    db.queries = [];
    db.doQuery = async (config, sql) => {
        db.queries.push(String(sql));
        for (const [needle, rows] of routes)
            if (String(sql).includes(needle)) return rows;
        return [];
    };
    db.getActionType    = async () => 'BET_EXPIRE';
    db.getActionFeeData = async () => null;
    db.getTransactionData = async () => null;
    return db;
}

const config = { coin: 'LTC', data: {} };
const betStatuses = (amounts) => ['bet_statuses',
    amounts.map((amount, i) => ({ bet_action_index: 1200 + i, amount }))];

describe('BET_EXPIRE action detail @regression', function () {

    it('resolves the expired feed through the bet_feed_statuses row it wrote', async function () {
        const db = makeDb([
            ['bet_feed_statuses', [FEED_STATUS_ROW]],
            betStatuses(['400.00000000'])
        ]);
        const data = await db.getActionData(config, EXPIRE);
        assert.strictEqual(data.action, 'BET_EXPIRE');
        assert.strictEqual(data.feed_action_index, FEED, 'the page cannot link back to the market it expired');
        assert.strictEqual(data.label, 'Will it rain?');
        assert.strictEqual(data.tick, 'XCHAIN');
        assert.strictEqual(data.expire_at, 1785346400);
        assert.strictEqual(data.feed_status, 'expired');
        assert.strictEqual(data.block_index, 2264, 'BET_EXPIRE is transactionless; the block comes off the action');
    });

    it('joins the feed terms through bet_feeds, not through a bet_expires table (there is none)', async function () {
        const db = makeDb([['bet_feed_statuses', [FEED_STATUS_ROW]]]);
        await db.getActionData(config, EXPIRE);
        const main = db.queries.find(q => q.includes('FROM') && q.includes('bet_feed_statuses'));
        assert.ok(main, 'no query drove off bet_feed_statuses');
        assert.ok(/JOIN\s+bet_feeds\b/.test(main), 'the feed terms (tick / deadline / expire_at) are not joined in');
        assert.ok(!db.queries.some(q => /\bbet_expires\b/.test(q)), 'queried a table that does not exist');
    });

    it('tallies the refunds off bet_statuses, exactly, in bignumber space', async function () {
        const db = makeDb([
            ['bet_feed_statuses', [FEED_STATUS_ROW]],
            betStatuses(['0.00000001', '0.00000002', '400.00000000'])
        ]);
        const data = await db.getActionData(config, EXPIRE);
        assert.strictEqual(data.refund_count, 3);
        assert.strictEqual(data.refund_amount, '400.00000003',
            'a float sum of the VARCHAR stakes loses the last places');
    });

    it('keeps the widest stake precision and never flips to exponent notation', async function () {
        const db = makeDb([
            ['bet_feed_statuses', [FEED_STATUS_ROW]],
            betStatuses(['21000000000000000000000.12345678', '1'])
        ]);
        const data = await db.getActionData(config, EXPIRE);
        assert.strictEqual(data.refund_amount, '21000000000000000000001.12345678');
        assert.ok(!/e/i.test(data.refund_amount), 'an amount field may never render as an exponent');
    });

    it('reports a zero tally rather than leaving the count undefined', async function () {
        const db = makeDb([['bet_feed_statuses', [FEED_STATUS_ROW]]]);
        const data = await db.getActionData(config, EXPIRE);
        assert.strictEqual(data.refund_count, 0, 'afterQuery2 does not run on no rows, so the seed has to');
        assert.strictEqual(data.refund_amount, '0');
    });

    it('returns a structured-cloneable payload, which the LRU cache requires', async function () {
        const db = makeDb([
            ['bet_feed_statuses', [FEED_STATUS_ROW]],
            betStatuses(['400.00000000'])
        ]);
        const data = await db.getActionData(config, EXPIRE);
        // util.bcadd returns a mathjs bignumber, and getActionData clones every
        // cacheable payload on the way into the LRU: handing that object through
        // would throw DataCloneError on the first expired feed anyone opened.
        assert.doesNotThrow(() => structuredClone(data));
        assert.strictEqual(typeof data.refund_amount, 'string');
    });
});
