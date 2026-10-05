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
 *********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const content = path.resolve(__dirname, '..', '..', '..', '../../src/content');

function bootSystemAction(){
    const markup = fs.readFileSync(path.join(content, 'html', 'action.html'), 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/action/2201'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.moment = function(){ return { utcOffset: function(){ return { format: function(){ return ''; } }; } }; };
    win.moment.unix = win.moment;
    win.eval(fs.readFileSync(path.join(content, 'js', 'jquery.min.js'), 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.jQuery.fn.dataTable = function(){ return this; };
    win.jQuery.fn.dataTable.ext = { errMode: null };
    win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
    win.eval(require('../../../../helpers/content-source.js').clientSource());
    win.XC = { coin: 'RDOGE' };
    return win;
}

function systemAction(){
    return {
        action: 'BET_EXPIRE', action_format: 0, action_index: '2201',
        source: null, status: null, tx_index: null, tx_hash: null,
        block_index: '2933', timestamp: '1787864999', tx_data: null
    };
}

function text(win, selector){
    return win.jQuery(selector).text().trim();
}

describe('action page: null system-action origin fields', function(){
    it('replaces all four ambiguous dashes with origin information', function(){
        const win = bootSystemAction();
        win.XC.actionInfo = systemAction();
        win.showTransactionDetails();
        expect(text(win, '#action-status')).to.equal('Protocol-generated action');
        expect(text(win, '#source')).to.equal('Protocol-generated');
        expect(text(win, '#tx-hash')).to.equal('Not applicable, no source transaction');
        expect(text(win, '#tx-index')).to.equal('Not applicable, no source transaction');
        expect(text(win, '#tx-data')).to.equal('Not applicable, no source transaction');
        expect(win.jQuery('#block a').attr('href')).to.equal('/RDOGE/block/2933');
    });

    it('does not relabel an ordinary action with a transaction', function(){
        const win = bootSystemAction();
        win.XC.actionInfo = systemAction();
        win.XC.actionInfo.tx_index = '1121';
        win.XC.actionInfo.status = 'valid';
        win.showTransactionDetails();
        expect(text(win, '#action-status')).to.equal('valid');
        expect(text(win, '#source')).to.equal('-');
        expect(text(win, '#tx-hash')).to.equal('-');
        expect(text(win, '#tx-data')).to.equal('-');
    });

    it('requires every origin field to be explicitly null', function(){
        const falseyNonNull = [undefined, '', 0, false];
        for(const field of ['status', 'source', 'tx_hash', 'tx_data']){
            for(const value of falseyNonNull){
                const win = bootSystemAction();
                win.XC.actionInfo = systemAction();
                win.XC.actionInfo[field] = value;
                win.showTransactionDetails();
                expect(text(win, '#source'), field + '=' + String(value)).to.equal('-');
                expect(text(win, '#tx-index'), field + '=' + String(value)).to.equal('-');
            }
        }
    });

    it('uses the four origin fields instead of transaction index as the discriminator', function(){
        const win = bootSystemAction();
        win.XC.actionInfo = systemAction();
        win.XC.actionInfo.tx_index = '1121';
        win.showTransactionDetails();
        expect(text(win, '#action-status')).to.equal('Protocol-generated action');
        expect(text(win, '#source')).to.equal('Protocol-generated');
        expect(text(win, '#tx-index')).to.equal('Not applicable, no source transaction');
    });

    it('does not relabel a transaction page', function(){
        const win = bootSystemAction();
        win.XC.transactionInfo = {
            tx_index: '1121', tx_hash: 'abc123', source: null,
            block_index: '2930', timestamp: '1787864900', actions: []
        };
        win.showTransactionDetails();
        expect(text(win, '#source')).to.equal('-');
    });
});
