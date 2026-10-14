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
 * XChain Explorer - the BET feed gating lists in force
 *
 * A BET format-4 edit never rewrites bet_feeds.allow_list / block_list; the
 * indexer resolves the lists in force at read time when it judges a wager
 * (xchain-indexer src/db/bets/index.js). This is the explorer's one copy of that
 * rule, shared by the bet_feed readers and the BET action-detail handler.
 *
 ********************************************************************/

'use strict';

// Join the latest VALID BET edit that set one list, so an edit to one list leaves the other as created.
function latestEditJoin(alias, column){
    return `
                        LEFT  JOIN bet_edits          ${alias} ON (${alias}.action_index=(
                            SELECT MAX(e.action_index) FROM bet_edits e
                            INNER JOIN index_statuses es ON (es.id=e.status_id)
                            WHERE e.feed_action_index=m.action_index AND es.status='valid' AND e.${column} IS NOT NULL))`;
}

// Resolve the gating lists the way the indexer judges wagers: the latest valid edit per
// list wins and 0 clears it. A replica without bet_edits reads the lists the feed was created with.
// The feed row must be aliased `m`, and the joins take the aliases `ae` and `be`.
function betListOverlay(hasEdits){
    if(!hasEdits) return { joins: '', allow: 'm.allow_list', block: 'm.block_list' };
    return {
        joins: latestEditJoin('ae', 'allow_list') + latestEditJoin('be', 'block_list'),
        allow: 'CASE WHEN ae.action_index IS NULL THEN m.allow_list ELSE NULLIF(ae.allow_list, 0) END as allow_list',
        block: 'CASE WHEN be.action_index IS NULL THEN m.block_list ELSE NULLIF(be.block_list, 0) END as block_list',
    };
}

module.exports = { betListOverlay };
