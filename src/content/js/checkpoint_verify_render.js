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
 * Renders the /checkpoint/{h}/verify verdict for checkpoint.html. Split out of
 * that page's inline script so a test can drive the real render path with a
 * stubbed verify response instead of asserting on page source text.
 */

// Builds the #checkpoint-verdict inner HTML from a verify-endpoint payload.
// esc/dash/fieldRow are redefined locally rather than shared, matching the
// per-function local-esc pattern already used by xchain.js (e.g. showBetDetails).
function renderCheckpointVerdict(v){
    let esc = function(s){ return $('<div>').text(s == null ? '' : String(s)).html(); };
    let dash = function(val){ return isNull(val) ? '-' : esc(val); };
    let fieldRow = function(label, value){
        return '<tr><th class="text-muted fw-normal" style="width:12rem;">' + esc(label) + '</th><td>' + value + '</td></tr>';
    };

    let html = '';
    if(v.verified){
        html += '<div class="alert alert-success py-2 mb-2">Verified: a qualifying quorum signed this checkpoint.</div>';
    } else {
        // Why it failed is the useful part. A young or unstaked chain fails for a
        // structural reason, not because someone forged a signature, and the three
        // causes below are told apart so the page does not read as an alarm.
        let why = 'The signatures present do not meet the quorum.';
        if(v.commitment_missing)
            why = 'This checkpoint is past the commitment flag day but is missing a root or version field, so it cannot be verified against the current preimage.';
        else if(!v.validators || v.validators.length === 0)
            why = 'No validator set qualified for oracle_publish at the snapshot block, so there is nothing to verify against on this chain yet.';
        html += '<div class="alert alert-warning py-2 mb-2">Not verified. ' + esc(why) + '</div>';
    }
    html += '<table class="table table-sm table-borderless mb-2"><tbody>';
    html += fieldRow('Valid Signatures', dash(v.valid_sigs));
    // The count quorum is NOT the operative threshold once stake weighting is
    // active, so showing it there invites the reader to compare it against the
    // signature count and conclude the verdict is wrong. Past the flag day a
    // single large-stake signer can clear the predicate on its own, which is
    // exactly what a regtest chain with one funded validator looks like.
    if(v.is_weighted){
        html += fieldRow('Rule', 'Stake-weighted: the VALID signers\' distinct stake sources must clear the source-deduped threshold, so the signature count alone does not decide this');
    } else {
        html += fieldRow('Rule',            'Signature count');
        html += fieldRow('Quorum Required', dash(v.quorum));
    }
    html += fieldRow('Qualifying Set',   (v.validators ? v.validators.length : 0) + ' validator(s)');
    html += '</tbody></table>';
    if(v.validators && v.validators.length){
        html += '<div class="small text-muted mb-1">Qualifying validators at the snapshot block:</div>';
        html += '<ul class="list-unstyled mb-2 small font-monospace">';
        v.validators.forEach(function(x){
            // A null weight means a corrupt mirror row, and the server deliberately
            // carries the absence through rather than resolving it to zero, so it is
            // shown as unknown here rather than as a number.
            let w = isNull(x.weight) ? '<span class="badge text-bg-danger">weight unknown</span>' : esc(x.weight);
            html += '<li>' + esc(x.pubkey) + ' <span class="text-muted">' + w + '</span></li>';
        });
        html += '</ul>';
    }
    // The canonical string is what a client re-signs to check this independently
    // rather than trusting the verdict above.
    if(!isNull(v.canonical))
        html += '<div class="small text-muted">Canonical signing string</div><pre class="mb-0 small">' + esc(v.canonical) + '</pre>';
    return html;
}
