/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The client system-action summary part renders populated expiry, roll-call,
 * and bridge rows while leaving sparse and unrelated rows unchanged. Runs the
 * shipped function sliced out of the page-loaded client parts.
 */
'use strict';

const { srcText } = require('../../../helpers/source_text');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = srcText('src/content/js/xchain.js');

function extractFn(name){
    const start = SRC.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('function not found in xchain.js: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0;
    let i = braceStart;
    for(; i < SRC.length; i++){
        if(SRC[i] === '{') depth++;
        else if(SRC[i] === '}'){
            depth--;
            if(depth === 0){ i++; break; }
        }
    }
    return SRC.slice(start, i);
}

function makeWindow(){
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
    const contentJs = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'content', 'js');
    dom.window.eval(fs.readFileSync(path.join(contentJs, 'network_coin.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.join(contentJs, 'formatters.js'), 'utf8'));
    dom.window.eval('function formatAmount(v){ return String(v); }');
    dom.window.XC = { coin: 'TDOGE' };
    dom.window.numeral = function(v){ return { format: function(){ return String(v); } }; };
    dom.window.eval(extractFn('actionDetail_renderSystemActions'));
    return dom.window;
}

function render(type, info, initial){
    return makeWindow().actionDetail_renderSystemActions(initial || '', type, info, 'TDOGE');
}

describe('client: system action summaries', function(){
    it('renders a bet expiry with plural refunds and a linked total', function(){
        const html = render('BET_EXPIRE', {
            feed_action_index: 1193, tick: 'DANK', refund_count: 2, refund_amount: '15.5'
        });
        expect(html).to.include('/TDOGE/action/1193');
        expect(html).to.include('2 refunds');
        expect(html).to.include('/TDOGE/token/DANK');
        expect(html).to.include('15.5');
    });

    it('renders one refund without a total when no amount is present', function(){
        const html = render('BET_EXPIRE', { feed_action_index: 1193, tick: 'DANK', refund_count: 1 });
        expect(html).to.include('1 refund');
        expect(html).to.not.include('1 refunds');
        expect(html).to.not.include('totalling');
    });

    it('renders a roll call epoch', function(){
        expect(render('ROLLCALL', { epoch_height: 4200 })).to.equal('Roll call for epoch 4200');
    });

    it('renders a bridge destination with escaped external address text', function(){
        const html = render('XBRIDGE', {
            tick: 'DANK', dest_chain: 'DOGE', dest_address: '<b>x</b>', bridge_kind: 'settle'
        });
        expect(html).to.include('/TDOGE/token/DANK');
        expect(html).to.include('to DOGE');
        expect(html).to.include('&lt;b&gt;x&lt;/b&gt;');
        expect(html).to.include('(settle)');
        expect(html).to.not.include('<b>');
    });

    it('renders an expired obligation link', function(){
        expect(render('COINPAY_EXPIRE', { obligation_action_index: 77 })).to.include('/TDOGE/action/77');
    });

    it('leaves every sparse system action unchanged', function(){
        for(const type of ['BET_EXPIRE', 'ROLLCALL', 'XBRIDGE', 'COINPAY_EXPIRE'])
            expect(render(type, {}, 'keep')).to.equal('keep');
    });

    it('leaves an unrelated action unchanged', function(){
        expect(render('SEND', { tick: 'DANK' }, 'keep')).to.equal('keep');
    });
});
