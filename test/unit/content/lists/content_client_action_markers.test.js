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
 * The client half of the structure markers: getActionDetails appends a count
 * toggle to a multi-leg send, a multi-destroy and a BATCH parent, an in-batch
 * link to a member, and nothing to a plain row; the disclosure renderer lists
 * legs and members from the full action payload with user text escaped.
 * Runs the shipped functions sliced out of the page-loaded client parts.
 */
'use strict';
const { srcText } = require('../../../helpers/source_text');
const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = srcText('src/content/js/xchain.js');

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

const RENDERERS = [
    'getActionDetails',
    'actionDetail_renderBasicActions', 'actionDetail_renderMarketActions', 'actionDetail_renderMessageActions',
    'actionDetail_renderContractActions', 'actionDetail_renderConsensusActions',
    'actionDetail_renderStructureMarkers', 'actionDetail_disclosureToggle',
    'actionDetail_renderDisclosure', 'actionDetail_statusClass',
];

function makeWindow() {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'src', 'content', 'js', 'formatters.js'), 'utf8'));
    dom.window.eval(`
        function formatAmount(v){ return String(v); }
        function bcadd(a, b){ return String(Number(a) + Number(b)); }
    `);
    dom.window.XC = { coin: 'TDOGE', dispenser_preferences: {} };
    for (const name of RENDERERS) dom.window.eval(extractFn(name));
    return dom.window;
}

describe('structure markers client: getActionDetails', function () {
    it('a multi-send row gets a recipients toggle after its leg-0 summary', function () {
        const w = makeWindow();
        const html = w.getActionDetails('SEND', { tick: 'P00P', amount: '1', destination: 'addrB', leg_count: 4, action_index: '2059' });
        expect(html).to.include('addrB');
        expect(html).to.include('xc-legs-toggle');
        expect(html).to.include('data-action-index="2059"');
        expect(html).to.include('4 recipients');
    });

    it('a multi-destroy row says legs, not recipients', function () {
        const w = makeWindow();
        const html = w.getActionDetails('DESTROY', { tick: 'P00P', amount: '1', leg_count: 2, action_index: '2062' });
        expect(html).to.include('2 legs');
        expect(html).to.not.include('recipients');
    });

    it('a BATCH parent shows its member count as a toggle', function () {
        const w = makeWindow();
        const html = w.getActionDetails('BATCH', { member_count: 3, action_index: '166' });
        expect(html).to.include('Batch');
        expect(html).to.include('3 actions');
        expect(html).to.include('data-action-index="166"');
    });

    it('a member row links its parent batch', function () {
        const w = makeWindow();
        const html = w.getActionDetails('SEND', { tick: 'P00P', amount: '1', destination: 'addrB', parent_batch_action_index: 166 });
        expect(html).to.include('xc-in-batch');
        expect(html).to.include('/TDOGE/action/166');
        expect(html).to.not.include('xc-legs-toggle');
    });

    it('a plain send row carries no marker at all', function () {
        const w = makeWindow();
        const html = w.getActionDetails('SEND', { tick: 'P00P', amount: '1', destination: 'addrB' });
        expect(html).to.not.include('xc-legs-toggle');
        expect(html).to.not.include('xc-in-batch');
    });

    it('a details value of false renders the summary without throwing', function () {
        const w = makeWindow();
        expect(w.getActionDetails('BATCH', false)).to.equal('Batch');
    });
});

describe('structure markers client: actionDetail_renderDisclosure', function () {
    it('lists every leg of a multi-send with the memo escaped', function () {
        const w = makeWindow();
        const html = w.actionDetail_renderDisclosure({
            action: 'SEND',
            sends: [
                { destination: 'addrB', tick: 'P00P', amount: '1', memo: '<script>x</script>', status: 'valid' },
                { destination: 'addrC', tick: 'P00P', amount: '2', memo: '', status: 'invalid' },
            ]
        });
        expect(html).to.include('addrB');
        expect(html).to.include('addrC');
        expect(html).to.include('&lt;script&gt;');
        expect(html).to.not.include('<script>');
        expect(html).to.include('bg-green');
        expect(html).to.include('bg-red');
    });

    it('lists batch members through the shared summary renderer, reading summary never details', function () {
        const w = makeWindow();
        const html = w.actionDetail_renderDisclosure({
            action: 'BATCH',
            actions: [
                { action: 'SEND', action_index: 167, status: 'valid', summary: { tick: 'P00P', amount: '1', destination: 'addrB' } },
                { action: 'BET', action_index: 168, status: 'valid', bet_kind: 'feed', label: 'Rain?', details: 'eyJ4IjoxfQ==' },
            ]
        });
        expect(html).to.include('addrB');
        expect(html).to.include('/TDOGE/action/167');
        expect(html).to.include('/TDOGE/action/168');
        expect(html).to.not.include('eyJ4IjoxfQ==');
    });

    it('falls back to a plain sentence for a payload with nothing to expand', function () {
        const w = makeWindow();
        expect(w.actionDetail_renderDisclosure({ action: 'ISSUE', tick: 'P00P' })).to.include('Nothing to expand');
        expect(w.actionDetail_renderDisclosure(null)).to.include('Nothing to expand');
    });
});
