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
function xcDatatableRenderUnstakeRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Capability unstake (UNSTAKE v0; begins the global cooldown on a staked key)

    let pubkey       = data[4];
    amount           = data[5];
    let cooldown_end = data[6];
    $('td', row).eq(4).html(formatHash(pubkey));
    $('td', row).eq(5).html(formatAmount(amount));
    $('td', row).eq(6).html(formatLink('/' + coin + '/block/' + cooldown_end, numeral(cooldown_end).format(fmtInteger)));
    $('td', row).eq(7).html(action_link);

}
xcDatatableRowHandlers.unstake = xcDatatableRenderUnstakeRow;
function xcDatatableRenderDelegationRevocationRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Delegate key revocation (DELEGATE v2/v3; stake_key_revocations)

    let pubkey       = data[4];
    let deactivation = data[5];
    $('td', row).eq(4).html(formatHash(pubkey));
    $('td', row).eq(5).html(formatLink('/' + coin + '/block/' + deactivation, numeral(deactivation).format(fmtInteger)));
    $('td', row).eq(6).html(action_link);

}
xcDatatableRowHandlers.delegation_revocation = xcDatatableRenderDelegationRevocationRow;
function xcDatatableRenderCapabilitySlashEventRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Capability equivocation slash (SLASH wire action; capability_slash_events). No row
// color (no status); the view links to the SLASH action via slash_action_index.

    let pubkey             = data[3];
    let capability         = data[4];
    amount                 = data[5];
    let submitter          = data[6];
    let slash_action_index = data[7];
    $('td', row).eq(3).html(formatHash(pubkey));
    $('td', row).eq(4).html('<span class="badge text-bg-secondary">' + escapeHtml(String(capability || '-')) + '</span>');
    $('td', row).eq(5).html(formatAmount(amount));
    $('td', row).eq(6).html(isNull(submitter) ? '-' : formatLink('/' + coin + '/address/' + submitter, submitter));
    $('td', row).eq(7).html(formatLink('/' + coin + '/action/' + slash_action_index, 'view', null, true));

}
xcDatatableRowHandlers.capability_slash_event = xcDatatableRenderCapabilitySlashEventRow;
function xcDatatableRenderOraclePriceRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// User token/fiat oracle row (PRICE v1; hub-mirrored, cross-chain). eq(1)/eq(2) override
// the generic block/time columns (no local block on a mirror row).

    let block_time    = data[1];
    let source_chain  = data[2];
    let source_address = data[3];
    token             = data[4];
    let fiat          = data[5];
    value             = data[6];
    $('td', row).eq(1).html(formatLivestamp(block_time));
    $('td', row).eq(2).text(isNull(source_chain) ? '-' : source_chain);
    $('td', row).eq(3).html(isNull(source_address) ? '-' : formatLink('/' + coin + '/address/' + source_address, source_address));
    $('td', row).eq(4).html(formatLink(tokenUrl(coin, token), token, token));
    $('td', row).eq(5).text(isNull(fiat) ? '-' : fiat);
    $('td', row).eq(6).html(formatAmount(bcformat(value, 2)));

}
xcDatatableRowHandlers.oracle_price = xcDatatableRenderOraclePriceRow;
function xcDatatableRenderAnchorRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Anchor (DOGE state checkpoint). eq(3) overrides the generic source link with the chain.

    let chain          = data[3];
    let network        = data[4];
    let version        = data[5];
    let checkpoint_seq = data[6];
    let snapshot_block = data[7];
    let match_count    = data[8];
    $('td', row).eq(3).text(isNull(chain) ? '-' : chain);
    $('td', row).eq(4).text(isNull(network) ? '-' : network);
    $('td', row).eq(5).text('v' + version);
    $('td', row).eq(6).html(numeral(checkpoint_seq).format(fmtInteger));
    $('td', row).eq(7).html(isNull(snapshot_block) ? '-' : formatLink('/' + coin + '/block/' + snapshot_block, numeral(snapshot_block).format(fmtInteger)));
    $('td', row).eq(8).html(numeral(match_count).format(fmtInteger));
    $('td', row).eq(9).html(action_link);

}
xcDatatableRowHandlers.anchor = xcDatatableRenderAnchorRow;
function xcDatatableRenderRewardRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Validator reward (validator_rewards; id-keyed accrual ledger, no own action_index)

    let pubkey      = data[4];
    let reward_type = data[5];
    amount          = data[6];
    $('td', row).eq(4).html(formatHash(pubkey));
    $('td', row).eq(5).html('<span class="badge text-bg-secondary">' + escapeHtml(String(reward_type || '-')) + '</span>');
    $('td', row).eq(6).html(formatAmount(amount));

}
xcDatatableRowHandlers.reward = xcDatatableRenderRewardRow;
function xcDatatableRenderDelegationRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Delegation (DELEGATE v0/v1/v2/v3 signing-key delegation)

    let pubkey = data[4];
    $('td', row).eq(4).html(formatHash(pubkey));
    $('td', row).eq(5).html(action_link);

}
xcDatatableRowHandlers.delegation = xcDatatableRenderDelegationRow;
function xcDatatableRenderFullNodeVerificationRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Full-node verification (NODEPROOF v0 possession-proof verdict). eq(3) overrides the
// generic source link with the verified pubkey; eq(7) badges the pass/fail result.

    let pubkey         = data[3];
    let staking_source = data[4];
    let epoch_height   = data[5];
    let target_height  = data[6];
    let passed         = data[8];
    $('td', row).eq(3).html(formatHash(pubkey));
    $('td', row).eq(4).html(isNull(staking_source) ? '-' : formatLink('/' + coin + '/address/' + staking_source, staking_source));
    $('td', row).eq(5).html(numeral(epoch_height).format(fmtInteger));
    $('td', row).eq(6).html(numeral(target_height).format(fmtInteger));
    $('td', row).eq(7).html('<span class="badge text-bg-' + (passed == 1 ? 'success' : 'danger') + '">' + (passed == 1 ? 'Pass' : 'Fail') + '</span>');
    $('td', row).eq(8).html(action_link);

}
xcDatatableRowHandlers.full_node_verification = xcDatatableRenderFullNodeVerificationRow;
function xcDatatableRenderCrossChainMatchRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Cross-chain DEX match (hub-mirrored; id-keyed, no per-row view link). eq(1) keeps the
// generic block link (snapshot_block); eq(2)/eq(3) override network/match_id.

    let network  = data[2];
    let match_id = data[3];
    let a_chain  = data[4];
    let a_tick   = data[5];
    let a_amount = data[6];
    let b_chain  = data[7];
    let b_tick   = data[8];
    let b_amount = data[9];
    let mstatus  = data[10];
    $('td', row).eq(2).text(isNull(network) ? '-' : network);
    $('td', row).eq(3).html(isNull(match_id) ? '-' : formatHash(match_id));
    $('td', row).eq(4).text(isNull(a_chain) ? '-' : a_chain);
    $('td', row).eq(5).html(isNull(a_tick) ? '-' : formatLink(tokenUrl(coin, a_tick), a_tick, a_tick));
    $('td', row).eq(6).html(formatAmount(a_amount));
    $('td', row).eq(7).text(isNull(b_chain) ? '-' : b_chain);
    $('td', row).eq(8).html(isNull(b_tick) ? '-' : formatLink(tokenUrl(coin, b_tick), b_tick, b_tick));
    $('td', row).eq(9).html(formatAmount(b_amount));
    $('td', row).eq(10).html('<span class="badge text-bg-secondary">' + escapeHtml(String(mstatus || '-')) + '</span>');

}
xcDatatableRowHandlers.cross_chain_match = xcDatatableRenderCrossChainMatchRow;
function xcDatatableRenderCrossChainSettlementRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Cross-chain settlement leg (local action-chain row; view links the settlement action)

    let match_id           = data[3];
    let local_action_index = data[4];
    $('td', row).eq(3).html(isNull(match_id) ? '-' : formatHash(match_id));
    $('td', row).eq(4).html(isNull(local_action_index) ? '-' : formatLink('/' + coin + '/action/' + local_action_index, local_action_index));
    $('td', row).eq(5).html(action_link);

}
xcDatatableRowHandlers.cross_chain_settlement = xcDatatableRenderCrossChainSettlementRow;
function xcDatatableRenderCheckpointRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Quorum-signed state checkpoint (hub-mirrored). No action row, so the last
// column drills into the checkpoint detail page by height rather than into an
// action, and signer_count is a plain count: the signature VERDICT costs an
// Ed25519 pass per signer and is only computed when the detail page's Verify
// control asks for it.

    let checkpoint_seq = data[3];
    let snapshot_block = data[4];
    let state_root     = data[5];
    let merkle_root    = data[6];
    let signer_count   = data[7];
    $('td', row).eq(3).text(isNull(checkpoint_seq) ? '-' : checkpoint_seq);
    $('td', row).eq(4).html(isNull(snapshot_block) ? '-' : formatLink('/' + coin + '/block/' + snapshot_block, numeral(snapshot_block).format(fmtInteger)));
    $('td', row).eq(5).html(isNull(state_root) ? '-' : formatHash(state_root));
    $('td', row).eq(6).html(isNull(merkle_root) ? '-' : formatHash(merkle_root));
    $('td', row).eq(7).text(isNull(signer_count) ? '-' : signer_count);
    $('td', row).eq(8).html(formatLink('/' + coin + '/checkpoint/' + block_index, 'view', null, true));

}
xcDatatableRowHandlers.checkpoint = xcDatatableRenderCheckpointRow;
function xcDatatableRenderCommitmentRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Per-block SPV commitments (state_tree_roots) plus the covering checkpoint
// and the ANCHOR that carried it. checkpoint_seq/anchor_action are null when
// neither exists YET, the normal state near the tip, so both render as a
// neutral badge rather than an error or a blank. Height is plain text, this
// section always sitting on the block it describes.

    let height              = data[1];
    let balances_root       = data[2];
    let stakes_root         = data[3];
    let commit_state_root   = data[4];
    let merkle_root         = data[5];
    let contract_state_root = data[6];
    let checkpoint_seq      = data[7];
    let checkpoint_signers  = data[8];
    let anchor_action       = data[9];
    let anchor_version      = data[10];
    $('td', row).eq(1).text(numeral(height).format(fmtInteger));
    $('td', row).eq(2).html(formatHash(balances_root));
    $('td', row).eq(3).html(formatHash(stakes_root));
    $('td', row).eq(4).html(formatHash(commit_state_root));
    $('td', row).eq(5).html(formatHash(merkle_root));
    $('td', row).eq(6).html(isNull(contract_state_root) ? '<span class="text-muted">Not armed</span>' : formatHash(contract_state_root));
    $('td', row).eq(7).html(isNull(checkpoint_seq)
        ? '<span class="badge text-bg-secondary">Not yet checkpointed</span>'
        : 'Seq ' + numeral(checkpoint_seq).format(fmtInteger) + ' &middot; ' +
          numeral(isNull(checkpoint_signers) ? 0 : checkpoint_signers).format(fmtInteger) + ' signers ' +
          formatLink('/' + coin + '/checkpoint/' + height, 'view', null, true));
    $('td', row).eq(8).html(isNull(anchor_action)
        ? '<span class="badge text-bg-secondary">Not yet anchored</span>'
        : 'ANCHOR v' + numeral(anchor_version).format('0') + ' ' +
          formatLink('/' + coin + '/action/' + anchor_action, 'view', null, true));

}
xcDatatableRowHandlers.commitment = xcDatatableRenderCommitmentRow;
function xcDatatableRenderPriceSnapshotRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Validator PBFT price round (hub-mirrored, id-keyed). reference_block names a
// height on reference_chain, which is not necessarily this coin's chain, so it
// stays plain text rather than becoming a local block link.

    let block_timestamp = data[1];
    let reference_block = data[2];
    let reference_chain = data[3];
    let coin_pair       = data[4];
    let price           = data[5];
    let validators      = data[6];
    let round           = data[7];
    let round_status    = data[8];
    $('td', row).eq(1).html(formatLivestamp(block_timestamp));
    $('td', row).eq(2).text(isNull(reference_block) ? '-' : numeral(reference_block).format(fmtInteger));
    $('td', row).eq(3).text(isNull(reference_chain) ? '-' : reference_chain);
    $('td', row).eq(4).text(isNull(coin_pair) ? '-' : coin_pair);
    $('td', row).eq(5).text(isNull(price) ? '-' : formatAmount(bcformat(price, 2)));
    $('td', row).eq(6).text(isNull(validators) ? '-' : validators);
    $('td', row).eq(7).text(isNull(round) ? '-' : round);
    $('td', row).eq(8).html('<span class="badge text-bg-secondary">' + escapeHtml(String(round_status || '-')) + '</span>');

}
xcDatatableRowHandlers.price_snapshot = xcDatatableRenderPriceSnapshotRow;
function xcDatatableRenderEmissionRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Per-contract emission rollup. Execution and Child Action link to their own
// action detail pages; Child Action is null for an internal emission (e.g.
// SLASH) that moves ledger state without minting a new on-wire action.

    let execution_index = data[3];
    let contract_index  = data[4];
    let position        = data[5];
    let emitted_action  = data[6];
    let child_action    = data[7];
    let emission_status = data[8];
    $('td', row).eq(3).html(isNull(execution_index) ? '-' : formatLink('/' + coin + '/action/' + execution_index, numeral(execution_index).format(fmtInteger)));
    $('td', row).eq(4).html(isNull(contract_index) ? '-' : formatLink('/' + coin + '/contract/' + contract_index, contract_index));
    $('td', row).eq(5).text(isNull(position) ? '-' : position);
    $('td', row).eq(6).html(isNull(emitted_action) ? '-' : '<span class="badge text-bg-secondary">' + escapeHtml(emitted_action) + '</span>');
    $('td', row).eq(7).html(isNull(child_action) ? '<span class="text-muted">internal</span>' : formatLink('/' + coin + '/action/' + child_action, numeral(child_action).format(fmtInteger)));
    $('td', row).eq(8).html('<span class="badge text-bg-' + (emission_status=='valid' ? 'success' : 'danger') + '">' + escapeHtml(emission_status || '-') + '</span>');

}
xcDatatableRowHandlers.emission = xcDatatableRenderEmissionRow;
function xcDatatableRenderReorgRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Cross-chain reorg attestation (hub-owned, id-keyed). reorg_height is THIS
// coin's own chain height (both transports scope to it), so it links to the
// local block page. reorg_timestamp is stored in MILLISECONDS, unlike
// price_snapshot's block_timestamp above, which is Unix seconds, so it is
// divided down before formatLivestamp. The status word is renamed here to avoid
// shadowing the positional `status` destructured at the top of createdRow.

    let reorg_timestamp = data[1];
    let reorg_height    = data[2];
    let reorg_id        = data[3];
    let affected_chains = data[4];
    let validator_count = data[5];
    let reorg_status    = data[6];
    let chains = [], chainsError = null;
    if(!isNull(affected_chains)) try { chains = JSON.parse(affected_chains); if(!Array.isArray(chains)) chainsError = 'expected a JSON array'; }
    catch(e){ chainsError = e && e.message ? e.message : 'could not parse JSON'; }
    let chainsHtml = Array.isArray(chains) ? chains.map((chain, i) => typeof chain === 'string' && chain.length
        ? escapeHtml(chain) : '<span class="text-danger">entry ' + (i + 1) + ': invalid chain name</span>').join(', ') : '';
    $('td', row).eq(1).html(isNull(reorg_timestamp) ? '-' : formatLivestamp(Math.floor(reorg_timestamp / 1000)));
    $('td', row).eq(2).html(isNull(reorg_height) ? '-' : formatLink('/' + coin + '/block/' + reorg_height, numeral(reorg_height).format(fmtInteger)));
    $('td', row).eq(3).html(isNull(reorg_id) ? '-' : formatHash(reorg_id, 24));
    $('td', row).eq(4).html(chainsError ? '<span class="text-danger">Invalid affected_chains: ' + escapeHtml(chainsError) + '</span>' : (chainsHtml || '-'));
    $('td', row).eq(5).text(isNull(validator_count) ? '-' : validator_count);
    $('td', row).eq(6).html('<span class="badge text-bg-' + (reorg_status=='confirmed' ? 'success' : 'danger') + '">' + escapeHtml(reorg_status || '-') + '</span>');

}
xcDatatableRowHandlers.reorg = xcDatatableRenderReorgRow;
function xcDatatableRenderSlashProposalRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Federation slash proposal (hub-owned, id-keyed). These rows are EVIDENCE,
// not enforcement, so 'pending' is badged NEUTRAL and labelled
// 'unadjudicated': red on an unadjudicated accusation reads as a verdict.
// 'rejected' means DISMISSED, the cleared state rather than a failure.

