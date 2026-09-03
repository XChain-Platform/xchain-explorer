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
 * Lifecycle, request, response, expiry, relay and leg renders for
 * attestation.html. Split out of that page's inline script so a test can drive
 * the real render path with stubbed endpoint payloads instead of asserting on
 * page source text.
 *
 * Three rules in here are protocol semantics, not presentation, and they are
 * the reason this file exists as its own module:
 *
 *  1. EXPIRY IS A STORED STATE, NEVER A CLOCK COMPARISON. ATTEST v2 (expire) is
 *     system-synthesized and writes NO ROW of its own: it only flips the v0
 *     request row's request_status to 'expired' and stamps resolved_block. The
 *     server therefore hands down expiry.expired as request_status === 'expired'
 *     and nothing else. A request whose deadline_block has passed but which the
 *     expiry sweep has not reached yet is STILL 'pending'. Comparing
 *     deadline_block against a chain tip here would report that request as
 *     expired, which is the one thing this surface must never say, so
 *     attIsExpired reads the stored flag and deadline_block is displayed as a
 *     fact about the request, never fed into a verdict.
 *
 *  2. THE EXPLORER ASSERTS NO VERDICT ON SIGNATURES. validator_signatures and
 *     responsible_set_json are rendered as opaque material: full pubkeys and
 *     full signatures, monospace, never truncated into something that reads as
 *     a checked value and never counted into a pass/fail against redundancy.
 *     "Attached" is not "valid", and this page only ever claims the former.
 *
 *  3. A NON-RELAY ATTESTATION IS NOT A BROKEN ONE. Most requests are native
 *     single-chain requests with no origin_chain at all, so the absent relay is
 *     rendered as a neutral statement of fact, never as a missing-data warning.
 *     Relay legs (rows carrying origin_chain / origin_action_index) are marked
 *     distinguishably ONLY where the row actually carries them.
 */

// Page-local escape. Payloads, provider metadata and callback params are
// attacker-influenced on-chain bytes, so nothing below reaches the DOM raw.
function attEsc(s){
    return $('<div>').text(s == null ? '' : String(s)).html();
}

function attDash(v){
    return isNull(v) ? '<span class="text-muted">-</span>' : attEsc(v);
}

// Opaque hex/base64 material: shown in full. Truncating a signature or a root
// invites the reader to compare two values that were never shown whole.
function attHex(v){
    if(isNull(v)) return '<span class="text-muted">-</span>';
    return '<span class="font-monospace small text-break">' + attEsc(v) + '</span>';
}

function attFieldRow(label, value){
    return '<tr><th class="text-muted fw-normal text-nowrap">' + attEsc(label) + '</th>'
         + '<td>' + value + '</td></tr>';
}

function attBlockLink(b){
    if(isNull(b)) return '<span class="text-muted">-</span>';
    return formatLink('/' + XC.coin + '/block/' + b, numeral(b).format('0,0'));
}

function attActionLink(i){
    if(isNull(i)) return '<span class="text-muted">-</span>';
    return formatLink('/' + XC.coin + '/action/' + i, numeral(i).format('0,0'));
}

// The recorded request_status, or 'unknown' when no v0 row reached the client.
// An unknown state is never coerced into a lifecycle verdict.
function attStatusName(d){
    let s = (d && d.expiry && !isNull(d.expiry.request_status)) ? String(d.expiry.request_status) : null;
    return s === null ? 'unknown' : s;
}

// THE stored terminal state, and the only expiry test on this page. See rule 1.
function attIsExpired(d){
    return !!(d && d.expiry && d.expiry.expired === true);
}

function attStatusBadge(d){
    let s = attStatusName(d);
    let tone = 'secondary';
    if(s === 'pending')                          tone = 'warning text-dark';
    else if(s === 'fulfilled')                   tone = 'success';
    else if(s === 'errored' || s === 'rejected') tone = 'danger';
    return '<span class="badge text-bg-' + tone + ' attestation-status" data-status="' + attEsc(s) + '">'
         + attEsc(s) + '</span>';
}

