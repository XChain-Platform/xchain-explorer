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
 **********************************************************************/

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

// batch_action_index is the DOGE action_index of the ATTEST v5/v6 batch that carried
// the response (attestation_responses.sql says so outright), never an action on the
// page's own rail, so attActionLink's '/' + XC.coin pointed at whatever unrelated
// action happens to hold that index here. siblingCoin resolves a declared base ticker
// to this deployment's coin id at the PAGE's network tier, the rule the PRICE token
// link and actionRefToRawPath already use; the tier regex is not restated here so the
// two cannot drift apart.
function attBatchActionLink(i){
    if(isNull(i)) return '<span class="text-muted">-</span>';
    return formatLink('/' + siblingCoin('DOGE') + '/action/' + i, numeral(i).format('0,0'));
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
                ? (isNull(d.expiry.expire_action_index)
                    ? 'recorded as expired'
                    : 'action ' + d.expiry.expire_action_index)
                : 'not recorded as expired'
        },
        {
            key: 'callback', label: 'Callback', reached: cb,
            // A stamped link and a derived one are both real callbacks, but only the
            // first was written by the indexer; the note says which, because an
            // expired round's link is matched on the execution's own columns.
            note: cb
                ? 'executed by action ' + d.callback_execute_action_index
                    + (d.callback_execute_derived ? ' (matched by request id)' : '')
                : 'no callback execution recorded'
        }
    ];
}

// The ATTEST v5/v6 batch that carried this response's body on chain
// (attests.batch_action_index). THREE states, and collapsing the last two into
// one dash would tell a reader something untrue:
//   - set: link the batch action ON THE DOGE RAIL at this network's tier, since
//     that is the chain the batch was published to.
//   - NULL on a response that has no transaction of its own (tx_index NULL, so
//     it was applied from the hub mirror): the body has NOT reached the chain
//     yet. The batch is published on a window boundary, so this is the normal
//     reading for a freshly applied response and it is expected to change.
//   - NULL on a response that WAS its own on-chain transaction (legacy era):
//     there is no batch to wait for and there never will be.
function attResponseBatchCell(r){
    if(!isNull(r.batch_action_index))
        return attBatchActionLink(r.batch_action_index);
    if(isNull(r.tx_index))
        return '<span class="text-muted attestation-batch-pending">'
             + 'not yet carried by an on-chain batch</span>';
    return '<span class="text-muted attestation-batch-na">'
         + 'not applicable: this response was its own on-chain transaction</span>';
}

function attLegStatusBadge(status){
    if(isNull(status)) return '<span class="text-muted">-</span>';
    let tone = (String(status) === 'valid') ? 'success' : 'danger';
    return '<span class="badge text-bg-' + tone + '">' + attEsc(status) + '</span>';
}
