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

function boot() {
    const dom = new JSDOM('<!doctype html><html><body>' + ACTION_HTML + '</body></html>', {
        runScripts: 'outside-only'
    });
    const win = dom.window;
    Object.defineProperty(win, 'localStorage', { value: {
        getItem: () => null, setItem: () => {}, removeItem: () => {}
    } });
    win.numeral = value => ({ format: () => String(value) });
    win.eval(JQUERY_SRC);
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC.coin = 'TDOGE';
    return win;
}

describe('client DELEGATE revoke rendering', function () {
    it('labels capability and contract revoke summaries by their formats', function () {
        const win = boot();
        expect(win.getActionDetails('DELEGATE', { action_format: 2 }))
            .to.equal('Revoke capability signing key');
        const contract = win.getActionDetails('DELEGATE', { action_format: 3, target_contract_index: 7 });
        expect(contract).to.contain('Revoke delegation on contract');
        expect(contract).to.contain('/TDOGE/contract/7');
    });

    it('keeps delegation summaries for formats zero and one', function () {
        const win = boot();
        expect(win.getActionDetails('DELEGATE', { action_format: 0 })).to.equal('Capability delegation');
        expect(win.getActionDetails('DELEGATE', { action_format: 1, target_contract_index: 7 }))
            .to.contain('Delegate to contract');
    });

    it('shows a revoke badge and identifies the copied delegation window', function () {
        const win = boot();
        win.showDelegateDetails({ action_format: 2, signing_pubkey: 'a'.repeat(64),
            activation_block: 10, deactivation_block: 20 });
        expect(win.jQuery('.delegate-revoke-row').hasClass('d-none')).to.equal(false);
        expect(win.jQuery('.delegate-revoked').text()).to.contain('Revoke');
        expect(win.jQuery('.delegate-revoked').text()).to.contain('revoked delegation\'s window');
    });

    it('shows contract fields for a format-three revoke', function () {
        const win = boot();
        win.showDelegateDetails({ action_format: 3, signing_pubkey: 'b'.repeat(64),
            target_contract_index: 7, tick: 'DANK' });
        expect(win.jQuery('.delegate-revoke-row').hasClass('d-none')).to.equal(false);
        expect(win.jQuery('.delegate-contract-row').hasClass('d-none')).to.equal(false);
        expect(win.jQuery('.delegate-contract a').attr('href')).to.equal('/TDOGE/contract/7');
    });

    it('retains the specific stake-key revocation badge', function () {
        const win = boot();
        win.showDelegateDetails({ action_format: 2, signing_pubkey: null, revoked_pubkey: 'c'.repeat(64) });
        expect(win.jQuery('.delegate-revoked').text()).to.equal('Stake-key revocation');
    });

    it('hides the revoke row for delegation formats zero and one', function () {
        for(const action_format of [0, 1]){
            const win = boot();
            win.showDelegateDetails({ action_format, signing_pubkey: 'd'.repeat(64),
                target_contract_index: action_format === 1 ? 7 : null, tick: 'DANK' });
            expect(win.jQuery('.delegate-revoke-row').hasClass('d-none')).to.equal(true);
        }
    });
});