// Every v1 row in the round. The (request_id, version) index is deliberately
// NON-UNIQUE: a retry-then-ok lifecycle produces several v1 rows, each its own
// on-chain action, so the response leg is a LIST and is shown as one.
function attResponseRounds(d){
    let legs = (d && Array.isArray(d.legs)) ? d.legs : [];
    return legs.filter(function(r){ return Number(r.version) === 1; });
}

// Lifecycle ladder. `reached` is derived only from what the server recorded:
// a row's presence for v0/v1 and the callback, and the STORED flag for v2.
function attestationStages(d){
    let req = !!(d && d.request);
    let res = !!(d && d.response);
    let exp = attIsExpired(d);
    let cb  = !!(d && !isNull(d.callback_execute_action_index));
    return [
        {
            key: 'request', label: 'Request (v0)', reached: req,
            note: req ? 'action ' + d.request.action_index : 'no request row in this round'
        },
        {
            key: 'response', label: 'Response (v1)', reached: res,
            note: res
                ? 'action ' + d.response.action_index
                    + (isNull(d.response.response_status) ? '' : ', ' + d.response.response_status)
                : 'no response recorded'
        },
        {
            key: 'expiry', label: 'Expiry (v2)', reached: exp,
            note: exp
                ? 'recorded as expired'
                : 'not recorded as expired'
        },
        {
            key: 'callback', label: 'Callback', reached: cb,
            note: cb ? 'executed by action ' + d.callback_execute_action_index : 'no callback execution recorded'
        }
    ];
}

function renderAttestationLifecycle(d){
    let html = '<div class="d-flex flex-wrap gap-2 attestation-lifecycle">';
    attestationStages(d).forEach(function(s){
        let cls = s.reached ? 'attestation-stage-reached border-success' : 'attestation-stage-unreached border-secondary-subtle';
        let icon = s.reached ? 'fa-circle-check text-success' : 'fa-circle text-muted';
        html += '<div class="border rounded p-2 attestation-stage ' + cls + '" data-stage="' + attEsc(s.key) + '"'
             + ' data-reached="' + (s.reached ? 'true' : 'false') + '">'
             + '<i class="fa ' + icon + ' me-1"></i>'
             + '<span class="fw-bold attestation-stage-label">' + attEsc(s.label) + '</span>'
             + '<div class="small text-muted attestation-stage-note">' + attEsc(s.note) + '</div>'
             + '</div>';
    });
    html += '</div>';
    return html;
}

