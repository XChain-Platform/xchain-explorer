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
 * ATTEST attestation detail page. Drives the SHIPPED renders in
 * src/content/js/attestation_detail_render.js and the SHIPPED inline script of
 * src/content/html/attestation.html against stubbed endpoint payloads, in the
 * same JSDOM harness the other content-client-*-detail tests use.
 *
 * What it protects:
 *
 *  - EXPIRY IS THE STORED TERMINAL STATE, NOT A CLOCK COMPARISON. ATTEST v2
 *    persists no row: it flips the v0 request row's request_status to 'expired'
 *    and stamps resolved_block. A request whose deadline_block has passed but
 *    which the expiry sweep has not reached is STILL 'pending'. A page that
 *    derived expiry by comparing deadline_block against a chain tip would show
 *    that live request as dead. The [pending-past-deadline] case below is the
 *    whole reason this file exists.
 *
 *  - RELAY LEGS ARE MARKED, AND ONLY WHERE THEY EXIST. Relay rows (ATTEST v3/v4)
 *    are ordinary v0/v1 rows carrying origin_chain / origin_action_index, so a
 *    render that ignores those columns loses the cross-chain half of the
 *    lifecycle. Equally, a NATIVE attestation must not read as one with missing
 *    relay data: most attestations have no relay leg at all.
 *
 *  - SIGNATURES ARE OPAQUE MATERIAL. The full pubkey and full signature are
 *    rendered, and nothing on the page claims they were checked.
 *
 *  - NOT FOUND is an explicit branch, not a page of blank placeholders.
 *
 * Venue note: the `attests` table is empty on the regtest venue and no ATTEST
 * round can be driven there, so this harness is the only thing that exercises
 * the page at all.
 */

'use strict';

const { srcText } = require('../../../../../helpers/source_text');

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

// formatters.js is read alongside xchain.js because the cell-rendering helpers
// (isNull, escapeHtml, formatAmount, formatHash, formatLivestamp) moved there
// in the component milestone. Concatenated rather than switched, so this file
// keeps naming ONE source for every helper it lifts and does not have to know
// which of the two a given function ended up in.
const XCHAIN_SRC = srcText('src/content/js/xchain.js')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '..', '..', '../../../../src/content/js/formatters.js'), 'utf8');
const RENDER_SRC = srcText('src/content/js/attestation_detail_render.js');
const PAGE_HTML  = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../../../src/content/html/attestation.html'), 'utf8');
const JQUERY_SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../../../src/content/js/jquery.min.js'), 'utf8');

// Slice a top-level function out of the source by walking braces, so the test
// runs shipped code rather than a copy that can drift.
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

// Helpers the renders lean on, kept naive so anything the assertions observe is
// the render's own doing. isNull is the REAL one out of xchain.js: every
// present/absent decision on this page is expressed through it, so a stub would
// be testing the stub.
function installHelpers(dom) {
    dom.window.eval(JQUERY_SRC);
    dom.window.eval(`
        var XC = { coin: 'RBTC', query: 'a'.repeat(64), name: 'Bitcoin', network: 'regtest', pageInfo: {}, datatables: {} };
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatLivestamp(t){ return '<span class="livestamp">a while ago</span>'; }
        function updatePageInfo(){}
        function loadDatatablesData(){ window.__datatable = Array.prototype.slice.call(arguments); }
        var numeral = function(n){ return { format: function(){ return String(n); } }; };
        ${extractFn(XCHAIN_SRC, 'isNull')}
        ${extractFn(XCHAIN_SRC, 'siblingCoin')}
    `);
    dom.window.eval(RENDER_SRC);
}

function renderDom() {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="out"></div></body>', { runScripts: 'outside-only' });
    installHelpers(dom);
    return dom;
}

// Drop a render's HTML into the DOM exactly as attestation.html hands it to .html().
function paint(dom, html) {
    dom.window.$('#out').html(html);
    return dom.window.$;
}

/* ------------------------------------------------------------------ *
 * Whole-page harness: evaluates attestation.html's SHIPPED inline
 * script with $.getJSON answering from a stubbed route table.
 * ------------------------------------------------------------------ */
