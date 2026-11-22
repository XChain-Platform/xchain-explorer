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
const { JSDOM } = require('jsdom');
const { expect } = require('chai');
const SOURCE = require('../../../../helpers/content-source.js');
const panels = require('../../../../../src/content/js/xbridge_panels_render.js');

const ACTION_HTML = fs.readFileSync(SOURCE.HTML_DIR + '/action.html', 'utf8');
const CLIENT_SRC = SOURCE.clientSource();
const JQUERY_SRC = fs.readFileSync(SOURCE.JS_DIR + '/jquery.min.js', 'utf8');
const POLL_RENDER_SRC = fs.readFileSync(SOURCE.JS_DIR + '/poll_tally_render.js', 'utf8');

function boot(){
    const dom = new JSDOM('<!doctype html><html><body>' + ACTION_HTML + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/TDOGE/action/1'
    });
    const win = dom.window;
    win.numeral = function(value){ return { format: function(){ return String(value); } }; };
    win.math = { bignumber: Number, multiply: (a, b) => Number(a) * Number(b),
        format: (value, options) => Number(value).toFixed(options.precision) };
    win.eval(JQUERY_SRC);
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.eval(POLL_RENDER_SRC);
    win.XC.coin = 'TDOGE';
    win.XC.network = 'testnet';
    win.XC.status = { available: { TDOGE: {} } };
    win.XC.fee_preferences = { 0: 'default' };
    return win;
}

const text = (win, selector) => win.jQuery(selector).text().trim();
const hidden = (win, selector) => win.jQuery(selector).closest('tr').hasClass('d-none');

// Every ISSUE row a format's wire layout carries, read from the indexer's own format strings.
const ISSUE_ROWS = {
    MINT_SUPPLY: '.issue-mint-supply', TRANSFER_SUPPLY: '.issue-transfer-supply',
    DECIMALS: '.issue-decimals', MAX_SUPPLY: '.issue-max-supply', TRANSFER: '.issue-transfer',
    MAX_MINT: '.issue-max-mint', DESCRIPTION: '.issue-description'
};
const ISSUE_FORMATS = {
    0: ['MINT_SUPPLY', 'TRANSFER_SUPPLY', 'DECIMALS', 'MAX_SUPPLY', 'TRANSFER', 'MAX_MINT', 'DESCRIPTION'],
    1: ['DESCRIPTION'],
    2: ['MAX_MINT', 'MINT_SUPPLY', 'TRANSFER_SUPPLY'],
    3: [], 4: [], 5: []
};

describe('client: ISSUE rows follow the fields each format carries', function () {
    for(const format of Object.keys(ISSUE_FORMATS)){
        it('shows exactly the supply and limit rows format ' + format + ' carries', function () {
            const win = boot();
            win.showIssueDetails({ action_format: Number(format), tick: 'TKN' });
            for(const [field, selector] of Object.entries(ISSUE_ROWS))
                expect(hidden(win, selector), field + ' on format ' + format)
                    .to.equal(!ISSUE_FORMATS[format].includes(field));
        });
    }

    it('renders the minted amount and its recipient on a format 2 reissue', function () {
        const win = boot();
        win.showIssueDetails({ action_format: 2, tick: 'TKN', mint_supply: '1000', transfer_supply: 'Drecipient' });
        expect(text(win, '.issue-mint-supply')).to.not.equal('');
        expect(win.jQuery('.issue-transfer-supply a').attr('href')).to.equal('/TDOGE/address/Drecipient');
    });
});

