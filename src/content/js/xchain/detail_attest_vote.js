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
 * detail_attest_vote.js
 *
 * Custom javascript for xchain explorer
 */

// Display ATTEST action information (v0 request / v1 response / v5 batch head /
// v6 batch continuation; `attests` table)
function showAttestDetails(data){
    let isResponse = (Number(data.version) === 1);
    // ATTEST v2 is the system-synthesized expire: it writes no attests row, so the
    // explorer resolves only baseline fields + version. Badge it as an Expire and
    // show neither the request nor the response sub-panels (their fields are absent).
    let isExpire   = (Number(data.version) === 2);
    // v5 head / v6 continuation are batch rows: every v0/v1 request and response
    // column is NULL on them, so both of those sub-panels stay hidden and the batch
    // panel carries the window header and the chunk slot instead. Falling through to
    // the request branch renders a signed window as a table of dashes.
    let isBatchHead = (Number(data.version) === 5);
    let isBatch     = isBatchHead || (Number(data.version) === 6);
    detailAttestVote_renderAttestIdentity(data, isResponse, isExpire, isBatchHead, isBatch);
    detailAttestVote_renderAttestBatch(data, isBatch);
    detailAttestVote_renderAttestRequest(data, isResponse, isExpire, isBatch);
    detailAttestVote_renderAttestResponse(data, isResponse);
}

function detailAttestVote_renderAttestIdentity(data, isResponse, isExpire, isBatchHead, isBatch){
    // Render the attestation badge and shared identity fields.
    $('#info-attest .attest-type').html(
        isResponse  ? '<span class="badge text-bg-primary">Response (v' + data.version + ')</span>' :
        isExpire    ? '<span class="badge text-bg-warning text-dark">Expire (v2)</span>' :
        isBatchHead ? '<span class="badge text-bg-info text-dark">Batch Head (v5)</span>' :
        isBatch     ? '<span class="badge text-bg-info text-dark">Batch Continuation (v6)</span>' :
                      '<span class="badge text-bg-secondary">Request (v' + data.version + ')</span>');
    // On a batch row request_id holds the batch key, not a request id.
    //
    // An EXPIRE names the request it retired and is the only page in the round with
    // nowhere else to go: it has no request or response panel, so the id cell carries
    // the whole path back - the lifecycle page, the v0 request action, and the expired
    // callback EXECUTE the sweep injected. The id itself is resolved server-side by
    // in-block correlation and is absent when that correlation refuses to guess, which
    // reads as "not recorded" rather than as a blank cell.
    if(isExpire){
        let expireHtml = '';
        if(isNull(data.request_id)){
            expireHtml = '<span class="text-muted attest-expire-unresolved">not recorded</span>';
        } else {
            expireHtml = formatLink('/' + XC.coin + '/attestation/' + data.request_id,
                                    formatHash(data.request_id, 32), 'View this attestation lifecycle');
            let links = [];
            if(!isNull(data.request_action_index))
                links.push('request ' + formatLink('/' + XC.coin + '/action/' + data.request_action_index, data.request_action_index));
            if(!isNull(data.callback_execute_action_index))
                links.push('callback ' + formatLink('/' + XC.coin + '/action/' + data.callback_execute_action_index, data.callback_execute_action_index));
            if(links.length)
                expireHtml += ' <span class="small text-muted attest-expire-links">(' + links.join(' &middot; ') + ')</span>';
        }
        $('#info-attest .attest-request-id').html(expireHtml);
    } else {
        $('#info-attest .attest-request-id').html(formatHash(data.request_id, 32));
    }
    // provider_id is the empty string on a batch row (no single provider answers a
    // batch), which isNull already counts as absent.
    $('#info-attest .attest-provider').text(isNull(data.provider_id) ? '-' : data.provider_id);
    if(!isNull(data.contract_index))
        $('#info-attest .attest-contract').html(formatLink('/' + XC.coin + '/contract/' + data.contract_index, data.contract_index));
}

