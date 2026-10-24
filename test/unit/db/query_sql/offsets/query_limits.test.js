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

const { apiPageOffset, explorerLimits } = require('../../../../../src/db/query_sql/query_limits.js');
const Utility = require('../../../../../src/lib/utility.js');

const util = new Utility();

function fakeDb(){
    return { util };
}

describe('apiPageOffset', function(){
    it('computes SQL OFFSET from a 1-based page and the page limit', function(){
        const config = { data: { sql: {} } };
        apiPageOffset(fakeDb(), config, { page: 3 }, 10);
        assert.strictEqual(config.data.sql.apiOffset, 20);
    });

    it('defaults to page 1 when the query carries no usable page number', function(){
        const config = { data: { sql: {} } };
        apiPageOffset(fakeDb(), config, {}, 10);
        assert.strictEqual(config.data.sql.apiOffset, 0);
    });

    it('refuses a positional page past the 100000-row cap', function(){
        const config = { data: { sql: {} } };
        assert.throws(() => apiPageOffset(fakeDb(), config, { page: 1000000 }, 100), { code: 'PAGE_TOO_DEEP' });
    });

    it('lets a keyset bound through a deep page with a zero offset', function(){
        const config = { data: { sql: {} } };
        apiPageOffset(fakeDb(), config, { page: 1000000, before: 5 }, 100);
        assert.strictEqual(config.data.sql.apiOffset, 0);
    });
});

describe('explorerLimits', function(){
    it('defaults start to zero when it is absent', function(){
        const config = { data: { method: 'getSends', query: {}, offset: {} } };
        const { limit } = explorerLimits(fakeDb(), config, { length: 5 }, 50, 0, 'DESC');
        assert.strictEqual(limit, 5);
    });

    it('refuses malformed row offsets instead of silently reading the first page', function(){
        const bad = ['nope', '-1', '1.5', '1e3', 'NaN', '9007199254740992', ['1', '2']];
        for(const start of bad){
            const config = { data: { method: 'getSends', query: {}, offset: {} } };
            assert.throws(() => explorerLimits(fakeDb(), config, { start, length: 5 }, 50, 0, 'DESC'),
                { code: 'INVALID_START' }, JSON.stringify(start));
        }
    });

    it('refuses malformed record totals that size the last page', function(){
        const bad = ['nope', '-1', '1.5', '1e3', 'NaN', '9007199254740992', ['1', '2']];
        for(const total of bad){
            const config = { data: { method: 'getSends', query: { total }, offset: {} } };
            assert.throws(() => explorerLimits(fakeDb(), config,
                { start: '0', length: '5', total }, 50, 0, 'DESC'),
            { code: 'INVALID_TOTAL' }, JSON.stringify(total));
        }
    });

    it('clamps length to the method max', function(){
        const config = { data: { method: 'getSends', query: {}, offset: {} } };
        const { limit } = explorerLimits(fakeDb(), config, { start: 0, length: 999 }, 50, 0, 'DESC');
        assert.strictEqual(limit, 50);
    });

    it('flips a plain prev/last action to ASC order', function(){
        const config = { data: { method: 'getSends', query: { action: 'prev' }, offset: { action: 'prev' } } };
        const { order } = explorerLimits(fakeDb(), config, { start: 0, length: 10, action: 'prev' }, 50, 0, 'DESC');
        assert.strictEqual(order, 'ASC');
    });

    it('rewrites a fetch-and-slice method\'s prev/last action to next instead of paging backward', function(){
        const config = { data: { method: 'getHolders', query: { action: 'prev' }, offset: { action: 'prev' } } };
        explorerLimits(fakeDb(), config, { start: 0, length: 10, action: 'prev' }, 50, 0, 'DESC');
        assert.strictEqual(config.data.query.action, 'next');
        assert.strictEqual(config.data.offset.action, 'next');
    });

    it('sizes the jump-to-last window from the clamped tail, not the raw total', function(){
        const config = { data: { method: 'getSends', query: { total: 1e15 }, offset: {} } };
        const { limit } = explorerLimits(fakeDb(), config, { start: 0, length: 10, action: 'last' }, 50, 0, 'DESC');
        assert.strictEqual(limit, 50);
    });
});
