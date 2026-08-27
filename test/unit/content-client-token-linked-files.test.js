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
 *
 * LINK v0 binds a FILE action to a token's ISSUE - the NFT pattern, and the
 * whole point of the action. Driving /RDOGE/token/CAMPC after seeding LINK
 * 1195 showed the link indexed, listed on /RDOGE/links, and present in the
 * token page's own Files TAB - while the info column, the part a reader
 * actually looks at for what a token IS, said "No additional information is
 * available at this time". The data existed at every layer and the card a
 * reader sees had nowhere to put it.
 *
 * The markup is loaded from the SHIPPED token.html, so a renamed id fails
 * here rather than silently rendering nothing again.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT = path.resolve(__dirname, '../../src/content');
const CLIENT  = path.join(CONTENT, 'js', 'xchain.js');
const JQUERY  = path.join(CONTENT, 'js', 'jquery.min.js');
const TOKEN   = path.join(CONTENT, 'html', 'token.html');

function bootPage(){
    const markup = fs.readFileSync(TOKEN, 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/token/CAMPC'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.jQuery.fn.dataTable = function(){ return this; };
    win.jQuery.fn.dataTable.ext = { errMode: null };
    win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
    win.eval(fs.readFileSync(CLIENT, 'utf8'));
    win.XC = win.XC || {};
    win.XC.coin = 'RDOGE';
    return win;
}

const shown = (win, sel) => win.jQuery(sel).css('display') !== 'none';

// FILE 1184 as getToken serves it for CAMPC: the plain campaign file, and the
// gated one whose bytes need a CAMPB balance.
const PLAIN = { action_index: 1184, name: 'e2e-a.bin', title: 'Campaign File A',
                type: 'application/octet-stream', block_index: 2907, gated: false };
const GATED = { action_index: 1186, name: 'e2e-gated.bin', title: 'Campaign File B',
                type: 'application/octet-stream', block_index: 2908, gated: true };

describe('token page: files LINKed to the token', function(){

    it('reveals the card and renders the linked file', function(){
        const win = bootPage();
        expect(shown(win, '#token-linked-files-card'), 'card hidden before render').to.equal(false);
        win.renderLinkedFiles([PLAIN], 'token-linked-files-body', 'token-linked-files-card');
        expect(shown(win, '#token-linked-files-card'), 'card revealed').to.equal(true);
        const html = win.jQuery('#token-linked-files-body').html();
        expect(html).to.contain('Campaign File A');
        expect(html).to.contain('e2e-a.bin');
        expect(html).to.contain('application/octet-stream');
        expect(html).to.contain('/RDOGE/action/1184');
    });

    it('offers the raw bytes of a plain file', function(){
        const win = bootPage();
        win.renderLinkedFiles([PLAIN], 'token-linked-files-body', 'token-linked-files-card');
        expect(win.jQuery('#token-linked-files-body').html()).to.contain('/RDOGE/file/1184/raw');
    });

    it('labels a gated file instead of offering a raw link that would refuse', function(){
        const win = bootPage();
        win.renderLinkedFiles([GATED], 'token-linked-files-body', 'token-linked-files-card');
        const html = win.jQuery('#token-linked-files-body').html();
        expect(html).to.contain('gated');
        expect(html, 'no raw link for a gated file').to.not.contain('/RDOGE/file/1186/raw');
    });

    it('stays hidden for a token with no linked file', function(){
        const win = bootPage();
        win.renderLinkedFiles([], 'token-linked-files-body', 'token-linked-files-card');
        expect(shown(win, '#token-linked-files-card')).to.equal(false);
        win.renderLinkedFiles(null, 'token-linked-files-body', 'token-linked-files-card');
        expect(shown(win, '#token-linked-files-card')).to.equal(false);
    });

    it('renders a blank cell, never the word null, for an untitled file', function(){
        const win = bootPage();
        win.renderLinkedFiles([Object.assign({}, PLAIN, { title: null, type: null })],
            'token-linked-files-body', 'token-linked-files-card');
        const text = win.jQuery('#token-linked-files-body').text();
        expect(text, 'the literal word null reached a cell').to.not.contain('null');
    });

    it('escapes an author-controlled title rather than injecting it', function(){
        const win = bootPage();
        win.renderLinkedFiles([Object.assign({}, PLAIN, { title: '<img src=x onerror=alert(1)>' })],
            'token-linked-files-body', 'token-linked-files-card');
        expect(win.jQuery('#token-linked-files-body img').length, 'markup was injected').to.equal(0);
    });
});
