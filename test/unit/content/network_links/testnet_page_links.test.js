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
 * The shipped renderers, fed bare chain symbols exactly as the API sends
 * them, on a page of every chain on every network. TDOGE action 3051's
 * market legs came back as give_coin "DOGE" / get_coin "DOGE" and linked
 * to /DOGE/token/..., the mainnet explorer. Here every coin-built link a
 * renderer emits has to land on the page's network, on the leg's own
 * chain: a testnet page's BTC leg is /TBTC/, never /BTC/ and never /TDOGE/.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SOURCE  = require('../../../helpers/content-source.js');
const JS_DIR  = SOURCE.JS_DIR;
const ACTION  = fs.readFileSync(path.join(SOURCE.HTML_DIR, 'action.html'), 'utf8');
const CLIENT  = SOURCE.clientSource();
const JQUERY  = fs.readFileSync(path.join(JS_DIR, 'jquery.min.js'), 'utf8');
// Renderers a page loads on its own, beside the shell's scripts.
const EXTRA   = ['dispenser_detail.js', 'xbridge_panels_render.js', 'xcall_timeline_render.js',
                 'anchor_detail_render/state.js', 'attestation_detail_render/state.js']
    .map((f) => fs.readFileSync(path.join(JS_DIR, f), 'utf8'));

const CHAINS   = ['BTC', 'LTC', 'DOGE'];
const PREFIXES = { mainnet: '', testnet: 'T', regtest: 'R' };

// One realm per page: the action page's markup and every shipped script, with XC
// set the way params.js sets it for that URL.
function boot(page, network){
    const dom = new JSDOM('<!doctype html><html><body>' + ACTION + '<div id="token-description"></div></body></html>',
        { runScripts: 'outside-only', url: 'https://xchain.test/' + page + '/action/3051' });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(JQUERY);
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT);
    EXTRA.forEach((src) => win.eval(src));
    win.XC.coin = page;
    win.XC.network = network;
    const available = {};
    Object.values(PREFIXES).forEach((p) => CHAINS.forEach((c) => { available[p + c] = {}; }));
    win.XC.status = { available: available };
    return win;
}