function detailAttestVote_renderAttestBatch(data, isBatch){
    // Render fields carried by attestation batches.
    // Batch-side fields
    $('#info-attest .attest-batch-fields').toggleClass('d-none', !isBatch);
    if(isBatch){
        // The window header (start/end, row count, BTC snapshot height) is declared on
        // the v5 head only, so a v6 continuation renders those cells as '-' rather than
        // blank. crc32 and the chunk counters ride on both.
        let start = data.batch_window_start, end = data.batch_window_end;
        $('#info-attest .attest-batch-window').html(
            (isNull(start) || isNull(end)) ? '-' :
            (formatLivestamp(start) + ' (' + moment.unix(start).utcOffset(0).format() + ' GMT)' +
             ' to ' + formatLivestamp(end) + ' (' + moment.unix(end).utcOffset(0).format() + ' GMT)'));
        $('#info-attest .attest-batch-rows').text(isNull(data.batch_row_count) ? '-' : numeral(data.batch_row_count).format('0,0'));
        $('#info-attest .attest-batch-btc-height').html(isNull(data.batch_btc_block_height) ? '-' : numeral(data.batch_btc_block_height).format('0,0'));
        $('#info-attest .attest-batch-crc32').text(isNull(data.batch_crc32) ? '-' : String(data.batch_crc32));
        // batch_chunk_index is 0 on the head and 1-based on each continuation, so the
        // slot a reader counts from 1 is index+1 of total.
        $('#info-attest .attest-batch-chunk').text(
            (isNull(data.batch_chunk_index) || isNull(data.batch_total_chunks)) ? '-' :
            ((Number(data.batch_chunk_index) + 1) + ' of ' + data.batch_total_chunks));
    }
}

function detailAttestVote_renderAttestRequest(data, isResponse, isExpire, isBatch){
    // Render fields carried by attestation requests.
    // Request-side fields
    $('#info-attest .attest-request-fields').toggleClass('d-none', isResponse || isExpire || isBatch);
    if(!isResponse && !isExpire && !isBatch){
        $('#info-attest .attest-fee-payer').html(isNull(data.fee_payer) ? '-' : formatLink('/' + XC.coin + '/address/' + data.fee_payer, data.fee_payer));
        // Request-side economics the requester escrowed and paid (fee_amount+fee_tick, gas_escrow).
        $('#info-attest .attest-fee').html(isNull(data.fee_amount) ? '-' : formatLink(tokenUrl(XC.coin, data.fee_tick), data.fee_tick, formatAmount(data.fee_amount) + ' ' + data.fee_tick));
        $('#info-attest .attest-gas-escrow').html(isNull(data.gas_escrow) ? '-' : formatAmount(data.gas_escrow));
        $('#info-attest .attest-callback').text(data.callback_method);
        $('#info-attest .attest-redundancy').text(data.redundancy);
        $('#info-attest .attest-deadline').html(isNull(data.deadline_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.deadline_block, numeral(data.deadline_block).format('0,0')));
        $('#info-attest .attest-request-status').text(data.request_status);
        let attestParams = isNull(data.callback_params) ? data.callback_params_json : data.callback_params;
        $('#info-attest .attest-payload').text(isNull(data.payload) ? '-' : String(data.payload));
        $('#info-attest .attest-callback-params').text(isNull(attestParams) ? '-' : (typeof attestParams === 'string' ? attestParams : JSON.stringify(attestParams)));
    }
}

function detailAttestVote_renderAttestResponse(data, isResponse){
    // Render fields carried by attestation responses.
    // Response-side fields
    $('#info-attest .attest-response-fields').toggleClass('d-none', !isResponse);
    if(isResponse){
        $('#info-attest .attest-response-status').text(data.response_status);
        $('#info-attest .attest-response-hash').html(formatHash(data.response_hash, 32));
        // Show the decoded body the response delivered, not only its hash: the detail query has
        // always selected attests.response_payload (action-detail/consensus.js) and nothing read
        // it, so the panel could not be compared against the hash beside it. Written
        // with .text() because the payload is validator-broadcast free text.
        $('#info-attest .attest-response-payload').text(isNull(data.response_payload) ? '-' : String(data.response_payload));
        $('#info-attest .attest-meta').text(isNull(data.meta) ? '-' : data.meta);
        let sigs = Array.isArray(data.signatures) ? data.signatures : [];
        $('#info-attest .attest-sig-count').text(sigs.length);
        let html = sigs.length ? sigs.map(s => formatHash(s.pubkey, 24)).join('<br>') : '-';
        $('#info-attest .attest-signatures').html(html);
        if(!isNull(data.callback_execute_action_index))
            $('#info-attest .attest-callback-execute').html(formatLink('/' + XC.coin + '/action/' + data.callback_execute_action_index, data.callback_execute_action_index));
    }
}

