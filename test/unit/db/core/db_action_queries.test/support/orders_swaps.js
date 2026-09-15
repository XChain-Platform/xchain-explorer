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
 * Unit tests for all get* ACTION query methods in src/db/index.js
 *
 * Each method is called directly (no DB connection needed) and the returned
 * [query, args, count] triple is verified for:
 *   - correct array length (3 elements)
 *   - presence of the expected main table name in both query and count
 *   - presence of sql.where.data in the WHERE clause
 *   - ORDER BY and LIMIT clauses driven by sql.order / sql.limit
 *   - args value (null for most methods, an array for those that build args internally)
 */

'use strict';

const { expect, makeConfig, db, WHERE_DATA, SEARCH_ADDR, makeActionConfig } = require('./helpers.js');

// Builds its own args: an address or token search is bound twice, matching
// either party, or either side of the order for a token.
describe('Database#getOrders', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getOrders', 'address');
        result = await db.getOrders(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "orders" with give/get tick+amount fields', () => {
        const [query] = result;
        expect(query).to.include('orders m');
        expect(query).to.include('give_tick');
        expect(query).to.include('get_tick');
        expect(query).to.include('m.give_amount');
        expect(query).to.include('m.get_amount');
    });

    it('args has two entries for address type', () => {
        const [, args] = result;
        expect(args).to.be.an('array').with.lengthOf(2);
    });
});

describe('Database#getOrderCancels', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getOrderCancels');
        result = await db.getOrderCancels(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "order_cancels" table', () => {
        const [query] = result;
        expect(query).to.include('order_cancels m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getOrderEdits', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getOrderEdits');
        result = await db.getOrderEdits(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "order_edits" table', () => {
        const [query] = result;
        expect(query).to.include('order_edits m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getOrderExpires', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getOrderExpires');
        result = await db.getOrderExpires(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "order_expires" with orders JOIN', () => {
        const [query] = result;
        expect(query).to.include('order_expires m');
        expect(query).to.include('orders');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getOrderMatches', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getOrderMatches');
        result = await db.getOrderMatches(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "order_matches" with give/get coin JOINs', () => {
        const [query] = result;
        expect(query).to.include('order_matches m');
        expect(query).to.include('give_coin');
        expect(query).to.include('get_coin');
    });

    it('query exposes give_amount and get_amount for the auto-pay cap cross-check', () => {
        const [query] = result;
        expect(query).to.include('m.give_amount');
        expect(query).to.include('m.get_amount');
    });

    it('query exposes settlement_type (instant vs coinpay)', () => {
        const [query] = result;
        expect(query).to.include('m.settlement_type');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// Builds its own args: an address search is bound twice (source or destination).
describe('Database#getSends', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSends', 'address');
        result = await db.getSends(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "sends" table with source/destination/tick', () => {
        const [query] = result;
        expect(query).to.include('sends m');
        expect(query).to.include('destination');
        expect(query).to.include('t3.tick');
    });

    it('args is an array with two entries for address type', () => {
        const [, args] = result;
        expect(args).to.be.an('array').with.lengthOf(2);
        expect(args[0]).to.equal(SEARCH_ADDR);
    });

    // A contract-emitted SEND moves balances with no broadcast transaction behind
    // it: the injected EXECUTE carries no TX_INDEX and execute/index.js propagates that
    // into the emitted action, so `actions.tx_index` is NULL while block_index is
    // NOT NULL. Joining blocks through an INNER-joined transaction deletes such a
    // row from the feed AND from its total, with no error, and /sends is what the
    // SDK's x402 layer reads to confirm a payment. Same shape the tx-less action
    // feed and getUnstakes already carry.
    it('joins blocks off a1.block_index (INNER) and transactions off a1.tx_index (LEFT), in both the rows and count queries', () => {
        const [query, , count] = result;
        for(const q of [query, count]){
            expect(q).to.include('INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)');
            expect(q).to.include('LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)');
            // The pre-fix shape: transactions INNER off a1.tx_index with blocks
            // chained off t1.block_index. A tx-less send satisfies neither.
            expect(q).to.not.include('INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)');
            expect(q).to.not.include('b1.block_index=t1.block_index');
        }
    });
});

describe('Database#getSleeps', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSleeps');
        result = await db.getSleeps(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "sleeps" table', () => {
        const [query] = result;
        expect(query).to.include('sleeps m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// Builds its own args: an address or token search is bound twice, matching
// either party, or either side of the swap for a token.
describe('Database#getSwaps', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSwaps', 'address');
        result = await db.getSwaps(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "swaps" with give/get coin and tick fields', () => {
        const [query] = result;
        expect(query).to.include('swaps m');
        expect(query).to.include('give_coin');
        expect(query).to.include('get_coin');
        expect(query).to.include('give_tick');
        expect(query).to.include('get_tick');
    });

    it('args has two entries for address type', () => {
        const [, args] = result;
        expect(args).to.be.an('array').with.lengthOf(2);
    });
});

describe('Database#getSwapCancels', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSwapCancels');
        result = await db.getSwapCancels(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "swap_cancels" table', () => {
        const [query] = result;
        expect(query).to.include('swap_cancels m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getSwapEdits', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSwapEdits');
        result = await db.getSwapEdits(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "swap_edits" table', () => {
        const [query] = result;
        expect(query).to.include('swap_edits m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getSwapExpires', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSwapExpires');
        result = await db.getSwapExpires(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "swap_expires" with swaps JOIN', () => {
        const [query] = result;
        expect(query).to.include('swap_expires m');
        expect(query).to.include('swaps');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getSwapMatches', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSwapMatches');
        result = await db.getSwapMatches(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "swap_matches" with give/get coin JOINs', () => {
        const [query] = result;
        expect(query).to.include('swap_matches m');
        expect(query).to.include('give_coin');
        expect(query).to.include('get_coin');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});
