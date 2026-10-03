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
 *********************************************************************/

'use strict';

const { srcText } = require('../../../../helpers/source_text');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
// The page loads network_coin.js ahead of every link builder (networkCoin).
const NETWORK_COIN_SRC = require('../../../../helpers/content-source.js').networkCoinSource();
const { expect } = require('chai');

const RENDER_SRC = srcText('src/content/js/anchor_detail_render.js');
const JQUERY_SRC = fs.readFileSync(path.resolve(__dirname, '../../../../../src/content/js/jquery.min.js'), 'utf8');
const NUMERAL_SRC = fs.readFileSync(path.resolve(__dirname, '../../../../../src/content/js/numeral.js'), 'utf8');

// fold is the ANCHOR_FOLD_ACTIVATION table the page receives; null leaves the
// global undeclared, the shape a page served without the injection would have.
function render(row, fold = { regtest: 0 }){
    const ids = [
        'anchor-heading', 'anchor-identity', 'anchor-heights', 'anchor-checkpoint-payload',
        'anchor-sections', 'anchor-archive-payload', 'anchor-covering-checkpoint',
        'anchor-election', 'anchor-rewards'
    ];
    const body = ids.map(id => '<div id="' + id + '"></div>').join('')
        + '<div id="anchor-sections-card"></div><div id="anchor-archive-card"></div>';
    const dom = new JSDOM('<!DOCTYPE html><body>' + body + '</body>', { runScripts: 'outside-only' });
    dom.window.eval(JQUERY_SRC);
    dom.window.eval(NUMERAL_SRC);
    dom.window.eval(`
        var ANCHOR_ACTIVATION = { regtest: 0 };
        ${fold === null ? '' : 'var ANCHOR_FOLD_ACTIVATION = ' + JSON.stringify(fold) + ';'}
        var XC = { coin: 'RDOGE', network: 'regtest' };
        function isNull(v){ return v === null || v === undefined; }
        // The real pair: formatLink escapes its label, formatLinkHtml takes markup as-is.
        function formatLinkHtml(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
        function formatLink(href, text){ return formatLinkHtml(href, text ? String(text).replace(/[&<>"']/g, function(c){ return '&#' + c.charCodeAt(0) + ';'; }) : text); }
        function formatLivestamp(t){ return String(t); }
        function formatAmount(v){ return String(v); }
    `);
    dom.window.eval(NETWORK_COIN_SRC);
    dom.window.eval(RENDER_SRC);
    dom.window.renderAnchorPage(row);
    return dom.window.$;
}

const CHECKPOINTS = [
    {
        section_index: 0, version: 41, chain: 'BTC', network: 'regtest',
        block_index: 120, checkpoint_seq: 8, snapshot_block: 900,
        state_root: '11'.repeat(32), state_root_version: 1,
        block_merkle_root: '22'.repeat(32), block_merkle_version: 1,
        validator_signatures: [], match_batch_seq: null, status: 'valid'
    },
    {
        section_index: 1, version: 42, chain: 'DOGE', network: 'regtest',
        block_index: 121, checkpoint_seq: 9, snapshot_block: 901,
        state_root: '33'.repeat(32), state_root_version: 1,
        block_merkle_root: '44'.repeat(32), block_merkle_version: 1,
        validator_signatures: [], match_batch_seq: null, status: 'valid'
    }
];

const ARCHIVE = {
    section_index: 2, version: 99, chain: null, network: 'regtest',
    match_batch_seq: 27, match_count: 5, batch_crc32: 'deadbeef',
    total_chunks: 2, chunk_index: 0, archive_b64_length: 4096,
    validator_signatures: [], status: 'invalid_archive'
};

const FOLDED = Object.assign({}, CHECKPOINTS[0], {
    action_index: 700, version: 3, block_index_doge: 130,
    snapshot_block: 901, tx_hash: 'ab'.repeat(32), timestamp: 1770000000,
    publisher: 'cd'.repeat(32), publisher_attestations: [],
    sections: CHECKPOINTS.concat([ARCHIVE]), local_section_index: 1,
    chunks: [], checkpoint: null, publisher_election: [], reward_attestations: []
});

