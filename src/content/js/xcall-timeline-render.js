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
 * Timeline derivation and render for xcall.html (/{COIN}/xcall/{CALL_ID}).
 *
 * Split out of the page's inline script so a test can drive the real
 * derivation with stubbed /api/xcall responses, the same way
 * checkpoint-verify-render.js is driven by checkpoint-verify-render.test.js.
 *
 * WHY A DERIVATION LAYER AT ALL. An XCALL's phase transitions are written
 * WITHOUT an action row of their own, so no generic action feed carries them:
 * the whole lifecycle has to be inferred from the one composed row the
 * /api/xcall/{id} route returns (the xcalls request row plus the nested
 * `execution` and `callback_delivery` sub-objects, both null until they
 * happen). A phase that has not happened is therefore INDISTINGUISHABLE from
 * a phase that never will, unless the request's own terminal status is read
 * alongside it - which is what buildXcallTimeline does, and why a call that
 * expired renders its far-chain execution as skipped rather than as forever
 * pending or as a blank.
 */

// Lifecycle order. The array is the single source of truth for the ORDER the
// phases render in, so a reader always sees request -> execution -> callback ->
// settlement -> deadline regardless of which of them carry data.
var XCALL_PHASE_ORDER = ['request', 'execution', 'callback', 'settlement', 'deadline'];

// Per-state badge chrome. Colour comes from Bootstrap's own contextual classes
// (which follow data-bs-theme) rather than any literal, so the theme layer owns it.
var XCALL_PHASE_STATES = {
    done:    { badge: 'text-bg-success',          text: 'complete',  icon: 'fa-circle-check'         },
    failed:  { badge: 'text-bg-danger',           text: 'failed',    icon: 'fa-circle-xmark'         },
    expired: { badge: 'text-bg-danger',           text: 'expired',   icon: 'fa-hourglass-end'        },
    late:    { badge: 'text-bg-warning text-dark',text: 'late',      icon: 'fa-triangle-exclamation' },
    missing: { badge: 'text-bg-warning text-dark',text: 'no record', icon: 'fa-circle-question'      },
    pending: { badge: 'text-bg-secondary',        text: 'pending',   icon: 'fa-circle-notch'         },
    skipped: { badge: 'text-bg-secondary',        text: 'skipped',   icon: 'fa-circle-minus'         },
    none:    { badge: 'text-bg-light text-dark',  text: 'not used',  icon: 'fa-circle-minus'         }
};

// A delivered result code that means the leg succeeded. Everything else that is
// present is a real outcome the reader must be able to tell apart from success,
// so this deliberately whitelists rather than blacklisting 'error'/'reverted'.
function xcallStatusIsOk(status){
    if(status === null || status === undefined) return false;
    var v = String(status).trim().toLowerCase();
    return (v === 'ok' || v === 'success' || v === 'completed');
}

// index_statuses.status for the request action itself. A non-valid status means
// consensus refused the request, so no later phase ever runs. An absent status is
// NOT treated as a refusal (older mirror rows can carry null).
function xcallRequestRefused(d){
    if(d.status === null || d.status === undefined || d.status === '') return false;
    return String(d.status).trim().toLowerCase() !== 'valid';
}

function xcallRequestStatusIs(d, want){
    return String(d.request_status === null || d.request_status === undefined ? '' : d.request_status)
        .trim().toLowerCase() === want;
}