// The v0 request: what was asked, of whom, on what terms.
function renderAttestationRequest(d){
    let r = (d) ? d.request : null;
    if(!r)
        return '<span class="text-muted attestation-no-request">No request (version 0) row was recorded for this attestation.</span>';

    let html = '<table class="table table-sm table-borderless mb-0"><tbody>';
    html += attFieldRow('Request Action', attActionLink(r.action_index)
        + (isNull(r.action_format) ? '' : ' <span class="badge text-bg-secondary">format ' + attEsc(r.action_format) + '</span>'));
    html += attFieldRow('Provider',       attDash(r.provider_id));
    html += attFieldRow('Contract',       isNull(r.contract_index) ? '<span class="text-muted">-</span>'
        : formatLink('/' + XC.coin + '/contract/' + r.contract_index, r.contract_index));
    html += attFieldRow('Requested By',   isNull(r.source) ? '<span class="text-muted">-</span>'
        : formatLink('/' + XC.coin + '/address/' + r.source, r.source));
    html += attFieldRow('Fee Payer',      isNull(r.fee_payer) ? '<span class="text-muted">-</span>'
        : formatLink('/' + XC.coin + '/address/' + r.fee_payer, r.fee_payer));
    // redundancy is the number of validator signatures the protocol REQUIRED,
    // not a count of what arrived, so it is labelled as the requirement and is
    // never compared against the attached signatures below.
    html += attFieldRow('Redundancy Required', isNull(r.redundancy) ? '<span class="text-muted">-</span>'
        : attEsc(r.redundancy) + ' <span class="small text-muted">validator signature(s) required by the request</span>');
    html += attFieldRow('Fee',            isNull(r.fee_amount) ? '<span class="text-muted">feeless</span>'
        : attEsc(r.fee_amount) + (isNull(r.fee_tick) ? '' : ' ' + formatLink('/' + XC.coin + '/token/' + r.fee_tick, r.fee_tick)));
    html += attFieldRow('Gas Escrow',     attDash(r.gas_escrow));
    html += attFieldRow('Deadline Block', attBlockLink(r.deadline_block));
    html += attFieldRow('Requested In',   attBlockLink(r.block_index)
        + (isNull(r.timestamp) ? '' : ' <span class="small text-muted">' + formatLivestamp(r.timestamp) + '</span>'));
    html += attFieldRow('Transaction',    isNull(r.tx_hash) ? '<span class="text-muted">-</span>'
        : formatLink('/' + XC.coin + '/transaction/' + r.tx_hash, r.tx_hash));
    html += attFieldRow('Action Status',  attLegStatusBadge(r.status));
    html += '</tbody></table>';

    // Payload is provider-defined free text (a URL for http_get, a JSON
    // envelope for llm). Inert data, shown as data.
    html += '<div class="small text-muted mt-2">Request payload (inert data)</div>';
    html += '<pre class="small mb-2 text-break attestation-request-payload">' + attEsc(isNull(r.payload) ? '-' : r.payload) + '</pre>';

    if(isNull(r.callback_method)){
        html += '<div class="small text-muted attestation-callback-none">No callback method was named on this request.</div>';
    } else {
        html += '<div class="small attestation-callback"><span class="text-muted">Callback:</span> '
             + attEsc(r.callback_method) + '()';
        if(r.callback_params != null)
            html += ' <span class="text-muted">params (inert data):</span> ' + attEsc(JSON.stringify(r.callback_params));
        html += '</div>';
    }

    html += renderAttestationResponsibleSet(r);
    return html;
}

// The responsible set was PINNED as-of the request block: it is the electorate a
// reader would check the response signatures against. Membership is shown; no
// claim is made about who did or did not sign.
function renderAttestationResponsibleSet(r){
    let set = (r && Array.isArray(r.responsible_set)) ? r.responsible_set : [];
    if(!set.length)
        return '<div class="small text-muted mt-2 attestation-responsible-set-empty">'
             + 'No responsible set was pinned on this request.</div>';
    let html = '<div class="small text-muted mt-2">Responsible set pinned at the request block ('
             + set.length + ' member' + (set.length === 1 ? '' : 's') + ')</div>';
    html += '<ul class="list-unstyled mb-0 small font-monospace attestation-responsible-set">';
    set.forEach(function(m){
        let key = (m && typeof m === 'object' && !isNull(m.pubkey)) ? m.pubkey : String(m);
        html += '<li class="text-break attestation-responsible-member">' + attEsc(key) + '</li>';
    });
    html += '</ul>';
    return html;
}

// The ATTEST v5/v6 batch that carried this response's body on chain
// (attests.batch_action_index). THREE states, and collapsing the last two into
// one dash would tell a reader something untrue:
//   - set: link the batch action.
//   - NULL on a response that has no transaction of its own (tx_index NULL, so
//     it was applied from the hub mirror): the body has NOT reached the chain
//     yet. The batch is published on a window boundary, so this is the normal
//     reading for a freshly applied response and it is expected to change.
//   - NULL on a response that WAS its own on-chain transaction (legacy era):
//     there is no batch to wait for and there never will be.
function attResponseBatchCell(r){
    if(!isNull(r.batch_action_index))
        return attActionLink(r.batch_action_index);
    if(isNull(r.tx_index))
        return '<span class="text-muted attestation-batch-pending">'
             + 'not yet carried by an on-chain batch</span>';
    return '<span class="text-muted attestation-batch-na">'
         + 'not applicable: this response was its own on-chain transaction</span>';
}

