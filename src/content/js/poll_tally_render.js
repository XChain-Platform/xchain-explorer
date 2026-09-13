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
 * Tally, outcome, quorum and delegation renders for poll.html. Split out of
 * that page's inline script so a test can drive the real render path with
 * stubbed endpoint responses instead of asserting on page source text.
 *
 * Two rules in here are protocol semantics, not presentation, and are the
 * reason this file is testable at all:
 *
 *  1. DELEGATIONS. vote_delegations is an APPEND-ONLY log: a re-point appends a
 *     new row and a REVOKE appends a CLEAR row (no delegate). The live
 *     delegation for a (tick, delegator) is its latest row, and only if that row
 *     is not a CLEAR. The server's getVoteDelegations already applies the
 *     correlated MAX and the not-cleared filter, so this file NEVER re-derives
 *     recency - it takes the list as the live set. What it does do is refuse to
 *     render a CLEAR row as live if one ever reaches the client, because
 *     "revoked delegation shown as live" is the exact defect this surface exists
 *     to not have.
 *
 *  2. TALLY WEIGHT IS NOT STORED. votes.share is a voter's RELATIVE share for an
 *     option (always '1' in approval mode), not voting weight; effective weight
 *     derives from the voter's balance at the effective close block and is
 *     frozen into poll_results only at finalization. So a finalized poll is
 *     tallied from poll_results (real weight), and an open poll shows a
 *     PROVISIONAL ballot count that is explicitly labelled as not weight.
 *     Summing `share` across voters and calling it a tally would be a fabricated
 *     number, and is deliberately not done here.
 */

// Page-local escape, matching the per-page pattern the other detail pages use.
// Poll questions, option labels and vote memos are attacker-controlled on-chain
// bytes, so nothing below reaches the DOM unescaped.
function pollEsc(s){
    return $('<div>').text(s == null ? '' : String(s)).html();
}

// The poll's option labels, tolerating the raw-string fallback getPoll leaves
// behind when the stored `options` JSON is malformed.
function pollOptionLabels(poll){
    if(!poll) return [];
    return Array.isArray(poll.options) ? poll.options : [];
}

// Lifecycle: `open` means still accepting ballots; every other poll_status is a
// terminal state. A poll with no status at all is treated as NOT open, so an
// unknown state never renders as "you can still vote on this".
function pollIsOpen(poll){
    return !!poll && String(poll.poll_status) === 'open';
}

function pollStatusBadge(poll){
    let s = (poll && !isNull(poll.poll_status)) ? String(poll.poll_status) : 'unknown';
    let tone = 'secondary';
    if(s === 'open')                       tone = 'primary';
    else if(s === 'passed')                tone = 'success';
    else if(s === 'failed' || s === 'rejected') tone = 'danger';
    else if(s === 'closed' || s === 'tallying') tone = 'warning text-dark';
    return '<span class="badge text-bg-' + tone + '" id="poll-status-value">' + pollEsc(s) + '</span>';
}

// Open vs closed outcome. The two states get different container classes AND
// different copy: an open poll must never be readable as a settled result, and a
// settled result must never be readable as still-collecting.
function renderPollOutcome(poll){
    if(!poll) return '';
    let opts = pollOptionLabels(poll);
    if(pollIsOpen(poll)){
        let closes = isNull(poll.end_block)
            ? 'an unrecorded block'
            : formatLink('/' + XC.coin + '/block/' + poll.end_block, numeral(poll.end_block).format('0,0'));
        return '<div class="alert alert-primary py-2 mb-0 poll-outcome-open" id="poll-outcome-state">'
             + '<span class="fw-bold">Open</span> - still accepting ballots until block ' + closes + '.'
             + ' <span class="small">No outcome exists yet; the tally below is provisional.</span>'
             + '</div>';
    }
    // Terminal state. winning_option is an index into the poll's options.
    let html = '<div class="alert alert-secondary py-2 mb-0 poll-outcome-closed" id="poll-outcome-state">';
    if(isNull(poll.winning_option)){
        html += '<span class="fw-bold">Closed</span> - no winning option was recorded.';
    } else {
        let i     = Number(poll.winning_option);
        let label = (i >= 0 && i < opts.length) ? opts[i] : ('option ' + i);
        html += '<span class="fw-bold">Result:</span> <span id="poll-winning-option">'
             + pollEsc(label) + '</span> <span class="text-muted small">(option ' + pollEsc(i) + ')</span>';
    }
    if(!isNull(poll.fail_reason))
        html += '<div class="small mt-1" id="poll-fail-reason">Did not carry: ' + pollEsc(poll.fail_reason) + '</div>';
    let notes = [];
    if(poll.decided_early)
        notes.push('decided early (the decide threshold was reached before the close block)');
    if(!isNull(poll.effective_close_block))
        notes.push('effective close block ' + numeral(poll.effective_close_block).format('0,0'));
    if(!isNull(poll.resolved_block))
        notes.push('resolved in block ' + numeral(poll.resolved_block).format('0,0'));
    if(notes.length)
        html += '<div class="small text-muted mt-1">' + pollEsc(notes.join(' · ')) + '</div>';
    html += '</div>';
    return html;
}

