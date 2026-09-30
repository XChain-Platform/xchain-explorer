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
 * XChain Explorer - explorer row shapes for the ledger list pages
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
 * This half covers the pages drawn straight off the action chain: addresses and
 * balances, tokens and trades, contracts, and the capability staking lifecycle.
 *
 ********************************************************************/

'use strict';

function chainAndBalanceRows(info, c){
    let { count_reverse, count, status, actions, amount, percent, value, method } = c;
    // Build out the correct response array based on method type
    if(method=='getAddresses')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.fee_preference, info.require_memo, info.dispenser_preference, status, info.action_index];
    if(method=='getAirdrops')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.memo, status, info.action_index];
    if(method=='getBalances')
        info = [count, info.tick, amount, percent, value, null];
    if(method=='getBatches')
        info = [count_reverse, info.block_index, info.timestamp, info.source, status, info.action_index];
    if(method=='getBlocks')
        info = [info.block_index, info.timestamp, actions, info.block_index];
    if(method=='getBroadcasts')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.message, info.value, info.fee, status, info.action_index];
    if(method=='getCallbacks')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.callback_tick, info.callback_amount, status, info.action_index];
    if(['getCredits','getDebits','getEscrows'].includes(method))
        info = [count_reverse, info.block_index, info.timestamp, info.address, info.tick, info.amount, info.action, info.action_index];
    if(method=='getDestroys')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.memo, status, info.action_index];
    if(method=='getDispensers')
        // Dynamic dispenser fields sit BEFORE status/action_index so action_index
        // stays LAST and status second-to-last for paging and row coloring.
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_coin, info.give_tick, info.give_amount, info.get_coin, info.get_tick, info.get_amount, info.give_ownership, info.price_stale === true, status, info.action_index];
    if(method=='getDispenses')
        info = [count_reverse, info.block_index, info.timestamp, info.destination, info.give_coin, info.give_tick, info.give_amount, info.get_coin, info.get_tick, info.get_amount, status, info.action_index];
    if(method=='getDividends')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.dividend_tick, info.amount, status, info.action_index];
    if(method=='getFees')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.method, info.action, info.action_index];
    if(method=='getFiles')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.name, info.type, info.title, info.gate_ticker, status, info.action_index];
    // A validator PRICE on the wire today is a BATCH: one signed action
    // carrying an hourly window of rounds, whose coin/tick/fiat/value/fee
    // are NULL by construction (they are the v1 user-oracle columns) and
    // whose pair_count is NULL too (it would describe one round out of the
    // window). Carrying only those five is why every validator row rendered
    // as dashes. The round window (batch_first_round/batch_last_round/
    // round_count), the round the action is about and the pair counts ride
    // ahead of status/action_index so the client can describe the batch;
    // batch_pair_count is the width of the batch's first round, counted by
    // the feed query rather than shipped as rounds_json (megabytes a page).
    if(method=='getPrices')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.version, info.coin, info.tick, info.fiat, info.round_number, info.batch_first_round, info.batch_last_round, info.round_count, info.pair_count, (info.batch_pair_count === undefined) ? null : info.batch_pair_count, info.value, info.fee, status, info.action_index];
    if(method=='getControllers')
        info = [count_reverse, info.block_index, info.timestamp, info.scope, info.subject, info.action_class, info.contract_index, info.is_unbind, info.cooldown_blocks, info.cooldown_end_block, status, info.action_index];
    if(method=='getDeployChunks')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.code_hash, info.chunk_index, info.total_chunks, status, info.action_index];
    return info;
}