// Builds the ordered phase list from one composed /api/xcall row. Pure: no DOM,
// no jQuery, so the derivation can be asserted on directly.
function buildXcallTimeline(data){
    var d         = data || {};
    var refused   = xcallRequestRefused(d);
    var expired   = xcallRequestStatusIs(d, 'expired');
    var completed = xcallRequestStatusIs(d, 'completed');
    var exec      = d.execution || null;
    var cb        = d.callback_delivery || null;
    var cbStatus  = cb ? String(cb.callback_result_status === null || cb.callback_result_status === undefined ? '' : cb.callback_result_status).trim().toLowerCase() : '';
    var phases    = {};

    // 1. The request itself. The row existing is the proof it was submitted; the
    //    action's own consensus status decides whether it started a lifecycle.
    phases.request = {
        key:   'request',
        label: 'Request',
        state: refused ? 'failed' : 'done',
        block: d.block_index,
        note:  refused
            ? 'Consensus refused this request, so no later phase ran.'
            : 'A contract on this chain emitted a cross-chain call.'
    };

    // 2. Target-chain execution, mirrored back from the target chain. Absent is
    //    three different things: refused/expired means it never runs, completed
    //    means the result arrived without its mirrored execution row, and
    //    otherwise it is simply still in flight.
    var execState;
    if(refused)        execState = 'skipped';
    else if(exec)      execState = xcallStatusIsOk(exec.result_status) ? 'done' : 'failed';
    else if(expired)   execState = 'skipped';
    else if(completed) execState = 'missing';
    else               execState = 'pending';
    phases.execution = {
        key:   'execution',
        label: 'Target Execution',
        state: execState,
        block: exec ? exec.execution_block_index : null,
        note:  (execState === 'skipped' && expired)
            ? 'The call expired before the target chain reported an execution.'
            : (execState === 'missing')
                ? 'The result was delivered, but no mirrored execution row is recorded for it.'
                : (execState === 'pending')
                    ? 'Waiting on ' + (d.target_chain ? String(d.target_chain) : 'the target chain') + ' to execute and report back.'
                    : ''
    };

    // 3. Callback delivery, back on this chain. A call with no callback_method
    //    asked for none, which is a legitimate terminal shape rather than a gap.
    //    The expiry path synthesizes a callback carrying status 'expired': that is
    //    a delivered expiry notice, not a delivery failure, so it gets its own
    //    state. A 'skipped:<status>' status is the exactly-once interlock's loser.
    var noCallback = (d.callback_method === null || d.callback_method === undefined || d.callback_method === '');
    var cbState;
    if(refused)                          cbState = 'skipped';
    else if(cb && cbStatus.indexOf('skipped:') === 0) cbState = 'skipped';
    else if(cb && cbStatus === 'expired') cbState = 'expired';
    else if(cb)                          cbState = xcallStatusIsOk(cbStatus) ? 'done' : 'failed';
    else if(noCallback)                  cbState = 'none';
    else if(expired || completed)        cbState = 'missing';
    else                                 cbState = 'pending';
    phases.callback = {
        key:   'callback',
        label: 'Callback Delivery',
        state: cbState,
        block: cb ? cb.callback_block_index : null,
        note:  (cbState === 'none')
            ? 'This call requested no callback, so nothing is delivered back.'
            : (cbState === 'skipped' && cb)
                ? 'The other terminal path won the exactly-once interlock, so this delivery was recorded as skipped.'
                : (cbState === 'missing')
                    ? 'The request is terminal but no callback delivery is recorded.'
                    : (cbState === 'pending')
                        ? 'Nothing delivered back to the source contract yet.'
                        : ''
    };

    // 4. Settlement: the outcome AS RECORDED ON THIS CHAIN (xcalls.result_status /
    //    result_payload / resolved_block). This is what the VM's getCallResult
    //    reads, so it is the value a contract here actually sees, and it can
    //    disagree with the mirrored execution above.
    var setState;
    if(refused)        setState = 'skipped';
    else if(expired)   setState = 'expired';
    else if(completed) setState = xcallStatusIsOk(d.result_status) ? 'done' : 'failed';
    else               setState = 'pending';
    phases.settlement = {
        key:   'settlement',
        label: 'Settlement',
        state: setState,
        block: d.resolved_block,
        note:  (setState === 'expired')
            ? 'Settled as expired: the contract was told the call did not complete.'
            : (setState === 'pending')
                ? 'The request is still open; no result has been recorded on this chain.'
                : ''
    };

    // 5. Deadline. The healthy completed call resolves at or before its deadline
    //    block. Resolving AFTER it means the expiry sweep and the result delivery
    //    raced and the delivery won, which is worth showing rather than flattening
    //    into a plain success.
    var dlState, dlNote = '';
    if(refused){
        dlState = 'skipped';
    } else if(expired){
        dlState = 'expired';
        dlNote  = 'The deadline passed with no delivered result, so the call was expired.';
    } else if(completed){
        if(d.deadline_block !== null && d.deadline_block !== undefined && d.deadline_block !== '' &&
           d.resolved_block !== null && d.resolved_block !== undefined && d.resolved_block !== '' &&
           Number(d.resolved_block) > Number(d.deadline_block)){
            dlState = 'late';
            dlNote  = 'This call resolved after its deadline block.';
        } else {
            dlState = 'done';
            dlNote  = 'Resolved within the deadline.';
        }
    } else {
        dlState = 'pending';
        dlNote  = 'The call expires if nothing is delivered by this block.';
    }
    phases.deadline = {
        key:   'deadline',
        label: 'Deadline',
        state: dlState,
        block: d.deadline_block,
        note:  dlNote
    };

    // Emit in lifecycle order, never in whatever order the branches above ran.
    var out = [];
    for(var i = 0; i < XCALL_PHASE_ORDER.length; i++)
        out.push(phases[XCALL_PHASE_ORDER[i]]);
    return out;
}

