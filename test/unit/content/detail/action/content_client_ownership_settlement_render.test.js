/* SPDX-License-Identifier: AGPL-3.0-or-later */

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');
const SOURCE = require('../../../../helpers/content-source.js');
const dispenserSql = require('../../../../../src/db/action_detail/dispensers_sql.js');
const orderSql = require('../../../../../src/db/action_detail/orders_sql.js');
const swapSql = require('../../../../../src/db/action_detail/swaps_sql.js');

const actionHtml = fs.readFileSync(path.join(SOURCE.HTML_DIR, 'action.html'), 'utf8');
const jquery = fs.readFileSync(path.join(SOURCE.JS_DIR, 'jquery.min.js'), 'utf8');
const readerDir = path.resolve(__dirname, '..', '..', '..', '../../src/db/readers/action_lists');

function boot(){
    const dom = new JSDOM('<!doctype html><body>' + actionHtml + '</body>', {
        runScripts: 'outside-only'
    });
    const win = dom.window;
    Object.defineProperty(win, 'localStorage', { value: {}, configurable: true });
    win.numeral = (value) => ({ format: () => String(value) });
    win.eval(jquery);
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(SOURCE.clientSource());
    win.XC.coin = 'BTC';
    win.XC.network = 'mainnet';
    win.XC.status = { available: { BTC: {}, LTC: {}, DOGE: {} } };
    return win;
}

function detailAmount(win, fn, panel, side, ownership){
    win[fn]({
        give_coin: 'BTC', give_tick: 'GIVE', give_amount: '1', give_action_index: 10,
        get_coin: 'LTC', get_tick: 'GET', get_amount: '2', get_action_index: 20,
        give_ownership: side === 'give' ? ownership : 0,
        get_ownership: side === 'get' ? ownership : 0
    });
    const prefix = panel.replace('#info-', '');
    return win.jQuery(panel + ' .' + prefix + '-' + side + '-amount').text().trim();
}

function listCells(win, action, data){
    const $ = win.jQuery;
    const row = $('<tr>')[0];
    for(let i = 0; i < 12; i++) $(row).append('<td></td>');
    win.xcDatatableCreateRow(row, data, 0, 'BTC', action, null);
    return $('td', row).map(function(){ return $(this).text().trim(); }).get();
}

describe('ownership settlement query orientation', function(){
    it('reads a DISPENSE ownership flag from its dispenser', function(){
        expect(dispenserSql.DISPENSE_QUERY).to.match(/d1\.give_ownership/);
    });

    it('reads ORDER_MATCH flags from the standing order', function(){
        expect(orderSql.ORDER_MATCH_DETAIL).to.match(/o1\.give_ownership/);
        expect(orderSql.ORDER_MATCH_DETAIL).to.match(/o1\.get_ownership/);
        expect(orderSql.ORDER_MATCH_DETAIL).to.match(/LEFT\s+JOIN\s+orders\s+o1\s+ON\s*\(o1\.action_index=m1\.get_action_index\)/i);
    });

    it('reads SWAP_MATCH flags from the incoming swap', function(){
        expect(swapSql.SWAP_MATCH_DETAIL).to.match(/s2\.give_ownership/);
        expect(swapSql.SWAP_MATCH_DETAIL).to.match(/s2\.get_ownership/);
        expect(swapSql.SWAP_MATCH_DETAIL).to.match(/LEFT\s+JOIN\s+swaps\s+s2\s+ON\s*\(s2\.action_index=m1\.give_action_index\)/i);
    });

    it('keeps the same orientation in all three list readers', function(){
        const dispense = fs.readFileSync(path.join(readerDir, 'dispensers.js'), 'utf8');
        const orders = fs.readFileSync(path.join(readerDir, 'orders.js'), 'utf8');
        const swaps = fs.readFileSync(path.join(readerDir, 'swaps.js'), 'utf8');
        expect(dispense).to.match(/d1\.give_ownership/);
        expect(orders).to.match(/orders\s+o1\s+ON\s*\(o1\.action_index=m\.get_action_index\)/i);
        expect(swaps).to.match(/swaps\s+s2\s+ON\s*\(s2\.action_index=m\.give_action_index\)/i);
    });
});

describe('ownership settlement rendering', function(){
    it('replaces placeholder detail amounts with ownership badges', function(){
        const win = boot();
        expect(detailAmount(win, 'showDispenseDetails', '#info-dispense', 'give', 1)).to.equal('👑 Ownership');
        expect(detailAmount(win, 'showOrderMatchDetails', '#info-order-match', 'give', 1)).to.equal('👑 Ownership');
        expect(detailAmount(win, 'showOrderMatchDetails', '#info-order-match', 'get', 1)).to.equal('👑 Ownership');
        expect(detailAmount(win, 'showSwapMatchDetails', '#info-swap-match', 'give', 1)).to.equal('👑 Ownership');
        expect(detailAmount(win, 'showSwapMatchDetails', '#info-swap-match', 'get', 1)).to.equal('👑 Ownership');
    });

    it('keeps ordinary detail amounts unchanged', function(){
        const win = boot();
        expect(detailAmount(win, 'showDispenseDetails', '#info-dispense', 'give', 0)).to.equal('1');
        expect(detailAmount(win, 'showOrderMatchDetails', '#info-order-match', 'get', 0)).to.equal('2');
        expect(detailAmount(win, 'showSwapMatchDetails', '#info-swap-match', 'give', 0)).to.equal('1');
    });

    it('replaces placeholder list amounts with ownership badges', function(){
        const win = boot();
        const dispense = listCells(win, 'dispense',
            [1, 100, 0, 'dest', 'BTC', 'GIVE', '1', 'LTC', 'GET', '2', 1, 'valid', 30]);
        const order = listCells(win, 'order_match',
            [1, 100, 0, 'BTC', 10, '1', 'LTC', 20, '2', 'settled', 1, 0, 'valid', 31]);
        const swap = listCells(win, 'swap_match',
            [1, 100, 0, 'BTC', 10, 'LTC', 20, 1, 0, 'valid', 32]);
        expect(dispense[4]).to.contain('Ownership');
        expect(order[4]).to.contain('Ownership');
        expect(swap[3]).to.contain('Ownership');
    });
});