describe('ANCHOR v3 folded verdict render', function(){
    it('recognizes v3 and renders its checkpoint and archive payload legs', function(){
        const $ = render(FOLDED);
        expect($('.anchor-kind').text()).to.equal('Folded checkpoint + archive bundle');
        expect($('#anchor-sections-card').hasClass('d-none')).to.equal(false);
        expect($('#anchor-archive-card').hasClass('d-none')).to.equal(false);
        expect($('.anchor-section-row').length).to.equal(2);
        expect($('.anchor-section-chain').map(function(){ return $(this).text().trim().split(' ')[0]; }).get())
            .to.deep.equal(['BTC', 'DOGE']);
        expect($('#anchor-archive-payload .anchor-batch-seq').text()).to.contain('27');
    });

    it('shows the archive failure separately from the valid checkpoint sections', function(){
        const $ = render(FOLDED);
        expect($('.anchor-checkpoint-verdict .anchor-status-badge').text()).to.equal('valid');
        expect($('.anchor-archive-verdict .anchor-status-badge').text()).to.equal('invalid_archive');
        expect($('.anchor-checkpoint-status-row .anchor-field-label').text()).to.equal('Checkpoint Sections Status');
        expect($('.anchor-archive-status-row .anchor-field-label').text()).to.equal('Archive Status');
        expect($('#anchor-identity .anchor-status-badge').length).to.equal(2);
    });

    it('keeps an archive-free v3 folded bundle on the checkpoint-only layout', function(){
        const withoutArchive = Object.assign({}, FOLDED, { sections: CHECKPOINTS });
        const $ = render(withoutArchive);
        expect($('.anchor-kind').text()).to.equal('Folded checkpoint + archive bundle');
        expect($('#anchor-sections-card').hasClass('d-none')).to.equal(false);
        expect($('#anchor-archive-card').hasClass('d-none')).to.equal(true);
        expect($('#anchor-identity .anchor-status-badge').text()).to.equal('valid');
    });

    it('scopes verdicts from row attributes rather than sibling version bytes', function(){
        const mixedVersions = Object.assign({}, FOLDED, {
            sections: CHECKPOINTS.map(s => Object.assign({}, s)).concat([
                Object.assign({}, ARCHIVE, { version: 2 })
            ])
        });
        const $ = render(mixedVersions);
        expect($('.anchor-section-row').length).to.equal(2);
        expect($('.anchor-checkpoint-verdict .anchor-status-badge').text()).to.equal('valid');
        expect($('.anchor-archive-verdict .anchor-status-badge').text()).to.equal('invalid_archive');
        expect($('#anchor-archive-payload .anchor-batch-seq').text()).to.contain('27');
    });
});

describe('ANCHOR v3 fold activation gate', function(){
    const PRE_FOLD = Object.assign({}, FOLDED, { status: 'invalid: VERSION (unknown)', sections: [] });

    function expectPreFold($){
        expect($('.anchor-kind').text()).to.equal('v3 before fold activation');
        expect($('body').text()).not.to.contain('Folded checkpoint + archive bundle');
    }

    it('[TRAP] a v3 row below its network fold height is not rendered as a folded bundle', function(){
        const $ = render(PRE_FOLD, { regtest: 131 });
        expectPreFold($);
        expect($('#anchor-identity .anchor-note').text()).to.contain('Stored status: invalid: VERSION (unknown).');
    });

    it('a v3 row AT the fold height is recognized (>= is the boundary)', function(){
        expect(render(FOLDED, { regtest: 130 })('.anchor-kind').text()).to.equal('Folded checkpoint + archive bundle');
    });

    it('uses the DOGE-qualified fold height before the bare network fallback', function(){
        const table = {
            testnet: 9999999999,
            'BTC:testnet': 155001,
            'LTC:testnet': 4906040,
            'DOGE:testnet': 67962387
        };
        const at = Object.assign({}, FOLDED, { network: 'testnet', block_index_doge: 67962387 });
        const before = Object.assign({}, PRE_FOLD, { network: 'testnet', block_index_doge: 67962386 });
        expectPreFold(render(before, table));
        expect(render(at, table)('.anchor-kind').text()).to.equal('Folded checkpoint + archive bundle');
    });

    it('keeps the bare network fold height as a compatibility fallback', function(){
        const at = Object.assign({}, FOLDED, { network: 'testnet', block_index_doge: 130 });
        expect(render(at, { testnet: 130 })('.anchor-kind').text()).to.equal('Folded checkpoint + archive bundle');
    });

    it('fails closed on an UNARMED, UNPINNED, unknown-network or undeclared fold gate', function(){
        expectPreFold(render(FOLDED, { regtest: 9999999999 }));
        expectPreFold(render(FOLDED, { regtest: null }));
        expectPreFold(render(FOLDED, { mainnet: 0 }));
        expectPreFold(render(FOLDED, null));
        expectPreFold(render(Object.assign({}, FOLDED, { block_index_doge: null }), { regtest: 0 }));
    });
});
