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
 * ANCHOR detail render leg. Drives the SHIPPED renders in
 * src/content/js/anchor_detail_render.js and the SHIPPED inline script of
 * src/content/html/anchor.html against stubbed /api/anchor/{QUERY} responses,
 * in the same JSDOM harness the poll and xcall detail tests use.
 *
 * What it protects:
 *
 *  - THE TWO HEIGHTS. anchor_actions carries block_index (the CHECKPOINTED
 *    height) and block_index_doge (the height the ANCHOR TRANSACTION was mined
 *    at). Both are correct data and they differ on every real anchor. A reader
 *    who takes one for the other looks the commitment leg up by the wrong number
 *    and reads correct data as a defect; that has already happened once. Each
 *    height is therefore pinned to its own label here, so swapping the two
 *    labels fails rather than shipping.
 *
 *  - VERSION TRAITS. Which payload legs an anchor carries is a property of its
 *    wire version, so a v5 must render SPV roots and a v6 must render the match
 *    archive, and an unrecognized version must still render what the row holds.
 *
 *  - REWARD LINKAGE. getAnchor correlates the reward trail on the mined DOGE
 *    txid (proof) OR on snapshot_block + round (inference). Rendering both as
 *    the same thing would overstate the evidence, so each row's linkage is
 *    pinned to the correlation that actually matched it.
 *
 *  - AN EMPTY REWARD TRAIL IS NOT AN ERROR. Rewards are attested after the
 *    anchor is mined and pre-reward-era anchors never get one, so the empty
 *    trail must render as an absence with no error styling at all.
 *
 *  - NOT FOUND IS AN EXPLICIT BRANCH, not a page of blank placeholders.
 */

'use strict';

const { srcText } = require('../../../helpers/source_text');

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
    + '\n' + fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/formatters.js'), 'utf8');
const RENDER_SRC = srcText('src/content/js/anchor_detail_render.js');
const PAGE_HTML  = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/html/anchor.html'), 'utf8');
const JQUERY_SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/jquery.min.js'), 'utf8');
const NUMERAL_SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/numeral.js'), 'utf8');

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

// isNull, formatAmount and numeral are the REAL ones: the empty/absent decisions
// and the thousands-separated heights the assertions read are expressed through
// them, so stubbing them would test the stub. formatLink/formatLivestamp are
// naive on purpose, so anything observed inside them is the render's own doing.
function installHelpers(dom) {
    dom.window.eval(JQUERY_SRC);
    dom.window.eval(NUMERAL_SRC);
    dom.window.eval(`
        var XC = { coin: 'RDOGE', query: '1006', name: 'Dogecoin', network: 'regtest', pageInfo: {}, datatables: {} };
        function tokenUrl(coin, tick){ return "/" + coin + "/token/" + encodeURIComponent(String(tick)); }
        function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatLivestamp(t){ return '<span class="stamp">' + t + '</span>'; }
        function updatePageInfo(){}
        ${extractFn(XCHAIN_SRC, 'isNull')}
        ${extractFn(XCHAIN_SRC, 'formatAmount')}
    `);
    dom.window.eval(RENDER_SRC);
}

// The page markup, minus its own <script> tags, so the panel ids the renders
// write into are the shipped ones.
function pageBody() {
    return PAGE_HTML.slice(0, PAGE_HTML.indexOf('<script'));
}

function domWithPage() {
    const dom = new JSDOM('<!DOCTYPE html><body>' + pageBody() + '</body>', { runScripts: 'outside-only' });
    installHelpers(dom);
    return dom;
}

// Drives renderAnchorPage exactly as anchor.html's success branch does.
function renderPage(d) {
    const dom = domWithPage();
    dom.window.renderAnchorPage(d);
    return dom.window.$;
}

/* ------------------------------------------------------------------ *
 * Whole-page harness: evaluates anchor.html's SHIPPED inline script with
 * $.getJSON answering from a stubbed route table.
 * ------------------------------------------------------------------ */
