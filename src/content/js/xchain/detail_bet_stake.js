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
 * xchain.js
 *
 * Custom javascript for xchain explorer
 */

// Display BET action information: one action name over four formats, so branch on
// bet_kind (set server-side in getActionData). 'feed' is format 0 market creation,
// 'bet' format 2 wager, 'cancel'/'resolve' the row-less formats 1/3.

// RENDERING SAFETY (§11.1): LABEL, OUTCOMES and DETAILS are attacker-controlled
// on-chain bytes. Everything derived from them goes through .text() or the
// $('<div>').text(x).html() escape, DETAILS is shown strictly as inert data, and no
// URL found inside it is ever fetched or turned into a link (SSRF-guard stance).
function showBetDetails(data){
    let kind = data.bet_kind;
    let esc  = function(s){ return $('<div>').text(s == null ? '' : String(s)).html(); };
    $('#info-bet .bet-kind').html('<span class="badge text-bg-info">' + esc(kind || '-') + '</span>');
    $('#info-bet .bet-feed-fields').toggleClass('d-none', kind != 'feed');
    $('#info-bet .bet-wager-fields').toggleClass('d-none', kind != 'bet');
    $('#info-bet .bet-action-fields').toggleClass('d-none', kind != 'cancel' && kind != 'resolve');
    // Only a resolve declares an outcome; a cancel shares the rows above and has none.
    $('#info-bet .bet-resolve-fields').toggleClass('d-none', kind != 'resolve');

    // Feed lifecycle badge colouring shared by the feed and cancel/resolve shapes.
    let statusClass = function(s){
        if(s=='resolved')                      return 'success';
        if(s=='cancelled' || s=='expired')     return 'danger';
        if(s=='resolved_void')                 return 'secondary';
        if(s=='closed')                        return 'warning text-dark';
        return 'primary';
    };

    if(kind=='feed'){
        $('#info-bet .bet-label').text(isNull(data.label) ? '-' : data.label);
        let outs = Array.isArray(data.outcome_labels) ? data.outcome_labels : [];
        $('#info-bet .bet-outcomes').html(outs.length ? outs.map((o, i) => i + ': ' + esc(o)).join('<br>') : '-');
        $('#info-bet .bet-token').html(isNull(data.tick) ? '-' : formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
        // FEE is the ORACLE's percent cut of the pot, NOT the protocol's market
        // duration fee. Label it so the two are never confused (§10 naming pin).
        // Read it from the aliased column (bet_fee): db.js getActionData overwrites the
        // reserved `fee` slot with the protocol-fee RECORD, so this printed
        // '[object Object]% of the pot' (#3932, same collision as broadcast_fee).
        $('#info-bet .bet-fee').text(isNull(data.bet_fee) ? '-' : data.bet_fee + '% of the pot (oracle fee)');
        $('#info-bet .bet-deadline').html(isNull(data.deadline) ? '-' : data.deadline + ' - ' + formatLivestamp(data.deadline) + ' (' + moment.unix(data.deadline).utcOffset(0).format() + ' GMT)');
        $('#info-bet .bet-refund-window').text(isNull(data.refund_window) ? '-' : numeral(data.refund_window).format('0,0') + ' seconds');
        $('#info-bet .bet-expire-at').html(isNull(data.expire_at) ? '-' : data.expire_at + ' - ' + formatLivestamp(data.expire_at) + ' (' + moment.unix(data.expire_at).utcOffset(0).format() + ' GMT)');
        $('#info-bet .bet-min-amount').html(isNull(data.min_amount) ? '<span class="text-muted">none</span>' : formatAmount(data.min_amount));
        $('#info-bet .bet-allow-list').html(isNull(data.allow_list) ? '-' : formatLink('/' + XC.coin + '/action/' + data.allow_list, data.allow_list));
        $('#info-bet .bet-block-list').html(isNull(data.block_list) ? '-' : formatLink('/' + XC.coin + '/action/' + data.block_list, data.block_list));
        let fs = data.feed_status;
        $('#info-bet .bet-feed-status').html(isNull(fs) ? '-' : '<span class="badge text-bg-' + statusClass(fs) + '">' + esc(fs) + '</span>');

        // DETAILS: render as inert, escaped text. Never as markup, and never fetched.
        if(isNull(data.details)){
            $('#info-bet .bet-details').text('-');
        } else if(data.details_json != null){
            $('#info-bet .bet-details').html('<pre class="mb-0 small">' + esc(JSON.stringify(data.details_json, null, 2)) + '</pre>');
        } else {
            $('#info-bet .bet-details').html('<span class="text-muted">unparsed base64 payload</span><pre class="mb-0 small">' + esc(data.details) + '</pre>');
        }

        // Live per-outcome pools (open bets only, the normative settlement predicate).
        $.getJSON('/' + XC.coin + '/api/bet_feed/' + data.action_index, function(res){
            let feed  = (res && res.data) ? (Array.isArray(res.data) ? res.data[0] : res.data) : null;
            let pools = (feed && Array.isArray(feed.pools)) ? feed.pools : [];
            if(!pools.length){ $('#info-bet .bet-pools').text('No open bets'); return; }
            let total = pools.reduce((a, p) => a + Number(p.pool || 0), 0);
            let html  = '<table class="table table-sm mb-0"><thead><tr><th>Outcome</th><th>Pool</th><th>Bets</th><th>Implied</th></tr></thead><tbody>';
            pools.forEach(function(p){
                let label = outs[p.outcome];
                let name  = (label == null) ? String(p.outcome) : (p.outcome + ': ' + esc(label));
                // Implied probability from the parimutuel split. Odds are NOT fixed at
                // bet time; this is the split as it stands right now.
                let pct   = total > 0 ? ((Number(p.pool || 0) / total) * 100).toFixed(1) + '%' : '-';
                html += '<tr><td>' + name + '</td><td>' + formatAmount(p.pool) + '</td><td>' + numeral(p.bet_count).format('0,0') + '</td><td>' + pct + '</td></tr>';
            });
            html += '</tbody></table><div class="small text-muted mt-1">Parimutuel: the split shown is current, not the odds locked at bet time.</div>';
            $('#info-bet .bet-pools').html(html);
        });
    }

    if(kind=='bet'){
        $('#info-bet .bet-feed-ref').html(isNull(data.feed_ref) ? '-' : formatLink('/' + XC.coin + '/action/' + data.feed_ref, data.feed_ref));
        $('#info-bet .bet-outcome').text(isNull(data.outcome) ? '-' : data.outcome);
        $('#info-bet .bet-amount').html(isNull(data.amount) ? '-' : formatAmount(data.amount));
        let bs   = data.bet_status;
        let bcls = (bs=='won') ? 'success' : (bs=='lost') ? 'danger' : (bs=='refunded') ? 'secondary' : 'primary';
        $('#info-bet .bet-status').html(isNull(bs) ? '-' : '<span class="badge text-bg-' + bcls + '">' + esc(bs) + '</span>');
        $('#info-bet .bet-settled-block').html(isNull(data.settled_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.settled_block, numeral(data.settled_block).format('0,0')));
    }

    if(kind=='cancel' || kind=='resolve'){
        $('#info-bet .bet-action-feed-ref').html(isNull(data.feed_ref) ? '-' : formatLink('/' + XC.coin + '/action/' + data.feed_ref, data.feed_ref));
        let fs = data.feed_status;
        $('#info-bet .bet-action-status').html(isNull(fs) ? '-' : '<span class="badge text-bg-' + statusClass(fs) + '">' + esc(fs) + '</span>');
    }

    if(kind=='resolve'){
        // The outcome index the resolve declared. A REJECTED resolve settles nothing
        // and stores the outcome the oracle merely CLAIMED (which is why
        // db.js getBetFeedWinningOutcome reads valid rows alone), so anything but a
        // valid action is labelled a claim rather than presented as the winner.
        // The value is on-chain input, so it goes out escaped like the rest of the panel.
        let ro = data.resolve_outcome;
        $('#info-bet .bet-resolve-outcome').html(isNull(ro) ? '-'
            : esc(ro) + (data.status == 'valid' ? '' : ' <span class="badge text-bg-warning text-dark">claimed - resolve ' + esc(isNull(data.status) ? 'not accepted' : data.status) + '</span>'));
    }
}

// Display BET_EXPIRE action information (feed passed expire_at unresolved, so
// every open bet is refunded in full and the oracle takes no cut)
function showBetExpireDetails(data){
    let esc = function(s){ return $('<div>').text(s == null ? '' : String(s)).html(); };
    $('#info-bet-expire .bet-expire-feed').html(isNull(data.feed_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.feed_action_index, numeral(data.feed_action_index).format('0,0')));
    $('#info-bet-expire .bet-expire-label').text(isNull(data.label) ? '-' : data.label);
    $('#info-bet-expire .bet-expire-token').html(isNull(data.tick) ? '-' : formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    $('#info-bet-expire .bet-expire-deadline').html(isNull(data.deadline) ? '-' : data.deadline + ' - ' + formatLivestamp(data.deadline) + ' (' + moment.unix(data.deadline).utcOffset(0).format() + ' GMT)');
    $('#info-bet-expire .bet-expire-refund-window').text(isNull(data.refund_window) ? '-' : numeral(data.refund_window).format('0,0') + ' seconds');
    $('#info-bet-expire .bet-expire-expire-at').html(isNull(data.expire_at) ? '-' : data.expire_at + ' - ' + formatLivestamp(data.expire_at) + ' (' + moment.unix(data.expire_at).utcOffset(0).format() + ' GMT)');
    // Refund tally. Zero is a real answer (every bet had already left 'open' by
    // another path), so print the count rather than dashing it out.
    $('#info-bet-expire .bet-expire-refund-count').text(isNull(data.refund_count) ? '-' : numeral(data.refund_count).format('0,0'));
    $('#info-bet-expire .bet-expire-refund-amount').html(isNull(data.refund_amount) ? '-' : formatAmount(data.refund_amount));
    let fs = data.feed_status;
    $('#info-bet-expire .bet-expire-feed-status').html(isNull(fs) ? '-' : '<span class="badge text-bg-' + ((fs=='expired') ? 'danger' : 'primary') + '">' + esc(fs) + '</span>');
}

// Display STAKE action information (capability v1/v2 or contract-targeted v3)
function showStakeDetails(data){
    let isContract = !isNull(data.target_contract_index);
    $('#info-stake .stake-version').text('v' + data.version);
    $('#info-stake .stake-pubkey').html(formatHash(data.signing_pubkey, 24));
    $('#info-stake .stake-amount').html(formatAmount(data.amount));
    $('#info-stake .stake-contract-row').toggleClass('d-none', !isContract);
    if(isContract){
        $('#info-stake .stake-contract').html(formatLink('/' + XC.coin + '/contract/' + data.target_contract_index, data.target_contract_index));
        $('#info-stake .stake-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    }
    if(!isNull(data.activation_block))
        $('#info-stake .stake-activation').html(formatLink('/' + XC.coin + '/block/' + data.activation_block, numeral(data.activation_block).format('0,0')));
    $('#info-stake .stake-deactivation').html(isNull(data.deactivation_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.deactivation_block, numeral(data.deactivation_block).format('0,0')));
}

// Display UNSTAKE action information (capability v0 or contract-targeted v1)
function showUnstakeDetails(data){
    let isContract = !isNull(data.target_contract_index);
    // ROLLCALL eviction (action_format 3): the protocol removed this validator for
    // missing liveness, the holder never broadcast anything. A user CAN broadcast a
    // format-3 UNSTAKE, but the indexer rejects it as invalid, so requiring status
    // 'valid' alongside the format keeps a rejected broadcast from reading as an
    // eviction that never happened.
    let isEviction = (Number(data.action_format) === 3 && data.status === 'valid');
    $('#info-unstake .unstake-pubkey').html(formatHash(data.signing_pubkey, 24));
    $('#info-unstake .unstake-amount').html(
        (isEviction ? '<span class="badge text-bg-danger me-2">Evicted</span>' : '') + formatAmount(data.amount));
    $('#info-unstake .unstake-cooldown').html(isNull(data.cooldown_end_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.cooldown_end_block, numeral(data.cooldown_end_block).format('0,0')));
    $('#info-unstake .unstake-contract-row').toggleClass('d-none', !isContract);
    if(isContract)
        $('#info-unstake .unstake-contract').html(formatLink('/' + XC.coin + '/contract/' + data.target_contract_index, data.target_contract_index));
    // Token is gated on the TICK, not on the contract index. The v2
    // cooldown-completion action is synthetic: it has no unstakes /
    // contract_unstakes row, so target_contract_index is always NULL, while the
    // handler recovers the tick from the return credit (src/action-detail/
    // staking.js, UNSTAKE afterEffects). Bundled under isContract that
    // recovered tick could never render, so a contract release denominated in
    // an arbitrary token read as a bare gas-coin amount.
    let hasTick = !isNull(data.tick);
    $('#info-unstake .unstake-token-row').toggleClass('d-none', !hasTick);
    if(hasTick)
        $('#info-unstake .unstake-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
}

// Display DELEGATE action information (capability v0/v2 or contract-targeted v1/v3)
function showDelegateDetails(data){
    let isContract = !isNull(data.target_contract_index);
    // Stake-key revoke variant: the indexer writes only a stake_key_revocations row (no
    // delegations/contract_delegations row), so signing_pubkey COALESCEs to NULL and the
    // pubkey/deactivation arrive under the revoked_pubkey/revocation_deactivation_block aliases.
    let isRevoke = isNull(data.signing_pubkey) && !isNull(data.revoked_pubkey);
    let pubkey = isNull(data.signing_pubkey) ? data.revoked_pubkey : data.signing_pubkey;
    let deactivation = isNull(data.deactivation_block) ? data.revocation_deactivation_block : data.deactivation_block;
    $('#info-delegate .delegate-pubkey').html(isNull(pubkey) ? '-' : formatHash(pubkey, 24));
    $('#info-delegate .delegate-revoke-row').toggleClass('d-none', !isRevoke);
    if(isRevoke)
        $('#info-delegate .delegate-revoked').html('<span class="badge text-bg-warning text-dark">Stake-key revocation</span>');
    $('#info-delegate .delegate-contract-row').toggleClass('d-none', !isContract);
    if(isContract){
        $('#info-delegate .delegate-contract').html(formatLink('/' + XC.coin + '/contract/' + data.target_contract_index, data.target_contract_index));
        $('#info-delegate .delegate-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    }
    if(!isNull(data.activation_block))
        $('#info-delegate .delegate-activation').html(formatLink('/' + XC.coin + '/block/' + data.activation_block, numeral(data.activation_block).format('0,0')));
    $('#info-delegate .delegate-deactivation').html(isNull(deactivation) ? '-' : formatLink('/' + XC.coin + '/block/' + deactivation, numeral(deactivation).format('0,0')));
}

// Display COLLECT action information (validator reward claim)
function showCollectDetails(data){
    $('#info-collect .collect-amount').html(formatAmount(data.amount));
}

// Display SLASH action information (capability equivocation bond-burn)
function showSlashDetails(data){
    $('#info-slash .slash-pubkey').html(formatHash(data.slashed_pubkey, 24));
    $('#info-slash .slash-capability').html(isNull(data.capability) ? '-' : '<span class="badge text-bg-secondary">' + data.capability + '</span>');
    $('#info-slash .slash-equiv-key').text(isNull(data.equiv_key) ? '-' : data.equiv_key);
    $('#info-slash .slash-amount').html(formatAmount(data.amount));
    $('#info-slash .slash-bounty').html(formatAmount(data.bounty_amount));
    $('#info-slash .slash-treasury').html(formatAmount(data.treasury_amount));
    $('#info-slash .slash-submitter').html(isNull(data.submitter) ? '-' : formatLink('/' + XC.coin + '/address/' + data.submitter, data.submitter));
    $('#info-slash .slash-destination').html(isNull(data.destination) ? '-' : formatLink('/' + XC.coin + '/address/' + data.destination, data.destination));
}
