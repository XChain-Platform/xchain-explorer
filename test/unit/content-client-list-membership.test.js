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
 * Display leg, client half. Drives the SHIPPED showListDetails against
 * the SHIPPED #info-list markup sliced out of action.html, so a renamed class
 * or a dropped panel row fails here instead of silently rendering nothing.
 *
 * What it protects: the "Full List" tab on a LIST create used to show the
 * create-time snapshot, because a LIST edit writes its resulting membership
 * under the EDIT's own action_index. Consumers pin a list by its CREATE index,
 * so that tab is where a betting market's "who may bet" link lands, and it was
 * showing members the chain had already stopped admitting.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/action.html'), 'utf8');

// Slice a top-level function out of the source by walking braces (the same
// technique content-client-xss.test.js uses) so the test runs shipped code
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

function panelHtml() {
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-list">');
    if (start < 0) throw new Error('#info-list panel not found in action.html');
    // Bounded by the next action panel; the LIST panel is self-contained.
    const end = ACTION_HTML.indexOf('id="info-message"', start);
    if (end < 0) throw new Error('could not bound the #info-list panel');
    return ACTION_HTML.slice(start, end);
}

function renderListDetails(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml() + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));

    dom.window.XC = { coin: 'BTC', list_types: { 1: 'Token', 2: 'Address' }, list_edit_types: { 0: 'None', 1: 'Add', 2: 'Remove' } };
    // Helpers showListDetails leans on, kept naive so anything the assertions
    // observe is showListDetails' own doing. showActionDatatable is recorded
    // rather than executed: DataTables is not under test, but WHICH array it is
    // handed is the entire point of this change.
    let tables = {};
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatAmount(v){ return String(v); }
        function isNumeric(v){ return !isNaN(parseFloat(v)) && isFinite(v); }
    `);
    dom.window.showActionDatatable = function (id, rows) { tables[id] = rows; };
    dom.window.eval(extractFn('showListDetails'));
    dom.window.showListDetails(data);
    const $ = dom.window.$;
    return {
        tables,
        tabLabel:        $('#list-items-tab').text().trim(),
        membershipShown: !$('#info-list .list-membership-row').hasClass('d-none'),
        membershipLink:  $('#info-list .list-membership-action-index').text().trim(),
    };
}

const CREATE_ROWS = ['mMemberA', 'mMemberB'];
const CURRENT     = ['mMemberB'];

describe('client: the LIST page shows current membership', function () {

    it('[REGRESSION] renders the edit head\'s membership, not the create snapshot', function () {
        const out = renderListDetails({
            action_index: 100, type: 2, edit: 0, list_action_index: null, list: CREATE_ROWS,
            state: { edit_resolution_active: true, membership_action_index: 140, current_list: CURRENT },
        });
        expect(out.tables['list-items'], 'the removed member must be gone').to.deep.equal(CURRENT);
        expect(out.tables['list-items']).to.not.include('mMemberA');
    });

    it('names the action that set membership, and links to it', function () {
        // Without this the page states a membership with no way to check where it
        // came from, which is the same opacity that hid the bug.
        const out = renderListDetails({
            action_index: 100, type: 2, edit: 0, list_action_index: null, list: CREATE_ROWS,
            state: { edit_resolution_active: true, membership_action_index: 140, current_list: CURRENT },
        });
        expect(out.membershipShown, 'the Membership Set By row is revealed').to.equal(true);
        expect(out.membershipLink).to.equal('140');
        expect(out.tabLabel).to.equal('Current List');
    });

    it('hides the membership row when this action IS the head', function () {
        const out = renderListDetails({
            action_index: 100, type: 2, edit: 0, list_action_index: null, list: CREATE_ROWS,
            state: { edit_resolution_active: true, membership_action_index: 100, current_list: CREATE_ROWS },
        });
        expect(out.membershipShown, 'nothing to point at: this action set it').to.equal(false);
        expect(out.tables['list-items']).to.deep.equal(CREATE_ROWS);
    });

    it('falls back to this action\'s own rows below the flag day', function () {
        // Inert state: consensus still gates on the create's rows, so the page
        // must keep showing them rather than a membership nothing enforces.
        const out = renderListDetails({
            action_index: 100, type: 2, edit: 0, list_action_index: null, list: CREATE_ROWS,
            state: { edit_resolution_active: false, membership_action_index: 100, current_list: null },
        });
        expect(out.tables['list-items']).to.deep.equal(CREATE_ROWS);
        expect(out.membershipShown).to.equal(false);
        expect(out.tabLabel, 'the old label stays while the old rule applies').to.equal('Full List');
    });

    it('renders an older explorer response (no state block) unchanged', function () {
        // The client is served from the same origin as the API, but a cached page
        // against a rolled-back server must not blank the list.
        const out = renderListDetails({
            action_index: 100, type: 2, edit: 0, list_action_index: null, list: CREATE_ROWS });
        expect(out.tables['list-items']).to.deep.equal(CREATE_ROWS);
        expect(out.membershipShown).to.equal(false);
    });

    it('still renders the edits table', function () {
        const out = renderListDetails({
            action_index: 140, type: 2, edit: 2, list_action_index: 100, list: CURRENT,
            edits: [{ address: 'mMemberA', status: 'valid' }],
            state: { edit_resolution_active: true, membership_action_index: 140, current_list: CURRENT },
        });
        expect(out.tables['list-edits']).to.deep.equal([{ address: 'mMemberA', status: 'valid' }]);
    });
});
