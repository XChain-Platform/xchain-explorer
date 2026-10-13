'use strict';

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
 * The blocks list's per-block action counts, end to end: the feed packs one
 * slot per action table in ACTION_TABLES order, the page reads slot i as
 * XC.actions[i], and the cell names every type a block carries.
 */

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { JSDOM }  = require('jsdom');
const { expect } = require('chai');

const { ACTION_TABLES } = require('../../../../src/db/method_tables.js');
const { explorerRow }   = require('../../../../src/explorer/paging/explorer_row.js');
const { extractFn }     = require('../../../helpers/source_slice.js');

const JS_DIR     = path.resolve(__dirname, '../../../../src/content/js');
const XCHAIN_SRC = fs.readFileSync(path.join(JS_DIR, 'xchain.js'), 'utf8');
const ROWS_SRC   = fs.readFileSync(path.join(JS_DIR, 'xchain/datatable/rows_actions_a.js'), 'utf8');
const FMT_SRC    = fs.readFileSync(path.join(JS_DIR, 'formatters.js'), 'utf8');
const JQUERY_SRC = fs.readFileSync(path.join(JS_DIR, 'jquery.min.js'), 'utf8');
const numeral    = require(path.join(JS_DIR, 'numeral.js'));

// The XC.actions literal as the page ships it.
function clientActions(){
    const match = XCHAIN_SRC.match(/\n {4}actions: (\[[\s\S]*?\]),/);
    if(!match) throw new Error('XC.actions literal not found in xchain.js');
    return vm.runInNewContext(match[1]);
}

function blockRow(actions){
    const info = { block_index: 840000, timestamp: 1713571767, actions };
    return explorerRow({}, info, { type: 'explorer', method: 'getBlocks', count: 1, count_reverse: 1 });
}

// Run the page's block-row renderer over one feed row and return the actions cell.
function renderActionsCell(row){
    const dom = new JSDOM('<!doctype html><table><tr><td></td><td></td><td></td><td></td></tr></table>', { runScripts: 'outside-only' });
    dom.window.eval(JQUERY_SRC);
    dom.window.numeral = numeral;
    dom.window.eval(`
        var XC = { actions: ${JSON.stringify(clientActions())} };
        function formatLink(url, text){ return text; }
        function formatLivestamp(ts){ return String(ts); }
        ${extractFn(FMT_SRC, 'isNull')}
        ${extractFn(FMT_SRC, 'escapeHtml')}
        ${ROWS_SRC.match(/var xcBlockActionIcons = \{[\s\S]*?\n\};/)[0]}
        ${extractFn(ROWS_SRC, 'xcDatatableRenderBlockRow')}
    `);
    const tr = dom.window.document.querySelector('tr');
    dom.window.xcDatatableRenderBlockRow({ row: tr, data: row, coin: 'BTC' });
    return dom.window.$('td', tr).eq(2);
}

describe('blocks list action slots', function () {
    it('XC.actions lists every action table in ACTION_TABLES order', function () {
        expect(clientActions()).to.deep.equal(ACTION_TABLES);
    });

    it('packs one slot per action table, each count in its table\'s slot', function () {
        const row = blockRow({ prices: 3n, sweeps: 2, anchor_actions: 1, sends: 4 });
        expect(row[0]).to.equal(840000);
        expect(row[3]).to.equal(840000);
        const slots = row[2].split('|');
        expect(slots).to.have.length(ACTION_TABLES.length);
        const filled = {};
        slots.forEach((value, i) => { if(value !== '') filled[ACTION_TABLES[i]] = value; });
        expect(filled).to.deep.equal({ prices: '3', sweeps: '2', anchor_actions: '1', sends: '4' });
    });

    it('draws a count and an icon for each type the block carries', function () {
        const cell = renderActionsCell(blockRow({ prices: 3, full_node_verifications: 2, sweeps: 1 }));
        const titles = cell.find('a').map((i, a) => a.getAttribute('title')).get();
        expect(titles).to.deep.equal(['2 full_node_verifications', '3 prices', '1 sweeps']);
        expect(cell.find('i.fa-chart-line')).to.have.length(1);
        expect(cell.find('i.fa-truck')).to.have.length(1);
    });

    it('says the block carries no XChain actions when every slot is empty', function () {
        expect(blockRow({})[2]).to.equal('|'.repeat(ACTION_TABLES.length - 1));
        expect(renderActionsCell(blockRow({})).text()).to.equal('No XChain actions');
    });
});