// One-line verdict for the page header: what a reader should take away without
// reading the phases. Derived from the same request status the phases use.
function xcallLifecycleSummary(data){
    var d = data || {};
    if(xcallRequestRefused(d))              return { state: 'failed',  text: 'Refused'   };
    if(xcallRequestStatusIs(d, 'expired'))  return { state: 'expired', text: 'Expired'   };
    if(xcallRequestStatusIs(d, 'completed'))
        return xcallStatusIsOk(d.result_status)
            ? { state: 'done',   text: 'Completed' }
            : { state: 'failed', text: 'Completed with an error result' };
    return { state: 'pending', text: 'In flight' };
}

// Builds the timeline's inner HTML. Local esc/row helpers, matching the
// per-function local-esc pattern used by xchain.js and checkpoint-verify-render.js.
function renderXcallTimeline(data){
    var d    = data || {};
    var coin = (typeof XC !== 'undefined' && XC && XC.coin) ? XC.coin : '';
    var esc  = function(s){ return $('<div>').text(s === null || s === undefined ? '' : String(s)).html(); };
    var num  = function(v){ return (v === null || v === undefined || v === '') ? '-' : numeral(v).format('0,0'); };
    var blockLink = function(v){
        if(v === null || v === undefined || v === '') return '-';
        return formatLink('/' + coin + '/block/' + encodeURIComponent(v), num(v));
    };
    var actionLink = function(v, onCoin){
        if(v === null || v === undefined || v === '') return '-';
        return formatLink('/' + (onCoin || coin) + '/action/' + encodeURIComponent(v), esc(v));
    };
    var mono = function(v){
        if(v === null || v === undefined || v === '') return '-';
        return '<span class="font-monospace small">' + esc(v) + '</span>';
    };
    var row = function(label, value){
        return '<tr><th class="text-muted fw-normal xcall-row-label">' + esc(label) + '</th>'
             + '<td class="xcall-' + esc(String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-')) + '">' + value + '</td></tr>';
    };
    var rows = function(list){
        if(!list.length) return '';
        return '<table class="table table-sm table-borderless mb-0 xcall-phase-fields"><tbody>' + list.join('') + '</tbody></table>';
    };

    var exec = d.execution || null;
    var cb   = d.callback_delivery || null;
    // The executed action is minted on the TARGET chain, where action indexes are
    // chain-local, so its link must be namespaced by target_chain and not by the
    // page's coin (the same trap showXcallDetails documents).
    var execCoin = d.target_chain ? String(d.target_chain) : coin;

    var detail = {
        request: function(){
            var r = [];
            r.push(row('Source', (d.source === null || d.source === undefined || d.source === '')
                ? '-' : formatLink('/' + coin + '/address/' + encodeURIComponent(d.source), esc(d.source))));
            r.push(row('Source Contract', (d.contract_index === null || d.contract_index === undefined || d.contract_index === '')
                ? '-' : formatLink('/' + coin + '/contract/' + encodeURIComponent(d.contract_index), esc(d.contract_index))));
            r.push(row('Target Chain',    (d.target_chain === null || d.target_chain === undefined || d.target_chain === '') ? '-' : esc(d.target_chain)));
            r.push(row('Target Contract', (d.target_contract_index === null || d.target_contract_index === undefined || d.target_contract_index === '') ? '-' : esc(d.target_contract_index)));
            r.push(row('Method',          (d.method === null || d.method === undefined || d.method === '') ? '-' : esc(d.method)));
            r.push(row('Params',          Array.isArray(d.params) ? mono(JSON.stringify(d.params)) : mono(d.params)));
            r.push(row('Gas Limit',       num(d.gas_limit)));
            r.push(row('Cross Hops',      (d.cross_hops === null || d.cross_hops === undefined || d.cross_hops === '') ? '-' : esc(d.cross_hops)));
            r.push(row('Action',          actionLink(d.action_index)));
            r.push(row('Status',          (d.status === null || d.status === undefined || d.status === '') ? '-' : esc(d.status)));
            return rows(r);
        },
        execution: function(){
            if(!exec) return '';
            var r = [];
            r.push(row('Executed Action', actionLink(exec.execute_action_index, execCoin)));
            r.push(row('Result Status',   (exec.result_status === null || exec.result_status === undefined || exec.result_status === '') ? '-' : esc(exec.result_status)));
            r.push(row('Return Payload',  mono(exec.return_payload_b64)));
            r.push(row('Gas Used',        num(exec.gas_used)));
            return rows(r);
        },
        callback: function(){
            var r = [];
            r.push(row('Callback Method', (d.callback_method === null || d.callback_method === undefined || d.callback_method === '') ? '-' : esc(d.callback_method)));
            r.push(row('Callback Params', Array.isArray(d.callback_params) ? mono(JSON.stringify(d.callback_params)) : mono(d.callback_params)));
            if(cb)
                r.push(row('Delivery Status', (cb.callback_result_status === null || cb.callback_result_status === undefined || cb.callback_result_status === '') ? '-' : esc(cb.callback_result_status)));
            r.push(row('Callback Action', actionLink(d.callback_action_index)));
            return rows(r);
        },
        settlement: function(){
            var r = [];
            r.push(row('Request Status',  (d.request_status === null || d.request_status === undefined || d.request_status === '') ? '-' : esc(d.request_status)));
            r.push(row('Recorded Result', (d.result_status === null || d.result_status === undefined || d.result_status === '') ? '-' : esc(d.result_status)));
            r.push(row('Result Payload',  mono(d.result_payload)));
            return rows(r);
        },
        deadline: function(){
            var r = [];
            r.push(row('Deadline Block', blockLink(d.deadline_block)));
            r.push(row('Resolved Block', blockLink(d.resolved_block)));
            return rows(r);
        }
    };

    var phases = buildXcallTimeline(d);
    var html   = '<ul class="xcall-timeline list-unstyled mb-0">';
    for(var i = 0; i < phases.length; i++){
        var p  = phases[i];
        var st = XCALL_PHASE_STATES[p.state] || XCALL_PHASE_STATES.pending;
        // Layout comes from Bootstrap utilities; xcall.html's style block owns only
        // the rail and the marker, and reads both from --xc-* tokens.
        html += '<li class="xcall-phase d-flex gap-3 pb-3" data-phase="' + esc(p.key) + '" data-state="' + esc(p.state) + '">';
        html += '<span class="xcall-marker badge ' + st.badge + '"><i class="fa ' + st.icon + '"></i></span>';
        html += '<div class="xcall-phase-body">';
        html += '<div class="d-flex flex-wrap align-items-center gap-2">';
        html += '<span class="fw-bold xcall-phase-label">' + esc(p.label) + '</span>';
        html += '<span class="badge xcall-phase-state ' + st.badge + '">' + esc(st.text) + '</span>';
        if(!(p.block === null || p.block === undefined || p.block === ''))
            html += '<span class="small text-muted xcall-phase-block">block ' + blockLink(p.block) + '</span>';
        html += '</div>';
        if(p.note)
            html += '<div class="small text-muted xcall-phase-note">' + esc(p.note) + '</div>';
        html += detail[p.key]();
        html += '</div></li>';
    }
    html += '</ul>';
    return html;
}
