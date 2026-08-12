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
 * Items 4451 / 4454: getActionDetails and showMessageDetails namespaced every
 * link by the BROADCAST chain (XC.coin), which is wrong for the two action
 * shapes that are deliberately cross-chain:
 *
 *  - a CROSS_CHAIN_DEX order/swap/dispenser carries give and get on different
 *    networks, and the row already supplies give_coin/get_coin;
 *  - a MESSAGE may be broadcast on any chain regardless of where its
 *    destination address lives, and messages.coin records the destination
 *    network (the indexer validates DESTINATION against COIN, not the
 *    broadcast chain).
 *
 * These assertions pin each leg to its own coin, and pin the fallback to the
 * page coin so same-chain and legacy rows are unchanged.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/action.html'), 'utf8');

// Slice a top-level function out of the source by walking braces (the same
// technique the sibling content-client tests use) so this runs shipped code
// rather than a copy that can drift.
function extractFn(name) {
    const sig = 'function ' + name + '(';
    const start = SRC.indexOf(sig);
    if (start < 0) throw new Error('function not found in xchain.js: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return SRC.slice(start, i);
}

// Run the shipped compact summary renderer with naive helpers, so every href
// the assertions read is getActionDetails' own doing.
function summary(action, info) {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
    dom.window.XC = { coin: 'BTC' };
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatLinkAmount(href, text, tick, amount){ return '<a href="' + href + '">' + amount + ' ' + text + '</a>'; }
        function formatAmount(v){ return String(v); }
        function isNull(v){ return (v === null || v === undefined || v === ''); }
        function getNetworkIcon(){ return 'fa-bitcoin'; }
    `);
    dom.window.eval(extractFn('getActionDetails'));
    return dom.window.getActionDetails(action, info);
}

// Carve the shipped MESSAGE panel out of action.html, so the test renders the
// real markup the page ships rather than a stub that can drift from it.
function messagePanelHtml() {
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-message">');
    if (start < 0) throw new Error('#info-message panel not found in action.html');
    // Bounded by the next action panel; the MESSAGE panel is self-contained.
    const end = ACTION_HTML.indexOf('id="info-mint"', start);
    if (end < 0) throw new Error('could not bound the #info-message panel');
    return ACTION_HTML.slice(start, end);
}

// Run the shipped MESSAGE detail renderer against that panel.
function messageDetail(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + messagePanelHtml() + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.XC = { coin: 'BTC', encryption_methods: { 1: 'ECIES', 2: 'ECDH' } };
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
    `);
    dom.window.eval(extractFn('showMessageDetails'));
    dom.window.showMessageDetails(data);
    return dom.window.$('#info-message .message-destination a').attr('href');
}

describe('item 4451 client: market summaries namespace each leg by its own coin', function () {

    it('a cross-chain ORDER links give and get into their own chains', function () {
        const html = summary('ORDER', {
            give_coin: 'BTC', give_tick: 'XCP',  give_amount: 100,
            get_coin:  'DOGE', get_tick: 'DANK', get_amount: 250
        });
        expect(html).to.contain('href="/BTC/token/XCP"');
        expect(html).to.contain('href="/DOGE/token/DANK"');
        expect(html).to.not.contain('href="/BTC/token/DANK"');
    });

    it('a cross-chain SWAP native get leg is labelled with the get chain coin', function () {
        const html = summary('SWAP', {
            give_coin: 'BTC', give_tick: 'XCP', give_amount: 1,
            get_coin:  'DOGE', get_tick: null,  get_amount: 5000
        });
        expect(html).to.contain('5000 DOGE');
        expect(html).to.not.contain('5000 BTC');
    });

    it('a cross-chain DISPENSE links both legs by their own coin', function () {
        const html = summary('DISPENSE', {
            give_coin: 'LTC',  give_tick: 'TOKENA', give_amount: 7,
            get_coin:  'DOGE', get_tick:  'TOKENB', get_amount: 9
        });
        expect(html).to.contain('href="/LTC/token/TOKENA"');
        expect(html).to.contain('href="/DOGE/token/TOKENB"');
    });

    it('[REGRESSION] a row without per-leg coins still falls back to the page coin', function () {
        const html = summary('ORDER_MATCH', {
            give_tick: 'XCP',  give_amount: 3,
            get_tick:  'DANK', get_amount: 4
        });
        expect(html).to.contain('href="/BTC/token/XCP"');
        expect(html).to.contain('href="/BTC/token/DANK"');
    });

    it('[REGRESSION] a single-coin action is unaffected by the market change', function () {
        const html = summary('MINT', { tick: 'XCP', amount: 12 });
        expect(html).to.contain('href="/BTC/token/XCP"');
    });
});

describe('item 4454 client: MESSAGE destinations link on the destination chain', function () {

    it('the compact summary links an encrypted message to the destination chain', function () {
        const html = summary('MESSAGE', { coin: 'DOGE', destination: 'DDestAddr', encryption_method: 3 });
        expect(html).to.contain('href="/DOGE/address/DDestAddr"');
        expect(html).to.not.contain('/BTC/address/');
    });

    it('the compact summary links a key exchange to the destination chain', function () {
        const html = summary('MESSAGE', { coin: 'DOGE', destination: 'DDestAddr', encryption_method: 1 });
        expect(html).to.contain('href="/DOGE/address/DDestAddr"');
    });

    it('[REGRESSION] a message with no coin falls back to the page coin', function () {
        const html = summary('MESSAGE', { destination: 'bc1DestAddr', encryption_method: 3 });
        expect(html).to.contain('href="/BTC/address/bc1DestAddr"');
    });

    it('the detail panel links the destination on the destination chain', function () {
        expect(messageDetail({ coin: 'DOGE', destination: 'DDestAddr', encryption_method: 3 }))
            .to.equal('/DOGE/address/DDestAddr');
    });

    it('[REGRESSION] the detail panel falls back to the page coin when coin is absent', function () {
        expect(messageDetail({ destination: 'bc1DestAddr', encryption_method: 3 }))
            .to.equal('/BTC/address/bc1DestAddr');
    });
});