function hrefs(win, html){
    const box = win.document.createElement('div');
    box.innerHTML = html;
    return Array.from(box.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'));
}

// The named cells of a list row rendered by the shipped createdRow, as the
// datatable would render it (the leading cells are the page's own block/source).
function listRow(win, action, data, cells){
    const $ = win.jQuery, tr = $('<tr>')[0];
    for(let i = 0; i < 12; i++) $(tr).append('<td></td>');
    win.xcDatatableCreateRow(tr, data, 0, win.XC.coin, action, null);
    return cells.map((i) => $('td', tr).eq(i).html()).join('');
}

// Summary, list-row and card renderers. Each case returns the markup it emitted
// and the hrefs it must carry, written with P for the page's network prefix.
const LIST_CASES = {
    'ORDER summary, same-chain legs (TDOGE action 3051)': (w) => [w.getActionDetails('ORDER',
        { give_coin: 'DOGE', give_tick: 'XCP', give_amount: 1, get_coin: 'DOGE', get_tick: 'DANK', get_amount: 2 }),
        ['PDOGE/token/XCP', 'PDOGE/token/DANK']],
    'ORDER summary, cross-chain legs': (w) => [w.getActionDetails('ORDER',
        { give_coin: 'BTC', give_tick: 'XCP', give_amount: 1, get_coin: 'LTC', get_tick: 'DANK', get_amount: 2 }),
        ['PBTC/token/XCP', 'PLTC/token/DANK']],
    'LINK summary': (w) => [w.getActionDetails('LINK',
        { coin1: 'BTC', coin1_action_index: 5, coin2: 'LTC', coin2_action_index: 6 }),
        ['PBTC/action/5', 'PLTC/action/6']],
    'MESSAGE summary': (w) => [w.getActionDetails('MESSAGE',
        { coin: 'LTC', action_format: 2, destination: 'addr1' }), ['PLTC/address/addr1']],
    'DISPENSER_CLOSE leg': (w) => [w.formatCoinLegAmount(w.XC.coin, 'BTC', 'TOK', 1), ['PBTC/token/TOK']],
    'ORDER_MATCH list row': (w) => [listRow(w, 'order_match',
        [1, 100, 0, 'BTC', 11, '1', 'LTC', 12, '2', 'settled', 1, 99], [3, 5]), ['PBTC/action/11', 'PLTC/action/12']],
    'DISPENSER list row': (w) => [listRow(w, 'dispenser',
        [1, 100, 0, 'src', 'BTC', 'GIVE', '1', 'LTC', 'GET', '2', 0, 1, 99], [4, 5]), ['PBTC/token/GIVE', 'PLTC/token/GET']],
    'LINK list row': (w) => [listRow(w, 'link',
        [1, 100, 0, 'src', 'BTC', 5, 'LTC', 6, null, 1, 99], [4, 5]), ['PBTC/action/5', 'PLTC/action/6']],
    'dispenser card price': (w) => [w.dispenserPriceHtml(w.XC.coin, { get_coin: 'BTC', get_tick: 'B', get_amount: 1 }), ['PBTC/token/B']],
    'bridge origin badge': (w) => [w.renderBridgeOrigin('BTC.FUFU', ['BTC', 'DOGE']), ['PBTC/token/BTC.FUFU']],
    'XCALL target-chain execution': (w) => [w.renderXcallTimelineHeader({ target_chain: 'LTC' }).actionLink(77, 'LTC'), ['PLTC/action/77']],
    'anchor bundle section': (w) => [w.anchorSectionRowsHtml([{ section_index: 0, chain: 'BTC', block_index: 2497, snapshot_block: 110 }], {}),
        ['PBTC/block/2497', 'PBTC/block/110']],
    'attestation batch action': (w) => [w.attBatchActionLink(5), ['PDOGE/action/5']],
    'TIS raw file reference': (w) => ['<a href="' + w.actionRefToRawPath('action:BTC:9') + '">f</a>', ['PBTC/api/file/9/raw']]
};

// Detail panels write into action.html's markup; each case names the panel it fills.
const PANEL_CASES = {
    'ORDER_MATCH panel': ['#info-order-match', (w) => w.showOrderMatchDetails({ give_coin: 'BTC', give_action_index: 11, give_tick: 'A',
        get_coin: 'LTC', get_action_index: 12, get_tick: 'B', state: {} }), ['PBTC/action/11', 'PLTC/action/12', 'PBTC/token/A', 'PLTC/token/B']],
    'DISPENSE panel': ['#info-dispense', (w) => w.showDispenseDetails({ give_coin: 'BTC', give_tick: 'A', get_coin: 'LTC', get_tick: 'B',
        source: 's1', destination: 'd1' }), ['PBTC/token/A', 'PLTC/token/B', 'PLTC/address/s1', 'PLTC/address/d1']],
    'LINK panel': ['#info-link', (w) => w.showLinkDetails({ coin1: 'BTC', coin1_action_index: 5, coin2: 'LTC', coin2_action_index: 6 }),
        ['PBTC/action/5', 'PLTC/action/6']],
    'TIS action reference': ['#token-description', (w) => w.tokenInfo_prepareDescription('action:ltc:12'), ['PLTC/action/12']]
};

function expectOnNetwork(links, prefix, label){
    expect(links.length, label + ' emitted no link').to.be.greaterThan(0);
    const onNetwork = new RegExp('^/' + prefix + '(BTC|LTC|DOGE)/');
    for(const href of links)
        expect(href, label + ' left the page network').to.match(onNetwork);
}

for(const [network, prefix] of Object.entries(PREFIXES)){
    for(const chain of CHAINS){
        const page = prefix + chain;
        describe('coin-built links on a ' + page + ' page stay on ' + network, function () {
            let win;
            before(function () { win = boot(page, network); });
            const want = (list) => list.map((h) => '/' + h.replace(/^P/, prefix));

            for(const [name, run] of Object.entries(LIST_CASES)){
                it(name, function () {
                    const [html, expected] = run(win);
                    const links = hrefs(win, html);
                    expectOnNetwork(links, prefix, name);
                    // formatLinkAmount links the icon and the label, so one leg is two anchors.
                    expect([...new Set(links)]).to.deep.equal(want(expected));
                });
            }
            for(const [name, [panel, run, expected]] of Object.entries(PANEL_CASES)){
                it(name, function () {
                    run(win);
                    const links = hrefs(win, win.jQuery(panel).html());
                    expectOnNetwork(links.filter((h) => !/\/action\/(undefined|null)$/.test(h)), prefix, name);
                    for(const h of want(expected)) expect(links, name).to.include(h);
                });
            }
        });
    }
}
