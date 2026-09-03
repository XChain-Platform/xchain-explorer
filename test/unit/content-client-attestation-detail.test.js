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
 * src/content/js/attestation-detail-render.js and the SHIPPED inline script of
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

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

// formatters.js is read alongside xchain.js because the cell-rendering helpers
// (isNull, escapeHtml, formatAmount, formatHash, formatLivestamp) moved there
// in the component milestone. Concatenated rather than switched, so this file
// keeps naming ONE source for every helper it lifts and does not have to know
// which of the two a given function ended up in.
const XCHAIN_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8')
    + '\n' + fs.readFileSync(path.resolve(__dirname, '../../src/content/js/formatters.js'), 'utf8');
const RENDER_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/attestation-detail-render.js'), 'utf8');
const PAGE_HTML  = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/attestation.html'), 'utf8');
const JQUERY_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8');

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
    if (query) dom.window.eval('XC.query = ' + JSON.stringify(query) + ';');

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
function expired() {
    const req = requestLeg({ request_status: 'expired', resolved_block: 901, callback_execute_action_index: null });
    return {
        query: REQ_ID, request_id: REQ_ID, provider_id: 'http_get',
        legs: [req], request: req, response: null,
        expiry: { request_status: 'expired', deadline_block: 900, resolved_block: 901, expired: true },
        relay: { is_relay: false, origin_chain: null, origin_action_index: null, response_relayed: false },
        callback_execute_action_index: null
    };
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

/* -------------------------------- tests -------------------------------- */

describe('attestation.html detail page @regression', function () {

    describe('expiry: the stored terminal state, never a deadline comparison', function () {

        it('[pending-past-deadline] a pending request whose deadline block has passed is NOT rendered as expired', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationExpiry(pendingPastDeadline()));

            // The deadline (400) is behind the request block (350 was mined, and
            // the round records nothing past it); a clock-style derivation would
            // light the expired branch here.
            expect($('.attestation-expired').length, 'no expired verdict for a pending request').to.equal(0);
            expect($('.attestation-not-expired').length).to.equal(1);
            expect($('.attestation-not-expired').attr('data-expired')).to.equal('false');
            expect($('.attestation-status').attr('data-status')).to.equal('pending');
            expect($('.attestation-not-expired').text()).to.contain('Passing the deadline block does not expire a request by itself');
            // The deadline is still SHOWN; it is just never fed into a verdict.
            expect($('.attestation-deadline-block').text()).to.contain('400');
        });

        it('[pending-past-deadline] the lifecycle expiry stage stays unreached', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationLifecycle(pendingPastDeadline()));
            expect($('[data-stage="expiry"]').attr('data-reached')).to.equal('false');
            expect($('[data-stage="expiry"]').hasClass('attestation-stage-unreached')).to.equal(true);
            expect($('[data-stage="request"]').attr('data-reached')).to.equal('true');
            expect($('[data-stage="response"]').attr('data-reached')).to.equal('false');
        });

        it('[pending-past-deadline] attestationStages reports request reached and expiry not reached', function () {
            const dom = renderDom();
            const stages = dom.window.attestationStages(pendingPastDeadline());
            const byKey = {};
            stages.forEach(function (s) { byKey[s.key] = s; });
            expect(Object.keys(byKey).sort()).to.deep.equal(['callback', 'expiry', 'request', 'response']);
            expect(byKey.request.reached).to.equal(true);
            expect(byKey.response.reached).to.equal(false);
            expect(byKey.expiry.reached).to.equal(false);
            expect(byKey.expiry.note).to.equal('not recorded as expired');
            expect(byKey.callback.reached).to.equal(false);
        });

        it('[expired] the stored expired state renders the expired verdict and the reached expiry stage', function () {
            const dom = renderDom();
            const d = expired();
            const $ = paint(dom, dom.window.renderAttestationExpiry(d));
            expect($('.attestation-expired').length).to.equal(1);
            expect($('.attestation-expired').attr('data-expired')).to.equal('true');
            expect($('.attestation-not-expired').length).to.equal(0);
            expect($('.attestation-status').attr('data-status')).to.equal('expired');
            expect($('.attestation-resolved-block').text()).to.contain('901');

            const $l = paint(dom, dom.window.renderAttestationLifecycle(d));
            expect($l('[data-stage="expiry"]').attr('data-reached')).to.equal('true');
            expect($l('[data-stage="response"]').attr('data-reached')).to.equal('false');
        });

        it('[expired] says plainly that ATTEST v2 wrote no action row', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationExpiry(expired()));
            expect($('.attestation-expired').text()).to.contain('ATTEST v2 writes no action row of its own');
        });

        it('[completed] a fulfilled request is not expired and reaches response and callback', function () {
            const dom = renderDom();
            const d = completed();
            const $ = paint(dom, dom.window.renderAttestationExpiry(d));
            expect($('.attestation-expired').length).to.equal(0);
            expect($('.attestation-status').attr('data-status')).to.equal('fulfilled');

            const $l = paint(dom, dom.window.renderAttestationLifecycle(d));
            expect($l('[data-stage="request"]').attr('data-reached')).to.equal('true');
            expect($l('[data-stage="response"]').attr('data-reached')).to.equal('true');
            expect($l('[data-stage="expiry"]').attr('data-reached')).to.equal('false');
            expect($l('[data-stage="callback"]').attr('data-reached')).to.equal('true');
        });
    });

    describe('request and response panels', function () {

        it('[completed] the v0 request shows provider, redundancy requirement, deadline and payload', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationRequest(completed()));
            const text = $('#out').text();
            expect(text).to.contain('http_get');
            expect(text).to.contain('Redundancy Required');
            expect(text).to.contain('Deadline Block');
            expect($('.attestation-request-payload').text()).to.equal('https://example.invalid/price');
            expect($('.attestation-callback').text()).to.contain('onPrice()');
            expect($('.attestation-callback').text()).to.contain('"pair":"XCP/BTC"');
        });

        it('[completed] the pinned responsible set is listed in full, with no signed/unsigned claim', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationRequest(completed()));
            const members = $('.attestation-responsible-member');
            expect(members.length).to.equal(2);
            expect(members.eq(0).text()).to.equal('c'.repeat(64));
            expect($('#out').text()).to.not.contain('did not sign');
        });

        it('[completed] the v1 response shows status, hash, payload and every quorum signature in full', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationResponse(completed()));
            expect($('.attestation-response-status').attr('data-response-status')).to.equal('ok');
            expect($('.attestation-response-payload').text()).to.equal('{"price":"0.00012"}');

            const sigs = $('.attestation-signature');
            expect(sigs.length).to.equal(2);
            // Full material, not truncated into something that reads as checked.
            expect(sigs.eq(0).find('.attestation-signature-pubkey').text()).to.equal('c'.repeat(64));
            expect(sigs.eq(0).find('.attestation-signature-sig').text()).to.equal('11'.repeat(32));
            expect($('.attestation-signatures-note').text())
                .to.contain('Attached is not the same as verified');
        });

        it('[expired] the response panel states there is no v1 row rather than rendering blanks', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationResponse(expired()));
            expect($('.attestation-no-response').length).to.equal(1);
            expect($('.attestation-signature').length).to.equal(0);
        });

        // attests.batch_action_index. Three distinct states, and the two NULL ones
        // mean opposite things: a mirror-applied response (no transaction of its
        // own) is WAITING for the ATTEST v5/v6 batch that carries its body, while a
        // legacy-era response WAS its own on-chain transaction and will never have
        // one. Collapsing them into a single dash tells a reader something untrue.
        it('[batch] links the batch action once the batch has landed', function () {
            const dom = renderDom();
            const d = completed();
            d.response = responseLeg({ tx_hash: null, tx_index: null, batch_action_index: 6100 });
            d.legs = [d.request, d.response];
            const $ = paint(dom, dom.window.renderAttestationResponse(d));
            expect($('#out').text()).to.contain('On-chain Batch');
            expect($('a[href="/RBTC/action/6100"]').length).to.equal(1);
            expect($('.attestation-batch-pending').length).to.equal(0);
            expect($('.attestation-batch-na').length).to.equal(0);
        });

        it('[batch] says the body is not on chain YET for a mirror-applied response', function () {
            const dom = renderDom();
            const d = completed();
            d.response = responseLeg({ tx_hash: null, tx_index: null, batch_action_index: null });
            d.legs = [d.request, d.response];
            const $ = paint(dom, dom.window.renderAttestationResponse(d));
            expect($('.attestation-batch-pending').text()).to.contain('not yet carried by an on-chain batch');
            expect($('.attestation-batch-na').length).to.equal(0);
        });

        it('[batch] says NOT APPLICABLE for a response that was its own transaction', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationResponse(completed()));
            expect($('.attestation-batch-na').text()).to.contain('its own on-chain transaction');
            expect($('.attestation-batch-pending').length).to.equal(0);
        });

        it('[retry-rounds] every v1 row is listed, not just the one the server named as `response`', function () {
            const dom = renderDom();
            const d = completed();
            const retry = responseLeg({ action_index: 5120, response_status: 'no_quorum', quorum_signatures: [] });
            d.legs = [d.request, retry, d.response];
            const $ = paint(dom, dom.window.renderAttestationResponse(d));
            const rounds = $('.attestation-response-round');
            expect(rounds.length).to.equal(2);
            expect($('.attestation-response-rounds-note').text()).to.contain('2 response rounds');
        });
    });

    describe('relay legs', function () {

        it('[relay] the origin chain and origin action are named, and the relayed response is marked', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationRelay(relayed()));
            expect($('.attestation-relay-origin').attr('data-relay')).to.equal('true');
            expect($('.attestation-relay-native').length).to.equal(0);
            expect($('.attestation-relay-chain').text()).to.equal('LTC');
            expect($('.attestation-relay-origin-action').text()).to.equal('44100');
            expect($('.attestation-relay-response').length).to.equal(1);
        });

        it('[relay] both relay legs are marked in the leg table, with the origin action shown', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationLegs(relayed()));
            const rows = $('tr.attestation-leg');
            expect(rows.length).to.equal(2);
            expect($('tr.attestation-leg-relay').length).to.equal(2);
            expect(rows.eq(0).attr('data-relay-leg')).to.equal('true');
            expect($('.attestation-leg-relay-badge').eq(0).text()).to.contain('relay from LTC');
            expect($('.attestation-leg-origin-action').eq(0).text()).to.equal('44100');
            expect($('.attestation-leg-native').length).to.equal(0);
        });

        it('[native] a non-relay attestation states the fact and raises no warning', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationRelay(completed()));
            expect($('.attestation-relay-native').attr('data-relay')).to.equal('false');
            expect($('.attestation-relay-origin').length).to.equal(0);
            // A missing relay is the ordinary case, so nothing on this panel may
            // read as a defect.
            expect($('.alert-warning, .alert-danger, .text-bg-warning, .text-bg-danger').length).to.equal(0);
            expect($('#out').text()).to.contain('no cross-chain relay leg');
        });

        it('[native] leg rows carrying no origin columns are marked native, not relay', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationLegs(completed()));
            expect($('tr.attestation-leg').length).to.equal(2);
            expect($('tr.attestation-leg-relay').length).to.equal(0);
            expect($('.attestation-leg-native').length).to.equal(2);
            expect($('tr.attestation-leg').eq(0).attr('data-relay-leg')).to.equal('false');
        });

        it('[mixed] only the rows carrying origin columns are marked, in a round where one leg is native', function () {
            const dom = renderDom();
            const d = relayed();
            // The response leg was NOT relayed back: it carries no origin columns.
            d.legs = [d.legs[0], responseLeg({ origin_chain: null, origin_action_index: null })];
            const $ = paint(dom, dom.window.renderAttestationLegs(d));
            expect($('tr.attestation-leg-relay').length).to.equal(1);
            expect($('.attestation-leg-native').length).to.equal(1);
            expect($('tr.attestation-leg').eq(0).attr('data-relay-leg')).to.equal('true');
            expect($('tr.attestation-leg').eq(1).attr('data-relay-leg')).to.equal('false');
        });
    });

    describe('leg table', function () {

        it('[completed] each leg is named by its version and carries its recorded state', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationLegs(completed()));
            const rows = $('tr.attestation-leg');
            expect(rows.eq(0).attr('data-version')).to.equal('0');
            expect(rows.eq(0).text()).to.contain('Request (v0)');
            expect(rows.eq(0).text()).to.contain('fulfilled');
            expect(rows.eq(1).attr('data-version')).to.equal('1');
            expect(rows.eq(1).text()).to.contain('Response (v1)');
            expect(rows.eq(1).text()).to.contain('ok');
        });

        it('[empty] an attestation with no legs says so instead of rendering an empty table', function () {
            const dom = renderDom();
            const $ = paint(dom, dom.window.renderAttestationLegs({ legs: [] }));
            expect($('.attestation-no-legs').length).to.equal(1);
            expect($('table.attestation-legs-table').length).to.equal(0);
        });
    });

    describe('whole page: the shipped inline script', function () {

        it('[completed] fetches the composed route once and fills every panel', function () {
            const page = loadPage({ [URL_FOR(REQ_ID)]: completed() }, REQ_ID);
            expect(page.seen).to.deep.equal([URL_FOR(REQ_ID)]);
            expect(page.$('#attestation-request-id-value').text()).to.equal(REQ_ID);
            expect(page.$('#attestation-provider-value').text()).to.equal('http_get');
            expect(page.$('#attestation-leg-count').text()).to.equal('2');
            expect(page.$('#attestation-status-badge .attestation-status').attr('data-status')).to.equal('fulfilled');
            expect(page.$('#attestation-lifecycle [data-stage]').length).to.equal(4);
            expect(page.$('#attestation-response .attestation-signature').length).to.equal(2);
            expect(page.$('#attestation-relay .attestation-relay-native').length).to.equal(1);
            expect(page.$('#attestation-legs tr.attestation-leg').length).to.equal(2);
            expect(page.$('#attestation-expiry .attestation-expired').length).to.equal(0);
        });

        it('[completed] accepts the {total,data} envelope as well as the bare object', function () {
            const page = loadPage({ [URL_FOR(REQ_ID)]: { total: 1, data: [completed()] } }, REQ_ID);
            expect(page.$('#attestation-not-found').length).to.equal(0);
            expect(page.$('#attestation-request-id-value').text()).to.equal(REQ_ID);
        });

        it('[expired] the whole page reports expiry and no response', function () {
            const page = loadPage({ [URL_FOR(REQ_ID)]: expired() }, REQ_ID);
            expect(page.$('#attestation-expiry .attestation-expired').attr('data-expired')).to.equal('true');
            expect(page.$('#attestation-lifecycle [data-stage="expiry"]').attr('data-reached')).to.equal('true');
            expect(page.$('#attestation-response .attestation-no-response').length).to.equal(1);
        });

        it('[pending-past-deadline] the whole page never reports the live request as expired', function () {
            const page = loadPage({ [URL_FOR(REQ_ID)]: pendingPastDeadline() }, REQ_ID);
            expect(page.$('#attestation-expiry .attestation-expired').length).to.equal(0);
            expect(page.$('#attestation-expiry .attestation-not-expired').attr('data-expired')).to.equal('false');
            expect(page.$('#attestation-lifecycle [data-stage="expiry"]').attr('data-reached')).to.equal('false');
            expect(page.$('#attestation-status-badge .attestation-status').attr('data-status')).to.equal('pending');
        });

        it('[relay] the whole page marks the relay legs', function () {
            const page = loadPage({ [URL_FOR(REQ_ID)]: relayed() }, REQ_ID);
            expect(page.$('#attestation-relay .attestation-relay-origin').attr('data-relay')).to.equal('true');
            expect(page.$('#attestation-legs tr.attestation-leg-relay').length).to.equal(2);
        });

        it('[not-found] a 404 renders an explicit not-found branch, not blank placeholders', function () {
            const page = loadPage({}, 'nosuchid');
            expect(page.seen).to.deep.equal([URL_FOR('nosuchid')]);
            expect(page.$('#attestation-load-error').length).to.equal(1);
            expect(page.$('#attestation-load-error').text()).to.equal('The requested resource was not found.');
            expect(page.$('#attestation-lifecycle [data-stage]').length).to.equal(0);
            expect(page.$('#attestation-headline').text()).to.not.contain('Loading');
        });

        it('[empty-body] a 200 with nothing usable renders the not-found branch', function () {
            const page = loadPage({ [URL_FOR(REQ_ID)]: null }, REQ_ID);
            expect(page.$('#attestation-not-found').length).to.equal(1);
            expect(page.$('#attestation-legs').text()).to.equal('-');
        });

        it('[error] a non-404 failure surfaces the server error string in a danger row', function () {
            const page = loadPage({
                [URL_FOR(REQ_ID)]: { __fail: { status: 500, responseJSON: { error: 'A database error occurred while serving this request.', code: 'DB_ERROR' } } }
            }, REQ_ID);
            expect(page.$('#attestation-load-error').hasClass('text-danger')).to.equal(true);
            expect(page.$('#attestation-load-error').text()).to.equal('A database error occurred while serving this request.');
        });
    });

    describe('escaping', function () {

        it('a script-bearing payload, meta and provider id reach the DOM as text', function () {
            const dom = renderDom();
            const d = completed();
            d.request.payload = '<img src=x onerror=alert(1)>';
            d.response.meta   = '<script>alert(2)</script>';
            const $r = paint(dom, dom.window.renderAttestationRequest(d));
            expect($r('.attestation-request-payload').text()).to.equal('<img src=x onerror=alert(1)>');
            expect($r('#out img').length).to.equal(0);
            const $s = paint(dom, dom.window.renderAttestationResponse(d));
            expect($s('#out script').length).to.equal(0);
            expect($s('#out').text()).to.contain('<script>alert(2)</script>');
        });
    });
});
