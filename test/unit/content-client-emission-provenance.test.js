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
 *
 * Two action-page render defects found by driving the RDOGE regtest venue:
 *
 *   - A VM-emitted action has no wire string of its own, so `tx_data` on its
 *     detail row is the PARENT EXECUTE's string. The page labelled it
 *     "Transaction Data", which on a per-ACTION page reads as this action's
 *     own data - and it is the field the E2E campaign cross-checks every
 *     rendered value against. Driven at /RDOGE/action/1211, which showed
 *     `EXECUTE|0|1209|shout` on a BROADCAST page.
 *   - A BROADCAST batch child rendered `Fee: %` with no number, because FEE
 *     is an OPTIONAL v1/v2 wire field and the label was emitted regardless.
 *     Driven at /RDOGE/action/1196 (child 1197, a v2 feed with no FEE).
 *
 * The markup is loaded from the SHIPPED action.html rather than a hand-built
 * fixture, so a renamed id in either file fails here instead of silently
 * rendering nothing again.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT = path.resolve(__dirname, '../../src/content');
const CLIENT  = path.join(CONTENT, 'js', 'xchain.js');
const JQUERY  = path.join(CONTENT, 'js', 'jquery.min.js');
const ACTION  = path.join(CONTENT, 'html', 'action.html');
const MATH    = path.join(CONTENT, 'js', 'math.min.js');

function bootPage(){
    const markup = fs.readFileSync(ACTION, 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/action/1211'
    });
    const win = dom.window;
    // Behaves like the shipped numeral: format(pattern) only. A stub that swallowed any
    // arguments once certified a call site written as .format(0,0), which the real numeral
    // rejects with "roundingFunction is not a function" - green here, broken on the page.
    win.numeral = function(v){
        return { format: function(pattern, rounding){
            if(pattern !== undefined && typeof pattern !== "string")
                throw new TypeError("numeral format pattern must be a string, got " + typeof pattern);
            if(rounding !== undefined && typeof rounding !== "function")
                throw new TypeError("roundingFunction is not a function");
            return String(v);
        } };
    };
    win.moment  = function(){ return { utcOffset: function(){ return { format: function(){ return ''; } }; } }; };
    win.moment.unix = win.moment;
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    // showTransactionDetails ends by wiring the page's DataTables, and the BROADCAST
    // summary prices its fee through mathjs. Neither is under test here; stub both so
    // the render half can be driven on its own, as content-client-multileg-render does.
    win.jQuery.fn.dataTable = function(){ return this; };
    win.jQuery.fn.dataTable.ext = { errMode: null };
    win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
    win.eval(fs.readFileSync(MATH, 'utf8'));
    win.eval(fs.readFileSync(CLIENT, 'utf8'));
    win.XC = win.XC || {};
    win.XC.coin = 'RDOGE';
    return win;
}

const text = (win, sel) => win.jQuery(sel).text().trim();
const shown = (win, sel) => win.jQuery(sel).css('display') !== 'none';

// The emitted BROADCAST 1211 as the API serves it, with its parent EXECUTE 1210.
function emittedAction(){
    return {
        action: 'BROADCAST', action_format: 0, action_index: '1211',
        source: 'C:DOGE:1209', status: 'valid', tx_index: '1121', block_index: '2925',
        timestamp: '1787864911', message: 'emit-probe hello', value: '1',
        tx_data: 'EXECUTE|0|1209|shout',
        emitted_by: { execution_index: '1210', position: 0, contract_index: '1209',
                      caller: 'myAzbjaNuvmf7J8J88v4tc5EVKLs3Z9Tq5' }
    };
}

describe('action page: a VM-emitted action says where it came from', function(){

    it('names the emitting EXECUTE, its contract and the emission position', function(){
        const win = bootPage();
        win.XC.actionInfo = emittedAction();
        win.showTransactionDetails();
        expect(shown(win, '#emitted-by-row'), 'provenance row shown').to.equal(true);
        const html = win.jQuery('#emitted-by').html();
        expect(html).to.contain('/RDOGE/action/1210');
        expect(html).to.contain('/RDOGE/contract/1209');
        expect(text(win, '#emitted-by')).to.contain('emission #1');
    });

    it('labels tx_data as the EMITTING execute\'s string, not this action\'s own', function(){
        const win = bootPage();
        win.XC.actionInfo = emittedAction();
        win.showTransactionDetails();
        expect(text(win, '#tx-data-label')).to.equal('Transaction Data (emitting EXECUTE)');
        // The parent's string is still shown - it is real and traceable - just not
        // presented as if this BROADCAST had been broadcast in that form.
        expect(text(win, '#tx-data')).to.equal('EXECUTE|0|1209|shout');
    });

    it('leaves an ordinary broadcast action untouched: no row, plain label', function(){
        const win = bootPage();
        const o = emittedAction();
        o.emitted_by = null;
        o.tx_data = 'BROADCAST|0|hello';
        win.XC.actionInfo = o;
        win.showTransactionDetails();
        expect(shown(win, '#emitted-by-row'), 'provenance row hidden').to.equal(false);
        expect(text(win, '#tx-data-label')).to.equal('Transaction Data');
    });

    it('ignores a provenance block with no execution index rather than half-rendering it', function(){
        const win = bootPage();
        const o = emittedAction();
        o.emitted_by = { execution_index: null, position: null, contract_index: null, caller: null };
        win.XC.actionInfo = o;
        win.showTransactionDetails();
        expect(shown(win, '#emitted-by-row')).to.equal(false);
        expect(text(win, '#tx-data-label')).to.equal('Transaction Data');
    });
});

describe('action page: a BROADCAST summary states a fee only when it has one', function(){

    it('renders no Fee clause for a v2 feed broadcast with no FEE field', function(){
        const win = bootPage();
        const html = win.getActionDetails('BROADCAST', {
            action_format: 2, message: 'Tier-2 batch ok child', broadcast_fee: null
        });
        expect(html).to.contain('Tier-2 batch ok child');
        expect(html, 'no orphaned percent sign').to.not.contain('%');
        expect(html, 'no orphaned Fee label').to.not.contain('Fee:');
    });

    it('renders no Fee clause for a v1 oracle broadcast with no FEE field', function(){
        const win = bootPage();
        const html = win.getActionDetails('BROADCAST', {
            action_format: 1, message: 'DOGE/USD', value: '0.06', broadcast_fee: null
        });
        expect(html, 'no orphaned percent sign').to.not.contain('%');
        expect(html, 'no orphaned Fee label').to.not.contain('Fee:');
    });

    it('still renders the fee when the broadcast actually declared one', function(){
        const win = bootPage();
        const html = win.getActionDetails('BROADCAST', {
            action_format: 2, message: 'paid feed', broadcast_fee: '0.05'
        });
        expect(html).to.contain('Fee:');
        expect(html).to.contain('5.00%');
    });
});
