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
 * Five renderer sites had drifted from the protocol enums and column meanings
 * the indexer writes.
 *
 *  - AIRDROP list_action_index and LINK coin1/coin2_action_index are ACTION
 *    indexes, and the compact summary linked all three through /token/.
 *  - the compact LIST label carried a second, INVERTED copy of XC.list_types.
 *  - XC.encryption_methods started at ECDH and had no AES entry, against the
 *    protocol's 1=ECIES / 2=ECDH / 3=AES.
 *  - the MESSAGE summary branched on encryption_method, which the indexer
 *    stamps to 1 on every format-2 record, so encrypted messages read as key
 *    exchanges.
 *  - attests.response_payload was selected by the detail query and rendered
 *    nowhere.
 *  - the XCALL far-chain execute link was namespaced by the source chain.
 *
 * Every assertion drives the SHIPPED function against the SHIPPED markup, in the
 * same harness the sibling content-client tests use, so a copy cannot drift.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

// formatters.js is read alongside xchain.js because the cell-rendering helpers
// (isNull, escapeHtml, formatAmount, formatLink and friends) moved there in the
// component milestone. Concatenated rather than switched, so this file keeps
// naming ONE source for every helper it lifts.
const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '../../src/content/js/formatters.js'), 'utf8');
const ACTION_HTML = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/action.html'), 'utf8');

// Slice a top-level function out of the source by walking braces.
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

// Slice one object literal off the XC singleton the same way, so the enum under
// test is the shipped map rather than a restatement of it.
function extractMap(key) {
    const sig = key + ': {';
    const start = SRC.indexOf(sig);
    if (start < 0) throw new Error('map not found in xchain.js: ' + key);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    // eslint-disable-next-line no-eval
    return eval('(' + SRC.slice(braceStart, i) + ')');
}

const LIST_TYPES         = extractMap('list_types');
const ENCRYPTION_METHODS = extractMap('encryption_methods');

// Carve a named action panel out of action.html, bounded by the next panel id.
function panelHtml(id, nextId) {
    const start = ACTION_HTML.indexOf('<div class="d-none" id="' + id + '">');
    if (start < 0) throw new Error(id + ' panel not found in action.html');
    const end = ACTION_HTML.indexOf('id="' + nextId + '"', start);
    if (end < 0) throw new Error('could not bound the ' + id + ' panel');
    return ACTION_HTML.slice(start, end);
}

// Run the shipped compact summary renderer with naive helpers, so every href the
// assertions read is getActionDetails' own doing.
function summary(action, info) {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
    dom.window.XC = { coin: 'BTC', list_types: LIST_TYPES };
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatLinkAmount(href, text, tick, amount){ return '<a href="' + href + '">' + amount + ' ' + text + '</a>'; }
        function formatAmount(v){ return String(v); }
        function isNull(v){ return (v === null || v === undefined || v === ''); }
        function isNumeric(v){ return !isNaN(parseFloat(v)) && isFinite(v); }
        function escapeHtml(v){ return String(v); }
        function getNetworkIcon(){ return 'fa-bitcoin'; }
    `);
    dom.window.eval(extractFn('getActionDetails'));
    return dom.window.getActionDetails(action, info);
}

// Render the shipped ATTEST detail panel and hand back a cell reader.
function attestDetail(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml('info-attest', 'info-vote') + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/numeral.js'), 'utf8'));
    dom.window.XC = { coin: 'BTC' };
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatHash(v, len){ return v == null ? '-' : String(v).substring(0, len || 32); }
        function formatAmount(v){ return String(v); }
        ${extractFn('isNull')}
    `);
    dom.window.eval(extractFn('showAttestDetails'));
    dom.window.showAttestDetails(data);
    return (cls) => dom.window.$('#info-attest .' + cls).text().trim();
}

