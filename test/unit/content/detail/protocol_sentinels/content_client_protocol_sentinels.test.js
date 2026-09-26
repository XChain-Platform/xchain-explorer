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

const ACTION_HTML = fs.readFileSync(SOURCE.HTML_DIR + '/action.html', 'utf8');
const CLIENT_SRC = SOURCE.clientSource();
const JQUERY_SRC = fs.readFileSync(SOURCE.JS_DIR + '/jquery.min.js', 'utf8');

function boot(){
    const dom = new JSDOM('<!doctype html><html><body>' + ACTION_HTML + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/TDOGE/action/1'
    });
    const win = dom.window;
    win.numeral = function(value){ return { format: function(){ return String(value); } }; };
    win.math = {
        bignumber: Number,
        multiply: function(a, b){ return Number(a) * Number(b); },
        format: function(value, options){ return Number(value).toFixed(options.precision); }
    };
    win.eval(JQUERY_SRC);
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC.coin = 'TDOGE';
    win.XC.network = 'testnet';
    win.XC.status = { available: { TDOGE: {} } };
    return win;
}

function text(win, selector){
    return win.jQuery(selector).text().trim();
}

function hidden(win, selector){
    return win.jQuery(selector).closest('tr').hasClass('d-none');
}

function rowCells(win, action, data){
    const $ = win.jQuery;
    const row = $('<tr>')[0];
    for(let i = 0; i < 12; i++) $(row).append('<td></td>');
    win.xcDatatableCreateRow(row, data, 0, win.XC.coin, action, null);
    return $('td', row).map(function(){ return $(this).text().trim(); }).get();
}

describe('client: protocol sentinel meanings', function () {
    it('renders SLEEP resume sentinels without block links on every surface', function () {
        const win = boot();
        win.showSleepDetails({ type: 2, tick: 'TKN', resume_block: -1, memo: null });
        expect(text(win, '.sleep-resume-block')).to.equal('Indefinitely');
        expect(win.jQuery('.sleep-resume-block a')).to.have.length(0);
        expect(win.getActionDetails('SLEEP', { type: 2, tick: 'TKN', resume_block: 0 }))
            .to.contain('Immediately').and.not.contain('block 0');
        expect(rowCells(win, 'sleep', [1, 10, 1, 'addr', 2, 'TKN', -1, 1, 10])[6])
            .to.equal('Indefinitely');
    });

    it('renders ISSUE zero caps and windows as absent restrictions', function () {
        const win = boot();
        win.showIssueDetails({
            action_format: 0, tick: 'TKN', max_supply: 0, max_mint: '0',
            mint_address_max: 0, mint_start_block: '0', mint_stop_block: 0
        });
        expect(text(win, '.issue-max-supply')).to.equal('No cap declared');
        expect(text(win, '.issue-max-mint')).to.equal('No per-transaction cap');
        expect(text(win, '.issue-mint-address-max')).to.equal('No per-address cap');
        expect(text(win, '.issue-mint-start-block')).to.equal('No start restriction');
        expect(text(win, '.issue-mint-stop-block')).to.equal('No stop restriction');
    });

    it('renders ISSUE and token list zero caps as absent restrictions', function () {
        const win = boot();
        const issue = rowCells(win, 'issue', [1, 10, 1, 'addr', 'TKN', 0, 0, '', null, 1, 10]);
        const token = rowCells(win, 'token', [1, 10, 1, 'TKN', 5, 0, 0, '']);
        expect(issue[5]).to.equal('No cap declared');
        expect(issue[6]).to.equal('No per-transaction cap');
        expect(token[5]).to.equal('No cap declared');
        expect(token[6]).to.equal('No per-transaction cap');
    });

    it('labels fee preference zero as the protocol default and omits option three', function () {
        const win = boot();
        win.showAddressDetails({ action_format: 0, fee_preference: 0, memo: null });
        expect(text(win, '.address-fee-preference'))
            .to.equal('0 - Default: donate to protocol development');
        expect(win.XC.fee_preferences).to.not.have.property('3');
    });

    it('renders ISSUE lock flags and SWEEP flags as words', function () {
        const win = boot();
        win.showIssueDetails({ action_format: 3, tick: 'TKN', lock_max_supply: 1, lock_max_mint: 0 });
        expect(text(win, '.issue-lock-max-supply')).to.equal('Locked');
        expect(text(win, '.issue-lock-max-mint')).to.equal('Unlocked');
        win.showSweepDetails({ balances: 1, ownerships: 0, orders: 1, swaps: 0, dispensers: 1 });
        expect(text(win, '.sweep-balances')).to.equal('Yes');
        expect(text(win, '.sweep-ownerships')).to.equal('No');
    });
});

