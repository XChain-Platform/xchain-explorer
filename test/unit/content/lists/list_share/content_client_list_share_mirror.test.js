/*********************************************************************
 * GENERATED
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
 **********************************************************************/

'use strict';

const { srcText } = require('../../../../helpers/source_text');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = srcText('src/content/js/xchain.js');
const ACTION_HTML = fs.readFileSync(path.resolve(__dirname, '../../../../../src/content/html/action.html'), 'utf8');

function extractFn(name){
    const start = SRC.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('function not found: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0;
    let end = braceStart;
    for(; end < SRC.length; end++){
        if(SRC[end] === '{') depth++;
        if(SRC[end] === '}' && --depth === 0){ end++; break; }
    }
    return SRC.slice(start, end);
}

function listPanel(){
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-list">');
    const end = ACTION_HTML.indexOf('id="info-message"', start);
    if(start < 0 || end < 0) throw new Error('#info-list panel not found');
    return ACTION_HTML.slice(start, end);
}

function makeRenderer(){
    const dom = new JSDOM('<!DOCTYPE html><body>' + listPanel() + '</body>', { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../../../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.XC = { coin: 'BTC', list_types: { 2: 'Address' }, list_edit_types: { 0: 'None' } };
    dom.window.eval(`
        function networkCoin(coin){ return String(coin).toLowerCase(); }
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatAmount(value){ return String(value); }
        function isNumeric(value){ return !isNaN(parseFloat(value)) && isFinite(value); }
    `);
    dom.window.showActionDatatable = function () {};
    dom.window.eval(extractFn('showListDetails'));
    return function render(state){
        dom.window.showListDetails({
            action_index: 100,
            type: 2,
            edit: 0,
            list_action_index: null,
            list: ['mAddress'],
            state
        });
        const $ = dom.window.$;
        return {
            hidden: $('#info-list .list-mirror-row').hasClass('d-none'),
            ariaHidden: $('#info-list .list-mirror-row').attr('aria-hidden'),
            text: $('#info-list .list-mirror-info').text().trim(),
            href: $('#info-list .list-mirror-info a').attr('href')
        };
    };
}

describe('client: shared-list mirror detail', function () {
    it('shows the home list line and links it on the home chain', function () {
        const out = makeRenderer()({ share_mirror: { home_chain: 'DOGE', home_list_index: 202, version: 3 } });
        expect(out.hidden).to.equal(false);
        expect(out.ariaHidden).to.equal('false');
        expect(out.text).to.equal('mirror of DOGE list 202, version 3');
        expect(out.href).to.equal('/doge/action/202');
    });

    it('keeps the mirror row hidden for a local list', function () {
        const out = makeRenderer()({ share_mirror: null });
        expect(out.hidden).to.equal(true);
        expect(out.ariaHidden).to.equal('true');
        expect(out.text).to.equal('');
    });

    it('clears mirror provenance when a later render is local', function () {
        const render = makeRenderer();
        render({ share_mirror: { home_chain: 'DOGE', home_list_index: 202, version: 3 } });
        const out = render({ share_mirror: null });
        expect(out.hidden).to.equal(true);
        expect(out.text).to.equal('');
        expect(out.href).to.equal(undefined);
    });
});
