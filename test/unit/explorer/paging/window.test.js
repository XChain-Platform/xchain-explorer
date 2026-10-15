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

const { pagingWindow } = require('../../../../src/explorer/paging/window.js');
const Utility = require('../../../../src/lib/utility.js');

const util = new Utility();

function fakeDb({ max = 50, cursorPagedMethods = [] } = {}){
    return {
        getMaxMethodResults: () => max,
        cursorPagedMethods
    };
}

describe('pagingWindow', function(){
    it('defaults start/limit/length when the request query carries none', function(){
        const cfg = { type: 'api', data: { method: 'getSends', query: false, offset: false } };
        const win = pagingWindow(util, fakeDb({ max: 50 }), cfg);
        assert.deepStrictEqual(win, { start: 0, limit: 50, offset: false, action: false, cursorLast: false });
    });

    it('forces start to 0 for an api request regardless of the query', function(){
        const cfg = { type: 'api', data: { method: 'getSends', query: { start: 40 }, offset: false } };
        const win = pagingWindow(util, fakeDb({ max: 50 }), cfg);
        assert.strictEqual(win.start, 0);
    });

    it('carries the offset and action through from cfg.data.offset', function(){
        const cfg = {
            type: 'api',
            data: { method: 'getSends', query: false, offset: { start: 77, action: 'next' } }
        };
        const win = pagingWindow(util, fakeDb({ max: 50 }), cfg);
        assert.strictEqual(win.offset, 77);
        assert.strictEqual(win.action, 'next');
    });

    it('sets cursorLast only for action=last on a cursor-paged method', function(){
        const cfg = {
            type: 'api',
            data: { method: 'getSlashEvents', query: false, offset: { start: false, action: 'last' } }
        };
        const cursorPagedDb = fakeDb({ max: 50, cursorPagedMethods: ['getSlashEvents'] });
        assert.strictEqual(pagingWindow(util, cursorPagedDb, cfg).cursorLast, true);

        const plainDb = fakeDb({ max: 50, cursorPagedMethods: [] });
        assert.strictEqual(pagingWindow(util, plainDb, cfg).cursorLast, false);
    });
});

describe('pagingWindow explorer-type length clamps', function(){
    it('clamps an explorer request length to 100 and derives limit from start+length', function(){
        const cfg = {
            type: 'explorer',
            data: {
                method: 'getSends',
                query: { start: 30, length: 500 },
                offset: false
            }
        };
        const win = pagingWindow(util, fakeDb({ max: 1000 }), cfg);
        // length clamps to 100, limit = bcadd(start, length) = 130 (a mathjs
        // bignumber, not a plain number, hence the Number() coercion below)
        assert.strictEqual(win.start, 30);
        assert.strictEqual(Number(win.limit), 130);
    });

    it('lets an offset-exempt explorer method carry a length up to 10000 before it clamps', function(){
        const cfg = {
            type: 'explorer',
            data: {
                method: 'getHolders',
                query: { start: 0, length: 5000 },
                offset: false
            }
        };
        const win = pagingWindow(util, fakeDb({ max: 100000 }), cfg);
        assert.strictEqual(Number(win.limit), 5000);

        const over = pagingWindow(util, fakeDb({ max: 100000 }), {
            type: 'explorer',
            data: { method: 'getHolders', query: { start: 0, length: 20000 }, offset: false }
        });
        assert.strictEqual(Number(over.limit), 10000);
    });
});
