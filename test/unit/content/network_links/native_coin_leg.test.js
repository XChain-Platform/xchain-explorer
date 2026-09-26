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
 * Native market legs carry a coin and amount but no token tick. Exercise
 * the shipped summary, detail panels, and list rows with the API shape that
 * exposed the defect so no surface can build an empty token destination.
 */

'use strict';

const fs = require('fs');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');
const SOURCE = require('../../../helpers/content-source.js');

const ACTION_HTML = fs.readFileSync(SOURCE.HTML_DIR + '/action.html', 'utf8');
const CLIENT_SRC = SOURCE.clientSource();
const JQUERY_SRC = fs.readFileSync(SOURCE.JS_DIR + '/jquery.min.js', 'utf8');

// TDOGE /api/action/3051, trimmed to the DISPENSE fields its renderers read.
const ACTION_3051 = {
    action: 'DISPENSE',
    action_index: '3051',
    give_coin: 'DOGE',
    give_tick: 'S0UR-PATCH-K1DS',
    give_amount: '1',
    get_coin: 'DOGE',
    get_tick: null,
    get_amount: '0.00001985',
    source: 'nqjVHBtKPPMb1TNfmnwx7kZ19G5NzG9rxy',
    destination: 'nmUN3SanVb323ZECB4fVWtrrWoCmxgmVoL'
};

function boot(){
    const dom = new JSDOM('<!doctype html><html><body>' + ACTION_HTML + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/TDOGE/action/3051'
    });
    const win = dom.window;
    win.numeral = function(value){ return { format: function(){ return String(value); } }; };
    win.eval(JQUERY_SRC);
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC.coin = 'TDOGE';
    win.XC.chain = 'dogecoin';
    win.XC.network = 'testnet';
    win.XC.status = { available: { TDOGE: {}, TBTC: {}, TLTC: {} } };
    return win;
}

function rowCells(win, action, data){
    const $ = win.jQuery;
    const row = $('<tr>')[0];
    for(let i = 0; i < 12; i++) $(row).append('<td></td>');
    win.xcDatatableCreateRow(row, data, 0, win.XC.coin, action, null);
    return $('td', row).map(function(){ return $(this).html(); }).get();
}

function expectNativeCell(win, selector, amount){
    const cell = win.jQuery(selector);
    expect(cell.text().trim()).to.equal(amount);
    expect(cell.find('a')).to.have.length(0);
    expect(cell.html()).to.not.contain('/token/');
}

describe('client: native coin market legs', function () {
    it('keeps the tokenUrl dead-link contract for every absent tick shape', function () {
        const win = boot();
        expect(win.tokenUrl('DOGE', null)).to.equal('/TDOGE/token/null');
        expect(win.tokenUrl('DOGE', undefined)).to.equal('/TDOGE/token/null');
        expect(win.tokenUrl('DOGE', '')).to.equal('/TDOGE/token/null');
    });

    it('renders the real action 3051 summary as an unlinked DOGE payment', function () {
        const win = boot();
        const box = win.jQuery('<div>').html(win.getActionDetails('DISPENSE', ACTION_3051));
        expect(box.text()).to.contain('0.00001985 DOGE');
        expect(box.find('a[href*="/token/"]').map(function(){ return win.jQuery(this).attr('href'); }).get())
            .to.deep.equal(['/TDOGE/token/S0UR-PATCH-K1DS', '/TDOGE/token/S0UR-PATCH-K1DS']);
    });

    it('renders the real action 3051 detail Get Token row as DOGE without a token link', function () {
        const win = boot();
        win.showDispenseDetails(ACTION_3051);
        expectNativeCell(win, '#info-dispense .dispense-get-tick', 'DOGE');
        expectNativeCell(win, '#info-dispense .dispense-get-amount', '0.00001985');
    });

    it('renders native tick fields plainly across dispenser, order, swap, and match panels', function () {
        const cases = [
            ['showDispenserDetails', '#info-dispenser .dispenser-give-tick', '#info-dispenser .dispenser-get-tick', { state: {} }],
            ['showOrderDetails', '#info-order .order-give-tick', '#info-order .order-get-tick', { state: {} }],
            ['showSwapDetails', '#info-swap .swap-give-tick', '#info-swap .swap-get-tick', { state: {} }],
            ['showOrderMatchDetails', '#info-order-match .order-match-give-tick', '#info-order-match .order-match-get-tick', {}],
            ['showSwapMatchDetails', '#info-swap-match .swap-match-give-tick', '#info-swap-match .swap-match-get-tick', {}]
        ];
        for(const [fn, giveSelector, getSelector, extra] of cases){
            const win = boot();
            win[fn](Object.assign({}, ACTION_3051, extra));
            expectNativeCell(win, getSelector, 'DOGE');
            win[fn](Object.assign({}, ACTION_3051, extra, { give_tick: '', get_tick: 'TOKEN' }));
            expectNativeCell(win, giveSelector, 'DOGE');
        }
    });

    it('renders empty and null ticks as native coin legs in current and terminal list rows', function () {
        const win = boot();
        const current = [1, 3051, 0, ACTION_3051.source, 'DOGE', ACTION_3051.give_tick, '1',
            'DOGE', null, '0.00001985', 1, 3051];
        const reversed = [1, 3052, 0, ACTION_3051.source, 'DOGE', '', '0.00001985',
            'DOGE', ACTION_3051.give_tick, '1', 1, 3052];
        const closed = [1, 3053, 0, ACTION_3051.source, 3048, 'DOGE', '', '0.00001985',
            'DOGE', ACTION_3051.give_tick, '1', 'empty', 1, 3053];

        expect(rowCells(win, 'dispense', current)[5]).to.contain('0.00001985 DOGE');
        expect(rowCells(win, 'dispense', current)[5]).to.not.contain('/token/');
        expect(rowCells(win, 'dispense', reversed)[4]).to.contain('0.00001985 DOGE');
        expect(rowCells(win, 'dispense', reversed)[4]).to.not.contain('/token/');
        expect(rowCells(win, 'dispenser_close', closed)[5]).to.contain('0.00001985 DOGE');
        expect(rowCells(win, 'dispenser_close', closed)[5]).to.not.contain('/token/');
    });
});