// evidence_hash is the sha256 of the evidence the hub holds, never served
// verbatim, and is shown so a holder of an evidence record can check it
// matches. The status word is renamed to avoid shadowing the positional
// `status` destructured at the top of createdRow.

    let created_at       = data[1];
    let validator_pubkey = data[2];
    let offense_type     = data[3];
    let round_number     = data[4];
    let evidence_hash    = data[5];
    let slash_status     = data[6];
    let badges = { pending: 'secondary', approved: 'danger', rejected: 'success', expired: 'secondary' };
    let labels = { pending: 'pending (unadjudicated)', approved: 'approved (penalty applied)', rejected: 'rejected (dismissed)', expired: 'expired' };
    $('td', row).eq(1).html(isNull(created_at) ? '-' : formatLivestamp(created_at));
    $('td', row).eq(2).html(isNull(validator_pubkey) ? '-' : formatHash(validator_pubkey));
    $('td', row).eq(3).text(isNull(offense_type) ? '-' : String(offense_type).replace(/_/g, ' '));
    $('td', row).eq(4).html(isNull(round_number) ? '-' : numeral(round_number).format(fmtInteger));
    $('td', row).eq(5).html(isNull(evidence_hash) ? '-' : formatHash(evidence_hash, 24));
    $('td', row).eq(6).html('<span class="badge text-bg-' + (badges[slash_status] || 'secondary') + '">' +
        escapeHtml(labels[slash_status] || slash_status || '-') + '</span>');

}
xcDatatableRowHandlers.slash_proposal = xcDatatableRenderSlashProposalRow;
function xcDatatableRenderContractDelegationRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// Contract-targeted stake delegation. deactivation_block is null while the
// delegation is live, which is the difference between a current delegation and
// a historical one, so it renders as a dash rather than being hidden.

    let signing_pubkey  = data[4];
    let contract_index  = data[5];
    let tick            = data[6];
    let activation      = data[7];
    let deactivation    = data[8];
    $('td', row).eq(4).html(isNull(signing_pubkey) ? '-' : formatHash(signing_pubkey));
    $('td', row).eq(5).html(isNull(contract_index) ? '-' : formatLink('/' + coin + '/contract/' + contract_index, contract_index));
    $('td', row).eq(6).html(isNull(tick) ? '-' : formatLink(tokenUrl(coin, tick), tick, tick));
    $('td', row).eq(7).text(isNull(activation) ? '-' : numeral(activation).format(fmtInteger));
    $('td', row).eq(8).text(isNull(deactivation) ? '-' : numeral(deactivation).format(fmtInteger));
    $('td', row).eq(9).html(action_link);

}
xcDatatableRowHandlers.contract_delegation = xcDatatableRenderContractDelegationRow;
function xcDatatableRenderVoteDelegationRow(context){
    let { row, data, idx, coin, action, type, action_index, status, count, block_index, block_index2, timestamp, source, destination, token, token2, amount, amount2, amount3, coin_index, coin2, coin2_index2, message, value, fee, locks, memo, edit, type2, txt, html, fmtInteger, fmtCurrency, fmtCoin, action_link, block_link, source_link } = context;

// VOTE v3 liquid-democracy delegation. The row is already the LIVE delegation
// for its (tick, delegator): revoked and re-pointed rows are excluded
// server-side, never here. The trailing view button opens the VOTE v3 action
// detail, where the single-action join renders the delegation itself.

    let tick      = data[3];
    let delegator = data[4];
    let delegate  = data[5];
    $('td', row).eq(3).html(isNull(tick) ? '-' : formatLink(tokenUrl(coin, tick), tick, tick));
    $('td', row).eq(4).html(isNull(delegator) ? '-' : formatLink('/' + coin + '/address/' + delegator, delegator));
    $('td', row).eq(5).html(isNull(delegate) ? '-' : formatLink('/' + coin + '/address/' + delegate, delegate));
    $('td', row).eq(6).html(action_link);

}
xcDatatableRowHandlers.vote_delegation = xcDatatableRenderVoteDelegationRow;
