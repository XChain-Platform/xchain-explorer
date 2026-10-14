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
 * XChain Explorer - Change Detector, rollback notice and reorg log
 *
 * What the per-coin pass (coin.js) does once a rewind has moved a cursor
 * back: it tells subscribers with one `reorg` event (the Broadcaster sends it
 * as a REORG frame before any replacement row), and it logs the rollback so a
 * catch-up from a cursor the rollback may have invalidated is refused rather
 * than replayed past the replaced rows. Also the short-fetch rule that flags a
 * rollback landing inside one poll for the next poll's fork search.
 *
 * Plain functions over the detector and its per-coin state, not a mixin part:
 * coin.js calls them, and the detector's reorgCovering method delegates to
 * reorgCovering here.
 *
 ********************************************************************/

'use strict';

// Rollbacks kept per coin for the catch-up gate (reorgCovering); the oldest is
// dropped first.
const REORG_LOG_DEPTH = 64;

// Tell the coin's subscribers what a rewind invalidated, and log it for clients that
// were away. Sent only when a cursor actually moved back, so a reorg verdict that
// touched nothing announced costs no frame. fork_block_index is the lowest height
// whose announced block is no longer on the chain; first_invalid_action_index is the
// lowest action_index whose announced row may be gone or replaced: every row a
// subscriber holds at or above it is void, and whatever the new chain holds there is
// sent again after this event.
function announceRollback(detector, coin, prev, before, fork) {
    const blockMoved  = prev.blockIndex < before.blockIndex;
    const actionMoved = BigInt(prev.actionIndex) < BigInt(before.actionIndex);
    if (!blockMoved && !actionMoved) return;
    const forkBlock    = (fork !== null) ? fork : Number(prev.blockIndex) + 1;
    const firstInvalid = BigInt(prev.actionIndex) + 1n;
    const previousTip  = BigInt(before.actionIndex);
    // Only a rollback that voided rows a client may hold matters to a catch-up.
    if (firstInvalid <= previousTip) {
        if (!prev.reorgLog) prev.reorgLog = [];
        prev.reorgLog.push({ forkBlock, firstInvalid, previousTip });
        if (prev.reorgLog.length > REORG_LOG_DEPTH) prev.reorgLog.shift();
    }
    detector.emit('reorg', coin, {
        fork_block_index:           String(forkBlock),
        first_invalid_action_index: String(firstInvalid)
    });
}

// A fetch that came back short of the tip read earlier in the same poll means rows
// were rolled back between the two reads (the since-queries have no filter, so
// nothing else drops a row). The db layer's reorg verdict was taken before the tip
// read and cannot have seen it, so flag the fork search for the next poll: a block
// this poll announced and the rollback replaced is then found and retracted.
function noteShortFetch(detector, prev, rows, indexKey, previous, tip) {
    if (rows && rows.length >= detector.fetchLimit) return;
    let reached;
    try {
        reached = (rows && rows.length) ? BigInt(rows[rows.length - 1][indexKey]) : BigInt(previous);
        if (reached < BigInt(tip)) prev.pendingReorg = true;
    } catch (e) {
        // A malformed index proves nothing about a rollback.
    }
}

// The newest logged rollback that may have invalidated a row at `cursor`: one whose
// first invalidated index is at or below the cursor and whose old high-water mark
// is at or above it, or null. A cursor above that mark was handed out after the
// rollback (only the new chain reached it), and one below its first invalidated
// index holds no rolled-back row. The log is bounded (REORG_LOG_DEPTH) and lives in
// this process only, so an older rollback, or one before a restart, is not found.
function reorgCovering(prev, cursor) {
    if (!prev || !prev.reorgLog) return null;
    let at;
    try {
        at = BigInt(cursor);
    } catch (e) {
        return null;
    }
    for (let i = prev.reorgLog.length - 1; i >= 0; i--) {
        const entry = prev.reorgLog[i];
        if (entry.firstInvalid <= at && at <= entry.previousTip) return entry;
    }
    return null;
}

module.exports = { REORG_LOG_DEPTH, announceRollback, noteShortFetch, reorgCovering };