function loadPage(routes) {
    const scriptStart = PAGE_HTML.indexOf('$(document).ready(function() {');
    if (scriptStart < 0) throw new Error("anchor.html's inline ready block was not found");
    const inline = PAGE_HTML.slice(scriptStart, PAGE_HTML.lastIndexOf('</script>'));

    const dom = domWithPage();

    // Run the ready callback synchronously so the assertions do not race
    // jQuery's deferred ready queue. Harness-only; the page is untouched.
    dom.window.eval('jQuery.fn.ready = function(fn){ fn(jQuery); return this; };');

    const seen = [];
    dom.window.$.getJSON = function (url, cb) {
        seen.push(url);
        const r = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : undefined;
        let xhr = null;
        if (r === undefined) {
            xhr = { status: 404, responseJSON: { error: 'anchor not found', code: 'NOT_FOUND' } };
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

/* ------------------------------- fixtures ------------------------------- */

const TXID_V5 = 'a1'.repeat(32);
const TXID_V1 = 'b2'.repeat(32);
const PUBLISHER = '128d293c' + 'f'.repeat(48) + '7eaa';
const OTHER_PUBKEY = 'c3'.repeat(32);

const ELECTION = [
    { signing_pubkey: PUBLISHER,     amount: '5000000000', source: 'stake' },
    { signing_pubkey: OTHER_PUBKEY,  amount: '1000000000', source: 'stake' }
];

const COVERING_CHECKPOINT = {
    chain: 'DOGE', network: 'regtest', block_index: '2497', block_hash: 'd4'.repeat(32),
    ledger_hash: 'e5'.repeat(32), actions_hash: 'f6'.repeat(32), contract_hash: '07'.repeat(32),
    checkpoint_seq: '110', snapshot_block: '146500',
    state_root: '18'.repeat(32), state_root_version: 1,
    block_merkle_root: '29'.repeat(32), block_merkle_version: 1,
    validator_signatures: [{ pubkey: PUBLISHER, sig: 'aa' }],
    created_at: '2026-08-19 12:00:00'
};

// ANCHOR v5: v3 checkpoint (SPV roots) + publisher-attestation tail. Retired by
// the wire restart: ANCHOR_VERSION_TRAITS only knows 0/1/2 now, and this
// shape (roots + publisher tail, no bundle, no archive) has no v0/v1/v2
// equivalent, so on a network with no activation history (regtest, activation 0)
// it renders through the unrecognized-version fallback rather than as a known
// trait - see the 'version traits' tests below.
// Venue shape: action 1006, checkpointed height 2497, mined at DOGE 2503.
const V5 = {
    action: 'anchor', action_index: 1006, action_format: 'XANC', version: 5,
    chain: 'DOGE', network: 'regtest',
    block_index: 2497,
    block_index_doge: 2503,
    block_hash: 'd4'.repeat(32), ledger_hash: 'e5'.repeat(32),
    actions_hash: 'f6'.repeat(32), contract_hash: '07'.repeat(32),
    checkpoint_seq: 110, snapshot_block: 146500,
    state_root: '18'.repeat(32), state_root_version: 1,
    block_merkle_root: '29'.repeat(32), block_merkle_version: 1,
    match_batch_seq: null, match_count: null, batch_crc32: null,
    total_chunks: null, chunk_index: null, archive_b64_length: null,
    validator_signatures: [{ pubkey: PUBLISHER, sig: 'aa' }],
    publisher: PUBLISHER,
    publisher_attestations: [{ pubkey: PUBLISHER, sig: 'bb' }, { pubkey: OTHER_PUBKEY, sig: 'cc' }],
    timestamp: 1755600000, tx_hash: TXID_V5, tx_index: 4001, status: 'valid',
    chunks: [],
    checkpoint: COVERING_CHECKPOINT,
    publisher_election: ELECTION,
    reward_attestations: [{
        id: 1, chain: 'DOGE', network: 'regtest', reward_type: 'anchor_DOGE',
        round_reference: 110, snapshot_block: 146500, publisher: PUBLISHER,
        reward_amount: '10.00000000', doge_anchor_txid: TXID_V5,
        created_at: '2026-08-19 12:01:00'
    }]
};

// ANCHOR v1: the archive head, carrying its own checkpoint fields plus the match
// archive and a publisher-attestation tail (today's wire, after the restart).
// Venue shape: action 1007, same checkpointed height 2497, mined at DOGE 2505.
const V1 = Object.assign({}, V5, {
    action_index: 1007, version: 1,
    block_index_doge: 2505,
    state_root: null, state_root_version: null,
    block_merkle_root: null, block_merkle_version: null,
    match_batch_seq: 7, match_count: 3, batch_crc32: 'deadbeef',
    total_chunks: 2, chunk_index: 0, archive_b64_length: 4096,
    tx_hash: TXID_V1,
    chunks: [
        { action_index: 1007, version: 1, chunk_index: 0, total_chunks: 2, archive_b64_length: 4096, block_index_doge: 2505, status: 'valid' },
        { action_index: 1008, version: 2, chunk_index: 1, total_chunks: 2, archive_b64_length: 1024, block_index_doge: 2506, status: 'valid' }
    ],
    reward_attestations: [{
        id: 2, chain: 'DOGE', network: 'regtest', reward_type: 'anchor_archive',
        round_reference: 7, snapshot_block: 146500, publisher: PUBLISHER,
        reward_amount: '10.00000000', doge_anchor_txid: TXID_V1,
        created_at: '2026-08-19 12:02:00'
    }]
});

/* ------------------------- v0 bundle fixture ------------------------- */

// ANCHOR v0: ONE action per network per cycle, carrying every checkpointed chain
// as its own section (formerly v7, re-keyed to v0 by the wire restart).
// getAnchor composes the sibling rows into this shape: a header holding what the
// BUNDLE owns, plus `sections` in section_index order holding what each CHAIN
// owns. Sections are ordered chain-ascending, so on this RDOGE explorer the local
// section is index 1, not index 0 - which is exactly the arrangement in which
// rendering section 0 as "the anchor" looks plausible and is wrong.
const BUNDLE_TXID = 'e7'.repeat(32);

const BUNDLE_SECTIONS = [
    { section_index: 0, chain: 'BTC', network: 'regtest', block_index: 2497, block_hash: 'b7'.repeat(32),
      ledger_hash: 'e5'.repeat(32), actions_hash: 'f6'.repeat(32), contract_hash: '07'.repeat(32),
      checkpoint_seq: 110, snapshot_block: 110, state_root: '18'.repeat(32), state_root_version: 1,
      block_merkle_root: '29'.repeat(32), block_merkle_version: 1,
      validator_signatures: [{ pubkey: PUBLISHER, sig: 'aa' }], status: 'valid' },
    { section_index: 1, chain: 'DOGE', network: 'regtest', block_index: 3001, block_hash: 'd0'.repeat(32),
      ledger_hash: 'e5'.repeat(32), actions_hash: 'f6'.repeat(32), contract_hash: '07'.repeat(32),
      checkpoint_seq: 112, snapshot_block: 112, state_root: '3a'.repeat(32), state_root_version: 1,
      block_merkle_root: '4b'.repeat(32), block_merkle_version: 1,
      validator_signatures: [{ pubkey: PUBLISHER, sig: 'bb' }, { pubkey: OTHER_PUBKEY, sig: 'cc' }], status: 'valid' },
    { section_index: 2, chain: 'LTC', network: 'regtest', block_index: 1200, block_hash: '1c'.repeat(32),
      ledger_hash: 'e5'.repeat(32), actions_hash: 'f6'.repeat(32), contract_hash: '07'.repeat(32),
      checkpoint_seq: 111, snapshot_block: 111, state_root: '5c'.repeat(32), state_root_version: 1,
      block_merkle_root: '6d'.repeat(32), block_merkle_version: 1,
      validator_signatures: [], status: 'valid' }
];

const BUNDLE = Object.assign({}, V5, {
    action_index: 1100, version: 0,
    chain: 'BTC', block_index: 2497, block_hash: 'b7'.repeat(32),
    checkpoint_seq: 110, snapshot_block: 112,
    state_root: '18'.repeat(32), block_merkle_root: '29'.repeat(32),
    block_index_doge: 3010, tx_hash: BUNDLE_TXID,
    sections: BUNDLE_SECTIONS, section_count: 3, local_section_index: 1,
    // The mirror this RDOGE explorer holds is DOGE's, so it agrees with the DOGE
    // SECTION's payload and not with the header's BTC hashes.
    checkpoint: Object.assign({}, COVERING_CHECKPOINT, {
        chain: 'DOGE', block_index: '3001', block_hash: 'd0'.repeat(32), checkpoint_seq: '112'
    }),
    reward_attestations: [{
        id: 9, chain: 'DOGE', network: 'regtest', reward_type: 'anchor_bundle',
        round_reference: 112, snapshot_block: 112, publisher: PUBLISHER,
        reward_amount: '10.00000000', doge_anchor_txid: BUNDLE_TXID,
        created_at: '2026-08-28 22:20:00'
    }]
});

// TDOGE testnet shape: action 22, a bundle-family anchor mined at DOGE
// height 150208, well below ANCHOR_ACTIVATION.testnet (67858600). Not
// yet reparsed (row 9 is off the launch path), so its stored status is
// still the old verdict ('valid').
const LEGACY_TESTNET_BUNDLE = Object.assign({}, BUNDLE, {
    action_index: 22, network: 'testnet', block_index_doge: 150208, status: 'valid',
    sections: BUNDLE_SECTIONS.map(function (s) { return Object.assign({}, s, { network: 'testnet' }); })
});

module.exports = { expect, renderPage, domWithPage, loadPage, V5, V1, BUNDLE, BUNDLE_SECTIONS, PUBLISHER, TXID_V5, TXID_V1, COVERING_CHECKPOINT, LEGACY_TESTNET_BUNDLE };

require('./content_client_anchor_detail.test/support/heights.js');
require('./content_client_anchor_detail.test/support/version_traits_known.js');
require('./content_client_anchor_detail.test/support/version_traits_fallback.js');
require('./content_client_anchor_detail.test/support/activation_parity.js');
require('./content_client_anchor_detail.test/support/activation_legacy_labels.js');
require('./content_client_anchor_detail.test/support/activation_legacy_boundary.js');
require('./content_client_anchor_detail.test/support/bundle_sections.js');
require('./content_client_anchor_detail.test/support/bundle_payload.js');
require('./content_client_anchor_detail.test/support/bundle_mirror.js');
require('./content_client_anchor_detail.test/support/publisher_election.js');
require('./content_client_anchor_detail.test/support/reward_trail.js');
require('./content_client_anchor_detail.test/support/covering_checkpoint.js');
require('./content_client_anchor_detail.test/support/page_wiring.js');