function loadPage(routes, query) {
    const bodyHtml = PAGE_HTML.slice(0, PAGE_HTML.indexOf('<script'));
    const scriptStart = PAGE_HTML.indexOf('$(document).ready(function() {');
    if (scriptStart < 0) throw new Error("attestation.html's inline ready block was not found");
    const inline = PAGE_HTML.slice(scriptStart, PAGE_HTML.lastIndexOf('</script>'));

    const dom = new JSDOM('<!DOCTYPE html><body>' + bodyHtml + '</body>', { runScripts: 'outside-only' });
    installHelpers(dom);
    // Compared against undefined rather than truthiness so a caller can plant the
    // ABSENT ids (null, '') this suite has to drive; a truthiness check would have
    // silently handed those cases the harness default instead.
    if (query !== undefined) dom.window.eval('XC.query = ' + JSON.stringify(query) + ';');

    // Run the ready callback synchronously so the assertions do not race
    // jQuery's deferred ready queue. Harness-only; the page is untouched.
    dom.window.eval('jQuery.fn.ready = function(fn){ fn(jQuery); return this; };');

    const seen = [];
    dom.window.$.getJSON = function (url, cb) {
        seen.push(url);
        const r = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : undefined;
        let xhr = null;
        if (r === undefined) {
            xhr = { status: 404, responseJSON: { error: 'The requested resource was not found.', code: 'NOT_FOUND' } };
        } else if (r && r.__fail) {
            xhr = r.__fail;
        } else {
            cb(r);
        }
        return { fail: function (f) { if (xhr) f(xhr); return this; } };
    };

    dom.window.eval(inline);
    return { $: dom.window.$, seen, window: dom.window };
}

/* ------------------------------- fixtures -------------------------------
 * Column names below are exactly the ones getAttestation selects out of
 * `attests` (src/db.js getAttestation), plus the three it derives:
 * request.callback_params, request.responsible_set, response.quorum_signatures.
 * ------------------------------------------------------------------------ */

const REQ_ID = 'b'.repeat(64);

function requestLeg(over) {
    return Object.assign({
        action: 'attest', action_index: 5100, action_format: 0, version: 0,
        request_id: REQ_ID, provider_id: 'http_get', contract_index: 12,
        source: 'mSourceAddr', fee_payer: 'mFeePayerAddr',
        payload: 'https://example.invalid/price', callback_method: 'onPrice',
        callback_params_json: '{"pair":"XCP/BTC"}', callback_params: { pair: 'XCP/BTC' },
        redundancy: 3, deadline_block: 900, gas_escrow: '100000',
        fee_tick: 'XCHAIN', fee_amount: '50000',
        request_status: 'fulfilled', resolved_block: 861,
        responsible_set_json: '["' + 'c'.repeat(64) + '"]',
        responsible_set: ['c'.repeat(64), 'd'.repeat(64)],
        origin_chain: null, origin_action_index: null,
        response_hash: null, response_payload: null, response_status: null,
        meta: null, validator_signatures: null, callback_execute_action_index: null,
        block_index: 850, timestamp: 1700000000, tx_hash: 'aa'.repeat(32), tx_index: 7,
        status: 'valid'
    }, over || {});
}

function responseLeg(over) {
    return Object.assign({
        action: 'attest', action_index: 5150, action_format: 1, version: 1,
        request_id: REQ_ID, provider_id: 'http_get', contract_index: 12,
        source: 'mValidatorAddr', fee_payer: null,
        payload: null, callback_method: null, callback_params_json: null,
        redundancy: null, deadline_block: null, gas_escrow: null,
        fee_tick: null, fee_amount: null,
        request_status: null, resolved_block: null, responsible_set_json: null,
        origin_chain: null, origin_action_index: null,
        response_hash: 'e'.repeat(64), response_payload: '{"price":"0.00012"}',
        response_status: 'ok', meta: 'http 200',
        validator_signatures: null,
        quorum_signatures: [
            { pubkey: 'c'.repeat(64), sig: '11'.repeat(32) },
            { pubkey: 'd'.repeat(64), sig: '22'.repeat(32) }
        ],
        callback_execute_action_index: 5175,
        block_index: 861, timestamp: 1700000600, tx_hash: 'bb'.repeat(32), tx_index: 9,
        status: 'valid'
    }, over || {});
}

