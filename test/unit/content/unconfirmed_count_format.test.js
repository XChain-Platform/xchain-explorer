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
 *********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '../../..');
const SRC = fs.readFileSync(
    path.join(ROOT, 'src/content/js/xchain/address_utils.js'), 'utf8');
const HOME = fs.readFileSync(
    path.join(ROOT, 'src/content/html/coin_home.html'), 'utf8');
const numeral = require(path.join(ROOT, 'src/content/js/numeral.js'));

function extractFn(name){
    const start = SRC.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('function not found: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0;
    for(let end = braceStart; end < SRC.length; end++){
        if(SRC[end] === '{') depth++;
        else if(SRC[end] === '}' && --depth === 0) return SRC.slice(start, end + 1);
    }
    throw new Error('function not closed: ' + name);
}

function helperContext(){
    const context = vm.createContext({ numeral });
    vm.runInContext(extractFn('isNumeric'), context);
    vm.runInContext(extractFn('formatUnconfirmedCount'), context);
    return context;
}

describe('unconfirmed count formatting', function(){
    it('marks unavailable mempool reads without displaying a zero', function(){
        const context = helperContext();
        assert.strictEqual(context.formatUnconfirmedCount(null), 'unavailable');
        assert.strictEqual(context.formatUnconfirmedCount(undefined), 'unavailable');
        assert.strictEqual(context.formatUnconfirmedCount('not-a-number'), 'unavailable');
    });

    it('formats numeric mempool counts', function(){
        const context = helperContext();
        assert.strictEqual(context.formatUnconfirmedCount(0), '0');
        assert.strictEqual(context.formatUnconfirmedCount(1234), '1,234');
        assert.strictEqual(context.formatUnconfirmedCount('57'), '57');
    });

    it('uses the helper at both coin home render sites', function(){
        const helperCalls = HOME.match(/formatUnconfirmedCount\(o\.network\.unconfirmed\)/g) || [];
        assert.strictEqual(helperCalls.length, 2);
        assert.strictEqual(HOME.includes('numeral(o.network.unconfirmed)'), false);
    });
});
