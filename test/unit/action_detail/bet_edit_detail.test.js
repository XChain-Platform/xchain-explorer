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
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const governanceSql = require('../../../src/db/action_detail/governance_sql.js');
const governance = require('../../../src/action-detail/governance.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'src/content/js/xchain/detail/detail_bet_stake.js'), 'utf8');
const CORE = fs.readFileSync(path.join(ROOT, 'src/content/js/xchain/detail/detail_core.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(path.join(ROOT, 'src/content/html/action.html'), 'utf8');
const JQUERY = fs.readFileSync(path.join(ROOT, 'src/content/js/jquery.min.js'), 'utf8');
const LAYOUT = require('../../../src/content/layouts/action-detail-cards.json');
const util = { isNull: value => value === null || value === undefined };

function extractFn(name, source = SCRIPT){
    const start = source.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('function not found: ' + name);
    const brace = source.indexOf('{', start);
    let depth = 0;
    for(let i = brace; i < source.length; i++){
        if(source[i] === '{') depth++;
        if(source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error('function not terminated: ' + name);
}

function panelHtml(){
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-bet">');
    const end = ACTION_HTML.indexOf('id="info-bet-expire"', start);
    return ACTION_HTML.slice(start, end);
}

function renderEdit(data){
    const dom = new JSDOM('<!doctype html><body>' + panelHtml() + '</body>', { runScripts: 'outside-only' });
    const win = dom.window;
    win.eval(JQUERY);
    win.XC = { coin: 'BTC' };
    win.eval(`
        function isNull(value){ return value === null || value === undefined; }
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatIndexedLabel(value){ return String(value); }
    `);
    win.eval(extractFn('detailBetStake_renderFeed'));
    win.eval(extractFn('detailBetStake_renderAction'));
    win.eval(extractFn('showBetDetails'));
    win.detailCore_dispatchBridgePanel = () => false;
    win.eval(extractFn('detailCore_dispatchAction', CORE));
    win.detailCore_dispatchAction({ action: 'BET_EDIT', ...data });
    const $ = win.$;
    return {
        panelHidden: $('#info-bet').hasClass('d-none'),
        hidden: $('#info-bet .bet-edit-fields').hasClass('d-none'),
        market: $('#info-bet .bet-edit-feed-ref').text().trim(),
        allow: $('#info-bet .bet-edit-allow-list').text().trim(),
        allowHref: $('#info-bet .bet-edit-allow-list a').attr('href'),
        block: $('#info-bet .bet-edit-block-list').text().trim(),
        status: $('#info-bet .bet-edit-status').text().trim()
    };
}

describe('BET format 4 action detail', function(){
    it('joins the edit row, its status, and parent market into the BET detail query', function(){
        assert.strictEqual(governance.BET_EDIT, governance.BET);
        assert.match(governanceSql.BET_DETAIL,
            /LEFT\s+JOIN bet_edits\s+be ON \(be\.action_index=a1\.action_index\)/);
        assert.match(governanceSql.BET_DETAIL,
            /LEFT\s+JOIN index_statuses\s+bes ON \(bes\.id=be\.status_id\)/);
        assert.match(governanceSql.BET_DETAIL,
            /be\.feed_action_index as edit_feed_ref/);
        assert.match(governanceSql.BET_DETAIL,
            /be\.allow_list as edit_allow_list/);
        assert.match(governanceSql.BET_DETAIL,
            /be\.block_list as edit_block_list/);
        assert.match(governanceSql.BET_DETAIL,
            /COALESCE\(fs\.status, bs\.status, bcs\.status, brs\.status\) as status/);
        assert.match(governanceSql.BET_DETAIL, /bes\.status as edit_status/);
        assert.match(governanceSql.BET_DETAIL,
            /COALESCE\([^)]*be\.feed_action_index\)/);
    });

    it('shapes format 4 as an edit without querying cancel or resolve history', async function(){
        let queried = false;
        const db = { util, doQuery: async () => { queried = true; return []; } };
        const data = {
            action_format: 4,
            edit_feed_ref: 41,
            edit_allow_list: null,
            edit_block_list: 93,
            status: null,
            edit_status: 'valid'
        };
        await governance.BET.afterMain({ db, config: {}, action_index: 55 }, data);
        assert.equal(queried, false);
        assert.equal(data.bet_kind, 'edit');
        assert.equal(data.feed_ref, 41);
        assert.equal(data.edit_allow_list, null);
        assert.equal(data.edit_block_list, 93);
        assert.equal(data.edit_feed_ref, undefined);
        assert.equal(data.edit_status, undefined);
    });

    it('keeps edit-only columns off the other BET shapes', async function(){
        const db = { util, doQuery: async () => [] };
        const data = {
            action_format: 2,
            feed_action_index: 41,
            edit_allow_list: 92,
            edit_block_list: 93,
            outcome: 1,
            amount: '10'
        };
        await governance.BET.afterMain({ db, config: {}, action_index: 56 }, data);
        assert.equal(data.bet_kind, 'bet');
        assert.equal(data.edit_allow_list, undefined);
        assert.equal(data.edit_block_list, undefined);
    });
});

describe('BET format 4 action detail rendering', function(){
    it('renders retain, detach, and replace semantics with the action status', function(){
        const retained = renderEdit({
            bet_kind: 'edit', feed_ref: 41, edit_allow_list: null,
            edit_block_list: '000', status: 'valid'
        });
        assert.equal(retained.panelHidden, false);
        assert.equal(retained.hidden, false);
        assert.equal(retained.market, '41');
        assert.equal(retained.allow, 'unchanged');
        assert.equal(retained.block, 'detached');
        assert.equal(retained.status, 'valid');

        const replaced = renderEdit({
            bet_kind: 'edit', feed_ref: 41, edit_allow_list: 93,
            edit_block_list: null, status: 'invalid: SOURCE (not owner)'
        });
        assert.equal(replaced.allow, '93');
        assert.equal(replaced.allowHref, '/BTC/action/93');
        assert.equal(replaced.block, 'unchanged');
        assert.equal(replaced.status, 'invalid: SOURCE (not owner)');
    });

    it('keeps the edit markup and layout registry in lockstep', function(){
        assert.match(panelHtml(), /<tbody[^>]*\bid="info-bet-edit"/);
        assert.match(CORE, /if\(o\.action=='BET_EDIT'\)\{\s*found = true;\s*showBetDetails\(o\);\s*\$\('#info-bet'\)\.removeClass\('d-none'\);\s*\}/);
        const rows = LAYOUT.cards.bet.rows.slice(-4);
        assert.deepEqual(rows, [
            { label: 'Market', cell: 'bet-edit-feed-ref' },
            { label: 'Allow List Edit', cell: 'bet-edit-allow-list' },
            { label: 'Block List Edit', cell: 'bet-edit-block-list' },
            { label: 'Action Status', cell: 'bet-edit-status' }
        ]);
        for(const row of rows)
            assert.match(panelHtml(), new RegExp('class="' + row.cell + '"'));
    });
});