// Quorum / participation gates. Every field here is null until VOTE v2
// finalizes, so a met/not-met verdict is rendered ONLY where the poll actually
// carries one; an absent quorum_met is reported as "not yet measured" rather
// than as a failure, which would libel every open poll.
function renderPollQuorum(poll){
    if(!poll) return '';
    let rows = [];
    let gate = function(label, requirement, met){
        let verdict;
        if(isNull(met))     verdict = '<span class="badge text-bg-secondary">not yet measured</span>';
        else if(Number(met)) verdict = '<span class="badge text-bg-success">met</span>';
        else                 verdict = '<span class="badge text-bg-danger">not met</span>';
        rows.push('<tr><th class="text-muted fw-normal">' + pollEsc(label) + '</th><td>'
            + requirement + ' ' + verdict + '</td></tr>');
    };
    if(!isNull(poll.quorum))
        gate('Quorum', pollEsc(poll.quorum) + ' of eligible weight', poll.quorum_met);
    if(!isNull(poll.min_voters))
        gate('Minimum voters', numeral(poll.min_voters).format('0,0'), poll.min_voters_met);
    if(!isNull(poll.min_vote_balance))
        rows.push('<tr><th class="text-muted fw-normal">Minimum balance to vote</th><td>'
            + pollEsc(poll.min_vote_balance) + '</td></tr>');
    if(!isNull(poll.decide_threshold))
        rows.push('<tr><th class="text-muted fw-normal">Decide threshold</th><td>'
            + pollEsc(poll.decide_threshold) + '</td></tr>');
    if(!isNull(poll.total_weight))
        rows.push('<tr><th class="text-muted fw-normal">Counted weight</th><td>'
            + pollEsc(poll.total_weight) + '</td></tr>');
    if(!isNull(poll.total_voters))
        rows.push('<tr><th class="text-muted fw-normal">Counted voters</th><td>'
            + numeral(poll.total_voters).format('0,0') + '</td></tr>');
    if(!rows.length)
        return '<span class="text-muted">This poll records no quorum or participation gates.</span>';
    return '<table class="table table-sm table-borderless mb-0" id="poll-quorum-table"><tbody>'
         + rows.join('') + '</tbody></table>';
}

// Reduce a raw ballot list to the CURRENT ballot set. votes is append-only: a
// re-vote appends a whole new action_index set and the earlier set is
// superseded, exactly as db.getPollTally reads it (MAX(action_index) per
// (poll, voter)). Counting the raw rows instead would count a re-voter twice
// and, worse, count the option they changed AWAY from.
function currentBallots(votes){
    let rows   = Array.isArray(votes) ? votes : [];
    let latest = {};
    rows.forEach(function(v){
        let voter = String(v.source);
        let ai    = Number(v.action_index);
        if(latest[voter] == null || ai > latest[voter])
            latest[voter] = ai;
    });
    return rows.filter(function(v){ return Number(v.action_index) === latest[String(v.source)]; });
}

