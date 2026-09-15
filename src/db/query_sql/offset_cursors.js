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
 * XChain Explorer - which column a list pages on
 *
 * One part of src/db/query_sql.js: the cursor column getQueryOffsetSql compares
 * against, per method. It is a hardcoded whitelist, never user input, and it
 * must stay in lockstep with each method's own ORDER BY: a cursor column that
 * disagrees with the column the list is ordered by is not a crash, it is a page
 * that silently resets to the newest row.
 *
 * Plain data and one lookup, not a class body: nothing here reaches
 * Database.prototype.
 *
 ********************************************************************/

'use strict';

// table `m` is a universal reference to the main action table, so the default
// cursor is its action_index; the entries below name the methods whose table
// carries a different one.
const DEFAULT_CURSOR = 'm.action_index';

const CURSOR_BY_METHOD = {
    getBlocks: 'b1.block_index',
    // getCollectibles is getTokens' filtered sibling and ORDERs BY the same
    // column, so it takes the same cursor: `tokens` has no per-row action_index
    // uniqueness (a re-ISSUE stamps last_action_index, not a new row).
    getTokens:      'm.id',
    getCollectibles: 'm.id',
    // state_checkpoints has no action_index, and unlike the id-keyed views below
    // it is not keyed by m.id either: the list ORDERs BY m.block_index (the
    // checkpointed height, one row per height after the MAX(checkpoint_seq)
    // GROUP BY), so the cursor must compare that column, not insertion order.
    // state_tree_roots (getCommitments) has the same shape: no action_index, one
    // row per height, and the list ORDERs BY m.block_index.
    getCheckpoints: 'm.block_index',
    getCommitments: 'm.block_index'
};

// id-keyed list views: their main query ORDERs BY m.id (these tables have no
// action_index cursor column, or a fan-out where action_index is not unique
// per displayed row), so the paging cursor must compare m.id rather than the
// default m.action_index. Must stay in lockstep with each method's ORDER BY.
const ID_KEYED_METHODS = ['getSlashEvents','getCapabilitySlashEvents','getOraclePrices',
    'getFullNodeVerifications','getPriceSnapshots','getCrossChainMatches',
    'getValidatorCapabilities','getGovernanceProposals','getGovernanceVotes',
    'getPeers','getConsensusState','getConfigs','getTelemetryPings',
    'getEmissions','getAttestValidatorStats','getCapabilitySnapshots',
    'getAnchorRewardAttestations','getReorgs','getSlashProposals'];

for(const method of ID_KEYED_METHODS)
    CURSOR_BY_METHOD[method] = 'm.id';

// The cursor column a method's offset predicate compares. Read through
// hasOwnProperty so a method name that collides with an Object.prototype key
// falls through to the default instead of resolving to an inherited value.
function cursorField(method){
    return (Object.prototype.hasOwnProperty.call(CURSOR_BY_METHOD, method))
        ? CURSOR_BY_METHOD[method]
        : DEFAULT_CURSOR;
}

module.exports = { DEFAULT_CURSOR, CURSOR_BY_METHOD, ID_KEYED_METHODS, cursorField };
