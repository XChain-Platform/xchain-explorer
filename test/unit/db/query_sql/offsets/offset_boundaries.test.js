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
    historyCursor,
    pagesOverBlocks,
    addressBoundaryWhere,
    tokenBoundaryWhere
} = require('../../../../../src/db/query_sql/offset_boundaries.js');

describe('historyCursor', function(){
    it('cursors on the mapping table for the address and token history feeds', function(){
        assert.strictEqual(historyCursor('getHistory', 'address').hCursor, 'm.action_index');
        assert.strictEqual(historyCursor('getHistory', 'token').hCursor, 'm.action_index');
        assert.match(historyCursor('getHistory', 'address').hSource, /^mappings_actions m/);
    });

    it('cursors on the raw actions table for every other type or method', function(){
        assert.strictEqual(historyCursor('getHistory', 'block').hCursor, 'a1.action_index');
        assert.strictEqual(historyCursor('getSends', 'address').hCursor, 'a1.action_index');
        assert.strictEqual(historyCursor('getSends', 'address').hSource, 'actions a1');
    });
});

describe('pagesOverBlocks', function(){
    it('is true only for the blocks table', function(){
        assert.strictEqual(pagesOverBlocks('blocks'), true);
        assert.strictEqual(pagesOverBlocks('actions'), false);
        assert.strictEqual(pagesOverBlocks(undefined), false);
    });
});

describe('addressBoundaryWhere', function(){
    it('filters on source or destination for the message/mint/send/sweep lane', function(){
        const { where, whereArgs } = addressBoundaryWhere('getSends', 42);
        // A UNION of index-friendly arms (own source, inherited tx source, destination)
        // replaced the COALESCE filter, which no index could serve.
        assert.match(where, /^ AND m\.action_index IN \(SELECT pu\.action_index FROM \(/);
        assert.match(where, /pa\.source_id IS NULL AND pt\.source_id=\?/);
        assert.match(where, /px\.destination_id=\?/);
        assert.deepStrictEqual(whereArgs, [42, 42, 42]);
    });

    it('filters on owner_id for getTokens', function(){
        const { where, whereArgs } = addressBoundaryWhere('getTokens', 7);
        assert.strictEqual(where, ` AND m.owner_id=?`);
        assert.deepStrictEqual(whereArgs, [7]);
    });

    it('falls back to the own-or-inherited source filter for an unlisted method', function(){
        const { where, whereArgs } = addressBoundaryWhere('getSomethingElse', 3);
        assert.strictEqual(where, ` AND (a1.source_id=? OR (a1.source_id IS NULL AND t1.source_id=?))`);
        assert.deepStrictEqual(whereArgs, [3, 3]);
    });
});

describe('tokenBoundaryWhere', function(){
    it('filters on either side of the pair for orders and swaps', function(){
        const { where, whereArgs } = tokenBoundaryWhere('getOrders', 5);
        assert.strictEqual(where, ` AND (m.get_tick_id=? OR m.give_tick_id=?)`);
        assert.deepStrictEqual(whereArgs, [5, 5]);
    });

    it('filters on the given-out token for dispensers and dispenses', function(){
        const { where, whereArgs } = tokenBoundaryWhere('getDispensers', 6);
        assert.strictEqual(where, ` AND m.get_tick_id=?`);
        assert.deepStrictEqual(whereArgs, [6]);
    });

    it('falls back to the plain tick_id filter for an unlisted method', function(){
        const { where, whereArgs } = tokenBoundaryWhere('getIssues', 7);
        assert.strictEqual(where, ` AND m.tick_id=?`);
        assert.deepStrictEqual(whereArgs, [7]);
    });
});
