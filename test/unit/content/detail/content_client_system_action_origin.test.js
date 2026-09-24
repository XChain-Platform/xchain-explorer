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
 * A system-injected Tier 4 action (BET_EXPIRE, an ORDER/SWAP/DISPENSER match
 * or expiry, DISPENSE, DISPENSER_CLOSE, CROSS_SETTLE, a mirror-applied ATTEST
 * v1 response) has a real action_index and block_index but no source
 * transaction, so source, transaction hash, transaction index and
 * transaction data all served null. The shared Transaction Information card
 * rendered each as a bare "-", so a real action read as a broken page.
 * The renderer now states what it is instead: a protocol-generated
 * origin and an explicit not-applicable for the transaction-only fields,
 * driven off the one signal every Tier 4 family shares (no tx_index), so one
 * fix covers all of them rather than naming each action type.
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

const CONTENT = path.resolve(__dirname, '..', '..', '../../src/content');
const CLIENT_SRC  = require('../../../helpers/content-source.js').clientSource();
const JQUERY  = path.join(CONTENT, 'js', 'jquery.min.js');
const ACTION  = path.join(CONTENT, 'html', 'action.html');

function bootPage(){
    const markup = fs.readFileSync(ACTION, 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/action/2201'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.moment  = function(){ return { utcOffset: function(){ return { format: function(){ return ''; } }; } }; };
    win.moment.unix = win.moment;
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    // showTransactionDetails ends by wiring the page's DataTables, which is not
    // under test here; stub it so the render half can be driven on its own, as
    // content_client_emission_provenance.test.js does.
    win.jQuery.fn.dataTable = function(){ return this; };
    win.jQuery.fn.dataTable.ext = { errMode: null };
    win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
    win.eval(CLIENT_SRC);
    win.XC = win.XC || {};
    win.XC.coin = 'RDOGE';
    return win;
}

const text = (win, sel) => win.jQuery(sel).text().trim();

// BET_EXPIRE as the reader's de-blank baseline serves it: a real action_index
// and block_index, no tx_index, no source, no tx_hash - the shape every
// system-injected Tier 4 family shares.
function betExpireAction(){
    return {
        action: 'BET_EXPIRE', action_format: 0, action_index: '2201',
        source: null, status: 'valid', tx_index: null, tx_hash: null,
        block_index: '2933', timestamp: '1787864999', tx_data: null
    };
}

describe('action page: a system-injected Tier 4 action states where it came from', function(){

    it('renders a protocol-generated origin instead of a dash', function(){
        const win = bootPage();
        win.XC.actionInfo = betExpireAction();
        win.showTransactionDetails();
        expect(text(win, '#source')).to.equal('Protocol-generated');
    });

    it('renders not-applicable, never a bare dash, for the transaction-only fields', function(){
        const win = bootPage();
        win.XC.actionInfo = betExpireAction();
        win.showTransactionDetails();
        expect(text(win, '#tx-hash')).to.equal('Not applicable, no source transaction');
        expect(text(win, '#tx-index')).to.equal('Not applicable, no source transaction');
        expect(text(win, '#tx-data')).to.equal('Not applicable, no source transaction');
    });

    it('preserves block, time and status instead of touching those fields', function(){
        const win = bootPage();
        win.XC.actionInfo = betExpireAction();
        win.showTransactionDetails();
        expect(win.jQuery('#block a').attr('href')).to.equal('/RDOGE/block/2933');
        expect(text(win, '#action-status')).to.equal('valid');
    });

    it('leaves an ordinary user-broadcast action untouched: a real source and dashes stay dashes', function(){
        const win = bootPage();
        win.XC.actionInfo = {
            action: 'SEND', action_format: 0, action_index: '2199',
            source: null, status: 'valid', tx_index: '1121', tx_hash: null,
            block_index: '2930', timestamp: '1787864900', tx_data: null
        };
        win.showTransactionDetails();
        expect(text(win, '#source')).to.equal('-');
        expect(text(win, '#tx-hash')).to.equal('-');
        expect(text(win, '#tx-data')).to.equal('-');
    });

    it('never fires on a plain transaction page, which always carries its own tx_index', function(){
        const win = bootPage();
        win.XC.transactionInfo = {
            tx_index: '1121', tx_hash: 'abc123', source: null,
            block_index: '2930', timestamp: '1787864900', actions: []
        };
        win.showTransactionDetails();
        expect(text(win, '#source')).to.equal('-');
    });
});