// Display VOTE action information. One action is exactly one of four kinds
// (data.vote_kind, set by the explorer): a v0 poll definition, a v1 ballot, a
// v3 standing delegation, or a v2 system-synthesized poll finalization. Show
// only the matching sub-section; for a poll, also fetch the frozen per-option
// tally (empty until the poll is finalized).
function showVoteDetails(data){
    let kind = data.vote_kind;
    $('#info-vote .vote-kind').html('<span class="badge text-bg-info">' + (kind || '-') + '</span>');
    $('#info-vote .vote-poll-fields').toggleClass('d-none', kind != 'poll');
    $('#info-vote .vote-ballot-fields').toggleClass('d-none', kind != 'ballot');
    $('#info-vote .vote-delegation-fields').toggleClass('d-none', kind != 'delegation');
    $('#info-vote .vote-finalize-fields').toggleClass('d-none', kind != 'finalize');
    detailAttestVote_renderVoteFinalize(data, kind);
    if(kind=='poll'){
        let opts = detailAttestVote_renderPollSummary(data);
        detailAttestVote_renderPollOutcome(data, opts);
        detailAttestVote_renderPollCallback(data);
        detailAttestVote_renderPollResults(data, opts);
    }
    detailAttestVote_renderVoteChoice(data, kind);
}

function detailAttestVote_renderVoteFinalize(data, kind){
    // Render a finalized poll reference and outcome.
    if(kind=='finalize'){
        // v2 finalization: link the finalized poll (poll id IS its creating action_index),
        // show the frozen terminal status and winning option.
        $('#info-vote .vote-finalize-poll').html(isNull(data.poll_ref) ? '-' : formatLink('/' + XC.coin + '/action/' + data.poll_ref, data.poll_ref));
        let fst = data.poll_status;
        let fcls = (fst=='finalized') ? 'success' : (fst=='failed_quorum') ? 'danger' : 'secondary';
        $('#info-vote .vote-finalize-status').html(isNull(fst) ? '-' : '<span class="badge text-bg-' + fcls + '">' + fst + '</span>');
        let fopts = Array.isArray(data.options) ? data.options : [];
        let wo = data.winning_option;
        $('#info-vote .vote-finalize-winning').text(isNull(wo) ? '-' : (wo + (fopts[wo] != null ? ': ' + fopts[wo] : '')));
    }
}

function detailAttestVote_renderPollSummary(data){
    // Render the poll definition and gate parameters.
        let pcls = (data.poll_status=='finalized') ? 'success' : (data.poll_status=='failed_quorum') ? 'danger' : 'warning text-dark';
        $('#info-vote .vote-token').html(isNull(data.tick) ? '-' : formatLink(tokenUrl(XC.coin, data.tick), data.tick, data.tick));
        $('#info-vote .vote-question').text(isNull(data.question) ? '-' : data.question);
        let opts = Array.isArray(data.options) ? data.options : [];
        $('#info-vote .vote-options').html(opts.length ? opts.map((o, i) => i + ': ' + $('<div>').text(o).html()).join('<br>') : '-');
        $('#info-vote .vote-tally-mode').text(isNull(data.tally_mode) ? '-' : data.tally_mode);
        $('#info-vote .vote-weight-mode').text(isNull(data.weight_mode) ? '-' : data.weight_mode);
        $('#info-vote .vote-max-selections').text(isNull(data.max_selections) ? '-' : data.max_selections);
        $('#info-vote .vote-end-block').html(isNull(data.end_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.end_block, numeral(data.end_block).format('0,0')));
        $('#info-vote .vote-quorum').text(isNull(data.quorum) ? '-' : data.quorum);
        $('#info-vote .vote-min-voters').text(isNull(data.min_voters) ? '-' : data.min_voters);
        // The two remaining gate parameters (polls.sql): min_vote_balance is the dust
        // floor a holder must clear to count toward min_voters, decide_threshold the
        // supply fraction that arms an early decide. Both are inputs the quorum verdict
        // below is judged against, so the verdict is uncheckable without them.
        $('#info-vote .vote-min-vote-balance').text(isNull(data.min_vote_balance) ? '-' : formatAmount(data.min_vote_balance));
        $('#info-vote .vote-decide-threshold').text(isNull(data.decide_threshold) ? '-' : data.decide_threshold);
        $('#info-vote .vote-poll-status').html('<span class="badge text-bg-' + pcls + '">' + (data.poll_status || '-') + '</span>');
        return opts;
}

