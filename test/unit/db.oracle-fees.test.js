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
 * The oracle track record reports FEES EARNED.
 *
 * The page had every count it was specified to carry except the one number that
 * says what running markets is worth to this address, so a reader could see that
 * an oracle resolves reliably but not that it has taken a cut at all.
 *
 * The sharp part is not the sum, it is WHOSE credits get summed. Settlement pays
 * the winners and the oracle inside ONE resolve action, so every winning bettor's
 * payout carries that resolve's action_index too. Summing credits by credited
 * address alone therefore reports other people's winnings as this address's fee
 * income the moment it has ever bet on someone else's market. The query requires
 * the credited address to BE the address that submitted the resolve, which is
 * exact rather than approximate: format 3 is owner-only and format 2 rejects a
 * bet from the feed source, so inside one resolve the oracle is credited exactly
 * once and can never appear as a bettor.
 ********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const ORACLE = 'mr9be3iRkfcWj9onyGFzyDSpfRwga2WtxH';

// A Database answering each query from `rows` ([substring-of-SQL, result] pairs),
// recording the SQL and the args it was called with. Unmatched queries answer empty.
function makeDb(rows) {
    const mockConfigInfo = createConfigInfoStub();
    const util           = new Utility(mockConfigInfo);
    const db             = new Database({ configInfo: mockConfigInfo, util });
    db.calls = [];
    db.doQuery = async (config, sql, args) => {
        db.calls.push({ sql: String(sql), args: args || [] });
        for (const [needle, result] of rows)
            if (String(sql).includes(needle)) return result;
        return [];
    };
    return db;
}

const config = { coin: 'BTC', data: { search: ORACLE } };

const FEES_ROWS = [
    { tick: 'PEPECREATURE', resolves: 2, amount: '0.175000000000000000' },
    { tick: 'XCHAIN',       resolves: 1, amount: '12.000000000000000000' },
];

describe('Betting oracle fees earned @regression', function () {

    it('sums the oracle credits and reports them per wager token', async function () {
        const db = makeDb([
            ['GROUP BY fs.status', [{ feed_status: 'resolved', feeds: 3 }]],
            ['bet_resolves',       FEES_ROWS],
        ]);
        const [rec] = await db.getOracleStats(config);
        assert.deepStrictEqual(rec.fees_earned, [
            { tick: 'PEPECREATURE', resolves: 2, amount: '0.175' },
            { tick: 'XCHAIN',       resolves: 1, amount: '12' },
        ]);
        // The counts half must survive the addition unchanged
        assert.strictEqual(rec.counts.resolved, 3);
        assert.strictEqual(rec.total_feeds, 3);
    });

    it('requires the credited address to BE the resolver, so a bettor payout is not counted', async function () {
        const db  = makeDb([['bet_resolves', FEES_ROWS]]);
        await db.getOracleStats(config);
        const call = db.calls.find(c => c.sql.includes('bet_resolves'));
        assert.ok(call, 'no fees query was issued at all');
        // Both halves of the identity test, and both bound to the searched address:
        // dropping either one turns every payout the oracle ever WON on someone
        // else's market into reported fee income.
        assert.ok(/WHERE ca\.address=\? AND ra\.address=\?/.test(call.sql),
            'the credited-address = resolver identity test is gone from the fees query');
        assert.ok(call.sql.includes('ra ON (ra.id=t1.source_id)'),
            'the resolver address is no longer resolved from the resolve tx source');
        assert.deepStrictEqual(call.args, [ORACLE, ORACLE]);
    });

    it('scopes the sum to BET resolve actions only', async function () {
        const db   = makeDb([]);
        await db.getOracleStats(config);
        const call = db.calls.find(c => c.sql.includes('credits c'));
        // Without the bet_resolves join this sums EVERY credit the address has ever
        // received, which is its whole income, not its oracle fees.
        assert.ok(call.sql.includes('INNER JOIN bet_resolves'),
            'the fees sum is no longer scoped to resolve actions');
        assert.ok(/SUM\(CAST\(c\.amount AS DECIMAL\(65,18\)\)\)/.test(call.sql),
            'the sum no longer casts through DECIMAL, so string amounts add as floats');
    });

    it('reports an oracle who has never been paid as an empty list, not a missing field', async function () {
        const db = makeDb([['GROUP BY fs.status', [{ feed_status: 'open', feeds: 1 }]]]);
        const [rec] = await db.getOracleStats(config);
        // An empty list is what the renderer branches on. `undefined` would read as
        // "this explorer is too old to know", which is a different statement.
        assert.deepStrictEqual(rec.fees_earned, []);
        assert.strictEqual(rec.active_feeds, 1);
    });

    describe('trimAmountTail', function () {
        const db = makeDb([]);
        it('drops the DECIMAL zero tail without touching a significant digit', function () {
            assert.strictEqual(db.trimAmountTail('0.175000000000000000'), '0.175');
            assert.strictEqual(db.trimAmountTail('12.000000000000000000'), '12');
            assert.strictEqual(db.trimAmountTail('0.000000010000000000'), '0.00000001');
        });
        it('leaves a value that is already exact alone', function () {
            assert.strictEqual(db.trimAmountTail('100'), '100');
            assert.strictEqual(db.trimAmountTail('0.5'), '0.5');
        });
        it('passes non-numeric input through and answers null as zero', function () {
            assert.strictEqual(db.trimAmountTail(null), '0');
            assert.strictEqual(db.trimAmountTail('1e-8'), '1e-8');
        });
    });
});
