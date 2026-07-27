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
 * BET cancel / resolve legs report a real status .
 *
 * BET is one action name over four formats. Create (0) and place (2) each own a
 * row that stores the action's PARSE status, so this endpoint has always served
 * "valid" or "invalid: <reason>" for them. Cancel (1) and resolve (3) owned no row
 * at all: their only durable trace was a bet_feed_statuses history row, written
 * ONLY on the valid path. So the action's `status` came back NULL for both legs,
 * whatever actually happened on chain, and the SDK could not tell a rejection from
 * a success - it reports statusKnown:false / statusSource:assumed for exactly this
 * case (, the honesty fix that this one makes unnecessary for BET).
 *
 * The indexer now writes bet_cancels / bet_resolves rows for both legs whatever the
 * status. These tests pin the reader half: the status reaches the payload, and the
 * shape disambiguation the row-less handling depended on does not regress (a cancel
 * must not start reading as a placed bet just because its table also has a
 * feed_action_index column).
 ********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const ACTION_INDEX = 4242;

// A Database whose every query is answered from `rows`, a list of
// [substring-of-SQL, result] pairs matched in order. Anything unmatched answers
// with an empty result set, which is what the credits/debits/escrow lookups and
// the other de-blanking probes want anyway.
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

// The row the BET branch of getActionData reads, as a cancel/resolve leg returns it:
// every bet_feeds / bets column NULL (the leg owns neither row), the leg's own
// status resolved through the new COALESCE, and the leg's feed ref in its own alias.
function legRow(over = {}) {
    return Object.assign({
        action: 'BET',
        action_format: 1,
        action_index: ACTION_INDEX,
        source: 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH',
        label: null, outcomes: null, fee: null, deadline: null, refund_window: null,
        expire_at: null, min_amount: null, allow_list: null, block_list: null,
        details: null, closed_block: null, terminal_block: null, feed_status: null,
        feed_action_index: null, outcome: null, amount: null, settled_block: null,
        bet_status: null,
        cancel_feed_ref: 5, resolve_feed_ref: null,
        tick: null, block_index: 100, timestamp: 1700000000,
        tx_hash: 'a'.repeat(64), tx_index: 1,
        status: 'valid',
    }, over);
}

const typeRow = ['LEFT  JOIN index_actions a2 ON (a2.id=a1.action_id)\n                    WHERE', [{ action: 'BET' }]];

const config = { coin: 'BTC', data: {} };

describe('BET cancel/resolve action status  @regression', function () {

    it('joins the two leg tables and coalesces their parse status into the action status', async function () {
        const db = makeDb([typeRow, ['bet_cancels', [legRow()]]]);
        const data = await db.getActionData(config, ACTION_INDEX);
        const sql  = db.queries.find(q => q.includes('bet_cancels'));
        // The status COALESCE must reach both leg tables, or the legs stay statusless
        assert.ok(/COALESCE\(fs\.status, bs\.status, bcs\.status, brs\.status\) as status/.test(sql),
            'the BET status COALESCE no longer reads the cancel/resolve leg tables');
        assert.ok(sql.includes('LEFT  JOIN bet_cancels'),  'bet_cancels is not joined');
        assert.ok(sql.includes('LEFT  JOIN bet_resolves'), 'bet_resolves is not joined');
        assert.strictEqual(data.status, 'valid');
        assert.strictEqual(data.bet_kind, 'cancel');
    });

    it('reports a REJECTED cancel as rejected instead of serving no status at all', async function () {
        const db = makeDb([typeRow, ['bet_cancels', [legRow({ status: 'invalid: SOURCE (not owner)' })]]]);
        const data = await db.getActionData(config, ACTION_INDEX);
        assert.strictEqual(data.status, 'invalid: SOURCE (not owner)');
        assert.strictEqual(data.bet_kind, 'cancel');
        // The leg's own row names the feed even though no bet_feed_statuses row exists
        // (that one is written only on the valid path)
        assert.strictEqual(data.feed_ref, 5);
    });

    it('reports a REJECTED resolve the same way, from its own leg table', async function () {
        const row = legRow({
            action_format: 3,
            cancel_feed_ref: null,
            resolve_feed_ref: 5,
            status: 'invalid: OUTCOME (range)',
        });
        const db = makeDb([typeRow, ['bet_resolves', [row]]]);
        const data = await db.getActionData(config, ACTION_INDEX);
        assert.strictEqual(data.status, 'invalid: OUTCOME (range)');
        assert.strictEqual(data.bet_kind, 'resolve');
        assert.strictEqual(data.feed_ref, 5);
    });

    it('prefers the lifecycle history row when one exists, so a valid leg still reports the feed status', async function () {
        const db = makeDb([
            typeRow,
            ['bet_cancels', [legRow()]],
            ['bet_feed_statuses', [{ feed_action_index: 5, feed_status: 'cancelled' }]],
        ]);
        const data = await db.getActionData(config, ACTION_INDEX);
        assert.strictEqual(data.status, 'valid');
        assert.strictEqual(data.feed_ref, 5);
        assert.strictEqual(data.feed_status, 'cancelled');
    });

    it('keeps the leg feed refs out of the payload and does not misread a cancel as a placed bet', async function () {
        const db = makeDb([typeRow, ['bet_cancels', [legRow()]]]);
        const data = await db.getActionData(config, ACTION_INDEX);
        // cancel_feed_ref / resolve_feed_ref are plumbing: one `feed_ref` ships
        assert.ok(!('cancel_feed_ref' in data));
        assert.ok(!('resolve_feed_ref' in data));
        // The shape disambiguation reads bets.feed_action_index ONLY. Coalescing the
        // leg refs onto that column would have made every cancel look like a wager.
        assert.notStrictEqual(data.bet_kind, 'bet');
        assert.ok(!('amount' in data));
    });
});
