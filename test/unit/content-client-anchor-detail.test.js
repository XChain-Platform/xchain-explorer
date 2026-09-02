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
 * src/content/js/anchor-detail-render.js and the SHIPPED inline script of
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
const RENDER_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/anchor-detail-render.js'), 'utf8');
const PAGE_HTML  = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/anchor.html'), 'utf8');
const JQUERY_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8');
const NUMERAL_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/numeral.js'), 'utf8');

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

describe('anchor.html detail render @regression', function () {

    /* ---------------------- the two block heights ---------------------- */

    describe('the two block heights', function () {

        it('[TRAP] labels the CHECKPOINTED height and the ANCHOR TRANSACTION height distinctly', function () {
            const $ = renderPage(V5);
            const cp = $('.anchor-height-checkpointed');
            const bc = $('.anchor-height-broadcast');
            expect(cp.length, 'the checkpointed-height row renders').to.equal(1);
            expect(bc.length, 'the broadcast-height row renders').to.equal(1);

            // The label-to-value binding is the whole point: swapping the two
            // labels must fail here, not ship.
            expect(cp.find('.anchor-height-label').text()).to.equal('Checkpointed Block');
            expect(cp.find('.anchor-height-value').text()).to.equal('2,497');
            expect(bc.find('.anchor-height-label').text()).to.equal('Anchor Transaction Block');
            expect(bc.find('.anchor-height-value').text()).to.equal('2,503');
        });

        it('[TRAP] never renders either height under a bare "Block" label', function () {
            const $ = renderPage(V5);
            const labels = $('.anchor-height-label').map(function (i, el) { return $(el).text(); }).get();
            expect(labels).to.have.lengthOf(2);
            for (const l of labels)
                expect(l, 'an unqualified "Block" label is the misreading this page exists to prevent').to.not.equal('Block');
        });

        it('[TRAP] each height carries its own explanation of which one it is', function () {
            const $ = renderPage(V5);
            expect($('.anchor-height-checkpointed .anchor-note').text())
                .to.contain('Checkpoint and commitment lookups key off THIS height');
            expect($('.anchor-height-broadcast .anchor-note').text())
                .to.contain('ANCHOR transaction itself was mined in');
        });

        it('keeps the two heights apart on the v6 archive anchor too (2497 vs 2505)', function () {
            const $ = renderPage(V1);
            expect($('.anchor-height-checkpointed .anchor-height-value').text()).to.equal('2,497');
            expect($('.anchor-height-broadcast .anchor-height-value').text()).to.equal('2,505');
        });

        it('shows a missing broadcast height as absent rather than borrowing the checkpointed one', function () {
            const $ = renderPage(Object.assign({}, V5, { block_index_doge: null }));
            expect($('.anchor-height-checkpointed .anchor-height-value').text()).to.equal('2,497');
            expect($('.anchor-height-broadcast .anchor-height-value').text()).to.equal('-');
        });
    });

    /* ------------------------- version traits ------------------------- */

    describe('version traits', function () {

        // v5 has no v0/v1/v2 equivalent after the restart (roots + tail,
        // no bundle, no archive), and this row's own network (regtest) has no
        // activation history, so it falls to the unrecognized-version shape
        // fallback rather than the legacy-before-activation path (that path is
        // covered separately below). Its PAYLOAD still renders in full: only the
        // label and the "known" flag change, because the fallback derives every
        // leg from the row's own columns.
        it('a retired non-bundle root-bearing version (v5) is no longer a known trait, but its payload still renders', function () {
            const $ = renderPage(V5);
            expect($('.anchor-version-badge').text()).to.equal('v5');
            expect($('.anchor-kind').text()).to.equal('Unrecognized version v5');
            expect($('.anchor-state-root-row').length, 'a v5 carries state_root').to.equal(1);
            expect($('.anchor-block-merkle-row').length, 'a v5 carries block_merkle_root').to.equal(1);
            expect($('#anchor-archive-card').hasClass('d-none'), 'a v5 carries no archive').to.equal(true);
            expect($('#anchor-checkpoint-payload .anchor-sig-count').text()).to.equal('1');
        });

        it('renders a v0 bundle-family checkpoint: known trait, no activation note, no "unrecognized" fallback', function () {
            // A single-section anchor cannot exercise anchor-sections-card wiring
            // (that is the 'v0 bundle sections' describe block below), but it
            // still proves v0 resolves through ANCHOR_VERSION_TRAITS as a KNOWN,
            // bundle-shaped version rather than falling back to the row's shape.
            const $ = renderPage(BUNDLE);
            expect($('.anchor-version-badge').text()).to.equal('v0');
            expect($('.anchor-kind').text()).to.equal('Checkpoint bundle (one per network)');
            expect($('.anchor-note').text()).to.not.contain('does not recognize');
            expect($('.anchor-note').text()).to.not.contain('Legacy');
        });

        it('renders a v1 as the ARCHIVE HEAD: archive card revealed with batch + chunk trail', function () {
            const $ = renderPage(V1);
            expect($('.anchor-version-badge').text()).to.equal('v1');
            expect($('.anchor-kind').text()).to.equal('Archive head + publisher tail');
            expect($('#anchor-archive-card').hasClass('d-none'), 'a v1 carries an archive').to.equal(false);
            expect($('.anchor-batch-seq .anchor-field-value').text()).to.equal('7');
            expect($('#anchor-archive-payload .anchor-chunk-row').length).to.equal(2);
            expect($('#anchor-archive-payload .anchor-chunk-self').length, 'this anchor is marked inside its own batch').to.equal(1);
            // A v1 still carries a checkpoint, so the checkpoint payload stays.
            expect($('#anchor-checkpoint-payload .anchor-empty').length).to.equal(0);
        });

        it('a v1 with null roots shows no root rows rather than empty root rows', function () {
            const $ = renderPage(V1);
            expect($('.anchor-state-root-row').length).to.equal(0);
        });

        it('a v2 continuation chunk says it carries no checkpoint instead of showing blanks', function () {
            const $ = renderPage(Object.assign({}, V1, {
                version: 2, checkpoint_seq: null, chunk_index: 1, publisher: null,
                publisher_attestations: []
            }));
            expect($('.anchor-kind').text()).to.equal('Archive continuation chunk');
            expect($('#anchor-checkpoint-payload .anchor-empty').text())
                .to.contain('carries no checkpoint payload');
        });

        it('falls back to the row shape for an unrecognized version instead of rendering nothing', function () {
            const $ = renderPage(Object.assign({}, V1, { version: 9 }));
            expect($('.anchor-kind').text()).to.equal('Unrecognized version v9');
            expect($('#anchor-archive-card').hasClass('d-none'), 'match_batch_seq is set, so the archive still renders').to.equal(false);
            expect($('.anchor-batch-seq .anchor-field-value').text()).to.equal('7');
        });
    });

    /* ------------------- activation gate: legacy rows ------------------ */

    // content/js ships as plain static scripts with no bundler, so the browser
    // copy of ANCHOR_ACTIVATION cannot require() this service's canonical
    // module and is instead a hand-vendored literal. That is a silent-drift
    // seam: the server would gate at one height and the page label at another,
    // and every symptom would look like a rendering bug. Pin the two together
    // here, against the SHIPPED script the renders run from.
    describe('ANCHOR_ACTIVATION twin parity (client literal vs. the module)', function () {

        it('the browser copy equals src/protocol/constants.js exactly', function () {
            const canonical = require('../../src/protocol/constants.js').ANCHOR_ACTIVATION;
            const shipped   = domWithPage().window.ANCHOR_ACTIVATION;
            expect(shipped, 'the render script must declare ANCHOR_ACTIVATION').to.be.an('object');
            expect(shipped).to.deep.equal(canonical);
            // deepEqual alone would pass if BOTH sides lost a network, so pin
            // the key set the gate switches on as well.
            expect(Object.keys(shipped).sort()).to.deep.equal(['mainnet', 'regtest', 'testnet']);
        });
    });

    // D7: a row mined before ANCHOR_ACTIVATION for its network is legacy
    // regardless of its version byte, because that byte was reused under an
    // older, unrelated meaning before the wire restart. It must render
    // through the SAME known:false path an unrecognized version does, under a
    // dedicated "Legacy (before activation)" label plus its own stored status,
    // and it must NEVER be read against today's v0/v1/v2 traits table - the
    // exact failure mode that motivates the gate (a legacy row misreading as
    // whatever today's version table happens to say that byte means).
    describe('activation gate: rows before ANCHOR_ACTIVATION', function () {

        // TDOGE testnet shape: action 22, a bundle-family anchor mined at DOGE
        // height 150208, well below ANCHOR_ACTIVATION.testnet (67858600). Not
        // yet reparsed (row 9 is off the launch path), so its stored status is
        // still the old verdict ('valid').
        const LEGACY_TESTNET_BUNDLE = Object.assign({}, BUNDLE, {
            action_index: 22, network: 'testnet', block_index_doge: 150208, status: 'valid',
            sections: BUNDLE_SECTIONS.map(function (s) { return Object.assign({}, s, { network: 'testnet' }); })
        });

        it('[TRAP] a bundle-shaped row below testnet activation renders as Legacy, never as a v0 bundle', function () {
            const $ = renderPage(LEGACY_TESTNET_BUNDLE);
            expect($('.anchor-version-badge').text()).to.equal('v0');
            expect($('.anchor-kind').text()).to.equal('Legacy (before activation)');
            expect($('.anchor-kind').text()).to.not.contain('bundle');
        });

        it('names the stored reason (the row\'s own status) in the legacy note', function () {
            const $ = renderPage(LEGACY_TESTNET_BUNDLE);
            const note = $('.anchor-field-value .anchor-note').first().text();
            expect(note).to.contain('activation height');
            expect(note).to.contain('Stored status: valid');
        });

        it('surfaces a post-reparse invalid verdict as the stored reason too, and leaves the Status badge untouched', function () {
            const $ = renderPage(Object.assign({}, LEGACY_TESTNET_BUNDLE, {
                status: 'invalid: ANCHOR before activation'
            }));
            expect($('.anchor-kind').text()).to.equal('Legacy (before activation)');
            expect($('.anchor-field-value .anchor-note').first().text())
                .to.contain('Stored status: invalid: ANCHOR before activation');
            // The real Status field still shows the raw stored verdict too,
            // unhidden - the legacy note explains it, it does not replace it.
            expect($('.anchor-status-badge').first().text()).to.equal('invalid: ANCHOR before activation');
        });

        it('[TRAP] a v1-shaped row below testnet activation ALSO renders as Legacy, never as today\'s v1', function () {
            // The exact misreading D7 exists to prevent: a legacy version byte 1
            // meant something else before the restart, and collapsing the
            // traits table without this gate would relabel it with TODAY'S v1
            // meaning ("Archive head + publisher tail") instead of flagging it.
            const $ = renderPage(Object.assign({}, V1, {
                network: 'testnet', block_index_doge: 150174, status: 'valid'
            }));
            expect($('.anchor-kind').text()).to.equal('Legacy (before activation)');
            expect($('.anchor-kind').text()).to.not.equal('Archive head + publisher tail');
            expect($('.anchor-kind').text()).to.not.equal('Archive continuation chunk');
        });

        it('a row AT the activation height is judged on its version, not flagged legacy (>= is the boundary)', function () {
            const $ = renderPage(Object.assign({}, V1, {
                network: 'testnet', block_index_doge: 67858600, status: 'valid'
            }));
            expect($('.anchor-kind').text()).to.equal('Archive head + publisher tail');
        });

        it('regtest has no activation history (ANCHOR_ACTIVATION.regtest = 0), so a regtest row is never flagged legacy', function () {
            const $ = renderPage(Object.assign({}, V1, { block_index_doge: 0 }));
            expect($('.anchor-kind').text()).to.not.equal('Legacy (before activation)');
            expect($('.anchor-kind').text()).to.equal('Archive head + publisher tail');
        });
    });

    /* --------------------------- v0 bundle ---------------------------- */

    describe('v0 bundle sections', function () {

        it('renders ONE row per chain, in section_index order, with each chain\'s own payload', function () {
            const $ = renderPage(BUNDLE);
            const rows = $('.anchor-section-row');
            expect(rows.length, 'three chains rode this anchor').to.equal(3);
            expect(rows.find('.anchor-section-index').map(function (i, el) { return $(el).text(); }).get())
                .to.deep.equal(['0', '1', '2']);
            expect(rows.find('.anchor-section-chain').map(function (i, el) { return $(el).text().trim().split(' ')[0]; }).get())
                .to.deep.equal(['BTC', 'DOGE', 'LTC']);
            // Each section commits its OWN height and sequence; collapsing them onto
            // the header's would show one chain's checkpoint three times.
            expect(rows.find('.anchor-section-block').map(function (i, el) { return $(el).text(); }).get())
                .to.deep.equal(['2,497', '3,001', '1,200']);
            expect(rows.find('.anchor-section-seq').map(function (i, el) { return $(el).text(); }).get())
                .to.deep.equal(['110', '112', '111']);
            expect(rows.find('.anchor-section-sig-count').map(function (i, el) { return $(el).text(); }).get())
                .to.deep.equal(['1', '2', '0']);
        });

        it('reveals the sections card on a bundle and hides it on a single-checkpoint anchor', function () {
            expect(renderPage(BUNDLE)('#anchor-sections-card').hasClass('d-none')).to.equal(false);
            expect(renderPage(V5)('#anchor-sections-card').hasClass('d-none'), 'a v5 carries no sections').to.equal(true);
            expect(renderPage(BUNDLE)('#anchor-archive-card').hasClass('d-none'), 'a bundle carries no archive').to.equal(true);
        });

        it('[TRAP] marks THIS explorer\'s own section rather than treating section 0 as the anchor', function () {
            const $ = renderPage(BUNDLE);
            const local = $('.anchor-section-local');
            expect(local.length, 'exactly one section belongs to this coin').to.equal(1);
            expect(local.find('.anchor-section-chain').text()).to.contain('DOGE');
            expect(local.find('.anchor-section-block').text()).to.equal('3,001');
        });

        it('[TRAP] the checkpoint card carries only what the BUNDLE owns, never section 0\'s hashes', function () {
            const $ = renderPage(BUNDLE);
            const card = $('#anchor-checkpoint-payload');
            expect(card.find('.anchor-section-count').text()).to.equal('3');
            // Section 0's block hash rendered here would read as the whole anchor's.
            expect(card.text(), 'a per-chain hash must not stand in for the bundle')
                .to.not.contain('b7b7b7');
            expect(card.find('.anchor-snapshot-block').text()).to.contain('112');
        });

        it('[TRAP] lists a checkpointed height PER CHAIN instead of one height for the bundle', function () {
            const $ = renderPage(BUNDLE);
            const labels = $('.anchor-height-label').map(function (i, el) { return $(el).text(); }).get();
            expect(labels).to.deep.equal(['Checkpointed Blocks', 'Anchor Transaction Block']);
            for (const l of labels) expect(l).to.not.equal('Block');
            const heights = $('.anchor-height-checkpointed .anchor-section-height').map(function (i, el) { return $(el).text(); }).get();
            expect(heights).to.deep.equal(['BTC 2,497', 'DOGE 3,001', 'LTC 1,200']);
            expect($('.anchor-height-broadcast .anchor-height-value').text()).to.equal('3,010');
        });

        it('names every chain in the bundle instead of one chain for the action', function () {
            const $ = renderPage(BUNDLE);
            expect($('.anchor-bundle-chains').text()).to.equal('BTC, DOGE, LTC');
            expect($('.anchor-version-badge').text()).to.equal('v0');
            expect($('.anchor-kind').text()).to.contain('bundle');
        });

        it('[TRAP] cross-checks the mirror against THIS coin\'s section, not the header chain', function () {
            const $ = renderPage(BUNDLE);
            // The header carries BTC's hash and the mirror holds DOGE's. Comparing
            // those two would report a false disagreement on a healthy bundle.
            expect($('.anchor-mirror-agreement .badge').text()).to.equal('Mirror agrees with the on-chain payload');
            expect($('.anchor-covering-link a').attr('href')).to.equal('/RDOGE/checkpoint/3001');
        });

        it('names the missing mirror by THIS coin\'s section height', function () {
            const $ = renderPage(Object.assign({}, BUNDLE, { checkpoint: null }));
            const msg = $('#anchor-covering-checkpoint .anchor-empty').text();
            expect(msg).to.contain('checkpointed height 3,001');
            expect(msg, 'another section\'s height was never looked up').to.not.contain('2,497');
        });

        it('renders the single anchor_bundle reward as the round-keyed trail it is', function () {
            const $ = renderPage(BUNDLE);
            expect($('.anchor-reward-row').length).to.equal(1);
            expect($('.anchor-reward-type').text()).to.equal('anchor_bundle');
            expect($('.anchor-reward-linkage').text()).to.equal('proven by txid');
        });

        it('a one-section bundle renders as a normal cycle, not as a fault', function () {
            const $ = renderPage(Object.assign({}, BUNDLE, {
                sections: [BUNDLE_SECTIONS[1]], section_count: 1, local_section_index: 1
            }));
            expect($('.anchor-section-row').length).to.equal(1);
            expect($('.anchor-section-count').text()).to.equal('1');
            expect($('#anchor-sections .text-danger').length, 'a short bundle is the normal daily case').to.equal(0);
            expect($('#anchor-sections-card').hasClass('d-none')).to.equal(false);
        });
    });

    /* ------------------------ publisher election ---------------------- */

    describe('publisher election', function () {

        it('renders the electorate and marks which member the anchor elected', function () {
            const $ = renderPage(V5);
            expect($('.anchor-elector-row').length).to.equal(2);
            const elected = $('.anchor-elector-elected');
            expect(elected.length, 'exactly one member is the elected publisher').to.equal(1);
            expect(elected.text()).to.contain(PUBLISHER);
            expect($('.anchor-publisher').text()).to.equal(PUBLISHER);
        });

        it('names the wire attestation tail as unverified transport, not a quorum', function () {
            const $ = renderPage(V5);
            expect($('.anchor-tail-count').text()).to.equal('2');
            expect($('.anchor-tail-row .anchor-note').text()).to.contain('not a verified quorum');
        });

        it('an empty electorate renders as an absence, with no error styling', function () {
            const $ = renderPage(Object.assign({}, V5, { publisher_election: [] }));
            expect($('#anchor-election .anchor-empty').text()).to.contain('No oracle_publish electorate');
            expect($('#anchor-election .text-danger').length).to.equal(0);
        });
    });

    /* --------------------- reward attestation trail -------------------- */

    describe('reward attestation trail', function () {

        it('renders the reward row with its exact stored columns', function () {
            const $ = renderPage(V5);
            const row = $('.anchor-reward-row');
            expect(row.length).to.equal(1);
            expect(row.find('.anchor-reward-id').text()).to.equal('1');
            expect(row.find('.anchor-reward-type').text()).to.equal('anchor_DOGE');
            expect(row.find('.anchor-reward-round').text()).to.equal('110');
            expect(row.find('.anchor-reward-amount').text()).to.equal('10.00000000');
            expect(row.find('.anchor-reward-txid').text()).to.equal(TXID_V5);
            expect($('.anchor-reward-scope').text()).to.contain('DOGE/regtest');
        });

        it('renders the archive-reward row on the v6 anchor', function () {
            const $ = renderPage(V1);
            expect($('.anchor-reward-row .anchor-reward-type').text()).to.equal('anchor_archive');
            expect($('.anchor-reward-row .anchor-reward-round').text()).to.equal('7');
        });

        it('[LINKAGE] separates a txid-PROVEN reward from one matched only by round', function () {
            // getAnchor ORs the two correlations, so both shapes reach the page.
            // Rendering the weaker one as proof would overstate the evidence.
            const $ = renderPage(Object.assign({}, V5, {
                reward_attestations: [
                    Object.assign({}, V5.reward_attestations[0], { id: 1, doge_anchor_txid: TXID_V5 }),
                    Object.assign({}, V5.reward_attestations[0], { id: 3, doge_anchor_txid: TXID_V1 })
                ]
            }));
            const badges = $('.anchor-reward-linkage').map(function (i, el) { return $(el).text(); }).get();
            expect(badges).to.deep.equal(['proven by txid', 'matched by round']);
            expect($('.anchor-reward-linkage.text-bg-success').length, 'only the txid match is proof').to.equal(1);
        });

        it('[EMPTY TRAIL] an anchor with no rewards renders an absence, never an error', function () {
            const $ = renderPage(Object.assign({}, V5, { reward_attestations: [] }));
            const panel = $('#anchor-rewards');
            expect(panel.find('.anchor-empty').text()).to.contain('No reward attestation is recorded');
            expect(panel.find('.text-danger').length, 'an unrewarded anchor is not a failure').to.equal(0);
            expect(panel.find('.alert-danger, .alert-warning').length).to.equal(0);
            expect(panel.find('.anchor-reward-row').length).to.equal(0);
            // The rest of the page must still be fully rendered.
            expect($('.anchor-height-checkpointed .anchor-height-value').text()).to.equal('2,497');
        });

        it('a missing reward_attestations key is treated as an empty trail, not a crash', function () {
            const bare = Object.assign({}, V5);
            delete bare.reward_attestations;
            const $ = renderPage(bare);
            expect($('#anchor-rewards .anchor-empty').length).to.equal(1);
        });
    });

    /* ---------------------- covering checkpoint ----------------------- */

    describe('covering checkpoint', function () {

        it('links the covering checkpoint at the CHECKPOINTED height, not the broadcast one', function () {
            const $ = renderPage(V5);
            const href = $('.anchor-covering-link a').attr('href');
            expect(href).to.equal('/RDOGE/checkpoint/2497');
            expect(href, 'the broadcast height would be the wrong lookup key').to.not.contain('2503');
        });

        it('states agreement between the on-chain payload and the mirrored checkpoint', function () {
            const $ = renderPage(V5);
            expect($('.anchor-mirror-agreement .badge').text()).to.equal('Mirror agrees with the on-chain payload');
        });

        it('flags a mirror whose block_hash disagrees with the anchor payload', function () {
            const $ = renderPage(Object.assign({}, V5, {
                checkpoint: Object.assign({}, COVERING_CHECKPOINT, { block_hash: '99'.repeat(32) })
            }));
            expect($('.anchor-mirror-agreement .badge').text()).to.equal('Mirror DISAGREES with the on-chain payload');
        });

        it('[NULL CHECKPOINT] a missing mirror row names the CHECKPOINTED height it looked up', function () {
            const $ = renderPage(Object.assign({}, V5, { checkpoint: null }));
            const msg = $('#anchor-covering-checkpoint .anchor-empty').text();
            expect(msg).to.contain('checkpointed height 2,497');
            expect(msg).to.contain('not the block the anchor transaction landed in');
            expect(msg, 'the broadcast height must not appear as the lookup key').to.not.contain('2,503');
            expect($('#anchor-covering-checkpoint .text-danger').length, 'an uncovered anchor is not an error').to.equal(0);
        });
    });

    /* --------------------------- page wiring -------------------------- */

    describe('page wiring (anchor.html inline script)', function () {

        it('fetches the composed anchor endpoint directly and renders a BARE object response', function () {
            const page = loadPage({ '/RDOGE/api/anchor/1006': V5 });
            expect(page.seen).to.deep.equal(['/RDOGE/api/anchor/1006']);
            expect(page.$('.anchor-height-checkpointed .anchor-height-value').text()).to.equal('2,497');
            expect(page.$('.anchor-reward-row').length).to.equal(1);
        });

        it('also accepts the {total, data} envelope shape', function () {
            const page = loadPage({ '/RDOGE/api/anchor/1006': { total: 1, data: [V5] } });
            expect(page.$('.anchor-height-broadcast .anchor-height-value').text()).to.equal('2,503');
        });

        it('[NOT FOUND] a 404 renders the endpoint error explicitly, not blank placeholders', function () {
            const page = loadPage({});
            const msg = page.$('#anchor-identity .anchor-message');
            expect(msg.length).to.equal(1);
            expect(msg.text()).to.equal('anchor not found');
            expect(msg.hasClass('text-danger')).to.equal(true);
            expect(page.$('#anchor-identity').text()).to.not.contain('Loading anchor');
            expect(page.$('#anchor-archive-card').hasClass('d-none')).to.equal(true);
        });

        it('[NOT FOUND] a 200 with an empty envelope renders the no-such-anchor branch', function () {
            const page = loadPage({ '/RDOGE/api/anchor/1006': { total: 0, data: [] } });
            const msg = page.$('#anchor-identity .anchor-message');
            expect(msg.text()).to.equal('No anchor matches this action index or transaction hash.');
            expect(msg.hasClass('text-danger'), 'no such anchor is not a server error').to.equal(false);
        });

        it('a failed request without a JSON body still says something concrete', function () {
            const page = loadPage({ '/RDOGE/api/anchor/1006': { __fail: { status: 500 } } });
            expect(page.$('#anchor-identity .anchor-message').text()).to.equal('Could not load this anchor');
        });

        it('leaves no panel showing its loading placeholder after a response', function () {
            const page = loadPage({ '/RDOGE/api/anchor/1006': V5 });
            for (const id of ['#anchor-identity', '#anchor-heights', '#anchor-checkpoint-payload',
                              '#anchor-covering-checkpoint', '#anchor-election', '#anchor-rewards'])
                expect(page.$(id).text(), id + ' still shows its placeholder').to.not.contain('Loading');
        });
    });
});
