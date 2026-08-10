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
 * Item 4086: showActionDatatable's actions/batch renderer decides what to hand
 * getActionDetails. Two different row shapes reach that one branch:
 *
 *  - the TRANSACTION actions table, whose rows come from db.getActionSummaryData
 *    and carry a built summary OBJECT on `.details`;
 *  - a BATCH's member table, whose rows are full getActionData payloads with
 *    their fields FLAT, and where a BET feed member keeps the raw
 *    attacker-supplied base64 DETAILS string on that same `.details` key
 *    (src/action-detail/governance.js).
 *
 * The unwrap keyed on truthiness alone, so a BET feed member handed
 * getActionDetails a base64 STRING instead of the action info. No BET case
 * exists in getActionDetails today, so nothing rendered wrong yet; these
 * assertions pin the argument so adding one cannot land on the string.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8');

// Slice the shipped function out of xchain.js by walking braces, the same
// technique the sibling content-client tests use, so this runs shipped code
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

// Render rows through the shipped renderer and record every (action, details)
// pair getActionDetails was called with.
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

describe('item 4086 client: showActionDatatable unwraps only a summary OBJECT', function () {

    it('[REGRESSION] a BET feed member\'s raw base64 details never reaches getActionDetails', function () {
        // governance.js keeps the raw DETAILS payload verbatim on a feed BET, and a
        // batch member row is the flat getActionData payload, so `.details` here is
        // hostile base64, not a summary object.
        const seen = renderRows('batch', [{
            action: 'BET', action_index: 42, status: 'valid',
            bet_kind: 'feed', label: 'Will it rain?', tick: 'XCP',
            details: 'eyJ1cmwiOiJodHRwczovL2V2aWwuZXhhbXBsZSJ9',
        }]);
        expect(seen).to.have.lengthOf(1);
        expect(seen[0].action).to.equal('BET');
        expect(seen[0].details).to.be.an('object');
        expect(seen[0].details.bet_kind, 'the flat action info is what a BET case needs').to.equal('feed');
        expect(seen[0].details.label).to.equal('Will it rain?');
    });

    it('the transaction actions table still gets its nested summary object', function () {
        // getActionSummaryData builds this shape; unwrapping it is the behavior the
        // renderer was written for and must be preserved.
        const seen = renderRows('actions', [{
            action: 'SEND', action_index: 7, status: 'valid',
            details: { tick: 'XCP', amount: '10', destination: 'addr2' },
        }]);
        expect(seen).to.have.lengthOf(1);
        expect(seen[0].details).to.deep.equal({ tick: 'XCP', amount: '10', destination: 'addr2' });
    });

    it('a row with no summary (details false) falls back to the flat row', function () {
        // getActionSummaryData assigns `false` when no summary field matched.
        const seen = renderRows('actions', [{
            action: 'ISSUE', action_index: 9, status: 'valid', tick: 'XCP', details: false,
        }]);
        expect(seen).to.have.lengthOf(1);
        expect(seen[0].details.tick).to.equal('XCP');
    });
});