// The v1 response: the provider's answer plus the federation signatures that
// carried it on chain.
function renderAttestationResponse(d){
    let r = (d) ? d.response : null;
    if(!r)
        return '<span class="text-muted attestation-no-response">'
             + 'No response (version 1) row was recorded for this attestation.</span>';

    let html = '<table class="table table-sm table-borderless mb-0"><tbody>';
    html += attFieldRow('Response Action', attActionLink(r.action_index)
        + (isNull(r.action_format) ? '' : ' <span class="badge text-bg-secondary">format ' + attEsc(r.action_format) + '</span>'));
    html += attFieldRow('Response Status', isNull(r.response_status) ? '<span class="text-muted">-</span>'
        : '<span class="badge text-bg-' + (String(r.response_status) === 'ok' ? 'success' : 'secondary')
          + ' attestation-response-status" data-response-status="' + attEsc(r.response_status) + '">'
          + attEsc(r.response_status) + '</span>');
    html += attFieldRow('Response Hash',   attHex(r.response_hash));
    html += attFieldRow('Provider Meta',   attDash(r.meta));
    html += attFieldRow('Responded In',    attBlockLink(r.block_index)
        + (isNull(r.timestamp) ? '' : ' <span class="small text-muted">' + formatLivestamp(r.timestamp) + '</span>'));
    html += attFieldRow('Transaction',     isNull(r.tx_hash) ? '<span class="text-muted">-</span>'
        : formatLink('/' + XC.coin + '/transaction/' + r.tx_hash, r.tx_hash));
    html += attFieldRow('On-chain Batch',  attResponseBatchCell(r));
    html += attFieldRow('Callback Execute', isNull(d.callback_execute_action_index)
        ? '<span class="text-muted">no callback execution recorded</span>'
        : attActionLink(d.callback_execute_action_index));
    html += attFieldRow('Action Status',   attLegStatusBadge(r.status));
    html += '</tbody></table>';

    html += '<div class="small text-muted mt-2">Response payload (inert data)</div>';
    html += '<pre class="small mb-2 text-break attestation-response-payload">'
         + attEsc(isNull(r.response_payload) ? '-' : r.response_payload) + '</pre>';

    // Several v1 rows are legitimate: each retry round (no_quorum / timeout /
    // provider_error, then the terminal ok) is its own action. The panel above
    // shows the round the server named as `response`; the rest are listed here
    // rather than left invisible, which would read as a single-round history.
    let rounds = attResponseRounds(d);
    if(rounds.length > 1){
        html += '<div class="small text-muted mt-2 attestation-response-rounds-note">'
             + rounds.length + ' response rounds were recorded for this request.</div>';
        html += '<ul class="list-unstyled mb-2 small attestation-response-rounds">';
        rounds.forEach(function(x){
            html += '<li class="attestation-response-round" data-action-index="' + attEsc(x.action_index) + '">'
                 + attActionLink(x.action_index)
                 + ' <span class="badge text-bg-secondary">' + attEsc(isNull(x.response_status) ? 'no status' : x.response_status) + '</span>'
                 + '</li>';
        });
        html += '</ul>';
    }

    html += renderAttestationSignatures(r);
    return html;
}