// COMPLETED: v0 request fulfilled, v1 response with provider payload and quorum
// signatures, callback executed.
function completed() {
    const req = requestLeg();
    const res = responseLeg();
    return {
        query: REQ_ID, request_id: REQ_ID, provider_id: 'http_get',
        legs: [req, res], request: req, response: res,
        expiry: { request_status: 'fulfilled', deadline_block: 900, resolved_block: 861, expired: false },
        relay: { is_relay: false, origin_chain: null, origin_action_index: null, response_relayed: false },
        callback_execute_action_index: 5175
    };
}

// EXPIRED: the expiry sweep flipped the stored status. No v1 row, no v2 row
// (ATTEST v2 writes none), resolved_block stamped at the sweep.
// EXPIRED, with the expire action and the injected callback UNRESOLVED. The server
// leaves both null when the block's expire actions and expired requests do not line
// up (db.correlateAttestationExpiries refuses to guess), so this is the shape the
// page must still render without inventing a link.
function expired() {
    const req = requestLeg({ request_status: 'expired', resolved_block: 901, callback_execute_action_index: null });
    return {
        query: REQ_ID, request_id: REQ_ID, provider_id: 'http_get',
        legs: [req], request: req, response: null,
        expiry: { request_status: 'expired', deadline_block: 900, resolved_block: 901, expired: true,
                  expire_action_index: null },
        relay: { is_relay: false, origin_chain: null, origin_action_index: null, response_relayed: false },
        callback_execute_action_index: null, callback_execute_derived: false
    };
}

// The ordinary expiry: the v2 expire action was resolved, and the callback EXECUTE
// the sweep injected was matched on the execution's own columns (there is no v1
// response row after an expiry, so nothing stamped attests.callback_execute_action_index).
function expiredLinked() {
    const d = expired();
    d.expiry.expire_action_index = 5101;
    d.callback_execute_action_index = 5102;
    d.callback_execute_derived = true;
    return d;
}

// PENDING PAST ITS DEADLINE: deadline_block is BEHIND every block in the round
// and the sweep has not run. The server keeps this as 'pending'/expired:false,
// and so must the page.
function pendingPastDeadline() {
    const req = requestLeg({
        request_status: 'pending', resolved_block: null,
        deadline_block: 400, block_index: 350
    });
    return {
        query: REQ_ID, request_id: REQ_ID, provider_id: 'http_get',
        legs: [req], request: req, response: null,
        expiry: { request_status: 'pending', deadline_block: 400, resolved_block: null, expired: false },
        relay: { is_relay: false, origin_chain: null, origin_action_index: null, response_relayed: false },
        callback_execute_action_index: null
    };
}

// RELAY: a request materialized on this chain from an LTC origin (ATTEST v3),
// answered here, and relayed back (ATTEST v4). Both legs carry the origin
// columns; ordinary v0/v1 rows is all they are in the table.
function relayed() {
    const req = requestLeg({ origin_chain: 'LTC', origin_action_index: 44100 });
    const res = responseLeg({ origin_chain: 'LTC', origin_action_index: 44100 });
    return {
        query: REQ_ID, request_id: REQ_ID, provider_id: 'http_get',
        legs: [req, res], request: req, response: res,
        expiry: { request_status: 'fulfilled', deadline_block: 900, resolved_block: 861, expired: false },
        relay: { is_relay: true, origin_chain: 'LTC', origin_action_index: 44100, response_relayed: true },
        callback_execute_action_index: 5175
    };
}

const URL_FOR = q => '/RBTC/api/attestation/' + q;

module.exports = {
    expect, renderDom, paint, loadPage, REQ_ID, requestLeg, responseLeg,
    completed, expired, expiredLinked, pendingPastDeadline, relayed, URL_FOR
};