function detailAttestVote_renderPollOutcome(data, opts){
        // Render the frozen poll outcome and participation measurements.
        // winning_option is an INDEX into `options`, so option 0 is a real winner and
        // only a null reads as "no outcome recorded". Named the way the finalize branch
        // above names it, because a bare index names nothing to a reader.
        let wopt = data.winning_option;
        $('#info-vote .vote-winning-option').text(isNull(wopt) ? '-' : (wopt + (opts[wopt] != null ? ': ' + opts[wopt] : '')));
        // Frozen finalization detail. VOTE v2 measures the turnout and freezes it into
        // the polls row (indexer finalizePoll) precisely so a terminal outcome stays
        // auditable; the detail query has always selected it and nothing rendered it,
        // so a poll badged 'failed_quorum' above named no gate and showed no turnout.
        // Null until v2 lands, which is why an open poll dashes rather than reading 'no':
        // TINYINT 0 is a measured miss, absent is not a measurement.
        let yesNo = function(v){ return isNull(v) ? '-' : (Number(v) ? 'yes' : 'no'); };
        $('#info-vote .vote-quorum-met').text(yesNo(data.quorum_met));
        $('#info-vote .vote-min-voters-met').text(yesNo(data.min_voters_met));
        $('#info-vote .vote-total-weight').text(isNull(data.total_weight) ? '-' : formatAmount(data.total_weight));
        $('#info-vote .vote-total-voters').text(isNull(data.total_voters) ? '-' : numeral(data.total_voters).format('0,0'));
        // fail_reason is the ENUM('quorum','min_voters','both') v2 stamps on a failure
        // and leaves null on a pass, so '-' reads as "no gate failed" rather than unknown.
        $('#info-vote .vote-fail-reason').text(isNull(data.fail_reason) ? '-' : data.fail_reason);
        $('#info-vote .vote-decided-early').text(yesNo(data.decided_early));
        // effective_close_block is the block weights were MEASURED at, which is end_block
        // on a normal close and the crossing block on an early decide, so it is the one
        // that explains the tally; resolved_block is when finalization went terminal.
        $('#info-vote .vote-effective-close-block').html(isNull(data.effective_close_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.effective_close_block, numeral(data.effective_close_block).format('0,0')));
        $('#info-vote .vote-resolved-block').html(isNull(data.resolved_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.resolved_block, numeral(data.resolved_block).format('0,0')));
        $('#info-vote .vote-finalized-by').html(isNull(data.finalized_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.finalized_action_index, data.finalized_action_index));
        $('#info-vote .vote-deposit').html(isNull(data.deposit_amount) ? '-' : formatAmount(data.deposit_amount));
        // Creation-deposit lifecycle: the refund target, and the ENUM('refunded',
        // 'forfeited') outcome v2 stamps once the escrow is released. Rendered as the
        // enum, never as a boolean - a forfeited deposit is not a "yes".
        $('#info-vote .vote-deposit-address').html(isNull(data.deposit_address) ? '-' : formatLink('/' + XC.coin + '/address/' + data.deposit_address, data.deposit_address));
        $('#info-vote .vote-deposit-resolved').text(isNull(data.deposit_resolved) ? '-' : data.deposit_resolved);
}

