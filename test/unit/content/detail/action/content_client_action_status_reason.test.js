/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT = path.resolve(__dirname, '..', '..', '..', '../../src/content');
const CLIENT_SRC = require('../../../../helpers/content-source.js').clientSource();
const JQUERY = path.join(CONTENT, 'js', 'jquery.min.js');
const ACTION = path.join(CONTENT, 'html', 'action.html');

function bootPage(){
    const markup = fs.readFileSync(ACTION, 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/TDOGE/action/6497'
    });
    const win = dom.window;
    win.numeral = function(value){ return { format: function(){ return String(value); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = { coin: 'TDOGE' };
    return win;
}

describe('action detail status reason', function(){

    it('shows an escaped muted reason directly below the stored status', function(){
        const win = bootPage();
        const reason = 'The payment was <strong>too small</strong> to buy one fill.';
        win.XC.actionInfo = {
            action: 'DISPENSE', action_format: 0, action_index: 6497,
            block_index: null, emitted_by: null, pending: false, source: null,
            status: 'invalid: insufficient funds ', status_reason: reason,
            timestamp: 0, tx_data: null, tx_hash: null, tx_index: null,
            actions: []
        };
        win.formatLivestamp = function(){ return ''; };
        win.moment = { unix: function(){
            return { utcOffset: function(){ return { format: function(){ return ''; } }; } };
        } };
        win.showActionDatatable = function(){};

        win.showTransactionDetails();

        expect(win.jQuery('#action-status-value').text()).to.equal('invalid: insufficient funds ');
        expect(win.jQuery('#action-status-reason').text()).to.equal(reason);
        expect(win.jQuery('#action-status-reason').hasClass('small')).to.equal(true);
        expect(win.jQuery('#action-status-reason').hasClass('text-muted')).to.equal(true);
        expect(win.jQuery('#action-status-reason').hasClass('d-none')).to.equal(false);
        expect(win.jQuery('#action-status-reason strong')).to.have.length(0);
    });

    it('hides and clears the reason when the API does not provide one', function(){
        const win = bootPage();

        win.renderActionStatus('invalid', 'old reason');
        win.renderActionStatus('valid', null);

        expect(win.jQuery('#action-status-value').text()).to.equal('valid');
        expect(win.jQuery('#action-status-reason').text()).to.equal('');
        expect(win.jQuery('#action-status-reason').hasClass('d-none')).to.equal(true);
    });

});
