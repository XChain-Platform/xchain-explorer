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
 *
 * XChain Explorer - explorer row shapes for the governance and mirror feeds
 *
 * Every step below takes the row the database returned and the render context `c`,
 * and hands back either the array the client draws or the row untouched. The steps
 * run in the order the branches ran when they sat inline in one method, and only
 * the branch naming this request's method rewrites the row, so chaining them is
 * the same pass it always was.
 *
 * The context carries what the enclosing loop worked out per row: the display
 * counts, the 0/1 action status, the packed lock and per-block action strings, the
 * formatted amount/percent/value, the method name and the request config, plus the
 * utility helper two branches need. Each step names the ones it uses on its first
 * line, so every branch below reads exactly as it read inline.
 *
 * This half covers the pages fed by something other than a plain action row: the
 * vote and bet markets, the cross-chain and checkpoint feeds, the hub-mirrored
 * governance and operational tables, and the search panel.
 *
 ********************************************************************/

'use strict';

function parentLabel(index, encoded, separator){
    if(index === null || index === undefined || encoded === null || encoded === undefined) return null;
    let labels = encoded;
    if(typeof labels == 'string'){
        if(separator){
            labels = labels.split(separator).map(label => label.trim());
        } else {
            try { labels = JSON.parse(labels); }
            catch(_){ labels = null; }
        }
    }
    return Array.isArray(labels) && labels[index] !== null && labels[index] !== undefined
        ? String(labels[index]) : null;
}

function voteAndBetRows(info, c){
    let { count_reverse, status, method, util } = c;
    // VOTE poll list page. poll_status (lifecycle enum), end_block (close
    // height) and callback_contract_index (non-null = binding poll: the
    // result fires a contract method) are rendered columns; status (0/1
    // action validity) + action_index stay LAST for the client's generic
    // row-color + paging-cursor extraction (data[len-2]/data[len-1]).
    // WINNER: polls.winning_option is an INDEX into the poll's options, so
    // option 0 is a real winner and only a null means "no outcome recorded".
    // The query has always selected it and this branch dropped it, leaving
    // the one field a reader opens a finished poll to see with no column at
    // all. It rides as the raw index PLUS the label resolved off the stored
    // options JSON, because the feed carries no options array and a bare
    // index names nothing to a reader.
    if(method=='getPolls'){
        let win = util.isNull(info.winning_option) ? null : Number(info.winning_option);
        if(win !== null && !Number.isFinite(win)) win = null;
        let winner = null;
        if(win !== null){
            let opts = info.options;
            if(typeof opts == 'string'){
                // getPolls hands back the stored JSON verbatim; a malformed
                // blob costs the label, never the index.
                try { opts = JSON.parse(opts); }
                catch(_){ opts = null; }
            }
            if(Array.isArray(opts) && !util.isNull(opts[win]))
                winner = String(opts[win]);
        }
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.question, info.poll_status, info.end_block, info.callback_contract_index, win, winner, status, info.action_index];
    }
    // VOTE ballot list page. One row per (poll, voter, chosen option); the voter
    // is the source. action_index stays LAST (paging cursor; links the ballot action).
    if(method=='getVotes')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.poll_index, info.choice,
            parentLabel(info.choice, info.poll_options), info.share, status, info.action_index];
    // VOTE v3 liquid-democracy delegations. The row IS already the live
    // delegation for its (tick, delegator): getVoteDelegations' correlated MAX
    // excludes every superseded, re-pointed or cleared row before this runs, so
    // no further live/revoked filtering happens here. Carries a real 0/1 action
    // status and an action_index, so it takes the standard colored,
    // view-button row shape.
    if(method=='getVoteDelegations')
        info = [count_reverse, info.block_index, info.timestamp, info.tick, info.delegator, info.delegate, status, info.action_index];
    // BET market list page. The feed id IS action_index, which stays LAST
    // (the datatables client uses it as the paging offset cursor). Label is
    // attacker-controlled and is escaped client-side before it reaches the DOM.
    if(method=='getBetFeeds')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.label, info.feed_status, info.deadline, status, info.action_index];
    return info;
}

