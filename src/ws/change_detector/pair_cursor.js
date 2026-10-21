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
 * XChain Explorer - Change Detector, (block, action_index) cursor steps
 *
 * The two cursors with no action row (bet latches, XCALL phases) read rows
 * ordered by (block, action_index), a total order because action_index is
 * unique in both tables. Their position is that pair: a block height plus,
 * while a capped fetch has stopped inside a block, the last action_index sent
 * from it. A null action means the whole block has gone out.
 *
 * Plain functions over the per-coin state, not a mixin part: bet_latches.js
 * and xcall_phases.js read and advance the cursors with them, and coin.js
 * bounds and rewinds them.
 *
 ********************************************************************/

'use strict';

// The inclusive height a cursor may read up to this poll: the caller's bound, else
// the tip. A bound of null means the action step could not say how far it got, so
// the read stays inside the block the cursor already holds.
function readCeiling(currentBlockIndex, since, upToBlock) {
    if (upToBlock === undefined) return currentBlockIndex;
    if (upToBlock === null) return since;
    return Math.min(currentBlockIndex, upToBlock);
}

// The action_index a read resumes after, or null when the cursor holds a whole block.
function subCursor(action) {
    return (action === undefined || action === null) ? null : action;
}

// Where the cursor lands after a non-empty fetch. A full fetch may stop inside a
// block, so it holds that block and the last row sent, and the next poll reads on
// from there. A short fetch returned every row up to `upTo`, so the cursor moves to it.
function pairCursorAfter(rows, fetchLimit, upTo, blockKey) {
    const last      = rows[rows.length - 1];
    const lastBlock = Number(last[blockKey]);
    if (rows.length >= fetchLimit) return { block: lastBlock, action: last.action_index };
    return { block: Math.max(upTo, lastBlock), action: null };
}

// The highest block whose NEW_BLOCK and every action row have gone out (a behind action
// cursor stops one below its last row's block; null when it sent nothing to measure).
function deliveredBlock(prev, currentBlockIndex, currentActionIndex, lastActionBlock) {
    const announced = Number(prev.blockIndex);
    const blocks = Number.isFinite(announced) ? Math.min(currentBlockIndex, announced) : currentBlockIndex;
    if (prev.actionIndex >= currentActionIndex) return blocks;
    if (lastActionBlock === null) return null;
    return Math.min(blocks, lastActionBlock - 1);
}

// Lowers one cursor (`closed` or `xcall`) to `height` for a rewind. A lowered cursor
// holds the whole block, because its sub-cursor named a row in a higher block.
function lowerPairCursor(prev, name, height) {
    if (prev[name + 'Block'] > height) {
        prev[name + 'Block']  = height;
        prev[name + 'Action'] = null;
    }
}

module.exports = { readCeiling, subCursor, pairCursorAfter, deliveredBlock, lowerPairCursor };