// Quorum signatures, rendered as opaque material. See rule 2: attached is not
// verified, and this page never says otherwise.
function renderAttestationSignatures(r){
    let sigs = (r && Array.isArray(r.quorum_signatures)) ? r.quorum_signatures : [];
    if(!sigs.length)
        return '<div class="small text-muted attestation-signatures-empty">'
             + 'No validator signatures are attached to this response.</div>';
    let html = '<div class="small text-muted mt-2 attestation-signatures-note">'
             + sigs.length + ' validator signature' + (sigs.length === 1 ? '' : 's')
             + ' attached. Attached is not the same as verified; the explorer records what is on chain and checks nothing here.</div>';
    html += '<ul class="list-unstyled mb-0 small attestation-signatures">';
    sigs.forEach(function(s){
        let pubkey = (s && typeof s === 'object') ? s.pubkey : String(s);
        let sig    = (s && typeof s === 'object') ? s.sig    : null;
        html += '<li class="mb-1 attestation-signature">'
             + '<div class="attestation-signature-pubkey">' + attHex(pubkey) + '</div>'
             + (isNull(sig) ? '' : '<div class="attestation-signature-sig">' + attHex(sig) + '</div>')
             + '</li>';
    });
    html += '</ul>';
    return html;
}

// Expiry (ATTEST v2). Rule 1 lives here: the verdict comes from the stored flag,
// and deadline_block is reported beside it as a fact, never compared into it.
function renderAttestationExpiry(d){
    let e = (d && d.expiry) ? d.expiry : {};
    let status = attStatusName(d);
    let html = '';

    if(attIsExpired(d)){
        html += '<div class="alert alert-secondary py-2 mb-2 attestation-expired" data-expired="true">'
             + '<span class="fw-bold">Expired.</span> The expiry sweep recorded this request as expired'
             + (isNull(e.resolved_block) ? '' : ' at block ' + attEsc(e.resolved_block))
             + '. ATTEST v2 writes no action row of its own, so there is no expiry action to link to: it flips this stored status.'
             + '</div>';
    } else if(status === 'pending'){
        html += '<div class="alert alert-warning py-2 mb-2 attestation-not-expired" data-expired="false">'
             + '<span class="fw-bold">Pending.</span> This request has not been recorded as expired.'
             + ' Passing the deadline block does not expire a request by itself: the stored status only changes when the'
             + ' expiry sweep reaches it, and until then the request is still pending.'
             + '</div>';
    } else {
        html += '<div class="alert alert-light py-2 mb-2 attestation-not-expired" data-expired="false">'
             + 'Not expired. The recorded request status is <span class="fw-bold">' + attEsc(status) + '</span>.'
             + '</div>';
    }

    html += '<table class="table table-sm table-borderless mb-0"><tbody>';
    html += attFieldRow('Recorded Status', attStatusBadge(d));
    html += attFieldRow('Deadline Block',  isNull(e.deadline_block)
        ? '<span class="text-muted">none recorded</span>'
        : '<span class="attestation-deadline-block">' + attBlockLink(e.deadline_block) + '</span>');
    html += attFieldRow('Resolved Block',  isNull(e.resolved_block)
        ? '<span class="text-muted">not resolved</span>'
        : '<span class="attestation-resolved-block">' + attBlockLink(e.resolved_block) + '</span>');
    html += '</tbody></table>';
    return html;
}

// Cross-chain relay (ATTEST v3/v4). See rule 3: no origin_chain is the ordinary
// case and reads as a plain statement, not a warning.
function renderAttestationRelay(d){
    let rel = (d && d.relay) ? d.relay : {};
    if(!rel.is_relay){
        return '<div class="text-muted attestation-relay-native" data-relay="false">'
             + 'Native request. This attestation was requested and answered on this chain, with no cross-chain relay leg.'
             + '</div>';
    }
    let html = '<div class="attestation-relay-origin" data-relay="true">';
    html += '<table class="table table-sm table-borderless mb-0"><tbody>';
    html += attFieldRow('Origin Chain', isNull(rel.origin_chain)
        ? '<span class="text-muted">-</span>'
        : '<span class="badge text-bg-info attestation-relay-chain">' + attEsc(rel.origin_chain) + '</span>');
    // The origin action lives on ANOTHER chain's indexer, so it is named rather
    // than linked: a link built from this coin's path would resolve to an
    // unrelated action index on this chain.
    html += attFieldRow('Origin Action', isNull(rel.origin_action_index)
        ? '<span class="text-muted">-</span>'
        : '<span class="font-monospace attestation-relay-origin-action">' + attEsc(rel.origin_action_index) + '</span>'
          + ' <span class="small text-muted">on ' + attEsc(isNull(rel.origin_chain) ? 'the origin chain' : rel.origin_chain) + '</span>');
    html += attFieldRow('Response Relayed', rel.response_relayed
        ? '<span class="badge text-bg-success attestation-relay-response">relayed back to the origin chain</span>'
        : '<span class="text-muted attestation-relay-response-pending">no relayed response leg recorded yet</span>');
    html += '</tbody></table>';
    html += '</div>';
    return html;
}