function tokenAndTradeRows(info, c){
    let { count_reverse, count, status, locks, amount, percent, value, method } = c;
    if(method=='getHistory')
        info = [count_reverse, info.block_index, info.timestamp, info.action, info.details, status, info.action_index];
    // Raw action list: one row per action with its type name and no
    // per-type detail object. The actions table has no status column,
    // so the action NAME lands second-to-last and the client keeps
    // this view in its no-color list. action_index stays LAST
    // (paging cursor).
    if(method=='getActions')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.action, info.action_index];
    if(method=='getHolders')
        info = [count, info.address, amount, percent, value, null];
    // transfer (ownership-transfer destination, null for plain issues)
    // sits BEFORE status/action_index so the client's length-relative
    // status + paging-offset extraction keeps working
    if(method=='getIssues')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.max_supply, info.max_mint, locks, info.transfer, status, info.action_index];
    if(method=='getLinks')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.coin1, info.coin1_action_index, info.coin2, info.coin2_action_index, info.memo, status, info.action_index];
    if(method=='getLists')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.type, info.edit, status, info.action_index];
    if(method=='getMarkets')
        info = [count_reverse, info.tick1, info.tick2, info.tick1_price, info.tick1_ask, info.tick1_bid, info.tick2_24hr_volume, info.tick1_24hr_change, info.id];
    if(method=='getMarketHistory')
        info = [count_reverse, info.block_index, info.timestamp, info.type, info.price, info.amount, null, info.action_index];
    if(method=='getMessages')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.destination, info.plaintext_message, info.encrypted_message, status, info.action_index];
    // Carry destination in the slot getSends uses, before
    // status/action_index, so the client's length-relative
    // status and paging-offset extraction keeps working.
    if(method=='getMints')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.destination, status, info.action_index];
    if(method=='getOrders')
        // give/get_ownership sit BEFORE status/action_index (invariant: action_index LAST).
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_tick, info.give_amount, info.get_tick, info.get_amount, info.give_ownership, info.get_ownership, status, info.action_index];
    if(method=='getSends')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.destination, status, info.action_index];
    if(method=='getSleeps')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.type, info.tick, info.resume_block, status, info.action_index];
    if(method=='getSwaps')
        // give/get_ownership sit BEFORE status/action_index (invariant: action_index LAST).
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_tick, info.give_amount, info.get_tick, info.get_amount, info.give_ownership, info.get_ownership, status, info.action_index];
    // Matched order pairs. A match row names each leg by coin plus the
    // matched ORDER's action_index and carries no ticks of its own, so
    // the legs render as action links, not token links. status and
    // action_index stay LAST (row color + paging cursor).
    if(method=='getOrderMatches')
        info = [count_reverse, info.block_index, info.timestamp, info.give_coin, info.give_action_index, info.give_amount, info.get_coin, info.get_action_index, info.get_amount, info.settlement_type, status, info.action_index];
    return info;
}

function contractAndStakeRows(info, c){
    let { count_reverse, status, locks, method } = c;
    // Matched swap pairs: the same two-leg shape minus the amount and
    // settlement-type columns, which a swap match does not carry.
    if(method=='getSwapMatches')
        info = [count_reverse, info.block_index, info.timestamp, info.give_coin, info.give_action_index, info.get_coin, info.get_action_index, status, info.action_index];
    if(method=='getSweeps')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.destination, info.balances, info.ownerships, info.orders, info.swaps, info.dispensers, status, info.action_index];
    // NOTE: decimals sits BEFORE the trailing id; the datatables client
    // uses the LAST element of each row for offset paging (offset_first/
    // offset_last), so new fields must never displace it. decimals +
    // locks (lock_max_supply) let the client badge NFT-pattern tokens.
    if(['getTokens','getProjectTokens'].includes(method))
        info = [count_reverse, info.block_index, info.timestamp, info.tick, info.supply, info.max_supply, info.max_mint, locks, info.decimals, info.id];
    // VM / Contract list pages. meta_name rides in the slot AFTER
    // source: the first four elements are the shared count/block/time/
    // source cells every list page renders generically, and status +
    // action_index stay last (row color + paging cursor).
    if(method=='getContracts')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.meta_name, info.code_hash, info.api_version, info.cooldown_blocks, info.slash_destination, status, info.action_index];
    if(method=='getExecutions')
        info = [count_reverse, info.block_index, info.timestamp, info.contract_index, info.caller, info.method_name, info.gas_used, status, info.action_index];
    // Per-contract emission rollup (contract_emissions joined through
    // contract_executions). Cursor is m.id: this table's own action_index
    // is nullable for internal emissions such as SLASH, so it sits with
    // the id-keyed views.

    // status is the parent EXECUTE's real valid/invalid state, not a
    // lifecycle word, and renders as TEXT: coloring an emissions row would
    // recolor the execution's outcome on a row about something else.
    if(method=='getEmissions')
        info = [count_reverse, info.block_index, info.timestamp, info.execution_index, info.contract_index, info.position, info.emitted_action, info.action_index, info.status, info.id];
    if(['getDeposits','getWithdrawals'].includes(method))
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.contract_index, info.tick, info.amount, status, info.action_index];
    // Capability staking list pages. The raw stakes page keeps action_index LAST
    // (paging cursor).
    if(method=='getStakes')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.version, info.amount, status, info.action_index];
    // The validators row carries the hub federation registry's addr /
    // chains / registration-status for the same signing pubkey (db/index.js
    // getData folds them on), so the on-chain active set and the hub
    // registry render as ONE table.

    // Those columns and the activation/deactivation tails all sit BEFORE
    // status/action_index: the client reads status second-to-last and
    // action_index last (view link + paging cursor), so nothing may
    // displace them.
    if(method=='getValidators')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.version, info.amount, info.hub_addr, info.hub_chains, info.hub_status, info.activation_block, info.deactivation_block, status, info.action_index];
    return info;
}

