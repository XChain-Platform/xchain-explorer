/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 *********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '../../../../..');
const CONTENT = path.join(ROOT, 'src', 'content');
const JQUERY = fs.readFileSync(path.join(CONTENT, 'js', 'jquery.min.js'), 'utf8');
const NUMERAL = fs.readFileSync(path.join(CONTENT, 'js', 'numeral.js'), 'utf8');
const VOTE_SRC = fs.readFileSync(path.join(CONTENT, 'js', 'xchain', 'detail_attest_vote.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(path.join(CONTENT, 'html', 'action.html'), 'utf8');

function extractFn(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if(start < 0) throw new Error('function not found: ' + name);
    const braceStart = src.indexOf('{', start);
    let depth = 0;
    let end = braceStart;
    for(; end < src.length; end++) {
        if(src[end] === '{') depth++;
        else if(src[end] === '}' && --depth === 0) return src.slice(start, end + 1);
    }
    throw new Error('unterminated function: ' + name);
}

function votePanelHtml() {
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-vote">');
    const end = ACTION_HTML.indexOf('id="info-bet"', start);
    if(start < 0 || end < 0) throw new Error('could not bound info-vote panel');
    return ACTION_HTML.slice(start, end);
}

function renderVote(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + votePanelHtml() + '</body>', {
        runScripts: 'outside-only'
    });
    dom.window.eval(JQUERY);
    dom.window.eval(NUMERAL);
    dom.window.XC = { coin: 'BTC' };
    dom.window.eval(`
        $.getJSON = function(){ return { done: function(){} }; };
        function isNull(value){ return value === null || value === undefined; }
        function tokenUrl(coin, tick){ return '/' + coin + '/token/' + encodeURIComponent(String(tick)); }
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatAmount(value){ return String(value); }
    `);
    [
        'detailAttestVote_renderVoteFinalize',
        'detailAttestVote_renderPollSummary',
        'detailAttestVote_renderPollOutcome',
        'detailAttestVote_renderPollCallback',
        'detailAttestVote_renderPollResults',
        'detailAttestVote_renderVoteChoice',
        'showVoteDetails'
    ].forEach(name => dom.window.eval(extractFn(VOTE_SRC, name)));
    dom.window.showVoteDetails(data);
    return dom.window.$('#info-vote .vote-options');
}

describe('VOTE poll options parsing marker', function () {
    it('distinguishes malformed options JSON from an empty options list', function () {
        const options = renderVote({ vote_kind: 'poll', options_unparseable: true });

        expect(options.text().trim()).to.equal('Malformed options JSON');
        expect(options.find('.text-danger')).to.have.lengthOf(1);
        expect(options.text().trim()).to.not.equal('-');
    });

    it('keeps rendering a normal populated options list', function () {
        const options = renderVote({ vote_kind: 'poll', options: ['Yes', 'No'] });

        expect(options.html()).to.equal('0: Yes<br>1: No');
        expect(options.find('.text-danger')).to.have.lengthOf(0);
    });

    it('keeps dashing a genuinely empty options list', function () {
        const options = renderVote({ vote_kind: 'poll', options: [] });

        expect(options.text().trim()).to.equal('-');
        expect(options.find('.text-danger')).to.have.lengthOf(0);
    });
});