function detailAttestVote_renderPollCallback(data){
        // Render the binding poll callback contract and execution state.
        // Binding poll: v2 finalize fires callback_method on the callback contract.
        if(!isNull(data.callback_contract_index))
            $('#info-vote .vote-callback').html(formatLink('/' + XC.coin + '/contract/' + data.callback_contract_index, data.callback_contract_index) + (isNull(data.callback_method) ? '' : '.' + data.callback_method));
        else
            $('#info-vote .vote-callback').text('-');
        // PC-42 timelock (callback_delay_blocks) and the EXECUTE the callback actually
        // fired (callback_execute_action_index). Both are selected by the VOTE detail
        // query and were rendered nowhere, so a binding poll whose callback had already
        // run showed no sign of it. Poll branch only: the v2 finalize action writes no
        // polls row of its own, so its LEFT JOIN misses and both fields are null there
        // (action-detail/governance.js) - a finalize row would be a permanent '-'.
        $('#info-vote .vote-callback-delay').text(isNull(data.callback_delay_blocks) ? '-' : data.callback_delay_blocks);
        if(!isNull(data.callback_execute_action_index))
            $('#info-vote .vote-callback-execute').html(formatLink('/' + XC.coin + '/action/' + data.callback_execute_action_index, data.callback_execute_action_index));
        else
            $('#info-vote .vote-callback-execute').text('-');
        // The rest of the binding-poll contract: callback_on is ENUM('pass','always')
        // (fire only on a finalized win, or on every finalization) and gas_escrow backs
        // the injected EXECUTE. callback_params is developer-supplied on-chain JSON that
        // afterMain has already parsed, so it is rendered as inert text through .text()
        // and never through an HTML sink.
        $('#info-vote .vote-callback-on').text(isNull(data.callback_on) ? '-' : data.callback_on);
        $('#info-vote .vote-callback-params').text(isNull(data.callback_params) ? '-' :
            (typeof data.callback_params === 'string' ? data.callback_params : JSON.stringify(data.callback_params)));
        $('#info-vote .vote-gas-escrow').text(isNull(data.gas_escrow) ? '-' : formatAmount(data.gas_escrow));
}

function detailAttestVote_renderPollResults(data, opts){
        // Fetch and render the frozen per-option tally.
        // Frozen per-option tally (poll_results). Empty until VOTE v2 finalizes.
        $.getJSON('/' + XC.coin + '/api/poll/' + data.action_index + '/results', function(res){
            let rows = (res && res.data) ? res.data : [];
            if(rows.length){
                let html = '<table class="table table-sm mb-0"><thead><tr><th>Option</th><th>Weight</th><th>Voters</th></tr></thead><tbody>';
                rows.forEach(function(r){
                    let label = opts[r.option_index];
                    let name  = isNull(label) ? r.option_index : (r.option_index + ': ' + $('<div>').text(label).html());
                    html += '<tr><td>' + name + '</td><td>' + formatAmount(r.total_weight) + '</td><td>' + numeral(r.voter_count).format('0,0') + '</td></tr>';
                });
                html += '</tbody></table>';
                $('#info-vote .vote-results').html(html);
            } else {
                $('#info-vote .vote-results').text(data.poll_status=='open' ? 'Voting open (not yet finalized)' : 'No results');
            }
        });
}

function detailAttestVote_renderVoteChoice(data, kind){
    // Render ballot and standing delegation details.
    if(kind=='ballot'){
        $('#info-vote .vote-poll-ref').html(isNull(data.poll_ref) ? '-' : formatLink('/' + XC.coin + '/action/' + data.poll_ref, data.poll_ref));
        let ballot = Array.isArray(data.ballot) ? data.ballot : [];
        $('#info-vote .vote-choices').html(ballot.length ? ballot.map(b => 'option ' + b.choice + (isNull(b.share) ? '' : ' (share ' + b.share + ')')).join('<br>') : '-');
        $('#info-vote .vote-memo').text(isNull(data.memo) ? '-' : data.memo);
    }
    if(kind=='delegation'){
        $('#info-vote .vote-deleg-token').html(isNull(data.delegation_tick) ? '-' : formatLink(tokenUrl(XC.coin, data.delegation_tick), data.delegation_tick, data.delegation_tick));
        $('#info-vote .vote-delegator').html(isNull(data.delegator) ? '-' : formatLink('/' + XC.coin + '/address/' + data.delegator, data.delegator));
        // delegate_to NULL is a CLEAR (revoke) of any standing delegation.
        $('#info-vote .vote-delegate-to').html(isNull(data.delegate_to) ? '<span class="badge text-bg-secondary">cleared</span>' : formatLink('/' + XC.coin + '/address/' + data.delegate_to, data.delegate_to));
    }
}
