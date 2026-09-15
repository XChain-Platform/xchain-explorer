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
 * getActionDetails' SEND branch read flat tick/amount/destination, but a raw
 * SEND detail payload keeps them per destination under sends[], so a BATCH
 * member SEND rendered as ' to ' plus an empty link to /address/undefined. The
 * renderer now tolerates the nested shape, and showActionDatatable prefers the
 * server projection a BATCH member carries under `summary`.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

// The client source comes from the shared helper: the cell-rendering helpers
// (isNull, escapeHtml, formatAmount, formatLink and friends) moved out of
// xchain.js into formatters.js in the component milestone, and this suite
// slices shipped functions out of whichever of the two they landed in.
const SRC = require('../helpers/content-source.js').clientSource();

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

function summary(action, info) {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
    dom.window.XC = { coin: 'BTC' };
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatLinkAmount(href, text, tick, amount){ return '<a href="' + href + '">' + amount + ' ' + text + '</a>'; }
        function formatAmount(v){ return String(v); }
        function isNull(v){ return (v === null || v === undefined || v === ''); }
        function isNumeric(v){ return !isNaN(parseFloat(v)) && isFinite(v); }
        function escapeHtml(v){ return String(v); }
        function bcadd(a, b){ return String(Number(a) + Number(b)); }
    `);
    dom.window.eval(extractFn('getActionDetails'));
    return dom.window.getActionDetails(action, info);
}

function renderRows(type, rows) {
    const dom = new JSDOM(
        '<!DOCTYPE html><body><table id="datatable-' + type + '"><tbody></tbody></table></body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatAmount(v){ return String(v); }
        function initStaticDatatable(){ }
    `);
    dom.window.XC = { coin: 'BTC' };
    const seen = [];
    dom.window.getActionDetails = function (action, details) {
        seen.push({ action, details });
        return 'summary';
    };
    dom.window.eval(extractFn('showActionDatatable'));
    dom.window.showActionDatatable(type, rows);
    return seen;
}

describe('getActionDetails SEND: flat summary and nested sends[] both render', function () {

    it('the flat summary shape renders amount, token and destination', function () {
        const html = summary('SEND', { tick: 'DANK', amount: '100', destination: 'addrB' });
        expect(html).to.include('/BTC/token/DANK');
        expect(html).to.include('100 DANK');
        expect(html).to.include('<a href="/BTC/address/addrB">addrB</a>');
    });

    it('[REGRESSION] a raw payload with one sends[] row renders that row, never /address/undefined', function () {
        const html = summary('SEND', { action: 'SEND', source: 'addrA',
            sends: [{ destination: 'addrB', tick: 'DANK', amount: '100', status: 'valid' }] });
        expect(html).to.include('100 DANK');
        expect(html).to.include('<a href="/BTC/address/addrB">addrB</a>');
        expect(html).to.not.include('undefined');
    });

    it('a multi-destination payload summarizes the total and the recipient count', function () {
        const html = summary('SEND', { action: 'SEND', source: 'addrA',
            sends: [{ destination: 'addrB', tick: 'DANK', amount: '100' },
                    { destination: 'addrC', tick: 'DANK', amount: '50' }] });
        expect(html).to.include('150 DANK');
        expect(html).to.include('2 recipients');
        expect(html).to.not.include('undefined');
    });

    it('a mixed-token multi-destination payload says so instead of picking one row', function () {
        const html = summary('SEND', { action: 'SEND',
            sends: [{ destination: 'addrB', tick: 'DANK', amount: '1' },
                    { destination: 'addrC', tick: 'PEPE', amount: '2' }] });
        expect(html).to.include('Multiple tokens to 2 recipients');
    });
});

describe('showActionDatatable: a BATCH member renders through its summary projection', function () {

    it('prefers the summary object over the flat payload and over a details string', function () {
        const seen = renderRows('batch', [
            { action_index: 1, action: 'SEND', status: 'valid',
              sends: [{ destination: 'addrB', tick: 'DANK', amount: '100' }],
              summary: { destination: 'addrB', tick: 'DANK', amount: '100' } },
            { action_index: 2, action: 'BET', status: 'valid', details: 'eyJ4IjoxfQ==',
              summary: { action_format: 0 } }
        ]);
        expect(seen[0].details).to.deep.equal({ destination: 'addrB', tick: 'DANK', amount: '100' });
        expect(seen[1].details).to.deep.equal({ action_format: 0 });
    });

    it('a member with no summary still falls back to the flat row', function () {
        const seen = renderRows('batch', [{ action_index: 3, action: 'MINT', status: 'valid', tick: 'DANK', amount: '1' }]);
        expect(seen[0].details.tick).to.equal('DANK');
    });
});
