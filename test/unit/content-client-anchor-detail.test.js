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

const XCHAIN_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8');
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
const TXID_V6 = 'b2'.repeat(32);
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

// ANCHOR v5: v3 checkpoint (SPV roots) + publisher-attestation tail.
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

// ANCHOR v6: v1 archive anchor + publisher-attestation tail.
// Venue shape: action 1007, same checkpointed height 2497, mined at DOGE 2505.
const V6 = Object.assign({}, V5, {
    action_index: 1007, version: 6,
    block_index_doge: 2505,
    state_root: null, state_root_version: null,
    block_merkle_root: null, block_merkle_version: null,
    match_batch_seq: 7, match_count: 3, batch_crc32: 'deadbeef',
    total_chunks: 2, chunk_index: 0, archive_b64_length: 4096,
    tx_hash: TXID_V6,
    chunks: [
        { action_index: 1007, version: 6, chunk_index: 0, total_chunks: 2, archive_b64_length: 4096, block_index_doge: 2505, status: 'valid' },
        { action_index: 1008, version: 2, chunk_index: 1, total_chunks: 2, archive_b64_length: 1024, block_index_doge: 2506, status: 'valid' }
    ],
    reward_attestations: [{
        id: 2, chain: 'DOGE', network: 'regtest', reward_type: 'anchor_archive',
        round_reference: 7, snapshot_block: 146500, publisher: PUBLISHER,
        reward_amount: '10.00000000', doge_anchor_txid: TXID_V6,
        created_at: '2026-08-19 12:02:00'
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
            const $ = renderPage(V6);
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

        it('renders a v5 as a ROOT-BEARING checkpoint: SPV roots present, archive card hidden', function () {
            const $ = renderPage(V5);
            expect($('.anchor-version-badge').text()).to.equal('v5');
            expect($('.anchor-kind').text()).to.equal('Checkpoint + SPV roots + publisher tail');
            expect($('.anchor-state-root-row').length, 'a v5 carries state_root').to.equal(1);
            expect($('.anchor-block-merkle-row').length, 'a v5 carries block_merkle_root').to.equal(1);
            expect($('#anchor-archive-card').hasClass('d-none'), 'a v5 carries no archive').to.equal(true);
            expect($('#anchor-checkpoint-payload .anchor-sig-count').text()).to.equal('1');
        });

        it('renders a v6 as an ARCHIVE anchor: archive card revealed with batch + chunk trail', function () {
            const $ = renderPage(V6);
            expect($('.anchor-version-badge').text()).to.equal('v6');
            expect($('#anchor-archive-card').hasClass('d-none'), 'a v6 carries an archive').to.equal(false);
            expect($('.anchor-batch-seq .anchor-field-value').text()).to.equal('7');
            expect($('#anchor-archive-payload .anchor-chunk-row').length).to.equal(2);
            expect($('#anchor-archive-payload .anchor-chunk-self').length, 'this anchor is marked inside its own batch').to.equal(1);
            // A v6 still carries a checkpoint, so the checkpoint payload stays.
            expect($('#anchor-checkpoint-payload .anchor-empty').length).to.equal(0);
        });

        it('a v6 with null roots shows no root rows rather than empty root rows', function () {
            const $ = renderPage(V6);
            expect($('.anchor-state-root-row').length).to.equal(0);
        });

        it('a v2 continuation chunk says it carries no checkpoint instead of showing blanks', function () {
            const $ = renderPage(Object.assign({}, V6, {
                version: 2, checkpoint_seq: null, chunk_index: 1, publisher: null,
                publisher_attestations: []
            }));
            expect($('.anchor-kind').text()).to.equal('Archive continuation chunk');
            expect($('#anchor-checkpoint-payload .anchor-empty').text())
                .to.contain('carries no checkpoint payload');
        });

        it('falls back to the row shape for an unrecognized version instead of rendering nothing', function () {
            const $ = renderPage(Object.assign({}, V6, { version: 9 }));
            expect($('.anchor-kind').text()).to.equal('Unrecognized version v9');
            expect($('#anchor-archive-card').hasClass('d-none'), 'match_batch_seq is set, so the archive still renders').to.equal(false);
            expect($('.anchor-batch-seq .anchor-field-value').text()).to.equal('7');
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
            const $ = renderPage(V6);
            expect($('.anchor-reward-row .anchor-reward-type').text()).to.equal('anchor_archive');
            expect($('.anchor-reward-row .anchor-reward-round').text()).to.equal('7');
        });

        it('[LINKAGE] separates a txid-PROVEN reward from one matched only by round', function () {
            // getAnchor ORs the two correlations, so both shapes reach the page.
            // Rendering the weaker one as proof would overstate the evidence.
            const $ = renderPage(Object.assign({}, V5, {
                reward_attestations: [
                    Object.assign({}, V5.reward_attestations[0], { id: 1, doge_anchor_txid: TXID_V5 }),
                    Object.assign({}, V5.reward_attestations[0], { id: 3, doge_anchor_txid: TXID_V6 })
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
