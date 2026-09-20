/*********************************************************************
 *
 * Copyright (c) 2025-2026 Dankest, LLC
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

const { srcText } = require('../../../helpers/source_text');

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const ROOT = path.resolve(__dirname, '..', '..', '../../');
const SRC = srcText('src/content/js/xchain.js')
    + '\n' + fs.readFileSync(path.join(ROOT, 'src/content/js/formatters.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(path.join(ROOT, 'src/content/html/action.html'), 'utf8');
const CARDS = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'src/content/layouts/action-detail-cards.json'), 'utf8'));

function extractFn(name) {
    const sig = 'function ' + name + '(';
    const start = SRC.indexOf(sig);
    if (start < 0) throw new Error('function not found in client source: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0;
    let i = braceStart;
    for (; i < SRC.length; i++) {
        if (SRC[i] === '{') depth++;
        else if (SRC[i] === '}') {
            depth--;
            if (depth === 0) {
                i++;
                break;
            }
        }
    }
    return SRC.slice(start, i);
}

function panelHtml() {
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-rollcall">');
    if (start < 0) throw new Error('#info-rollcall panel not found in action.html');
    const end = ACTION_HTML.indexOf('<!-- Credits -->', start);
    if (end < 0) throw new Error('could not bound the #info-rollcall panel');
    return ACTION_HTML.slice(start, end);
}

function render(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.join(ROOT, 'src/content/js/numeral.js'), 'utf8'));
    dom.window.eval(`
        function formatHash(h, len){ return String(h == null ? '' : h).substring(0, len); }
        ${extractFn('isNull')}
        ${extractFn('escapeHtml')}
    `);
    dom.window.eval(extractFn('showRollcallDetails'));
    dom.window.showRollcallDetails(Object.assign({
        epoch_height: 151400,
        ledger_hash: 'ab'.repeat(32),
        publisher: 'cd'.repeat(32),
        signers: []
    }, data));

    const doc = dom.window.document;
    const cell = (name) => doc.querySelector('#info-rollcall .' + name);
    return {
        version: cell('rollcall-version'),
        gates: cell('rollcall-gates'),
        gateBadges: [...cell('rollcall-gates').querySelectorAll('.badge')]
            .map((badge) => badge.textContent)
    };
}

function markupRows() {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>');
    return [...dom.window.document.querySelectorAll('#info-rollcall > table:first-of-type tbody tr')]
        .map((row) => ({
            label: row.querySelector('th').textContent.trim(),
            cell: row.querySelector('td').classList[0]
        }));
}

describe('ROLLCALL detail version and consensus gates', function () {
    it('renders v0 from action_format and shows no gate list', function () {
        const out = render({ action_format: 0, gates: ['ignored.GATE'] });
        expect(out.version.textContent.trim()).to.equal('ROLLCALL v0');
        expect(out.version.querySelector('.badge')).to.not.equal(null);
        expect(out.gates.textContent.trim()).to.equal('-');
        expect(out.gateBadges).to.deep.equal([]);
    });

    it('renders v1 from action_format and every published gate as a badge', function () {
        const out = render({
            action_format: 1,
            gates: ['alpha.FIRST', 'beta.SECOND', 'gamma.THIRD']
        });
        expect(out.version.textContent.trim()).to.equal('ROLLCALL v1');
        expect(out.version.querySelector('.badge')).to.not.equal(null);
        expect(out.gateBadges).to.deep.equal([
            'alpha.FIRST', 'beta.SECOND', 'gamma.THIRD'
        ]);
    });

    it('preserves the published gate order', function () {
        const gates = ['zeta.LAST', 'alpha.FIRST', 'middle.GATE'];
        expect(render({ action_format: 1, gates }).gateBadges).to.deep.equal(gates);
    });

    it('escapes gate names before writing badge markup', function () {
        const hostile = '<img src=x onerror=alert(1)>';
        const out = render({ action_format: 1, gates: [hostile, 'safe.GATE'] });
        expect(out.gateBadges).to.deep.equal([hostile, 'safe.GATE']);
        expect(out.gates.querySelector('img')).to.equal(null);
        expect(out.gates.innerHTML).to.contain('&lt;img');
    });

    it('shows a dash when a v1 payload has no gates', function () {
        expect(render({ action_format: 1, gates: [] }).gates.textContent.trim()).to.equal('-');
    });

    it('keeps the shipped markup and rollcall row layout exactly aligned', function () {
        expect(markupRows()).to.deep.equal(CARDS.cards.rollcall.rows);
        expect(markupRows().map((row) => row.cell)).to.deep.equal([
            'rollcall-version',
            'rollcall-epoch-height',
            'rollcall-ledger-hash',
            'rollcall-publisher',
            'rollcall-gates',
            'rollcall-signer-count'
        ]);
    });
});