// The tally. Finalized polls tally from poll_results (frozen real weight);
// everything else shows a provisional per-option BALLOT count, labelled as such.
function renderPollTally(poll, results, votes){
    let opts  = pollOptionLabels(poll);
    let final = Array.isArray(results) ? results : [];
    if(!opts.length)
        return '<span class="text-muted">This poll records no options.</span>';

    let metric = '';
    let body   = '';
    let note   = '';
    let winner = (poll && !isNull(poll.winning_option)) ? Number(poll.winning_option) : null;

    if(final.length){
        let byOption = {};
        final.forEach(function(r){ byOption[Number(r.option_index)] = r; });
        let total = final.reduce(function(a, r){ return a + Number(r.total_weight || 0); }, 0);
        opts.forEach(function(label, i){
            let r   = byOption[i] || {};
            let w   = Number(r.total_weight || 0);
            let pct = total > 0 ? ((w / total) * 100).toFixed(1) + '%' : '-';
            body += '<tr class="poll-tally-row' + (winner === i ? ' poll-tally-winner' : '') + '">'
                 + '<td>' + pollEsc(i) + ': ' + pollEsc(label)
                 + (winner === i ? ' <span class="badge text-bg-success">winner</span>' : '') + '</td>'
                 + '<td class="poll-tally-weight">' + pollEsc(isNull(r.total_weight) ? '0' : r.total_weight) + '</td>'
                 + '<td class="poll-tally-voters">' + numeral(r.voter_count || 0).format('0,0') + '</td>'
                 + '<td>' + pct + '</td></tr>';
        });
        note   = '<div class="small text-muted mt-1" id="poll-tally-basis">Final tally, frozen at finalization.'
               + ' Weight is each voter\'s balance at the effective close block.</div>';
        metric = 'Weight';
    } else {
        let current = currentBallots(votes);
        let counts  = {};
        current.forEach(function(v){
            let c = Number(v.choice);
            counts[c] = (counts[c] || 0) + 1;
        });
        let voters = {};
        current.forEach(function(v){ voters[String(v.source)] = true; });
        let totalVoters = Object.keys(voters).length;
        opts.forEach(function(label, i){
            let n   = counts[i] || 0;
            let pct = totalVoters > 0 ? ((n / totalVoters) * 100).toFixed(1) + '%' : '-';
            body += '<tr class="poll-tally-row">'
                 + '<td>' + pollEsc(i) + ': ' + pollEsc(label) + '</td>'
                 + '<td class="poll-tally-ballots">' + numeral(n).format('0,0') + '</td>'
                 + '<td class="poll-tally-voters">' + numeral(n).format('0,0') + '</td>'
                 + '<td>' + pct + '</td></tr>';
        });
        // Saying "weight" here would be a fabrication: no weight exists until the
        // poll finalizes against close-block balances.
        note   = '<div class="small text-muted mt-1" id="poll-tally-basis">Provisional: ballots cast, not voting weight.'
               + ' Weight is measured against balances at the close block and is not settled until this poll finalizes.'
               + ' ' + numeral(totalVoters).format('0,0') + ' current ballot(s) counted; superseded re-votes are excluded.</div>';
        metric = 'Ballots';
    }
    let head = '<table class="table table-sm mb-0" id="poll-tally-table"><thead><tr>'
             + '<th>Option</th><th id="poll-tally-metric">' + metric + '</th><th>Voters</th><th>Share</th>'
             + '</tr></thead><tbody>';
    return head + body + '</tbody></table>' + note;
}

// Standing per-token delegations for the poll's electorate. The rows arrive
// already reduced to the live set by getVoteDelegations' correlated MAX; the one
// judgement made here is CLEAR-vs-delegation, and a CLEAR (a revoke, carrying no
// delegate) is rendered as revoked and never counted or listed as live.
function renderPollDelegations(rows, tick){
    let all = Array.isArray(rows) ? rows : [];
    let live = [], revoked = [];
    all.forEach(function(r){
        let d = r ? r.delegate : null;
        if(isNull(d) || String(d) === '') revoked.push(r);
        else                              live.push(r);
    });

    let tickName = isNull(tick) ? '' : ' on ' + pollEsc(tick);
    let html = '<div class="small text-muted mb-2" id="poll-delegation-summary">'
             + '<span id="poll-delegation-live-count">' + live.length + '</span> live delegation(s)'
             + tickName + '.'
             + (revoked.length ? ' <span id="poll-delegation-revoked-count">' + revoked.length + '</span> revoked.' : '')
             + '</div>';

    if(!live.length && !revoked.length)
        return html + '<span class="text-muted" id="poll-delegation-empty">No holder of this token has delegated their voting weight.</span>';

    html += '<table class="table table-sm mb-0" id="poll-delegation-table"><thead><tr>'
          + '<th>Delegator</th><th>Delegate</th><th>State</th><th>Block</th></tr></thead><tbody>';

    let row = function(r, isLive){
        let delegator = isNull(r.delegator) ? '-'
            : formatLink('/' + XC.coin + '/address/' + r.delegator, r.delegator);
        let delegate = isLive
            ? formatLink('/' + XC.coin + '/address/' + r.delegate, r.delegate)
            : '<span class="text-muted">none</span>';
        let state = isLive
            ? '<span class="badge text-bg-success">live</span>'
            : '<span class="badge text-bg-secondary">revoked</span>';
        let block = isNull(r.block_index) ? '-'
            : formatLink('/' + XC.coin + '/block/' + r.block_index, numeral(r.block_index).format('0,0'));
        return '<tr class="' + (isLive ? 'poll-delegation-live' : 'poll-delegation-revoked') + '">'
             + '<td class="poll-delegation-delegator">' + delegator + '</td>'
             + '<td class="poll-delegation-delegate">' + delegate + '</td>'
             + '<td>' + state + '</td><td>' + block + '</td></tr>';
    };

    live.forEach(function(r){    html += row(r, true);  });
    revoked.forEach(function(r){ html += row(r, false); });

    html += '</tbody></table>'
          + '<div class="small text-muted mt-1">A delegation stands until the holder re-points or revokes it.'
          + ' Revoked and superseded delegations carry no weight into this poll.</div>';
    return html;
}
