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
 * A finalized poll's WINNING OPTION, across the three surfaces a reader can
 * reach it from (D-E033).
 *
 * `polls.winning_option` is an INDEX into the poll's `options` array, and every
 * defect in this class comes from one of two mistakes about that:
 *
 *  1. IT WAS NEVER CARRIED. db.getPolls has always selected winning_option and
 *     the getPagingDataResults 'getPolls' branch dropped it, so the polls list
 *     had no winner column at all: the field a reader opens a finished poll to
 *     see was stored, queried, returned by /api/polls, and rendered nowhere.
 *
 *  2. INDEX 0 IS FALSY. Option 0 is a real winner. Any renderer that tests the
 *     value for truthiness instead of for null turns the first option into a
 *     dash, which is indistinguishable from "no outcome was recorded" - the
 *     wrong answer, silently, on exactly half of a two-option poll.
 *
 * So every assertion below is written against winning_option === 0, and the
 * fixtures deliberately put the winner in the FIRST slot. The server half runs
 * the shipped getPagingDataResults; the client half drives the shipped
 * createdRow, showVoteDetails and renderPollOutcome against the shipped markup.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM }  = require('jsdom');
const proxyquire = require('proxyquire');

const ROOT    = path.resolve(__dirname, '../..');
const CONTENT = path.join(ROOT, 'src', 'content');
const JQUERY  = fs.readFileSync(path.join(CONTENT, 'js', 'jquery.min.js'), 'utf8');
const NUMERAL = fs.readFileSync(path.join(CONTENT, 'js', 'numeral.js'), 'utf8');
const RENDER_SRC  = fs.readFileSync(path.join(CONTENT, 'js', 'poll-tally-render.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(path.join(CONTENT, 'html', 'action.html'), 'utf8');

const SOURCE     = require('../helpers/content-source.js');
const CLIENT_SRC = SOURCE.clientSource();
const POLLS_HTML = SOURCE.pageSource('polls.html');

const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeExplorerConfig }   = require('../fixtures/mock-query-args.js');

/* ------------------------------------------------------------------ *
 * Server harness: the real XChainExplorer with express and the DB
 * stubbed, so getPagingDataResults runs its shipped shaping branch.
 * ------------------------------------------------------------------ */

const mockApp = { use: () => {}, get: () => {}, post: () => {}, enable: () => {} };
const express = () => mockApp;
express.static = () => {};
express.json   = () => {};

class MockDB {
    async init() {}
    getMaxMethodResults() { return 100; }
}

const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
    'express': express,
    './db.js': MockDB
});

// One polls row exactly as db.getPolls returns it: `options` is the stored JSON
// blob (a string off the wire), winning_option a MySQL SMALLINT.
function pollRow(overrides = {}) {
    return Object.assign({
        action:                  'VOTE',
        action_index:            377,
        action_format:           0,
        source:                  'mzM2jjgdBsFnLWKVScpLxqnJSuXUT6bY5a',
        tick:                    'CORPA',
        end_block:               1341,
        options:                 '["Yes","No"]',
        max_selections:          1,
        tally_mode:              'approval',
        weight_mode:             'balance',
        quorum:                  '0.1',
        min_voters:              1,
        question:                'Does the corpus seed?',
        poll_status:             'finalized',
        winning_option:          0,
        total_weight:            '500',
        total_voters:            1,
        quorum_met:              1,
        min_voters_met:          1,
        deposit_amount:          '0',
        callback_contract_index: null,
        callback_method:         null,
        finalized_action_index:  385,
        block_index:             1332,
        timestamp:               1788322527,
        tx_hash:                 'e74db1cf',
        tx_index:                373,
        status:                  'valid'
    }, overrides);
}

// The shipped shaping branch, run over one row, returned as the positional array
// the /explorer feed actually serves.
function feedRow(overrides = {}) {
    const explorer = new XChainExplorer(mockApp, createConfigInfoStub());
    const cfg      = makeExplorerConfig('getPolls', null, null, { length: 10 });
    const rows     = explorer.getPagingDataResults(cfg, [pollRow(overrides)], 1);
    expect(rows, 'getPagingDataResults returned no rows').to.have.lengthOf(1);
    return rows[0];
}

/* ------------------------------------------------------------------ *
 * Client harness: the shipped client in jsdom, with dataTable() stubbed
 * so the real createdRow closure can be driven over one feed row.
 * ------------------------------------------------------------------ */

function bootClient() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/polls'
    });
    const win = dom.window;
    win.numeral = function (v) { return { format: function () { return String(v); } }; };
    win.eval(JQUERY);
    win.jQuery.fn.ready = function () { return this; };
    win.eval(CLIENT_SRC);
    const captured = {};
    win.jQuery.fn.dataTable = function (config) { captured.config = config; return this; };
    win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
    return { win, captured };
}