function stakeLifecycleRows(info, c){
    let { count_reverse, status, method } = c;
    if(method=='getDelegations')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, status, info.action_index];
    if(method=='getValidatorRewards')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.reward_type, info.amount, info.id];
    // Full-node possession-proof verdict list page. action_index stays LAST
    // (the datatables client uses it as the paging offset cursor).
    if(method=='getFullNodeVerifications')
        info = [count_reverse, info.block_index, info.timestamp, info.signing_pubkey, info.staking_source, info.epoch_height, info.target_height, info.challenge_id, info.passed, info.action_index];
    // Contract-targeted staking list pages
    if(method=='getContractStakes')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.target_contract_index, info.tick, info.amount, info.version, status, info.action_index];
    if(method=='getContractUnstakes')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.target_contract_index, info.tick, info.amount, info.cooldown_end_block, status, info.action_index];
    if(method=='getSlashEvents')
        info = [count_reverse, info.block_index, info.timestamp, info.slashed_pubkey, info.target_contract_index, info.tick, info.amount, info.destination, info.execution_index];
    // Capability staking lifecycle list pages. action_index stays LAST (paging cursor).
    if(method=='getCollects')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.amount, status, info.action_index];
    if(method=='getUnstakes')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.amount, info.cooldown_end_block, status, info.action_index];
    if(method=='getStakeKeyRevocations')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.deactivation_block, status, info.action_index];
    // Capability equivocation slashes. No own action_index; id is the paging cursor
    // (LAST), slash_action_index links the view to the SLASH wire action.
    if(method=='getCapabilitySlashEvents')
        info = [count_reverse, info.block_index, info.timestamp, info.slashed_pubkey, info.capability, info.amount, info.submitter, info.slash_action_index, info.id];
    // User token/fiat oracle rows (hub-mirrored, cross-chain). id is the paging cursor
    // (LAST); block_time + source_chain replace the block/time columns (no local block).
    if(method=='getOraclePrices')
        info = [count_reverse, info.block_time, info.source_chain, info.source_address, info.tick, info.fiat, info.value, info.id];
    // Attestation list page
    if(method=='getAttestations')
        info = [count_reverse, info.block_index, info.timestamp, info.source, info.version, info.provider_id, info.request_id, info.request_status, info.response_status, status, info.action_index, info.payload, info.callback_params_json, info.fee_payer];
    // Per-validator per-provider ATTEST accountability counters
    // (indexer-owned, id-keyed: the surrogate id is the paging cursor and
    // stays LAST).

    // last_updated_block is the freshness column and lands second-to-last,
    // where createdRow reads `status` positionally, so attest_validator_stat
    // sits in the client's no-color list rather than having a numeric height
    // read as a coloring flag. slashed_count and quality_score are Phase 4
    // columns, 0 until a producer exists, but stay surfaced.
    if(method=='getAttestValidatorStats')
        info = [count_reverse, info.validator_pubkey, info.provider_id, info.fulfilled_count, info.missed_count, info.slashed_count, info.quality_score, info.last_updated_block, info.id];
    return info;
}

module.exports = { chainAndBalanceRows, tokenAndTradeRows, contractAndStakeRows, stakeLifecycleRows };