describe('client: nullable and format-specific action fields', function () {
    it('renders nullable memos as blank instead of null or stale text', function () {
        const win = boot();
        win.showMintDetails({ tick: 'TKN', amount: 1, destination: 'addr', memo: 'first' });
        win.showMintDetails({ tick: 'TKN', amount: 1, destination: 'addr', memo: undefined });
        expect(text(win, '.mint-memo')).to.equal('');
        win.showAddressDetails({ action_format: 0, fee_preference: 0, memo: null });
        expect(text(win, '.address-memo')).to.equal('');
    });

    it('shows only the fields carried by each BROADCAST format', function () {
        const win = boot();
        win.showBroadcastDetails({ action_format: 2, message: 'feed', broadcast_fee: 1, memo: null });
        expect(hidden(win, '.broadcast-message')).to.equal(false);
        expect(hidden(win, '.broadcast-value')).to.equal(true);
        expect(hidden(win, '.broadcast-fee')).to.equal(false);
        expect(text(win, '.broadcast-memo')).to.equal('');
        expect(text(win, '.broadcast-fee')).to.not.contain('null');
    });

    it('shows only the fields carried by each MESSAGE format', function () {
        const win = boot();
        win.showMessageDetails({ action_format: 3, coin: 'DOGE', destination: 'addr', plaintext_message: 'hello' });
        expect(hidden(win, '.message-method')).to.equal(true);
        expect(hidden(win, '.message-key')).to.equal(true);
        expect(hidden(win, '.message-encrypted')).to.equal(true);
        expect(hidden(win, '.message-plaintext')).to.equal(false);
        expect(text(win, '.message-plaintext')).to.equal('hello');
    });

    it('hides ISSUE rows that belong to other formats', function () {
        const win = boot();
        win.showIssueDetails({ action_format: 1, tick: 'TKN', description: 'updated', memo: null });
        expect(hidden(win, '.issue-description')).to.equal(false);
        expect(hidden(win, '.issue-decimals')).to.equal(true);
        expect(hidden(win, '.issue-max-mint')).to.equal(true);
        expect(hidden(win, '.issue-lock-mint')).to.equal(true);
        expect(text(win, '.issue-memo')).to.equal('');
    });
});

describe('client: indexed governance labels', function () {
    it('renders BET wager and resolve indexes with parent outcome labels', function () {
        const win = boot();
        win.showBetDetails({ bet_kind: 'bet', feed_ref: 7, outcome: 1,
            outcome_labels: ['Chiefs', '49ers'], amount: 5, bet_status: 'open' });
        expect(text(win, '.bet-outcome')).to.equal('1: 49ers');
        win.showBetDetails({ bet_kind: 'resolve', feed_ref: 7, resolve_outcome: 0,
            outcome_labels: ['Chiefs', '49ers'], status: 'valid' });
        expect(text(win, '.bet-resolve-outcome')).to.equal('0: Chiefs');
    });

    it('renders VOTE ballot choices with parent option labels and shares', function () {
        const win = boot();
        win.showVoteDetails({ vote_kind: 'ballot', poll_ref: 9,
            ballot: [{ choice: 1, label: 'NO', share: 40 }] });
        expect(text(win, '.vote-choices')).to.equal('1: NO (share 40)');
    });

    it('renders BET and VOTE list rows with labels', function () {
        const win = boot();
        const bet = rowCells(win, 'bet', [1, 10, 1, 'addr', 7, 1, '49ers', 'TKN', 5, 'open', 1, 10]);
        const vote = rowCells(win, 'vote', [1, 10, 1, 'addr', 9, 1, 'NO', 40, 1, 10]);
        expect(bet[5]).to.equal('1: 49ers');
        expect(vote[5]).to.equal('1: NO');
    });
});