// Render the shipped VOTE detail panel and hand back a cell reader plus the DOM,
// so a test can read either the text or an href out of a cell. $.getJSON is
// stubbed: the poll branch fetches the frozen tally, which is not what is under
// test here and would be an unanswered XHR in jsdom.
function voteDetail(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml('info-vote', 'info-bet') + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/numeral.js'), 'utf8'));
    dom.window.XC = { coin: 'BTC' };
    dom.window.eval(`
        $.getJSON = function(){ return { done: function(){} }; };
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatAmount(v){ return String(v); }
        ${extractFn('isNull')}
    `);
    dom.window.eval(extractFn('showVoteDetails'));
    dom.window.showVoteDetails(data);
    return {
        text: (cls) => dom.window.$('#info-vote .' + cls).text().trim(),
        href: (cls) => dom.window.$('#info-vote .' + cls + ' a').attr('href')
    };
}

// Render the shipped XCALL detail panel and hand back the execute-action href.
function xcallExecuteHref(data) {
    const dom = new JSDOM('<!DOCTYPE html><body>' + panelHtml('info-xcall', 'info-xexec') + '</body>',
        { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/numeral.js'), 'utf8'));
    dom.window.XC = { coin: 'BTC' };
    dom.window.eval(`
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatHash(v, len){ return v == null ? '-' : String(v).substring(0, len || 32); }
        ${extractFn('isNull')}
    `);
    dom.window.eval(extractFn('showXcallDetails'));
    dom.window.showXcallDetails(data);
    return dom.window.$('#info-xcall .xcall-execute-action a').attr('href');
}

describe('client: action-index summary links open actions, not token searches', function () {

    it('an AIRDROP links its list reference as an action', function () {
        const html = summary('AIRDROP', { amount: 5, tick: 'XCP', list_action_index: 4242 });
        expect(html).to.contain('href="/BTC/action/4242"');
        expect(html).to.not.contain('href="/BTC/token/4242"');
    });

    it('[REGRESSION] the AIRDROP ticker beside it is still a token link', function () {
        const html = summary('AIRDROP', { amount: 5, tick: 'XCP', list_action_index: 4242 });
        expect(html).to.contain('href="/BTC/token/XCP"');
    });

    it('a LINK links both chain legs as actions on their own chains', function () {
        const html = summary('LINK', {
            coin1: 'BTC', coin1_action_index: 11,
            coin2: 'DOGE', coin2_action_index: 22
        });
        expect(html).to.contain('href="/BTC/action/11"');
        expect(html).to.contain('href="/DOGE/action/22"');
        expect(html).to.not.contain('/token/');
    });
});

describe('client: the compact LIST label reads the canonical enum', function () {

    it('the shipped enum still declares 1=Token and 2=Address', function () {
        expect(LIST_TYPES[1]).to.equal('Token');
        expect(LIST_TYPES[2]).to.equal('Address');
    });

    it('a type-1 list summarizes as a Token list', function () {
        expect(summary('LIST', { type: 1, edit: 0 })).to.equal('Create Token List');
    });

    it('a type-2 list summarizes as an Address list', function () {
        expect(summary('LIST', { type: 2, edit: 1 })).to.equal('Add to Address List');
    });

    it('an undeclared type names itself rather than printing undefined', function () {
        // An invalid edit row can persist with a null type (the parent-list lookup failed),
        // and the old inline ternary silently called that an Address list.
        expect(summary('LIST', { type: null, edit: 1 })).to.equal('Add to Unknown List');
    });

    it('the compact label agrees with the canonical map for every declared type', function () {
        for (const type of Object.keys(LIST_TYPES))
            expect(summary('LIST', { type: Number(type), edit: 0 })).to.contain(LIST_TYPES[type]);
    });
});

describe('client: the encryption-method map matches the protocol enum', function () {

    it('declares 1=ECIES, 2=ECDH and 3=AES', function () {
        expect(ENCRYPTION_METHODS[1]).to.contain('ECIES');
        expect(ENCRYPTION_METHODS[2]).to.contain('ECDH');
        expect(ENCRYPTION_METHODS[3]).to.contain('AES');
    });

    it('AES is no longer a missing key that renders a blank method', function () {
        expect(Object.keys(ENCRYPTION_METHODS)).to.have.members(['1', '2', '3']);
    });
});

describe('client: MESSAGE summaries key on the record format', function () {

    it('a format-2 record summarizes as an encrypted message despite its stamped method 1', function () {
        const html = summary('MESSAGE', {
            coin: 'BTC', destination: 'bc1Dest', action_format: 2, encryption_method: 1
        });
        expect(html).to.contain('Encrypted message to');
        expect(html).to.not.contain('key exchange');
    });

    it('a format-0 record is still a key exchange', function () {
        const html = summary('MESSAGE', {
            coin: 'BTC', destination: 'bc1Dest', action_format: 0, encryption_method: 2
        });
        expect(html).to.contain('Encryption key exchange with');
    });

    it('a format-1 record is still a key exchange', function () {
        const html = summary('MESSAGE', {
            coin: 'BTC', destination: 'bc1Dest', action_format: 1, encryption_method: 2
        });
        expect(html).to.contain('Encryption key exchange with');
    });

    it('a format-3 record still shows its plaintext', function () {
        const html = summary('MESSAGE', {
            coin: 'BTC', destination: 'bc1Dest', action_format: 3, plaintext_message: 'hello there'
        });
        expect(html).to.equal('hello there');
    });

    it('[REGRESSION] a row with no action_format does not fall into the key-exchange branch', function () {
        const html = summary('MESSAGE', { coin: 'BTC', destination: 'bc1Dest', encryption_method: 1 });
        expect(html).to.contain('Encrypted message to');
    });
});

describe('client: the ATTEST response panel shows the decoded payload', function () {

    it('renders response_payload on a v1 response', function () {
        const cell = attestDetail({
            version: 1, request_id: 'a'.repeat(64), provider_id: 'p1',
            response_status: 'ok', response_hash: 'ff00', meta: 'm',
            response_payload: '{"price":42}', signatures: []
        });
        expect(cell('attest-response-payload')).to.equal('{"price":42}');
    });

    it('renders a dash when the response carried no payload', function () {
        const cell = attestDetail({
            version: 1, request_id: 'a'.repeat(64), provider_id: 'p1',
            response_status: 'timeout', response_hash: 'ff00', meta: null,
            response_payload: null, signatures: []
        });
        expect(cell('attest-response-payload')).to.equal('-');
    });

    it('[REGRESSION] the request-side panel is untouched by the new row', function () {
        const cell = attestDetail({
            version: 0, request_id: 'a'.repeat(64), provider_id: 'p1',
            payload: '{"symbol":"BTC"}', request_status: 'pending',
            redundancy: 3, deadline_block: 900000, callback_method: 'cb'
        });
        expect(cell('attest-payload')).to.equal('{"symbol":"BTC"}');
    });
});

describe('client: the XCALL execute link is namespaced by the target chain', function () {

    const BASE = {
        call_id: 'abcd1234', version: 0, contract_index: 10, target_chain: 'LTC',
        target_contract_index: 20, method: 'ping', params: [], gas_limit: 100000,
        cross_hops: 1, callback_method: 'pong', deadline_block: 900000,
        request_status: 'completed', result_status: 'ok', result_payload: 'aa',
        resolved_block: 899123, callback_action_index: null, callback_delivery: null
    };

    it('links the executed action on the far chain, not the chain being viewed', function () {
        const href = xcallExecuteHref({
            ...BASE,
            execution: { execute_action_index: 555, result_status: 'ok', return_payload_b64: 'bb', gas_used: 21000 }
        });
        expect(href).to.equal('/LTC/action/555');
    });

    it('[REGRESSION] falls back to the page coin when the row carries no target chain', function () {
        const href = xcallExecuteHref({
            ...BASE, target_chain: null,
            execution: { execute_action_index: 555, result_status: 'ok', return_payload_b64: 'bb', gas_used: 21000 }
        });
        expect(href).to.equal('/BTC/action/555');
    });
});

describe('client: the VOTE poll panel shows the callback timelock and the EXECUTE it fired', function () {

    const POLL = {
        vote_kind: 'poll', action_index: 900, tick: 'XCP', question: 'ship it?',
        options: ['no', 'yes'], tally_mode: 'weighted', weight_mode: 'balance',
        max_selections: 1, end_block: 900000, quorum: 10, min_voters: 2,
        poll_status: 'finalized', winning_option: 1, deposit_amount: 5,
        callback_contract_index: 77, callback_method: 'onDecided'
    };

    it('links callback_execute_action_index as an action, the way ATTEST does', function () {
        const cell = voteDetail({ ...POLL, callback_delay_blocks: 144, callback_execute_action_index: 4242 });
        expect(cell.href('vote-callback-execute')).to.equal('/BTC/action/4242');
        expect(cell.text('vote-callback-execute')).to.equal('4242');
    });

    it('renders the PC-42 timelock the query has always selected', function () {
        const cell = voteDetail({ ...POLL, callback_delay_blocks: 144, callback_execute_action_index: 4242 });
        expect(cell.text('vote-callback-delay')).to.equal('144');
    });

    it('dashes both cells on a binding poll whose callback has not fired', function () {
        const cell = voteDetail({ ...POLL, callback_delay_blocks: 0, callback_execute_action_index: null });
        expect(cell.text('vote-callback-execute')).to.equal('-');
        expect(cell.text('vote-callback-delay')).to.equal('0');
    });

    it('dashes both cells on a non-binding poll', function () {
        const cell = voteDetail({
            ...POLL, callback_contract_index: null, callback_method: null,
            callback_delay_blocks: null, callback_execute_action_index: null
        });
        expect(cell.text('vote-callback')).to.equal('-');
        expect(cell.text('vote-callback-delay')).to.equal('-');
        expect(cell.text('vote-callback-execute')).to.equal('-');
    });

    it('[REGRESSION] the contract/method callback cell still renders beside them', function () {
        const cell = voteDetail({ ...POLL, callback_delay_blocks: 144, callback_execute_action_index: 4242 });
        expect(cell.href('vote-callback')).to.equal('/BTC/contract/77');
        expect(cell.text('vote-callback')).to.equal('77.onDecided');
    });

    it('every cell the poll branch writes exists in the shipped markup', function () {
        // The gap this covers was a renderer/template split: the JS read fields the
        // page had no cell for. Assert the pairing rather than the two halves.
        const panel = panelHtml('info-vote', 'info-bet');
        for (const cls of ['vote-callback', 'vote-callback-delay', 'vote-callback-execute'])
            expect(panel, cls + ' is missing from action.html').to.contain('class="' + cls + '"');
    });
});

// The finalization set is the third sighting of the same renderer/template split in
// this one function (response_payload, then the PC-42 callback pair). VOTE v2 freezes
// the measured turnout into the polls row so a terminal outcome stays auditable, and
// the detail query has always selected it, but a poll badged 'failed_quorum' named no
// gate and showed no turnout because nothing rendered it.
describe('client: the VOTE poll panel shows the finalization detail v2 froze', function () {

    const POLL = {
        vote_kind: 'poll', action_index: 900, tick: 'XCP', question: 'ship it?',
        options: ['no', 'yes'], tally_mode: 'weighted', weight_mode: 'balance',
        max_selections: 1, end_block: 900000, quorum: '0.2', min_voters: 2,
        poll_status: 'failed_quorum', winning_option: null, deposit_amount: 5
    };

    // A failed poll: the gates were measured and missed, and fail_reason names which.
    const FAILED = {
        ...POLL, quorum_met: 0, min_voters_met: 1, fail_reason: 'quorum',
        decided_early: 0, total_weight: '1234.5', total_voters: 7,
        effective_close_block: 900000, resolved_block: 900001, finalized_action_index: 4242
    };

    it('names which gate failed instead of only badging failed_quorum', function () {
        const cell = voteDetail(FAILED);
        expect(cell.text('vote-fail-reason')).to.equal('quorum');
        expect(cell.text('vote-quorum-met')).to.equal('no');
        expect(cell.text('vote-min-voters-met')).to.equal('yes');
    });

    it('shows the measured turnout the quorum verdict was judged against', function () {
        const cell = voteDetail(FAILED);
        expect(cell.text('vote-total-weight')).to.equal('1234.5');
        expect(cell.text('vote-total-voters')).to.equal('7');
    });

    it('links the measurement block, the resolution block and the finalizing action', function () {
        const cell = voteDetail(FAILED);
        expect(cell.href('vote-effective-close-block')).to.equal('/BTC/block/900000');
        expect(cell.href('vote-resolved-block')).to.equal('/BTC/block/900001');
        expect(cell.href('vote-finalized-by')).to.equal('/BTC/action/4242');
    });

    it('flags an early decide and shows the threshold that armed it', function () {
        const cell = voteDetail({ ...FAILED, decided_early: 1, decide_threshold: '0.6' });
        expect(cell.text('vote-decided-early')).to.equal('yes');
        expect(cell.text('vote-decide-threshold')).to.equal('0.6');
    });

    it('dashes every finalization cell on an open poll rather than reading them as no', function () {
        // Null is "not yet measured"; TINYINT 0 is a measured miss. Collapsing the two
        // would show an open poll as having failed both gates.
        const cell = voteDetail({ ...POLL, poll_status: 'open' });
        for (const cls of ['vote-quorum-met', 'vote-min-voters-met', 'vote-decided-early',
                           'vote-total-weight', 'vote-total-voters', 'vote-fail-reason',
                           'vote-effective-close-block', 'vote-resolved-block', 'vote-finalized-by'])
            expect(cell.text(cls), cls + ' should dash while the poll is open').to.equal('-');
    });

    it('dashes fail_reason on a poll that passed both gates', function () {
        const cell = voteDetail({
            ...FAILED, poll_status: 'finalized', winning_option: 1,
            quorum_met: 1, min_voters_met: 1, fail_reason: null
        });
        expect(cell.text('vote-fail-reason')).to.equal('-');
        expect(cell.text('vote-quorum-met')).to.equal('yes');
    });

    it('renders deposit_resolved as its enum, not as a boolean', function () {
        // polls.deposit_resolved is ENUM('refunded','forfeited'). A forfeited deposit
        // rendered through a yes/no formatter would read as a successful refund.
        const forfeited = voteDetail({ ...FAILED, deposit_resolved: 'forfeited', deposit_address: 'mAddr1' });
        expect(forfeited.text('vote-deposit-resolved')).to.equal('forfeited');
        expect(forfeited.href('vote-deposit-address')).to.equal('/BTC/address/mAddr1');
        const refunded = voteDetail({ ...FAILED, deposit_resolved: 'refunded' });
        expect(refunded.text('vote-deposit-resolved')).to.equal('refunded');
    });

    it('shows the rest of the binding-poll contract', function () {
        const cell = voteDetail({ ...FAILED, callback_on: 'always', gas_escrow: '0.001' });
        expect(cell.text('vote-callback-on')).to.equal('always');
        expect(cell.text('vote-gas-escrow')).to.equal('0.001');
    });

    it('renders developer-supplied callback_params as inert text', function () {
        // callback_params is on-chain JSON afterMain has already parsed, so it is
        // attacker-shaped input reaching a cell; it must never open an element. Had the
        // cell been written through .html(), the payload would have become an <img> and
        // this .text() read would come back missing it.
        const cell = voteDetail({ ...FAILED, callback_params: ['<img src=x onerror=alert(1)>', 2] });
        expect(cell.text('vote-callback-params')).to.equal('["<img src=x onerror=alert(1)>",2]');
    });

    it('every finalization cell the poll branch writes exists in the shipped markup', function () {
        const panel = panelHtml('info-vote', 'info-bet');
        for (const cls of ['vote-min-vote-balance', 'vote-decide-threshold', 'vote-quorum-met',
                           'vote-min-voters-met', 'vote-total-weight', 'vote-total-voters',
                           'vote-fail-reason', 'vote-decided-early', 'vote-effective-close-block',
                           'vote-resolved-block', 'vote-finalized-by', 'vote-deposit-address',
                           'vote-deposit-resolved', 'vote-callback-on', 'vote-callback-params',
                           'vote-gas-escrow'])
            expect(panel, cls + ' is missing from action.html').to.contain('class="' + cls + '"');
    });
});
