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
 * Two label families the action pages print.
 *
 *  - Version labels: the STAKE card and the stake, validator and anchor rows
 *    show '-' for a missing version, never the literal text 'vnull'.
 *  - Anchor chunk labels: the stored index is 0 on the head and 1-based on each
 *    continuation, and every surface shows it 1-based, so the feed summary, the
 *    ANCHOR card and the anchor page name the same chunk.
 *
 * Every case drives the SHIPPED function against the SHIPPED markup.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');
const { srcText } = require('../../../../helpers/source_text');

const CONTENT    = path.resolve(__dirname, '..', '..', '..', '..', '..', 'src', 'content');
const CLIENT_SRC = require('../../../../helpers/content-source.js').clientSource();
const JQUERY     = fs.readFileSync(path.join(CONTENT, 'js', 'jquery.min.js'), 'utf8');
const ACTION     = fs.readFileSync(path.join(CONTENT, 'html', 'action.html'), 'utf8');
const ANCHOR_SRC = srcText('src/content/js/anchor_detail_render.js');

// Boot the action page with the full client bundle, as the XSS harness does.
function bootPage(){
    const dom = new JSDOM('<!doctype html><html><body>' + ACTION + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/TDOGE/action/1'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(JQUERY);
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = win.XC || {};
    win.XC.coin    = 'TDOGE';
    win.XC.network = 'testnet';
    return win;
}

// Slice a top-level function out of a source text by walking braces.
function extractFn(src, name){
    const start = src.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('function not found: ' + name);
    let depth = 0, i = src.indexOf('{', start);
    for(; i < src.length; i++){
        if(src[i] === '{') depth++;
        else if(src[i] === '}'){ depth--; if(depth === 0){ i++; break; } }
    }
    return src.slice(start, i);
}

// Run one datatable row handler and read back the version cell.
function rowVersionCell(win, fn, cells, data){
    let tds = '';
    for(let i = 0; i < cells; i++) tds += '<td></td>';
    const row = win.jQuery('<tr>' + tds + '</tr>')[0];
    win[fn]({ row: row, data: data, idx: 0, coin: 'TDOGE', action: '', type: '',
        action_index: 1, status: 1, count: 1, block_index: 1, timestamp: 1, source: '',
        fmtInteger: '0,0', fmtCurrency: '0,0', fmtCoin: '0,0', action_link: '' });
    return win.jQuery('td', row).eq(5).text();
}

// The shipped anchorChunkLabel with the real isNull and an escaping anchorEsc.
function anchorChunkLabel(row){
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(JQUERY);
    dom.window.eval(extractFn(CLIENT_SRC, 'isNull'));
    dom.window.eval(extractFn(ANCHOR_SRC, 'anchorEsc'));
    dom.window.eval(extractFn(ANCHOR_SRC, 'anchorChunkLabel'));
    return dom.window.anchorChunkLabel(row);
}

const ROW_CASES = [
    { fn: 'xcDatatableRenderStakeRow', cells: 8 },
    { fn: 'xcDatatableRenderValidatorRow', cells: 11 },
    { fn: 'xcDatatableRenderAnchorRow', cells: 10 }
];

describe('client: version labels never print vnull', function(){

    it('the STAKE card shows a dash for a missing version', function(){
        const win = bootPage();
        win.showStakeDetails({ version: null, signing_pubkey: 'ab', amount: '1', target_contract_index: null });
        expect(win.jQuery('#info-stake .stake-version').text()).to.equal('-');
    });

    it('the STAKE card still prints a real version, zero included', function(){
        const win = bootPage();
        win.showStakeDetails({ version: 2, signing_pubkey: 'ab', amount: '1', target_contract_index: null });
        expect(win.jQuery('#info-stake .stake-version').text()).to.equal('v2');
        win.showStakeDetails({ version: 0, signing_pubkey: 'ab', amount: '1', target_contract_index: null });
        expect(win.jQuery('#info-stake .stake-version').text()).to.equal('v0');
    });

    ROW_CASES.forEach(function(c){
        it(c.fn + ' shows a dash for a missing version and v1 for a real one', function(){
            const win = bootPage();
            const blank = [null, null, null, null, 'ab', null, '1', null, null, null, null];
            const set   = blank.slice(); set[5] = 1;
            expect(rowVersionCell(win, c.fn, c.cells, blank)).to.equal('-');
            expect(rowVersionCell(win, c.fn, c.cells, set)).to.equal('v1');
        });
    });
});

describe('client: anchor chunk labels are 1-based on every surface', function(){

    it('the ANCHOR card shows a continuation as the feed does', function(){
        const win = bootPage();
        win.showAnchorDetails({ version: 2, chunk_index: 1, total_chunks: 3 });
        expect(win.jQuery('#info-anchor .anchor-chunk').text()).to.equal('2 of 3');
        expect(win.getActionDetails('ANCHOR', { chunk_index: 1, total_chunks: 3 })).to.contain('(chunk 2 of 3)');
    });

    it('the ANCHOR card shows a head row as chunk 1 and a missing total as ?', function(){
        const win = bootPage();
        win.showAnchorDetails({ version: 3, chunk_index: 0, total_chunks: 1 });
        expect(win.jQuery('#info-anchor .anchor-chunk').text()).to.equal('1 of 1');
        win.showAnchorDetails({ version: 2, chunk_index: 1, total_chunks: null });
        expect(win.jQuery('#info-anchor .anchor-chunk').text()).to.equal('2 of ?');
    });

    it('the ANCHOR card keeps a dash when the row carries no chunk', function(){
        const win = bootPage();
        win.showAnchorDetails({ version: 0, chunk_index: null, total_chunks: null });
        expect(win.jQuery('#info-anchor .anchor-chunk').text()).to.equal('-');
    });

    it('the anchor page chunk label is 1-based and reads a v1 head as chunk 1', function(){
        expect(anchorChunkLabel({ chunk_index: 0, total_chunks: 2 })).to.equal('1 of 2');
        expect(anchorChunkLabel({ chunk_index: 1, total_chunks: 2 })).to.equal('2 of 2');
        expect(anchorChunkLabel({ chunk_index: null, total_chunks: 3 })).to.equal('1 of 3');
        expect(anchorChunkLabel({ chunk_index: null, total_chunks: null })).to.equal('-');
    });

    it('the sibling chunks table numbers a v1 head and its continuations 1 to N', function(){
        const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
        const win = dom.window;
        win.eval(JQUERY);
        win.eval(extractFn(CLIENT_SRC, 'isNull'));
        win.formatLink = function(href, text){ return String(text); };
        ['anchorEsc', 'anchorNum', 'anchorEmpty', 'anchorCoin', 'anchorBlockLink',
            'anchorStatusBadge', 'anchorChunkLabel', 'renderAnchorChunks']
            .forEach(function(n){ win.eval(extractFn(ANCHOR_SRC, n)); });
        win.document.body.innerHTML = win.renderAnchorChunks({ action_index: 7, chunks: [
            { action_index: 7, version: 1, chunk_index: null, total_chunks: 3 },
            { action_index: 8, version: 2, chunk_index: 1, total_chunks: 3 },
            { action_index: 9, version: 2, chunk_index: 2, total_chunks: 3 }
        ] });
        const cells = Array.from(win.document.querySelectorAll('.anchor-chunk-row td:first-child'))
            .map(function(td){ return td.textContent; });
        expect(cells).to.deep.equal(['1 of 3', '2 of 3', '3 of 3']);
    });
});
