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
 * Drives the SHIPPED showListDetails against the SHIPPED #info-list markup:
 * a list page whose state carries share_mirror names its home list and links
 * it on the home chain; a page without one renders as before.
 */

'use strict';

const { srcText } = require('../../../helpers/source_text');

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = srcText('src/content/js/xchain.js');
const ACTION_HTML = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/html/action.html'), 'utf8');

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

function panelHtml() {
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-list">');
    if (start < 0) throw new Error('#info-list panel not found in action.html');
    const end = ACTION_HTML.indexOf('id="info-message"', start);
    if (end < 0) throw new Error('could not bound the #info-list panel');
    return ACTION_HTML.slice(start, end);
}

function renderListDetails(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.XC = { coin: 'BTC', list_types: { 2: 'Address' }, list_edit_types: { 0: 'None' } };
    dom.window.eval(`
        function networkCoin(coin){ return String(coin).toLowerCase(); }
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatAmount(v){ return String(v); }
        function isNumeric(v){ return !isNaN(parseFloat(v)) && isFinite(v); }
    `);
    dom.window.showActionDatatable = function () {};
    dom.window.eval(extractFn('showListDetails'));
    dom.window.showListDetails(data);
    const $ = dom.window.$;
    const row = $('#info-list .list-mirror-row');
    return {
        shown: !row.hasClass('d-none'),
        text:  $('#info-list .list-mirror-info').text().trim(),
        href:  $('#info-list .list-mirror-info a').attr('href'),
        linkText: $('#info-list .list-mirror-info a').text(),
    };
}

const BASE = { action_index: 100, type: 2, edit: 0, list_action_index: null, list: ['mA'] };

describe('client: the LIST page shows a shared-list mirror line', function () {

    it('shows the line and links the home list on its own chain', function () {
        const out = renderListDetails({ ...BASE,
            state: { share_mirror: { home_chain: 'XCP', home_list_index: 4242, version: 3 } } });
        expect(out.shown).to.equal(true);
        expect(out.text).to.equal('mirror of XCP list 4242, version 3');
        expect(out.href).to.equal('/xcp/action/4242');
        expect(out.linkText).to.equal('4242');
    });

    it('stays hidden when the state carries no share_mirror', function () {
        const out = renderListDetails({ ...BASE, state: { edit_resolution_active: false } });
        expect(out.shown).to.equal(false);
        expect(out.text).to.equal('');
    });

    it('stays hidden for a response with no state block', function () {
        expect(renderListDetails(BASE).shown).to.equal(false);
    });

    it('hides the line again when a later render has no mirror', function () {
        const out = renderListDetails({ ...BASE, state: { share_mirror: null } });
        expect(out.shown).to.equal(false);
    });
});
