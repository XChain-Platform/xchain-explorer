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
 * XChain Explorer - the WHERE anchor each list method opens its clause with
 *
 * One part of src/db/query_sql.js (its where_clauses.js part reads this table
 * first, then hands the anchor to the method's clause builder). A method absent
 * from the table anchors on DEFAULT_ANCHOR, exactly as the chain of `if`s this
 * table replaces fell through to it.
 *
 * Plain data and one lookup, not a class body: nothing here is a method, so
 * nothing here reaches Database.prototype.
 *
 ********************************************************************/

'use strict';

// The base predicate is a WHERE ANCHOR: callers append ` AND ...`
// fragments, so the clause always needs a first term. On mappings_actions
// and mappings_files action_index is declared NOT NULL, so that anchor is
// deliberately always-true and filters nothing; the address_id and
// block_index branches below anchor on nullable columns and do drop
// orphan rows. Do not read either as a state filter.
const DEFAULT_ANCHOR = `m.action_index IS NOT NULL`;

// Per-method anchors, keyed by the method whose table names a different first
// term than the default. Each entry carries the reason its table cannot anchor
// on m.action_index, which is the question a reader of one line here has.
const ANCHOR_BY_METHOD = {
    getBalances:                 `m.address_id IS NOT NULL`,
    getHolders:                  `m.address_id IS NOT NULL`,
    getBlocks:                   `b1.block_index IS NOT NULL`,
    getBlock:                    `b1.block_index IS NOT NULL`,
    getTransaction:              `m.tx_index IS NOT NULL`,
    // contract_state is queried via the `cs` alias (+ a latest-per-key subquery
    // that already filters by contract_index); it has no `m` table.
    getContractState:            `cs.id IS NOT NULL`,
    getMarket:                   `m.id IS NOT NULL`,
    getMarkets:                  `m.id IS NOT NULL`,
    // validator_rewards is the per-round accrual ledger; no action_index, keyed by m.id
    getValidatorRewards:         `m.id IS NOT NULL`,
    // slash_events has no action_index; its PK is m.id
    getSlashEvents:              `m.id IS NOT NULL`,
    // capability_slash_events has no action_index of its own; its PK is m.id
    getCapabilitySlashEvents:    `m.id IS NOT NULL`,
    // price_snapshots is a materialized consensus-round table with no action_index; its PK is m.id
    getPriceSnapshots:           `m.id IS NOT NULL`,
    // contract_emissions carries no reliable action_index of its own (it is nullable
    // for internal emissions such as SLASH, which move ledger state without minting a
    // new on-wire action); its PK is m.id
    getEmissions:                `m.id IS NOT NULL`,
    // attest_validator_stats is an upsert-incremented counter rollup with no
    // action_index; it gained a surrogate m.id (xchain-indexer migration
    // 2026-08-19-attest-validator-stats-surrogate-id) precisely so it could be paged
    // on a monotonic AND unique cursor, since last_updated_block ties whenever a
    // whole ATTEST responsible set misses in one block
    getAttestValidatorStats:     `m.id IS NOT NULL`,
    // cross_chain_matches is a standalone mirror of the hub's match table with no action_index; its PK is m.id
    getCrossChainMatches:        `m.id IS NOT NULL`,
    // oracle_prices is the hub-mirrored user-published oracle row table; no action_index, keyed by m.id
    getOraclePrices:             `m.id IS NOT NULL`,
    // state_checkpoints is the hub-mirrored quorum-signed checkpoint table; no
    // action_index, keyed by m.id (the cursor used for paging is m.block_index,
    // set separately in getQueryOffsetSql; this anchor only opens the WHERE clause).
    getCheckpoints:              `m.id IS NOT NULL`,
    // capability_snapshots is the hub-mirrored historical electorate (which signing
    // keys carried which stake weight at a snapshot block); no action_index, keyed by m.id
    getCapabilitySnapshots:      `m.id IS NOT NULL`,
    // anchor_reward_attestations is the hub-mirrored quorum-attested ANCHOR publisher
    // reward record; no action_index, keyed by m.id
    getAnchorRewardAttestations: `m.id IS NOT NULL`,
    // state_tree_roots is the indexer-local per-block SPV commitment row; no
    // action_index, keyed by m.id (the paging cursor is m.block_index, set separately
    // in getQueryOffsetSql, same shape as getCheckpoints)
    getCommitments:              `m.id IS NOT NULL`,
    // co-located hub capability/governance tables; no action_index, keyed by m.id
    getValidatorCapabilities:    `m.id IS NOT NULL`,
    getGovernanceProposals:      `m.id IS NOT NULL`,
    getGovernanceVotes:          `m.id IS NOT NULL`,
    // reorg_attestations is the hub-mirrored cross-chain reorg record; no action_index,
    // keyed by m.id (same PK-cursor shape as the three tables above)
    getReorgs:                   `m.id IS NOT NULL`,
    // slash_proposals is the hub-owned federation slash-evidence table; no
    // action_index, keyed by m.id (same PK-cursor shape as the tables above)
    getSlashProposals:           `m.id IS NOT NULL`,
    // co-located hub operational tables (p2p_peers/consensus_state/configs/telemetry_pings); keyed by m.id
    getPeers:                    `m.id IS NOT NULL`,
    getConsensusState:           `m.id IS NOT NULL`,
    getConfigs:                  `m.id IS NOT NULL`,
    getTelemetryPings:           `m.id IS NOT NULL`
};

// The anchor a method opens with. Read through hasOwnProperty, never `table[method]`:
// the method name arrives from the route registry as a plain string, and a name that
// collides with an Object.prototype key ('toString') would otherwise resolve to an
// inherited value instead of falling through to the default the `if` chain gave it.
function whereAnchor(method){
    return (Object.prototype.hasOwnProperty.call(ANCHOR_BY_METHOD, method))
        ? ANCHOR_BY_METHOD[method]
        : DEFAULT_ANCHOR;
}

module.exports = { DEFAULT_ANCHOR, ANCHOR_BY_METHOD, whereAnchor };
