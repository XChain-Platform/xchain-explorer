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
 * (src/content/js/checkpoint-verify-render.js) with a stubbed verify-endpoint
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
const RENDER_SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/checkpoint-verify-render.js'), 'utf8');

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
    dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));
    dom.window.eval(extractFn(XCHAIN_SRC, 'isNull'));
    dom.window.eval(extractFn(RENDER_SRC, 'renderCheckpointVerdict'));
    const html = dom.window.renderCheckpointVerdict(v);
    dom.window.$('body').html('<div id="checkpoint-verdict">' + html + '</div>');
    return dom.window.$;
}

// Live-endpoint-shaped payload; individual fields are overridden per case.
const BASE = {
    is_weighted: false, quorum: 3, valid_sigs: 1, verified: false,
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

    it('[control] verified=true renders the success alert, and the warning alert is absent', function () {
        const $ = renderVerdict({ ...BASE, verified: true, valid_sigs: 3, quorum: 3 });
        const ok = $('#checkpoint-verdict .alert-success');
        expect(ok.length).to.equal(1);
        expect(ok.text()).to.equal('Verified: a qualifying quorum signed this checkpoint.');
        expect($('#checkpoint-verdict .alert-warning').length).to.equal(0);
    });

    it('[no-validators] falls back to the no-qualifying-set why-string when validators is empty', function () {
        const $ = renderVerdict({ ...BASE, verified: false, commitment_missing: false, validators: [] });
        expect($('#checkpoint-verdict .alert-warning').text())
            .to.equal('Not verified. No validator set qualified for oracle_publish at the snapshot block, so there is nothing to verify against on this chain yet.');
    });
});
