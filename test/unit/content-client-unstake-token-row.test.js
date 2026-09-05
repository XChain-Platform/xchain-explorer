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
 * Token row on the UNSTAKE action detail page.
 *
 * Once UNSTAKE_COOLDOWN_COMPLETION_ACTION is active the indexer mints a
 * synthetic UNSTAKE (action_format 2) at the cooldown-expiry block to carry
 * the return credit. It has no unstakes / contract_unstakes row, so the detail
 * query's target_contract_index comes back NULL even when the matured release
 * was contract-targeted and denominated in an arbitrary token. The UNSTAKE
 * handler recovers amount and tick from that credit
 * (src/action-detail/staking.js, afterEffects).
 *
 * The constraint under test: the Token row is gated on the TICK, never on the
 * contract index. Bundled under one class with the Contract row, the recovered
 * tick could not render for the one shape it was recovered for, and a non-gas
 * release read as a bare gas-coin amount.
 *
 * The markup is loaded from the SHIPPED action.html rather than a hand-built
 * fixture, so a renamed class fails here instead of silently rendering
 * nothing.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT = path.resolve(__dirname, '../../src/content');
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

const hidden = (win, sel) => win.jQuery(sel).hasClass('d-none');

describe('UNSTAKE detail: Token row @regression', function(){

    it('shows the token on a cooldown completion that has no contract index', function(){
        const win = bootPage();
        win.showUnstakeDetails({
            action_format: 2, status: 'valid', signing_pubkey: null,
            amount: '12.50000000', cooldown_end_block: null,
            target_contract_index: null, tick: 'SOMETOKEN'
        });
        // Assert the row EXISTS before asserting it is shown: hasClass() on an
        // empty set is false, so a renamed or deleted row would otherwise read
        // as "visible" and this test could never say no.
        expect(win.jQuery('#info-unstake .unstake-token-row').length).to.equal(1);
        expect(hidden(win, '#info-unstake .unstake-token-row')).to.equal(false);
        expect(win.jQuery('#info-unstake .unstake-tick').html()).to.contain('SOMETOKEN');
        // The contract is genuinely unknown on the synthetic action, so that row
        // stays hidden rather than naming a contract nobody resolved.
        expect(hidden(win, '#info-unstake .unstake-contract-row')).to.equal(true);
    });

    it('still shows both rows for a contract-targeted unstake that carries its own row', function(){
        const win = bootPage();
        win.showUnstakeDetails({
            action_format: 1, status: 'valid', signing_pubkey: 'aa'.repeat(32),
            amount: '4.00000000', cooldown_end_block: 900,
            target_contract_index: 4242, tick: 'MYTOKEN'
        });
        expect(hidden(win, '#info-unstake .unstake-contract-row')).to.equal(false);
        expect(hidden(win, '#info-unstake .unstake-token-row')).to.equal(false);
        expect(win.jQuery('#info-unstake .unstake-contract').html()).to.contain('4242');
        expect(win.jQuery('#info-unstake .unstake-tick').html()).to.contain('MYTOKEN');
    });

    it('hides both rows for an ordinary capability unstake', function(){
        const win = bootPage();
        win.showUnstakeDetails({
            action_format: 0, status: 'valid', signing_pubkey: 'cc'.repeat(32),
            amount: '250.00000000', cooldown_end_block: 500,
            target_contract_index: null, tick: null
        });
        expect(hidden(win, '#info-unstake .unstake-contract-row')).to.equal(true);
        expect(hidden(win, '#info-unstake .unstake-token-row')).to.equal(true);
    });
});
