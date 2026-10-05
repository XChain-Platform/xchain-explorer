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
 ********************************************************************/

'use strict';

const assert = require('assert');

const {
    ACTION_CLAUSE_BUILDERS,
    genericClause
} = require('../../../../src/db/query_sql/where_action_clauses.js');

const db = { util: { isNull: (value) => value == null } };
const anchor = 'WHERE anchor';
const pairPredicate = ' AND ((COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?) OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?))';
const marketsPredicate = ' AND (COALESCE(t1.tick, c1.coin)=? OR COALESCE(t2.tick, c2.coin)=?)';

function build(method, type, search3 = null, sql = anchor) {
    const config = { data: { method, type, search3 } };
    return ACTION_CLAUSE_BUILDERS[method](db, config, sql);
}

function placeholderCount(sql) {
    return (sql.match(/\?/g) || []).length;
}

describe('ACTION_CLAUSE_BUILDERS', function(){
    it('exports exactly the eight action clause builders', function(){
        const expected = [
            'getHistory', 'getMarket', 'getMarkets', 'getMarketOrders',
            'getOrderbook', 'getMarketHistory', 'getTokens', 'getCollectibles'
        ];

        assert.deepStrictEqual(Object.keys(ACTION_CLAUSE_BUILDERS).sort(), expected.sort());
    });

    it('builds each getHistory lane from the correct anchor', function(){
        assert.strictEqual(
            build('getHistory', 'address'),
            `${anchor} AND m.type_id=2 AND m.id=?`
        );
        assert.strictEqual(
            build('getHistory', 'token'),
            `${anchor} AND m.type_id=1 AND m.id=?`
        );
        assert.strictEqual(build('getHistory', 'block'),
            'a1.action_index IS NOT NULL AND b1.block_index=?');
        assert.strictEqual(build('getHistory', 'unknown'),
            'a1.action_index IS NOT NULL');
    });
});

describe('market action clause builders', function(){
    it('appends the four-placeholder pair predicate for getMarket', function(){
        const result = build('getMarket', 'unknown');

        assert.strictEqual(result, anchor + pairPredicate);
        assert.strictEqual(placeholderCount(result), 4);
    });

    it('appends the two-placeholder getMarkets predicate only for tokens', function(){
        const tokenResult = build('getMarkets', 'token');

        assert.strictEqual(tokenResult, anchor + marketsPredicate);
        assert.strictEqual(placeholderCount(tokenResult), 2);
        assert.strictEqual(build('getMarkets', 'address'), anchor);
    });

    it('uses one shared builder for all market order methods', function(){
        const shared = ACTION_CLAUSE_BUILDERS.getMarketOrders;

        assert.strictEqual(ACTION_CLAUSE_BUILDERS.getOrderbook, shared);
        assert.strictEqual(ACTION_CLAUSE_BUILDERS.getMarketHistory, shared);
    });

    for (const method of ['getMarketOrders', 'getOrderbook']) {
        it(`${method} adds an optional single-address predicate`, function(){
            const withoutAddress = build(method, 'token', null);
            const withAddress = build(method, 'token', 'address');

            assert.strictEqual(withoutAddress, anchor + pairPredicate);
            assert.strictEqual(placeholderCount(withoutAddress), 4);
            assert.strictEqual(withAddress, `${withoutAddress} AND a2.address=?`);
            assert.strictEqual(placeholderCount(withAddress), 5);
        });
    }

    it('getMarketHistory adds its optional two-address predicate', function(){
        const withoutAddress = build('getMarketHistory', 'token', undefined);
        const withAddress = build('getMarketHistory', 'token', 'address');

        assert.strictEqual(withoutAddress, anchor + pairPredicate);
        assert.strictEqual(placeholderCount(withoutAddress), 4);
        assert.strictEqual(
            withAddress,
            `${withoutAddress} AND (a2.address=? OR a3.address=?)`
        );
        assert.strictEqual(placeholderCount(withAddress), 6);
    });
});

describe('token action clause builders', function(){
    it('getCollectibles always filters collectibles and supports block and address', function(){
        const base = `${anchor} AND m.decimals=0 AND m.lock_max_supply=1`;

        assert.strictEqual(build('getCollectibles', 'unknown'), base);
        assert.strictEqual(build('getCollectibles', 'block'),
            `${base} AND b1.block_index=?`);
        assert.strictEqual(build('getCollectibles', 'address'),
            `${base} AND a2.address=?`);
    });

    it('getTokens appends the ticker search for token and subtoken types', function(){
        const expected = `${anchor} AND t3.tick LIKE ?`;

        assert.strictEqual(build('getTokens', 'token'), expected);
        assert.strictEqual(build('getTokens', 'subtoken'), expected);
    });

    it('getTokens delegates every other type to genericClause', function(){
        for (const type of ['address', 'block', 'source', 'unknown']) {
            const config = { data: { method: 'getTokens', type, search3: null } };
            const expected = genericClause(db, config, anchor);

            assert.strictEqual(build('getTokens', type), expected);
        }
    });
});
