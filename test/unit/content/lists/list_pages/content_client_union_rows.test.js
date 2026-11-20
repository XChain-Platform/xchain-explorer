/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const { JSDOM } = require('jsdom');
const { srcText } = require('../../../../helpers/source_text');
const { extractFn } = require('../../../../helpers/source_slice');

const SRC = srcText('src/content/js/xchain.js');

function row(type, info, idx) {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.XC = { coin: 'BTC' };
    dom.window.eval(`
        function isNull(v){ return v === null || v === undefined || v === ''; }
        function formatAmount(v){ return String(v); }
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function tokenUrl(coin, tick){ return '/' + coin + '/token/' + tick; }
    `);
    dom.window.eval(extractFn(SRC, 'detailAnchorPrice_actionRow', 'xchain.js'));
    return dom.window.detailAnchorPrice_actionRow(type, info, idx, 'Union', '');
}

describe('client union list rows', function () {
    it('links a union member to its LIST action', function () {
        expect(row('list-items', 42, 0)).to.contain('href="/BTC/action/42"');
    });

    it('links an edit member and retains its status cell', function () {
        const html = row('list-edits', { list_action_index: 9, status: 'valid' }, 0);
        expect(html).to.contain('href="/BTC/action/9"');
        expect(html).to.contain('<td>valid</td>');
    });

    it('renders an unresolved edit member as a plain dash', function () {
        const html = row('list-edits', { list_action_index: null, status: 'invalid' }, 0);
        expect(html).to.contain('<td>-</td>');
        expect(html).to.not.contain('/action/');
    });
});