describe('client: fee tab by payment mode', function () {
    it('labels the amount a quote and names the native payment on a mode 1 fee', function () {
        const win = boot();
        win.showActionFeeDetails({ payment_mode: 1, tick: 'XCHAIN', amount: '5', method: 0,
            native_coin_amount: '0.01', native_coin: 'DOGE', oracle_round: 12, destination: null });
        expect(text(win, '.fee-amount-label')).to.equal('XCHAIN Quote');
        expect(win.jQuery('.fee-native-row').hasClass('d-none')).to.equal(false);
        expect(text(win, '.fee-native')).to.equal('0.01 DOGE');
        expect(text(win, '.fee-oracle')).to.equal('12');
        expect(win.jQuery('.fee-destination-row').hasClass('d-none')).to.equal(true);
    });

    it('keeps the XCHAIN rows for a mode 2 fee and hides the native rows', function () {
        const win = boot();
        win.showActionFeeDetails({ payment_mode: 2, tick: 'XCHAIN', amount: '5', method: 0, destination: 'Dfee' });
        expect(text(win, '.fee-amount-label')).to.equal('Amount');
        expect(win.jQuery('.fee-native-row').hasClass('d-none')).to.equal(true);
        expect(win.jQuery('.fee-oracle-row').hasClass('d-none')).to.equal(true);
        expect(win.jQuery('.fee-destination-row').hasClass('d-none')).to.equal(false);
        expect(win.jQuery('.fee-destination a').attr('href')).to.equal('/TDOGE/address/Dfee');
    });
});

describe('client: refused VOTE creates, ballots and finalizations', function () {
    it('badges a refused poll create as refused, never as voting open', function () {
        const win = boot();
        win.showVoteDetails({ vote_kind: 'poll', poll_status: 'refused', status: 'invalid: bad options',
            options: [], action_index: 5 });
        expect(text(win, '.vote-poll-status')).to.equal('refused');
        expect(win.jQuery('.vote-poll-status .badge').hasClass('text-bg-secondary')).to.equal(true);
    });

    it('says no ballot was recorded when a ballot action left no choice rows', function () {
        const win = boot();
        win.showVoteDetails({ vote_kind: 'ballot', poll_ref: null, ballot: [], status: null });
        expect(text(win, '.vote-choices')).to.contain('No ballot recorded');
    });

    it('says no poll was finalized when a v2 finalization resolved no poll', function () {
        const win = boot();
        win.showVoteDetails({ vote_kind: 'finalize', poll_ref: undefined, poll_status: undefined });
        expect(text(win, '.vote-finalize-status')).to.contain('No finalized poll recorded');
    });

    it('renders the refused outcome on the poll page', function () {
        const win = boot();
        const html = win.renderPollOutcome({ poll_status: 'refused', options: [] });
        expect(html).to.contain('poll-outcome-refused');
        expect(html).to.not.contain('poll-outcome-open');
    });
});

describe('client: refused XBRIDGE broadcast of a system-injected version', function () {
    it('labels a refused v2 as a broadcast, with no injected provenance', function () {
        const html = panels.renderXbridgeAction({ action_format: 2, status: 'invalid: XBRIDGE v2 is system-injected',
            bridge_settlement: null, bridge_pending: false });
        expect(html).to.contain('Broadcast by the source address (refused)');
        expect(html).to.not.contain('Mirror-injected');
        expect(html).to.contain('data-injected="0"');
        expect(html).to.contain('none: the action was refused');
    });

    it('still labels a settled v2 as mirror-injected', function () {
        const html = panels.renderXbridgeAction({ action_format: 2, status: 'valid',
            bridge_settlement: { src_chain: 'BTC', src_action_index: 1, dest_chain: 'DOGE', dest_address: 'D', block_index: 3 } });
        expect(html).to.contain('Mirror-injected from a finalized bridge transfer');
        expect(html).to.contain('data-injected="1"');
    });

    it('labels a v2 or v5 refused before activation as a broadcast, not injected', function () {
        for(const format of [2, 5]){
            const html = panels.renderXbridgeAction({ action_format: format, status: 'invalid: XBRIDGE before activation',
                bridge_settlement: null, bridge_pending: false });
            expect(html, 'format ' + format).to.contain('Broadcast by the source address (refused)');
            expect(html, 'format ' + format).to.not.contain('Mirror-injected');
            expect(html, 'format ' + format).to.contain('data-injected="0"');
            expect(html, 'format ' + format).to.contain('none: the action was refused');
        }
    });

    it('keeps an unsettled valid v5 as injected rather than refused', function () {
        const html = panels.renderXbridgeAction({ action_format: 5, status: 'valid', bridge_settlement: null });
        expect(html).to.contain('Mirror-injected');
    });
});
