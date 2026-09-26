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
 * Defense in depth for formatLinkHtml(): every shipped caller only ever
 * passes a same-origin relative path or a tokenUrl()/`'/' + coin + ...`
 * result, but the function itself accepted any scheme, so a future caller
 * that forwarded an on-chain URL unchecked would have built a javascript:
 * or data: href. formatLinkHtml() now refuses anything but a relative path
 * or an http(s) URL and renders the label as plain text instead. This pins
 * the refusal and that every existing relative caller shape still links.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT    = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'src', 'content');
const CLIENT_SRC = require('../../../../../helpers/content-source.js').clientSource();
const JQUERY     = path.join(CONTENT, 'js', 'jquery.min.js');
const ACTION     = path.join(CONTENT, 'html', 'action.html');

function bootPage(){
    const markup = fs.readFileSync(ACTION, 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/TDOGE/action/1'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = win.XC || {};
    win.XC.coin = 'TDOGE';
    return win;
}

function parse(win, html){
    const div = win.document.createElement('div');
    div.innerHTML = html;
    return div;
}

describe('formatLinkHtml: relative/http(s) allow-list @regression', function(){

    it('refuses a javascript: URL and renders the label as plain text', function(){
        const win = bootPage();
        const out = parse(win, win.formatLinkHtml('javascript:alert(1)', 'click me'));
        expect(out.querySelector('a')).to.equal(null);
        expect(out.textContent).to.equal('click me');
    });

    it('refuses a data: URL', function(){
        const win = bootPage();
        const out = parse(win, win.formatLinkHtml('data:text/html,<script>alert(1)</script>', 'open'));
        expect(out.querySelector('a')).to.equal(null);
        expect(out.textContent).to.equal('open');
    });

    it('refuses a protocol-relative URL (host-controlled, not this origin)', function(){
        const win = bootPage();
        const out = parse(win, win.formatLinkHtml('//evil.example/x', 'go'));
        expect(out.querySelector('a')).to.equal(null);
    });

    it('still links a same-origin relative path', function(){
        const win = bootPage();
        const out = parse(win, win.formatLinkHtml('/TDOGE/action/7', 'view'));
        expect(out.querySelector('a').getAttribute('href')).to.equal('/TDOGE/action/7');
    });

    it('still links a real http(s) URL', function(){
        const win = bootPage();
        const out = parse(win, win.formatLinkHtml('https://example.test/x', 'view'));
        expect(out.querySelector('a').getAttribute('href')).to.equal('https://example.test/x');
    });

    it('links a token literally named null', function(){
        const win = bootPage();
        const out = parse(win, win.formatLinkHtml('/TDOGE/token/null', 'TICK'));
        expect(out.querySelector('a').getAttribute('href')).to.equal('/TDOGE/token/null');
        expect(out.textContent).to.equal('TICK');
    });

});