// Drive the shipped createdRow over one polls feed row and read back every cell.
function renderPollRow(data) {
    const { win, captured } = bootClient();
    const $ = win.jQuery;
    win.loadDatatablesData('RDOGE', 'poll', null, null);
    expect(captured.config, 'loadDatatablesData did not reach .dataTable()').to.be.an('object');
    const row = $('<tr>')[0];
    for (let i = 0; i < POLL_COLUMNS; i++)
        $(row).append($('<td>').text('PLACEHOLDER'));
    captured.config.createdRow.call(captured.config, row, data, 0);
    return {
        text: $('td', row).map(function () { return $(this).text(); }).get(),
        html: $('td', row).map(function () { return $(this).html(); }).get()
    };
}

// The column count polls.html declares, read from the page rather than restated.
const POLL_COLUMNS = Number(POLLS_HTML.match(/<td colspan="(\d+)" class="loading-data"/)[1]);

/* ------------------------------------------------------------------ *
 * Detail-panel harnesses (action.html's VOTE panel, poll.html's outcome).
 * ------------------------------------------------------------------ */

function extractFn(src, name) {
    const sig = 'function ' + name + '(';
    const start = src.indexOf(sig);
    if (start < 0) throw new Error('function not found: ' + name);
    const braceStart = src.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

function panelHtml(id, nextId) {
    const start = ACTION_HTML.indexOf('<div class="d-none" id="' + id + '">');
    if (start < 0) throw new Error(id + ' panel not found in action.html');
    const end = ACTION_HTML.indexOf('id="' + nextId + '"', start);
    if (end < 0) throw new Error('could not bound the ' + id + ' panel');
    return ACTION_HTML.slice(start, end);
}

// The shipped VOTE detail panel of action.html, rendered by the shipped
// showVoteDetails. $.getJSON is stubbed: the poll branch fetches the frozen
// tally, which is not under test and would be an unanswered XHR in jsdom.
function voteDetail(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml('info-vote', 'info-bet') + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(JQUERY);
    dom.window.eval(NUMERAL);
    dom.window.XC = { coin: 'BTC' };
    dom.window.eval(`
        $.getJSON = function(){ return { done: function(){} }; };
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatAmount(v){ return String(v); }
        ${extractFn(CLIENT_SRC, 'isNull')}
    `);
    dom.window.eval(extractFn(CLIENT_SRC, 'showVoteDetails'));
    dom.window.showVoteDetails(data);
    return (cls) => dom.window.$('#info-vote .' + cls).text().trim();
}

// poll.html's outcome banner, through the shipped renderPollOutcome.
function outcomeDom(poll) {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="out"></div></body>', { runScripts: 'outside-only' });
    dom.window.eval(JQUERY);
    dom.window.eval(`
        var XC = { coin: 'RBTC' };
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        var numeral = function(n){ return { format: function(){ return String(n); } }; };
        ${extractFn(CLIENT_SRC, 'isNull')}
    `);
    dom.window.eval(RENDER_SRC);
    dom.window.$('#out').html(dom.window.renderPollOutcome(poll));
    return dom.window.$;
}

const DETAIL_POLL = {
    vote_kind: 'poll', action_index: 377, tick: 'CORPA', question: 'Does the corpus seed?',
    options: ['Yes', 'No'], tally_mode: 'approval', weight_mode: 'balance',
    max_selections: 1, end_block: 1341, quorum: '0.1', min_voters: 1,
    poll_status: 'finalized', winning_option: 0, deposit_amount: '0'
};

/* -------------------------------- tests -------------------------------- */

describe('poll winning option @regression', function () {

    describe('feed: the /explorer/polls row carries the outcome', function () {

        it('carries winning option 0 as a real value, not as an absent field', function () {
            const row = feedRow();
            expect(row[9], 'winning_option 0 must survive the shaping branch').to.equal(0);
        });

        it('resolves the option label off the stored options JSON', function () {
            expect(feedRow()[10]).to.equal('Yes');
            expect(feedRow({ winning_option: 1 })[10]).to.equal('No');
        });

        it('keeps status second-to-last and the paging cursor last', function () {
            // createdRow reads both POSITIONALLY (data[len-2] / data[len-1]); adding
            // the winner ahead of them is the only safe place to add anything.
            const row = feedRow();
            expect(row[row.length - 1], 'paging cursor').to.equal(377);
            expect(row[row.length - 2], 'status flag').to.equal(1);
            expect(row).to.have.lengthOf(13);
        });

        it('leaves the winner null on a poll with no recorded outcome', function () {
            const row = feedRow({ poll_status: 'failed_quorum', winning_option: null });
            expect(row[9]).to.equal(null);
            expect(row[10]).to.equal(null);
        });

        it('keeps the index when the stored options blob is malformed', function () {
            // getPolls hands back the stored JSON verbatim. A blob that will not parse
            // costs the label; it must never cost the outcome itself.
            const row = feedRow({ options: 'not json at all' });
            expect(row[9]).to.equal(0);
            expect(row[10]).to.equal(null);
        });

        it('keeps the index when the options array is too short to name it', function () {
            const row = feedRow({ winning_option: 4 });
            expect(row[9]).to.equal(4);
            expect(row[10]).to.equal(null);
        });
    });

    describe('polls list page', function () {

        it('declares a Winner column whose colspan matches the header', function () {
            const head = POLLS_HTML.match(/<thead>([\s\S]*?)<\/thead>/);
            expect(head, 'polls.html has no <thead>').to.not.equal(null);
            expect(head[1]).to.contain('>Winner<');
            const columns = [...head[1].matchAll(/<th[\s>]/g)].length;
            expect(columns, 'header width vs loading-row colspan').to.equal(POLL_COLUMNS);
        });

        it('renders option 0 as the winner rather than as a dash', function () {
            const cells = renderPollRow(feedRow()).text;
            expect(cells[9]).to.equal('0: Yes');
        });

        it('still renders the view button in the last cell', function () {
            const { html } = renderPollRow(feedRow());
            expect(html[POLL_COLUMNS - 1]).to.contain('/RDOGE/action/377');
        });

        it('dashes the winner of a poll that recorded no outcome', function () {
            const cells = renderPollRow(feedRow({ poll_status: 'failed_quorum', winning_option: null })).text;
            expect(cells[9]).to.equal('-');
        });

        it('leaks no literal null/undefined/NaN, and fills every declared cell', function () {
            const cells = renderPollRow(feedRow({
                poll_status: 'failed_quorum', winning_option: null, tick: null,
                question: null, end_block: null, callback_contract_index: null
            })).text;
            const bad = [];
            cells.forEach((cell, i) => {
                if (/\b(null|undefined|NaN)\b/.test(cell)) bad.push(`cell ${i} rendered "${cell}"`);
                if (cell === 'PLACEHOLDER')                bad.push(`cell ${i} was never written`);
            });
            expect(bad, 'polls row leaked an absent value:\n  ' + bad.join('\n  ')).to.deep.equal([]);
        });

        it('writes an attacker-controlled option label as text, never as markup', function () {
            // Option labels are on-chain bytes chosen by whoever created the poll.
            const { text, html } = renderPollRow(feedRow({ options: '["<img src=x onerror=alert(1)>","No"]' }));
            expect(text[9]).to.contain('<img src=x onerror=alert(1)>');
            expect(html[9], 'the label must be escaped in the cell markup').to.not.contain('<img');
        });
    });

    describe('action page: the VOTE poll panel', function () {

        it('names option 0 instead of dashing it', function () {
            expect(voteDetail(DETAIL_POLL)('vote-winning-option')).to.equal('0: Yes');
        });

        it('names a later option the same way', function () {
            expect(voteDetail({ ...DETAIL_POLL, winning_option: 1 })('vote-winning-option')).to.equal('1: No');
        });

        it('dashes a poll with no recorded outcome', function () {
            expect(voteDetail({ ...DETAIL_POLL, poll_status: 'failed_quorum', winning_option: null })('vote-winning-option'))
                .to.equal('-');
        });

        it('falls back to the bare index when the options are unavailable', function () {
            expect(voteDetail({ ...DETAIL_POLL, options: [] })('vote-winning-option')).to.equal('0');
        });
    });

    describe('poll page: the outcome banner', function () {

        it('reads as a result naming option 0, not as "no winning option"', function () {
            const $ = outcomeDom({
                poll_status: 'finalized', winning_option: 0, options: ['Yes', 'No'],
                end_block: 1341, fail_reason: null, effective_close_block: null, resolved_block: null
            });
            expect($('#poll-winning-option').text().trim()).to.equal('Yes');
            expect($('#poll-outcome-state').text()).to.not.contain('no winning option');
        });

        it('says so plainly when no outcome was recorded', function () {
            const $ = outcomeDom({
                poll_status: 'failed_quorum', winning_option: null, options: ['Yes', 'No'],
                end_block: 1341, fail_reason: 'quorum', effective_close_block: null, resolved_block: null
            });
            expect($('#poll-winning-option').length).to.equal(0);
            expect($('#poll-outcome-state').text()).to.contain('no winning option');
        });
    });
});
