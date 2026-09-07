/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Renders for governance.html (spec explorer-coverage-completion M5.3): the one
 * page that shows XChain's TWO governance systems together.
 *
 * THE DESIGN DECISION, which is the whole of this row:
 *
 *  Token polls (VOTE, indexed on chain, decided by token holders' balances) and
 *  network-parameter proposals (hub-side, decided by staked validators) are
 *  deliberately separate systems. This page puts them side by side so a reader
 *  can find both from one place, and it does NOT merge them: no combined feed,
 *  no shared status vocabulary, no summed participation. Each column names its
 *  electorate and its decider in its own words. A unified TALLY would be a
 *  fabricated number, because the two systems weigh entirely different things.
 *
 *  The second rule is the failure behaviour. The proposals half is served over
 *  the hub dual path, which FAILS LOUD when a configured hub is unreachable
 *  past the stale ceiling. So the two halves fail independently: the poll half
 *  keeps rendering while the proposal half says the hub could not be read.
 *  Rendering an unreachable hub as "no open proposals" would tell a reader that
 *  the federation is proposing nothing, which is a claim this page cannot make.
 */

// Page-local escape. Poll questions and parameter names/values are
// attacker-controlled bytes; nothing below reaches the DOM unescaped.
function govEsc(s){
    return $('<div>').text(s == null ? '' : String(s)).html();
}

// One system's unavailable state. `tone` is 'warning' for a transport failure
// (the data exists and we could not read it) and 'muted' for an empty result.
function govUnavailable(message, tone){
    let cls = (tone === 'warning') ? 'text-warning gov-unavailable-error' : 'text-muted gov-unavailable-empty';
    return '<div class="p-2 small ' + cls + '">' + govEsc(message) + '</div>';
}

// Token polls. `poll_status` is the indexer's own vocabulary (open / passed /
// failed / ...), rendered verbatim rather than translated into a shared status
// set: mapping it onto the hub's words is exactly the merge this page refuses.
function renderGovernancePolls(rows){
    let list = Array.isArray(rows) ? rows : [];
    if(!list.length)
        return govUnavailable('No token polls have been created on this chain yet.', 'muted');
    let html = '<table class="table table-sm table-striped mb-0 gov-polls-table"><thead><tr>'
             + '<th class="text-muted fw-normal">Poll</th>'
             + '<th class="text-muted fw-normal">Electorate</th>'
             + '<th class="text-muted fw-normal">Question</th>'
             + '<th class="text-muted fw-normal">Status</th>'
             + '<th class="text-muted fw-normal text-end">Closes</th>'
             + '</tr></thead><tbody>';
    list.forEach(function(r){
        html += '<tr class="gov-poll-row" data-poll="' + govEsc(r.action_index) + '">'
              + '<td>' + (isNull(r.action_index)
                  ? '<span class="text-muted">-</span>'
                  : formatLink('/' + XC.coin + '/poll/' + r.action_index, govEsc(r.action_index))) + '</td>'
              + '<td class="gov-poll-tick">' + (isNull(r.tick)
                  ? '<span class="text-muted">-</span>'
                  : formatLink('/' + XC.coin + '/token/' + encodeURIComponent(String(r.tick)), govEsc(r.tick))) + '</td>'
              + '<td class="text-truncate gov-poll-question">' + govEsc(r.question) + '</td>'
              + '<td class="gov-poll-status">' + govEsc(isNull(r.poll_status) ? '-' : r.poll_status) + '</td>'
              + '<td class="text-end gov-poll-end">' + (isNull(r.end_block)
                  ? '<span class="text-muted">-</span>'
                  : formatLink('/' + XC.coin + '/block/' + r.end_block, numeral(r.end_block).format('0,0'))) + '</td>'
              + '</tr>';
    });
    html += '</tbody></table>';
    return html;
}

// Network-parameter proposals. A proposal changes ONE consensus parameter, so
// the current and proposed values ride together: a proposed value shown without
// what it replaces is unreadable.
function renderGovernanceProposals(rows){
    let list = Array.isArray(rows) ? rows : [];
    if(!list.length)
        return govUnavailable('The federation has no recorded parameter proposals.', 'muted');
    let html = '<table class="table table-sm table-striped mb-0 gov-proposals-table"><thead><tr>'
             + '<th class="text-muted fw-normal">Proposal</th>'
             + '<th class="text-muted fw-normal">Parameter</th>'
             + '<th class="text-muted fw-normal">Change</th>'
             + '<th class="text-muted fw-normal">Status</th>'
             + '<th class="text-muted fw-normal text-end">Voting ends</th>'
             + '</tr></thead><tbody>';
    list.forEach(function(r){
        html += '<tr class="gov-proposal-row" data-proposal="' + govEsc(r.proposal_id) + '">'
              + '<td class="font-monospace small gov-proposal-id">' + govEsc(r.proposal_id) + '</td>'
              + '<td class="gov-proposal-parameter">' + govEsc(r.parameter) + '</td>'
              + '<td class="gov-proposal-change">' + govEsc(isNull(r.current_value) ? '-' : r.current_value)
              + ' <i class="fa fa-arrow-right-long"></i> ' + govEsc(isNull(r.proposed_value) ? '-' : r.proposed_value) + '</td>'
              + '<td class="gov-proposal-status">' + govEsc(isNull(r.status) ? '-' : r.status) + '</td>'
              + '<td class="text-end gov-proposal-end">' + (isNull(r.voting_end)
                  ? '<span class="text-muted">-</span>'
                  : formatLink('/' + XC.coin + '/block/' + r.voting_end, numeral(r.voting_end).format('0,0'))) + '</td>'
              + '</tr>';
    });
    html += '</tbody></table>';
    return html;
}

// What the proposals half renders when the hub read fails. Separate from the
// empty state on purpose: these two must never look the same.
function renderGovernanceProposalsOutage(message){
    return govUnavailable(
        (message ? String(message) : 'The federation hub could not be read')
        + '. Parameter proposals are served by the hub, not by this chain\'s index,'
        + ' so this section is unknown rather than empty. Token polls above are unaffected.',
        'warning');
}