function crossChainRows(info, c){
    let { count_reverse, status, method } = c;
    // BET wager list page. One row per placed bet; the bettor is the source.
    if(method=='getBets')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.feed_action_index, info.outcome,
            parentLabel(info.outcome, info.outcomes, ','), info.tick, info.amount, info.bet_status, status, info.action_index];
    // XCALL cross-chain call list page (source request rows). action_index stays
    // LAST (the datatables client uses it as the paging offset cursor).
    if(method=='getXcalls')
        info = [count_reverse, info.block_index, info.timestamp, info.contract_index, info.target_chain, info.target_contract_index, info.method, info.request_status, status, info.action_index];
    // ANCHOR checkpoint list page. action_index stays LAST (paging cursor).
    if(method=='getAnchors')
        info = [count_reverse, info.block_index, info.timestamp, info.chain, info.network, info.version, info.checkpoint_seq, info.snapshot_block, info.match_count, status, info.action_index];
    // Cross-chain DEX match (hub-mirrored, id-keyed). id is the paging cursor (LAST);
    // snapshot_block is the BTC-anchored quorum block. No status coloring (status is a
    // word, not 0/1); the render badges it instead.
    if(method=='getCrossChainMatches')
        info = [count_reverse, info.snapshot_block, info.network, info.match_id, info.a_chain, info.a_tick, info.a_amount, info.b_chain, info.b_tick, info.b_amount, info.status, info.id];
    // Quorum-signed state checkpoints (hub-mirrored). No action row and no
    // 0/1 status, so block_index doubles as the paging cursor (LAST) and the
    // client renders this action in its no-color list. signer_count is the
    // signature count the list shows without verifying anything; the verdict
    // costs an Ed25519 pass per signer and lives behind the detail page's
    // Verify control instead.
    if(method=='getCheckpoints')
        info = [count_reverse, info.block_index, info.created_at, info.checkpoint_seq, info.snapshot_block, info.state_root, info.block_merkle_root, info.signer_count, info.block_index];
    // Per-block SPV commitments (state_tree_roots, id-keyed - no action_index).
    // The checkpoint_/anchor_ fields are NULL when this block has no covering
    // checkpoint yet or no carrying ANCHOR yet, both normal near the tip rather
    // than errors; the client renders those as a neutral pending badge.
    // m.block_index doubles as the paging cursor (LAST), same as getCheckpoints.
    if(method=='getCommitments')
        info = [count_reverse, info.block_index, info.balances_root, info.stakes_root, info.state_root, info.block_merkle_root, info.contract_state_root, info.checkpoint_seq, info.checkpoint_signer_count, info.anchor_action_index, info.anchor_version, info.block_index];
    // Quorum-attested ANCHOR publisher rewards (hub-mirrored, id-keyed,
    // never routed through HubOperationalCache; see checkpointSource).
    // id is the paging cursor (LAST).

    // doge_anchor_txid lands second-to-last, so anchor_reward_attestation
    // sits in the no-color exclusion list: it is the mined DOGE transaction
    // the reward is proof-bound to, not a status. reward_amount (audit-only)
    // and publisher_attestations (raw quorum JSON) are not carried.
    if(method=='getAnchorRewardAttestations')
        info = [count_reverse, info.created_at, info.chain, info.network, info.reward_type, info.round_reference, info.snapshot_block, info.publisher, info.doge_anchor_txid, info.id];
    // Capability snapshots: the historical electorate behind those checkpoints
    // (which signing key carried which stake weight for a capability at a
    // snapshot block). id is the paging cursor (LAST); source is second-to-last
    // and carries the staking source the weight groups under (empty before
    // stake-weighted-quorum activation), not a status, so this action is in the
    // client's no-color list.
    if(method=='getCapabilitySnapshots')
        info = [count_reverse, info.created_at, info.snapshot_block, info.capability, info.signing_pubkey, info.amount, info.source, info.id];
    return info;
}

