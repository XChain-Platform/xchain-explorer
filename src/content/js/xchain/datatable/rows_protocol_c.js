/*********************************************************************
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
 * Custom javascript for xchain explorer
 */
var xcDatatableRowHandlers = xcDatatableRowHandlers || {};
function xcDatatableRenderCoinpayRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// COINPAY settlement record. txid/vout name the specific output that paid THIS
// obligation, so one transaction legitimately appears on several rows.

    let obligation = data[4];
    let paid       = data[5];
    let txid       = data[6];
    let vout       = data[7];
    $('td', row).eq(4).html(isNull(obligation) ? '-' : formatLink('/' + coin + '/action/' + obligation, obligation));
    $('td', row).eq(5).html(isNull(paid) ? '-' : formatAmount(paid));
    $('td', row).eq(6).html(isNull(txid) ? '-' : formatHash(txid));
    $('td', row).eq(7).text(isNull(vout) ? '-' : vout);
    $('td', row).eq(8).html(action_link);

}
xcDatatableRowHandlers.coinpay = xcDatatableRenderCoinpayRow;
function xcDatatableRenderCoinpayObligationRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// COINPAY obligation: who owes what native coin, expiring when. The row carries
// the LATEST status for the obligation, and no block time of its own (an
// ORDER_MATCH creates it, so eq(2) shows the payer instead of a timestamp).

    let payer      = data[2];
    let payee      = data[3];
    let owed_coin  = data[4];
    let owed       = data[5];
    let expiration = data[6];
    let pay_status = data[7];
    $('td', row).eq(2).html(isNull(payer) ? '-' : formatLink('/' + coin + '/address/' + payer, payer));
    $('td', row).eq(3).html(isNull(payee) ? '-' : formatLink('/' + coin + '/address/' + payee, payee));
    $('td', row).eq(4).text(isNull(owed_coin) ? '-' : owed_coin);
    $('td', row).eq(5).html(isNull(owed) ? '-' : formatAmount(owed));
    // expiration is a Unix TIMESTAMP (coinpay_obligations.expiration is a
    // BIGINT of seconds), not a block height, so it must not be rendered as
    // a block link: on regtest the value is nine digits against a tip in the
    // thousands, and the link resolves to a block that cannot exist.
    $('td', row).eq(6).html(isNull(expiration) ? '-' : formatLivestamp(expiration));
    $('td', row).eq(7).html('<span class="badge text-bg-secondary">' + escapeHtml(String(pay_status || '-')) + '</span>');
    $('td', row).eq(8).html(action_link);

}
xcDatatableRowHandlers.coinpay_obligation = xcDatatableRenderCoinpayObligationRow;
function xcDatatableRenderOrderExpireOrSwapExpireOrDispenserExpireRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// ORDER_EXPIRE / SWAP_EXPIRE / DISPENSER_EXPIRE: the protocol retiring an
// unfilled order, an unfilled swap, or a dispenser that reached its expiration
// height. All three carry the same shape - the expire action, plus a pointer at
// the record it retired - so one branch renders the pointer for each.

    let expired = data[4];
    $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
    $('td', row).eq(4).html(isNull(expired) ? '-' : formatLink('/' + coin + '/action/' + expired, expired));
    $('td', row).eq(5).html(action_link);

}
xcDatatableRowHandlers.order_expire = xcDatatableRenderOrderExpireOrSwapExpireOrDispenserExpireRow;
xcDatatableRowHandlers.swap_expire = xcDatatableRenderOrderExpireOrSwapExpireOrDispenserExpireRow;
xcDatatableRowHandlers.dispenser_expire = xcDatatableRenderOrderExpireOrSwapExpireOrDispenserExpireRow;
function xcDatatableRenderDispenserCloseRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// DISPENSER_CLOSE: the owner retiring a dispenser and taking back its remaining
// escrow. The give/get legs are the CLOSED dispenser's terms, and either leg may
// be a native coin, which carries NO tick - linking one builds /token/null, so an
// absent tick renders the coin name unlinked instead.

    let dispenser = data[4];
    let reason    = data[11];
    give_coin   = data[5];
    give_token  = data[6];
    give_amount = data[7];
    get_coin    = data[8];
    get_token   = data[9];
    get_amount  = data[10];
    $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
    $('td', row).eq(4).html(isNull(dispenser) ? '-' : formatLink('/' + coin + '/action/' + dispenser, dispenser));
    $('td', row).eq(5).html(formatCoinLegAmount(coin, give_coin, give_token, give_amount));
    $('td', row).eq(6).html(formatCoinLegAmount(coin, get_coin, get_token, get_amount));
    // 'empty' (the dispenser drained itself) and 'cancelled' (the owner withdrew
    // it) are indistinguishable in every other column, so they carry different
    // badge colours: a reader must be able to tell them apart without reading.
    $('td', row).eq(7).html(isNull(reason)
        ? '-'
        : '<span class="badge text-bg-' + ((String(reason)=='cancelled') ? 'warning' : 'secondary') + '">' + escapeHtml(String(reason)) + '</span>');
    $('td', row).eq(8).html(action_link);

}
xcDatatableRowHandlers.dispenser_close = xcDatatableRenderDispenserCloseRow;
function xcDatatableRenderOrderCancelOrSwapCancelOrDispenserCancelRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// ORDER_CANCEL / SWAP_CANCEL / DISPENSER_CANCEL: the owner pulling a live
// record off the book. All three carry the same shape - the cancel action, a
// pointer at the record it cancelled, and the memo explaining why - so one
// branch renders all three.

    let cancelled = data[4];
    let why       = data[5];
    $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
    $('td', row).eq(4).html(isNull(cancelled) ? '-' : formatLink('/' + coin + '/action/' + cancelled, cancelled));
    // .text(), not .html(): a memo is arbitrary on-chain bytes.
    $('td', row).eq(5).text(isNull(why) ? '-' : String(why));
    $('td', row).eq(6).html(action_link);

}
xcDatatableRowHandlers.order_cancel = xcDatatableRenderOrderCancelOrSwapCancelOrDispenserCancelRow;
xcDatatableRowHandlers.swap_cancel = xcDatatableRenderOrderCancelOrSwapCancelOrDispenserCancelRow;
xcDatatableRowHandlers.dispenser_cancel = xcDatatableRenderOrderCancelOrSwapCancelOrDispenserCancelRow;
function xcDatatableRenderOrderEditOrSwapEditRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// ORDER_EDIT / SWAP_EDIT: the owner amending a live record in place. The whole
// point of the row is WHAT CHANGED, so expiration and the allow/block lists are
// columns rather than detail-page-only fields. Each is nullable and a null means
// "this edit left that setting alone", which renders as a dash - dropping the
// column would hide the difference between an edit that cleared a list and one
// that never touched it. Zero is the removal sentinel and reads Removed; other
// allow_list/block_list values point at LIST actions and render as links.

    let edited     = data[4];
    let expiration = data[5];
    let allowList  = data[6];
    let blockList  = data[7];
    let why        = data[8];
    $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
    $('td', row).eq(4).html(isNull(edited) ? '-' : formatLink('/' + coin + '/action/' + edited, edited));
    // expiration is a Unix TIMESTAMP (seconds), the same field coinpay
    // obligations carry, not a block height.
    $('td', row).eq(5).html(isNull(expiration) ? '-' : formatLivestamp(expiration));
    $('td', row).eq(6).html(isNull(allowList) ? '-' : formatListReference(coin, allowList, true));
    $('td', row).eq(7).html(isNull(blockList) ? '-' : formatListReference(coin, blockList, true));
    $('td', row).eq(8).text(isNull(why) ? '-' : String(why));
    $('td', row).eq(9).html(action_link);

}
xcDatatableRowHandlers.order_edit = xcDatatableRenderOrderEditOrSwapEditRow;
xcDatatableRowHandlers.swap_edit = xcDatatableRenderOrderEditOrSwapEditRow;
function xcDatatableRenderDispenserEditRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// DISPENSER_EDIT: as above, plus give_escrow - a refill is the most common
// dispenser edit and moves ONLY the escrow, so that row carries a null
// expiration and a real escrow amount. Both must render on their own.

    let edited     = data[4];
    let escrow     = data[5];
    let expiration = data[6];
    let allowList  = data[7];
    let blockList  = data[8];
    let why        = data[9];
    $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
    $('td', row).eq(4).html(isNull(edited) ? '-' : formatLink('/' + coin + '/action/' + edited, edited));
    $('td', row).eq(5).text(isNull(escrow) ? '-' : formatAmount(escrow));
    $('td', row).eq(6).html(isNull(expiration) ? '-' : formatLivestamp(expiration));
    $('td', row).eq(7).html(isNull(allowList) ? '-' : formatListReference(coin, allowList, true));
    $('td', row).eq(8).html(isNull(blockList) ? '-' : formatListReference(coin, blockList, true));
    $('td', row).eq(9).text(isNull(why) ? '-' : String(why));
    $('td', row).eq(10).html(action_link);

}
xcDatatableRowHandlers.dispenser_edit = xcDatatableRenderDispenserEditRow;
function xcDatatableRenderCoinpayExpireRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// COINPAY_EXPIRE: an obligation nobody paid, closed out at its expiration. No
// user transaction writes it, so it carries no source of its own and slot 3
// holds the obligation it retired instead of an address.

    let obligation = data[3];
    $('td', row).eq(3).html(isNull(obligation) ? '-' : formatLink('/' + coin + '/action/' + obligation, obligation));
    $('td', row).eq(4).html(action_link);

}
xcDatatableRowHandlers.coinpay_expire = xcDatatableRenderCoinpayExpireRow;
function xcDatatableRenderValidatorCapabilityRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Per-validator per-capability qualification flags (hub-owned; id-keyed). qualified/
// self_test_ok/enabled are 0/1 flags rendered as yes/no badges.

    let updated_at   = data[1];
    let pubkey       = data[2];
    let capability   = data[3];
    let qualified    = data[4];
    let self_test_ok = data[5];
    let enabled      = data[6];
    let qual_block   = data[7];
    let yesno = (v) => '<span class="badge text-bg-' + (v == 1 ? 'success' : 'secondary') + '">' + (v == 1 ? 'Yes' : 'No') + '</span>';
    $('td', row).eq(1).html(formatLivestamp(updated_at));
    $('td', row).eq(2).html(formatHash(pubkey));
    $('td', row).eq(3).html('<span class="badge text-bg-info">' + escapeHtml(String(capability || '-')) + '</span>');
    $('td', row).eq(4).html(yesno(qualified));
    $('td', row).eq(5).html(yesno(self_test_ok));
    $('td', row).eq(6).html(yesno(enabled));
    $('td', row).eq(7).html(isNull(qual_block) ? '-' : formatLink('/' + coin + '/block/' + qual_block, numeral(qual_block).format(fmtInteger)));

}
xcDatatableRowHandlers.validator_capability = xcDatatableRenderValidatorCapabilityRow;
function xcDatatableRenderCapabilitySnapshotRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Capability snapshot (co-located checkpoint mirror; id-keyed): the HISTORICAL
// electorate behind the qualification view above. amount is a stake weight, not
// a token balance, so it is labelled rather than rendered as a bare number;
// source is the staking source the weight groups under, and is the empty string
// before stake-weighted-quorum activation, when only the qualifying count
// mattered.

    let snapshot_block = data[2];
    let capability     = data[3];
    let signing_pubkey = data[4];
    amount             = data[5];
    let source_key     = data[6];
    $('td', row).eq(1).html(formatLivestamp(data[1]));
    $('td', row).eq(2).html(isNull(snapshot_block) ? '-' : formatLink('/' + coin + '/block/' + snapshot_block, numeral(snapshot_block).format(fmtInteger)));
    $('td', row).eq(3).html('<span class="badge text-bg-info">' + escapeHtml(capability || '-') + '</span>');
    $('td', row).eq(4).html(isNull(signing_pubkey) ? '-' : formatHash(signing_pubkey));
    $('td', row).eq(5).html(isNull(amount) ? '-' : formatAmount(bcformat(amount, 8)) + ' stake weight');
    $('td', row).eq(6).text(isNull(source_key) || source_key === '' ? '-' : source_key);

}
xcDatatableRowHandlers.capability_snapshot = xcDatatableRenderCapabilitySnapshotRow;
function xcDatatableRenderAttestValidatorStatRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Per-validator per-provider ATTEST accountability counters (indexer-owned; no
// action row, so no status badge and no action link - this sits in the no-color
// list above). slashed_count and quality_score are Phase 4 columns that read 0
// on every venue today (no producer yet), still surfaced so the column is ready
// when one ships.

    let pubkey     = data[1];
    let provider   = data[2];
    let fulfilled  = data[3];
    let missed     = data[4];
    let slashed    = data[5];
    let quality    = data[6];
    let lastBlock  = data[7];
    $('td', row).eq(1).html(formatHash(pubkey));
    $('td', row).eq(2).html('<span class="badge text-bg-info">' + escapeHtml(provider || '-') + '</span>');
    $('td', row).eq(3).text(isNull(fulfilled) ? '-' : numeral(fulfilled).format(fmtInteger));
    $('td', row).eq(4).html('<span class="badge text-bg-' + (Number(missed) > 0 ? 'warning' : 'secondary') + '">' + (isNull(missed) ? '-' : numeral(missed).format(fmtInteger)) + '</span>');
    $('td', row).eq(5).html('<span class="badge text-bg-' + (Number(slashed) > 0 ? 'danger' : 'secondary') + '">' + (isNull(slashed) ? '-' : numeral(slashed).format(fmtInteger)) + '</span>');
    let qClass = (Number(quality) >= 0.9) ? 'success' : (Number(quality) >= 0.5) ? 'warning' : 'danger';
    $('td', row).eq(6).html(isNull(quality) ? '-' : '<span class="badge text-bg-' + qClass + '">' + numeral(quality).format('0.0000') + '</span>');
    $('td', row).eq(7).html(isNull(lastBlock) ? '-' : formatLink('/' + coin + '/block/' + lastBlock, numeral(lastBlock).format(fmtInteger)));

}
xcDatatableRowHandlers.attest_validator_stat = xcDatatableRenderAttestValidatorStatRow;
function xcDatatableRenderGovernanceProposalRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Governance parameter proposal (hub-owned; id-keyed). proposal_id links the votes view.

    let proposal_id    = data[1];
    let parameter      = data[2];
    let current_value  = data[3];
    let proposed_value = data[4];
    let pstatus        = data[5];
    let voting_end     = data[6];
    let activation     = data[7];
    let proposer       = data[8];
    $('td', row).eq(1).html(isNull(proposal_id) ? '-' : formatLink('/' + coin + '/governance_votes/' + proposal_id + '/proposal', proposal_id));
    $('td', row).eq(2).text(isNull(parameter) ? '-' : parameter);
    $('td', row).eq(3).text(isNull(current_value) ? '-' : current_value);
    $('td', row).eq(4).text(isNull(proposed_value) ? '-' : proposed_value);
    $('td', row).eq(5).html('<span class="badge text-bg-secondary">' + escapeHtml(String(pstatus || '-')) + '</span>');
    $('td', row).eq(6).html(formatLivestamp(voting_end));
    $('td', row).eq(7).html(isNull(activation) ? '-' : formatLink('/' + coin + '/block/' + activation, numeral(activation).format(fmtInteger)));
    $('td', row).eq(8).html(formatHash(proposer));

}
xcDatatableRowHandlers.governance_proposal = xcDatatableRenderGovernanceProposalRow;
function xcDatatableRenderGovernanceVoteRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Per-validator governance vote (hub-owned; id-keyed). approve=green, reject=red badge.

    let created_at  = data[1];
    let proposal_id = data[2];
    let voter       = data[3];
    let vote        = data[4];
    $('td', row).eq(1).html(formatLivestamp(created_at));
    $('td', row).eq(2).html(isNull(proposal_id) ? '-' : formatLink('/' + coin + '/governance_votes/' + proposal_id + '/proposal', proposal_id));
    $('td', row).eq(3).html(formatHash(voter));
    $('td', row).eq(4).html('<span class="badge text-bg-' + (vote == 'approve' ? 'success' : 'danger') + '">' + escapeHtml(String(vote || '-')) + '</span>');

}
xcDatatableRowHandlers.governance_vote = xcDatatableRenderGovernanceVoteRow;
function xcDatatableRenderPeerRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Hub P2P peer roster (hub-owned; id-keyed). is_seed rendered as a badge.

    let last_seen    = data[1];
    let addr         = data[2];
    let validator_id = data[3];
    let is_seed      = data[4];
    $('td', row).eq(1).html(isNull(last_seen) ? '-' : formatLivestamp(last_seen));
    $('td', row).eq(2).text(isNull(addr) ? '-' : addr);
    $('td', row).eq(3).html(isNull(validator_id) ? '-' : formatHash(validator_id));
    $('td', row).eq(4).html(is_seed == 1
        ? '<span class="badge text-bg-primary">Seed</span>'
        : '<span class="badge text-bg-secondary">Peer</span>');

}
xcDatatableRowHandlers.peer = xcDatatableRenderPeerRow;
function xcDatatableRenderConsensusStateRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Hub consensus key/value state (hub-owned; id-keyed).

    let updated_at = data[1];
    let key_name   = data[2];
    value          = data[3];
    $('td', row).eq(1).html(isNull(updated_at) ? '-' : formatLivestamp(updated_at));
    $('td', row).eq(2).html('<span class="badge text-bg-info">' + (isNull(key_name) ? '-' : escapeHtml(String(key_name))) + '</span>');
    $('td', row).eq(3).html(isNull(value) ? '-' : '<code>' + escapeHtml(String(value)) + '</code>');

}
xcDatatableRowHandlers.consensus_state = xcDatatableRenderConsensusStateRow;
function xcDatatableRenderConfigRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Hub config-oracle parameter store (hub-owned; id-keyed).

    let updated_at  = data[1];
    let coin_col    = data[2];
    let network_col = data[3];
    let module_col  = data[4];
    let param_name  = data[5];
    let param_value = data[6];
    $('td', row).eq(1).html(isNull(updated_at) ? '-' : formatLivestamp(updated_at));
    $('td', row).eq(2).text(isNull(coin_col) ? '-' : coin_col);
    $('td', row).eq(3).text(isNull(network_col) ? '-' : network_col);
    $('td', row).eq(4).html('<span class="badge text-bg-secondary">' + (isNull(module_col) ? '-' : escapeHtml(String(module_col))) + '</span>');
    $('td', row).eq(5).text(isNull(param_name) ? '-' : param_name);
    $('td', row).eq(6).html(isNull(param_value) ? '-' : '<code>' + escapeHtml(String(param_value)) + '</code>');

}
xcDatatableRowHandlers.config = xcDatatableRenderConfigRow;
function xcDatatableRenderTelemetryPingRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Anonymous xchain-node telemetry ping (hub-owned; id-keyed).

    let created_at   = data[1];
    let event        = data[2];
    let node_version = data[3];
    let os_platform  = data[4];
    let arch         = data[5];
    let country      = data[6];
    let region       = data[7];
    $('td', row).eq(1).html(isNull(created_at) ? '-' : formatLivestamp(created_at));
    $('td', row).eq(2).html('<span class="badge text-bg-info">' + (isNull(event) ? '-' : escapeHtml(String(event))) + '</span>');
    $('td', row).eq(3).text(isNull(node_version) ? '-' : node_version);
    $('td', row).eq(4).text(isNull(os_platform) ? '-' : os_platform);
    $('td', row).eq(5).text(isNull(arch) ? '-' : arch);
    let loc = [country, region].filter(v => !isNull(v) && v !== '').join(' / ');
    $('td', row).eq(6).text(loc || '-');

}
xcDatatableRowHandlers.telemetry_ping = xcDatatableRenderTelemetryPingRow;