function attLegStatusBadge(status){
    if(isNull(status)) return '<span class="text-muted">-</span>';
    let tone = (String(status) === 'valid') ? 'success' : 'danger';
    return '<span class="badge text-bg-' + tone + '">' + attEsc(status) + '</span>';
}

// Every raw attests row in the round, oldest first, exactly as the server
// ordered them. A row carrying origin_chain or origin_action_index IS a relay
// leg and is marked as one; a row carrying neither is not.
function renderAttestationLegs(d){
    let legs = (d && Array.isArray(d.legs)) ? d.legs : [];
    if(!legs.length)
        return '<span class="text-muted attestation-no-legs">No legs were recorded for this attestation.</span>';

    let html = '<table class="table table-sm table-striped table-hover mb-0 align-middle attestation-legs-table">'
             + '<thead><tr>'
             + '<th>Action</th><th>Leg</th><th>Block</th><th>Time</th><th>Source</th>'
             + '<th>Recorded State</th><th>Status</th><th>Relay</th>'
             + '</tr></thead><tbody>';

    legs.forEach(function(leg){
        let v = Number(leg.version);
        let legName = (v === 0) ? 'Request (v0)' : ((v === 1) ? 'Response (v1)' : ('version ' + leg.version));
        let isRelayLeg = !isNull(leg.origin_chain) || !isNull(leg.origin_action_index);
        let state = (v === 0) ? leg.request_status : leg.response_status;

        html += '<tr class="attestation-leg' + (isRelayLeg ? ' attestation-leg-relay' : '') + '"'
             + ' data-version="' + attEsc(leg.version) + '"'
             + ' data-relay-leg="' + (isRelayLeg ? 'true' : 'false') + '">';
        html += '<td>' + attActionLink(leg.action_index) + '</td>';
        html += '<td>' + attEsc(legName)
             + (isNull(leg.action_format) ? '' : ' <span class="small text-muted">format ' + attEsc(leg.action_format) + '</span>')
             + '</td>';
        html += '<td>' + attBlockLink(leg.block_index) + '</td>';
        html += '<td>' + (isNull(leg.timestamp) ? '<span class="text-muted">-</span>' : formatLivestamp(leg.timestamp)) + '</td>';
        html += '<td>' + (isNull(leg.source) ? '<span class="text-muted">-</span>'
             : formatLink('/' + XC.coin + '/address/' + leg.source, leg.source)) + '</td>';
        html += '<td>' + attDash(state) + '</td>';
        html += '<td>' + attLegStatusBadge(leg.status) + '</td>';
        if(isRelayLeg){
            html += '<td><span class="badge text-bg-info attestation-leg-relay-badge">relay'
                 + (isNull(leg.origin_chain) ? '' : ' from ' + attEsc(leg.origin_chain))
                 + '</span>'
                 + (isNull(leg.origin_action_index) ? ''
                    : ' <span class="small font-monospace attestation-leg-origin-action">' + attEsc(leg.origin_action_index) + '</span>')
                 + '</td>';
        } else {
            html += '<td><span class="text-muted small attestation-leg-native">native</span></td>';
        }
        html += '</tr>';
    });

    html += '</tbody></table>';
    return html;
}