function mirrorAndExpiryRows(info, c){
    let { count_reverse, status, method } = c;
    // Validator PBFT COIN/FIAT price rounds (hub-mirrored, id-keyed). id is the
    // paging cursor (LAST); status is a round-lifecycle word, not 0/1, so this
    // action sits in the client's no-color list.
    if(method=='getPriceSnapshots')
        info = [count_reverse, info.block_timestamp, info.reference_block, info.reference_chain, info.coin_pair, info.price, info.validator_count, info.consensus_round, info.status, info.id];
    // Contract-targeted stake delegations. Carries both a 0/1 action status and
    // an action_index, so it takes the standard colored-row shape.
    if(method=='getContractDelegations')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.target_contract_index, info.tick, info.activation_block, info.deactivation_block, status, info.action_index];
    // Cross-chain reorg attestations (hub-owned, id-keyed). id is the paging
    // cursor (LAST); status is a lifecycle word ('confirmed'/'rejected'), not
    // 0/1, so this action sits in the client's no-color list. reorg_timestamp is
    // stored in MILLISECONDS by the hub, which the client divides down before
    // rendering.
    if(method=='getReorgs')
        info = [count_reverse, info.reorg_timestamp, info.reorg_height, info.reorg_id, info.affected_chains, info.validator_count, info.status, info.id];
    // Federation slash proposals (hub-owned, id-keyed). id is the paging
    // cursor (LAST); evidence_hash is served in place of the verbatim
    // evidence blob (hashed hub-side; see db/index.js getSlashProposals).

    // status is a lifecycle word, not 0/1, so this action sits in the
    // client's no-color list. The exclusion is load-bearing, not
    // cosmetic: an UNADJUDICATED accusation painted in the failure
    // colour reads as a verdict.
    if(method=='getSlashProposals')
        info = [count_reverse, info.created_at, info.validator_pubkey, info.offense_type, info.round_number, info.evidence_hash, info.status, info.id];
    // COINPAY settlement records. obligation_action_index links the payment back
    // to the obligation it discharged; txid/vout name the specific output that
    // paid THAT obligation, which is why one transaction can appear on several rows.
    if(method=='getCoinpays')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.obligation_action_index, info.coin_amount, info.txid, info.vout, status, info.action_index];
    // COINPAY obligations: who owes what native coin, expiring when. The row is
    // the LATEST status per obligation (the query's MAX(action_index) join), and
    // coinpay_status is a lifecycle word rather than 0/1, so no color and no
    // block time column (the obligation is created by a match, not by its own tx).
    if(method=='getCoinpayObligations')
        info = [count_reverse, info.block_index, info.payer_address, info.payee_address, info.coin, info.coin_amount, info.expiration, info.coinpay_status, info.action_index];
    // Protocol-written terminal actions for orders/swaps/dispensers. Each row
    // is the expire/close action itself plus a pointer at what it retired, so
    // the pointer sits at slot 4 and status/action_index stay last.
    if(method=='getOrderExpires')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.order_action_index, status, info.action_index];
    if(method=='getSwapExpires')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.swap_action_index, status, info.action_index];
    if(method=='getDispenserExpires')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.dispenser_action_index, status, info.action_index];
    return info;
}

