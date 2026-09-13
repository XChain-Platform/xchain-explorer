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
 * ROLLCALL eviction label on the UNSTAKE action detail page.
 *
 * The BTC indexer evicts a validator that misses K roll-call epochs by
 * writing a synthetic UNSTAKE (action_format 3, tx_index NULL, source_id
 * NULL). That row is not a holder's choice, so showUnstakeDetails must badge
 * it "Evicted" rather than render it as an ordinary capability unstake.
 *
 * The constraint under test: a user CAN broadcast a wire UNSTAKE|3|... of
 * their own, but the indexer rejects it (invalid: VERSION unknown), landing
 * it with status 'invalid'. Labelling on action_format alone would let
 * anyone mint an action that reads as somebody being evicted, so the badge
 * requires BOTH action_format===3 AND status==='valid'.
 *
 * The markup is loaded from the SHIPPED action.html rather than a hand-built
 * fixture, matching content-client-action-detail-render.test.js, so a
 * renamed class in either file fails here instead of silently rendering
 * nothing again.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT = path.resolve(__dirname, '../../src/content');
// The client ships as formatters.js plus xchain.js, and showUnstakeDetails calls
// isNull, which lives in the first. The helper joins them the way the browser
// loads them, so this realm sees the same globals a page does.
const SOURCE  = require('../helpers/content-source.js');
const JQUERY  = path.join(CONTENT, 'js', 'jquery.min.js');
const ACTION  = path.join(CONTENT, 'html', 'action.html');

function bootPage(){
    const markup = fs.readFileSync(ACTION, 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RBTC/action/1'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(SOURCE.clientSource());
    win.XC = win.XC || {};
    win.XC.coin = 'RBTC';
    return win;
}

const html = (win, sel) => win.jQuery(sel).html();

describe('UNSTAKE detail: ROLLCALL eviction label @regression', function(){

    it('badges a valid format-3 UNSTAKE as Evicted', function(){
        const win = bootPage();
        win.showUnstakeDetails({
            action_format: 3, signing_pubkey: 'aa'.repeat(32),
            amount: '1000.00000000', cooldown_end_block: 900, status: 'valid'
        });
        const cell = html(win, '#info-unstake .unstake-amount');
        expect(cell).to.contain('Evicted');
        expect(cell).to.contain('1,000.00000000');
    });

    it('does NOT read as an eviction when a format-3 UNSTAKE is invalid (a user-broadcast forgery the indexer rejected)', function(){
        const win = bootPage();
        win.showUnstakeDetails({
            action_format: 3, signing_pubkey: 'bb'.repeat(32),
            amount: '5.00000000', cooldown_end_block: null, status: 'invalid'
        });
        const cell = html(win, '#info-unstake .unstake-amount');
        expect(cell).to.not.contain('Evicted');
    });

    it('does not badge an ordinary valid capability unstake (action_format 0)', function(){
        const win = bootPage();
        win.showUnstakeDetails({
            action_format: 0, signing_pubkey: 'cc'.repeat(32),
            amount: '250.00000000', cooldown_end_block: 500, status: 'valid'
        });
        const cell = html(win, '#info-unstake .unstake-amount');
        expect(cell).to.not.contain('Evicted');
    });

    it('does not badge a valid UNSTAKE v2 cooldown-completion (action_format 2)', function(){
        const win = bootPage();
        win.showUnstakeDetails({
            action_format: 2, signing_pubkey: null,
            amount: '5.00000000', cooldown_end_block: null, status: 'valid'
        });
        const cell = html(win, '#info-unstake .unstake-amount');
        expect(cell).to.not.contain('Evicted');
    });
});
