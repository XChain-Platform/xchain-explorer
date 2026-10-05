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
    apiPageOffset,
    explorerLimits
} = require('../../../../src/db/query_sql/query_limits.js');

const db = { util: { isInteger: Number.isInteger, bcadd: (a, b) => Number(a) + Number(b) } };

function offsetFor(q, limit){
    const config = { data: { sql: {} } };
    apiPageOffset(db, config, q, limit);
    return config.data.sql.apiOffset;
}

function limitsFor(method, q, order, type){
    const config = { data: { method, type, query: q, offset: {} } };
    return explorerLimits(db, config, q, 50, 10, order || 'DESC');
}

describe('apiPageOffset', function(){
    it('derives the offset from the page and limit', function(){
        assert.strictEqual(offsetFor({ page: '3' }, 25), 50);
    });

    it('falls back to the first page for a missing, non-numeric or zero page', function(){
        assert.strictEqual(offsetFor({}, 25), 0);
        assert.strictEqual(offsetFor({ page: 'abc' }, 25), 0);
        assert.strictEqual(offsetFor({ page: '0' }, 25), 0);
    });

    it('caps the offset at 100000', function(){
        assert.strictEqual(offsetFor({ page: '99999999' }, 25), 100000);
    });
});

describe('explorerLimits page size', function(){
    it('defaults to 10 for an empty or unusable query', function(){
        assert.deepStrictEqual(limitsFor('getBlocks', {}), { limit: 10, order: 'DESC' });
        assert.deepStrictEqual(limitsFor('getBlocks', { start: 'abc', length: 'xyz' }), { limit: 10, order: 'DESC' });
    });

    it('clamps the length to the method max', function(){
        assert.strictEqual(limitsFor('getBlocks', { length: 500 }).limit, 50);
    });

    it('sizes the last page from the total, clamped to the max', function(){
        const last = limitsFor('getBlocks', { action: 'last', total: 42 });
        assert.deepStrictEqual(last, { limit: 42, order: 'ASC' });
        assert.strictEqual(limitsFor('getBlocks', { action: 'last', total: '1e15' }).limit, 50);
        assert.strictEqual(limitsFor('getBlocks', { action: 'last', total: 'abc' }).limit, 10);
    });

    it('orders ascending for a prev action', function(){
        assert.strictEqual(limitsFor('getBlocks', { action: 'prev' }).order, 'ASC');
    });
});

describe('explorerLimits fetch-and-slice methods', function(){
    it('caps the start at 100000 before adding the length', function(){
        assert.strictEqual(limitsFor('getBalances', { start: 500000, length: 10 }).limit, 100010);
    });

    it('covers start plus length for token searches only', function(){
        assert.strictEqual(limitsFor('getTokens', { start: 5, length: 10 }, 'DESC', 'token').limit, 15);
        assert.strictEqual(limitsFor('getTokens', { start: 5, length: 10 }, 'DESC', 'other').limit, 10);
    });

    it('rewrites a prev action to next for holders', function(){
        const q = { action: 'prev' };
        const config = { data: { method: 'getHolders', query: q, offset: { action: 'prev' } } };
        explorerLimits(db, config, q, 50, 10, 'DESC');
        assert.strictEqual(q.action, 'next');
        assert.strictEqual(config.data.offset.action, 'next');
    });
});