function cancelEditAndGovernanceRows(info, c){
    let { count_reverse, status, method } = c;
    // DISPENSER_CLOSE also returns the closed dispenser's terms, so both legs
    // ride along. A native-coin leg carries a null tick with a real coin+amount,
    // which the client must render unlinked rather than as /token/null.
    // close_reason ('empty' vs 'cancelled') sits BEFORE status/action_index so
    // action_index stays LAST (paging cursor) and status second-to-last.
    if(method=='getDispenserCloses')
        info = [count_reverse, info.block_index, info.timestamp, info.dispenser_address, info.dispenser_action_index, info.give_coin, info.give_tick, info.give_amount, info.get_coin, info.get_tick, info.get_amount, info.close_reason, status, info.action_index];
    // COINPAY_EXPIRE has no source of its own (no user transaction writes it),
    // so slot 3 carries the obligation it closed out instead of an address.
    if(method=='getCoinpayExpires')
        info = [count_reverse, info.block_index, info.timestamp, info.obligation_action_index, status, info.action_index];
    // User-written cancels. The row is the cancel action plus a pointer at
    // the record it pulled, and its memo: the memo is the only field saying
    // WHY the owner cancelled, so it is the one column worth the width.
    if(method=='getOrderCancels')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.order_action_index, info.memo, status, info.action_index];
    if(method=='getSwapCancels')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.swap_action_index, info.memo, status, info.action_index];
    if(method=='getDispenserCancels')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.dispenser_action_index, info.memo, status, info.action_index];
    // User-written edits. An edit exists only for what it CHANGED, so the
    // amended fields ride along: a null expiration/allow_list/block_list means
    // the edit left that setting alone, which the client must render as a dash
    // rather than dropping the column (a DISPENSER_EDIT that moved only escrow
    // legitimately carries a null expiration). give_escrow is dispenser-only.
    if(method=='getOrderEdits')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.order_action_index, info.expiration, info.allow_list, info.block_list, info.memo, status, info.action_index];
    if(method=='getSwapEdits')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.swap_action_index, info.expiration, info.allow_list, info.block_list, info.memo, status, info.action_index];
    if(method=='getDispenserEdits')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.dispenser_action_index, info.give_escrow, info.expiration, info.allow_list, info.block_list, info.memo, status, info.action_index];
    // Cross-chain settlement leg (local action-chain row; no status column). action_index
    // is the paging cursor (LAST) and links the local settlement action.
    if(method=='getCrossChainSettlements')
        info = [count_reverse, info.block_index, info.timestamp, info.match_id, info.local_action_index, info.action_index];
    // Hub capability + governance rows (read from the co-located hub DB, id-keyed).
    // id is the paging cursor (LAST); status/vote are enum words (no 0/1 coloring,
    // so these methods sit in the no-color list client-side).
    if(method=='getValidatorCapabilities')
        info = [count_reverse, info.updated_at, info.signing_pubkey, info.capability, info.qualified, info.self_test_ok, info.enabled, info.qualified_at_block, info.id];
    if(method=='getGovernanceProposals')
        info = [count_reverse, info.proposal_id, info.parameter, info.current_value, info.proposed_value, info.status, info.voting_end, info.activation_block, info.proposer_pubkey, info.id];
    if(method=='getGovernanceVotes')
        info = [count_reverse, info.created_at, info.proposal_id, info.voter_pubkey, info.vote, info.id];
    return info;
}

function hubOperationalAndSearchRows(info, c){
    let { count_reverse, count, method, cfg } = c;
    // Hub operational rows (read from the co-located hub DB, id-keyed). id is the
    // paging cursor (LAST); these have no 0/1 status column, so they sit in the
    // client-side no-color list.
    if(method=='getPeers')
        info = [count_reverse, info.last_seen_at, info.addr, info.validator_id, info.is_seed, info.id];
    if(method=='getConsensusState')
        info = [count_reverse, info.updated_at, info.key_name, info.value, info.id];
    if(method=='getConfigs')
        info = [count_reverse, info.updated_at, info.coin, info.network, info.module, info.param_name, info.param_value, info.id];
    if(method=='getTelemetryPings')
        info = [count_reverse, info.created_at, info.event, info.node_version, info.os_platform, info.arch, info.country, info.region, info.id];
    if(method=='getSearch'){
        if(cfg.data.type=='address')
            info = [count, info.address, null];
        if(cfg.data.type=='broadcast')
            info = [count, info.message, info.memo, info.action_index];
        if(cfg.data.type=='token')
            info = [count, info.tick, info.description, null];
        if(cfg.data.type=='transaction')
            info = [count, info.hash, null];
        // Contract hits carry the identity a reader searched by: the
        // declared name, its version, the derived address they navigate
        // to, and a snippet of the description. action_index rides LAST,
        // the same paging-cursor position the broadcast panel uses.
        if(cfg.data.type=='contract')
            info = [count, info.meta_name, info.meta_version, info.contract_address, info.snippet, info.action_index];
    }
    return info;
}

module.exports = { voteAndBetRows, crossChainRows, mirrorAndExpiryRows, cancelEditAndGovernanceRows, hubOperationalAndSearchRows };
