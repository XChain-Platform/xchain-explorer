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
 * Checkpoint verify verdict render leg. Drives the SHIPPED renderCheckpointVerdict
 * (src/content/js/checkpoint_verify_render.js) with a stubbed verify-endpoint
 * response, in the same JSDOM-eval harness the other content-client-*-detail
 * tests use for action.html panels.
 *
 * What it protects: this below-quorum warning branch is structurally
 * unreachable on the single-hub regtest venue (the hub refuses to finalize
 * below quorum), so nothing else in the suite exercises it. It guards the
 * three checkpoint.html:141-152 outcomes: below-quorum warning, the
 * commitment_missing variant, and the verified=true success path, so an
 * inverted or short-circuited verified branch fails here.
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
const RENDER_SRC = fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/checkpoint_verify_render.js'), 'utf8');

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

// Drives the shipped renderCheckpointVerdict against a stubbed verify payload
// and returns the DOM produced, exactly as checkpoint.html's click handler
// hands it to $('#checkpoint-verdict').html(...).
function renderVerdict(v) {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(extractFn(XCHAIN_SRC, 'isNull'));
    dom.window.eval(extractFn(RENDER_SRC, 'renderCheckpointValidSigners'));
    dom.window.eval(extractFn(RENDER_SRC, 'renderCheckpointVerdict'));
    const html = dom.window.renderCheckpointVerdict(v);
    dom.window.$('body').html('<div id="checkpoint-verdict">' + html + '</div>');
    return dom.window.$;
}

function renderSigners(raw) {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '..', '..', '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(extractFn(XCHAIN_SRC, 'isNull'));
    dom.window.eval(extractFn(RENDER_SRC, 'renderCheckpointSigners'));
    dom.window.$('body').html('<div id="checkpoint-signers">' + dom.window.renderCheckpointSigners(raw) + '</div>');
    return dom.window.$;
}

// Live-endpoint-shaped payload; individual fields are overridden per case.
const BASE = {
    is_weighted: false, quorum: 3, valid_sigs: 1, verified: false,
    valid_signers: ['a'.repeat(64)],
    commitment_missing: false, snapshot_available: true, signatures_unparseable: false,
    validators: [{ pubkey: 'a'.repeat(64), weight: '5' }],
    canonical: 'canonical-string', checkpoint: { block_index: 500 }
};

describe('checkpoint.html verify verdict: renderCheckpointVerdict @regression', function () {

    it('[below-quorum] warns with the exact quorum why-string, and the success alert is absent', function () {
        const $ = renderVerdict({ ...BASE, verified: false, valid_sigs: 1, quorum: 3, commitment_missing: false });
        const warn = $('#checkpoint-verdict .alert-warning');
        expect(warn.length).to.equal(1);
        expect(warn.text()).to.equal('Not verified. The signatures present do not meet the quorum.');
        expect($('#checkpoint-verdict .alert-success').length).to.equal(0);
    });

    it('[commitment_missing] warns with the missing-root/version why-string', function () {
        const $ = renderVerdict({ ...BASE, verified: false, commitment_missing: true });
        const warn = $('#checkpoint-verdict .alert-warning');
        expect(warn.length).to.equal(1);
        expect(warn.text()).to.equal('Not verified. This checkpoint is past the commitment flag day but is missing a root or version field, so it cannot be verified against the current preimage.');
        expect($('#checkpoint-verdict .alert-success').length).to.equal(0);
    });

    it('[unparseable-signatures] names the malformed field as the failed verification reason', function () {
        const $ = renderVerdict({ ...BASE, signatures_unparseable: true });
        expect($('#checkpoint-verdict .alert-warning').text())
            .to.equal('Not verified. The stored validator_signatures field is not valid JSON, so its signatures could not be checked.');
    });

    it('[control] verified=true renders the success alert, and the warning alert is absent', function () {
        const $ = renderVerdict({ ...BASE, verified: true, valid_sigs: 3, quorum: 3 });
        const ok = $('#checkpoint-verdict .alert-success');
        expect(ok.length).to.equal(1);
        expect(ok.text()).to.equal('Verified: a qualifying quorum signed this checkpoint.');
        expect($('#checkpoint-verdict .alert-warning').length).to.equal(0);
    });

    it('[valid-signers] names each counted signer and escapes its pubkey', function () {
        const $ = renderVerdict({ ...BASE, valid_sigs: 2,
            valid_signers: ['a'.repeat(64), '<img src=x onerror=alert(1)>'] });
        const signers = $('#checkpoint-verdict .checkpoint-valid-signers li');
        expect(signers.length).to.equal(2);
        expect(signers.eq(0).text()).to.equal('a'.repeat(64));
        expect(signers.eq(1).text()).to.equal('<img src=x onerror=alert(1)>');
        expect(signers.eq(1).find('img').length).to.equal(0);
    });

    it('[no-validators] falls back to the no-qualifying-set why-string when validators is empty', function () {
        const $ = renderVerdict({ ...BASE, verified: false, commitment_missing: false, validators: [] });
        expect($('#checkpoint-verdict .alert-warning').text())
            .to.equal('Not verified. No validator set qualified for oracle_publish at the snapshot block, so there is nothing to verify against on this chain yet.');
    });
});

describe('checkpoint.html signer list: renderCheckpointSigners @regression', function () {

    it('renders the parser reason instead of claiming malformed JSON contains no signatures', function () {
        const $ = renderSigners('{bad json');
        expect($('#checkpoint-signers .checkpoint-signers-invalid').text())
            .to.include('Invalid validator_signatures field:');
        expect($('#checkpoint-signers').text()).to.not.include('No signatures attached');
    });

    it('renders the entry number and missing field for each invalid signature item', function () {
        const $ = renderSigners([{ pubkey: 'a'.repeat(64), sig: '1'.repeat(128) }, { sig: '2'.repeat(128) }, { pubkey: 'b'.repeat(64) }]);
        const invalid = $('#checkpoint-signers .checkpoint-signer-invalid');
        expect(invalid.eq(0).text()).to.equal('entry 2: pubkey is missing');
        expect(invalid.eq(1).text()).to.equal('entry 3: sig is missing');
        expect($('#checkpoint-signers').text()).to.include('3 signatures attached');
    });

    it('escapes a stored pubkey before rendering the signer item', function () {
        const pubkey = '<img src=x onerror=alert(1)>';
        const $ = renderSigners([{ pubkey: pubkey, sig: '1'.repeat(128) }]);
        expect($('#checkpoint-signers li').text()).to.equal(pubkey);
        expect($('#checkpoint-signers img').length).to.equal(0);
    });
});
