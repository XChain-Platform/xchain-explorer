'use strict';

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
 * Unit tests for pagingWindow: start, limit, offset, action and cursorLast
 * for api and explorer requests. Pure; no network or database.
 */

const assert = require('assert');
const { pagingWindow } = require('../../../../src/explorer/paging/window.js');

const util = {
    isInteger: Number.isInteger,
    isNull:    (v) => v == null,
    bcadd:     (a, b) => Number(a) + Number(b)
};

function makeDb(cursorPagedMethods){
    return { getMaxMethodResults: () => 50, cursorPagedMethods };
}

function window(type, method, query, offset, db){
    const data = { method };
    if(query !== undefined) data.query = query;
    if(offset !== undefined) data.offset = offset;
    return pagingWindow(util, db || makeDb(['getAnchors']), { type, data });
}

describe('pagingWindow defaults', function(){
    it('gives an explorer request with no query the first page of ten', function(){
        assert.deepStrictEqual(window('explorer', 'getBlocks'),
            { start: 0, limit: 10, offset: false, action: false, cursorLast: false });
    });
});

describe('pagingWindow api requests', function(){
    it('leaves start at 0 because the SQL OFFSET already paged', function(){
        const w = window('api', 'getBlocks', { start: '30', limit: '20' });
        assert.strictEqual(w.start, 0);
        assert.strictEqual(w.limit, 20);
    });

    it('clamps a limit above the method max down to it', function(){
        assert.strictEqual(window('api', 'getBlocks', { limit: '500' }).limit, 50);
    });

    it('clamps a limit of 0 up to 1', function(){
        assert.strictEqual(window('api', 'getBlocks', { limit: '0' }).limit, 1);
        assert.strictEqual(window('api', 'getBlocks', { limit: -5 }).limit, 1);
    });
});

describe('pagingWindow explorer length handling', function(){
    it('caps length at 100 for an ordinary method', function(){
        assert.strictEqual(window('explorer', 'getTokens', { start: '5', length: '500' }).limit, 105);
    });

    it('exempts getHolders from the 100 cap', function(){
        assert.strictEqual(window('explorer', 'getHolders', { start: '5', length: '500' }).limit, 505);
    });

    it('caps an exempt method at 10000', function(){
        assert.strictEqual(window('explorer', 'getHolders', { length: '20000' }).limit, 10000);
    });

    it('falls back to start 0 and length 10 for non-numeric input', function(){
        const w = window('explorer', 'getBlocks', { start: 'abc', length: 'x' });
        assert.strictEqual(w.start, 0);
        assert.strictEqual(w.limit, 10);
    });
});

describe('pagingWindow offset and action', function(){
    it('passes a cursor offset and action through', function(){
        const w = window('explorer', 'getBlocks', undefined, { start: 7, action: 'last' });
        assert.strictEqual(w.offset, 7);
        assert.strictEqual(w.action, 'last');
    });

    it('returns offset false for a null offset start', function(){
        assert.strictEqual(window('explorer', 'getBlocks', undefined, { start: null }).offset, false);
    });
});

describe('pagingWindow cursorLast', function(){
    const last = { start: 1, action: 'last' };

    it('is true for the last action on a cursor-paged method', function(){
        assert.strictEqual(window('explorer', 'getAnchors', undefined, last).cursorLast, true);
    });

    it('is false for a method that is not cursor-paged', function(){
        assert.strictEqual(window('explorer', 'getBlocks', undefined, last).cursorLast, false);
    });

    it('is false for another action on a cursor-paged method', function(){
        assert.strictEqual(window('explorer', 'getAnchors', undefined, { start: 1, action: 'next' }).cursorLast, false);
    });

    it('is false when the db has no cursorPagedMethods', function(){
        assert.strictEqual(window('explorer', 'getAnchors', undefined, last, makeDb(undefined)).cursorLast, false);
    });
});
