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
 * XChain Explorer - the Database class's two method tables
 *
 * The two name lists the Database constructor hands every instance: the action
 * tables the list and search readers walk, and the list methods that page on the
 * preserved client cursor. They used to be literals inside the constructor. They
 * live here so the constructor stays a list of instance fields, and so a query
 * family that needs to add a name edits this file rather than the class.
 *
 * Each list is exported once and copied per instance by the constructor, so every
 * Database still owns its own array, exactly as it did when each `new Database`
 * evaluated the literal afresh.
 *
 ********************************************************************/

'use strict';

// Tables holding one row per typed action, read as this.actionTables by
// getQueryOffsets (a list method whose mangled name is one of these gets the
// boundary-discovery query), getActionTotals (the per-table network totals)
// and getBlocks (the per-block action counts union).
const ACTION_TABLES = [
    'addresses',
    'airdrops',
    'anchor_actions',
    'batches',
    'broadcasts',
    'callbacks',
    'coinpays',
    'coinpay_expires',
    'coinpay_obligations',
    'destroys',
    'dispensers',
    'dispenses',
    'dividends',
    'files',
    'full_node_verifications',
    'issues',
    'links',
    'lists',
    'messages',
    'mints',
    'orders',
    'order_cancels',
    'order_edits',
    'order_matches',
    'prices',
    'sends',
    'sleeps',
    'swaps',
    'swap_cancels',
    'swap_edits',
    'swap_matches',
    'sweeps'
];

// List views whose backing table name is NOT derivable from the method via
// the get->lowercase mangle in getQueryOffsets (e.g. getAnchors -> anchor_actions,
// getSlashEvents -> slash_events, the hub-mirrored governance/match tables). The
// boundary-discovery query can't run for these, but it doesn't need to: each main
// list query already orders by and filters on the correct cursor column
// (getQueryOffsetSql picks m.id vs m.action_index per method). We only need to
// preserve the inbound client cursor so next/prev advance instead of resetting to
// the newest page every time.
// The mangle is `method.toLowerCase().replace('get','')`, which never
// reinserts an underscore, so EVERY method over a multi-word table name
// belongs here regardless of which cursor column it uses:
// getContractDelegations ('contractdelegations' vs contract_delegations)
// is the standing proof, and it pages on the default action_index cursor.
const CURSOR_PAGED_METHODS = [
    'getAnchors','getXcalls','getAttestations','getAttestValidatorStats',
    'getContractStakes','getContractUnstakes','getContractDelegations','getEmissions',
    'getCrossChainSettlements','getCrossChainMatches',
    'getSlashEvents','getCapabilitySlashEvents','getFullNodeVerifications',
    'getPriceSnapshots','getOraclePrices',
    'getValidatorCapabilities','getGovernanceProposals','getGovernanceVotes','getReorgs','getSlashProposals',
    'getPeers','getConsensusState','getConfigs','getTelemetryPings',
    'getPolls','getVotes','getVoteDelegations',
    // BET market/wager lists: getBetFeeds -> bet_feeds and getBets -> bets are
    // not reachable through the get->lowercase table mangle, so they page on the
    // preserved client cursor like the poll family. Both ORDER BY m.action_index,
    // which is getQueryOffsetSql's default cursor field, so no id-keyed entry.
    'getBetFeeds','getBets',
    // The checkpoint-schema family: state_checkpoints, capability_snapshots and
    // anchor_reward_attestations are hub-mirrored and state_tree_roots is
    // indexer-local, and none of the four is reachable through the mangle. They
    // page on the preserved client cursor; getQueryOffsetSql gives getCheckpoints
    // and getCommitments their own m.block_index cursor field below (not m.id),
    // since both lists ORDER BY the committed height.
    'getCheckpoints','getCapabilitySnapshots','getAnchorRewardAttestations','getCommitments',
    // getCollectibles -> 'collectibles' is not a table (the rows are `tokens`
    // filtered by the M5.1 classification), so the get->lowercase mangle cannot
    // find a boundary; it pages on the preserved client cursor over m.id.
    // The gallery is /api-only today (it pages by ?page=, and the cursor path
    // runs for /explorer requests alone), so this entry and its sibling in
    // getQueryOffsetSql are armed rather than exercised: they exist so that
    // registering an /explorer feed later cannot silently page this method on
    // the wrong column, which is the failure the cursor list itself documents.
    'getCollectibles'
];

module.exports = { ACTION_TABLES, CURSOR_PAGED_METHODS };
