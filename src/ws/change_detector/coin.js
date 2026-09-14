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
 * XChain Explorer - Change Detector, per-coin tip pass
 *
 * One coin's poll: read the tip (and whether it reorged), seed or rewind the
 * cursors, announce the new blocks and actions, then run the two cursors whose
 * transitions mint no action row.
 *
 * HOW THIS ATTACHES
 *
 * Authored as a class body and exported as that class's prototype, so
 * change_detector.js can copy the method onto ChangeDetector.prototype by
 * descriptor. Nothing here is ever instantiated: `this` is the ChangeDetector
 * instance at call time, exactly as it was when the method sat inline. The tip,
 * block and action steps the method was cut into are plain module functions that
 * take the detector as an argument, so the detector's method surface is the same
 * set of names it always had.
 *
 ********************************************************************/

'use strict';

class CoinPass {

    // One coin's tip pass: reorg check, then the block and action cursors, then the
    // two cursors whose transitions mint no action row (bet latches, XCALL phases).
    async checkCoin(coin) {
        const config = { coin };
        const prev   = this.state[coin];

        const { reorged, currentBlockIndex, currentActionIndex } = await readTip(this, config);

        // First poll: seed state without emitting
        if (!prev.initialized) {
            seedCursors(prev, currentBlockIndex, currentActionIndex);
            return;
        }

        // On a reorg, clamp each cursor down to the (possibly lower) new tip so the
        // feed resumes at the correct height instead of waiting for the chain to
        // re-pass the old high-water mark. Same-height replacements are covered by
        // the cache invalidation above + the authoritative REST reads; this loop is
        // a best-effort live feed, not a reorg replay.
        if (reorged) rewindCursors(prev, currentBlockIndex, currentActionIndex);

        // The chain grew since the last poll, so there are new blocks to announce.
        if (currentBlockIndex > prev.blockIndex)
            await emitNewBlocks(this, coin, config, prev, currentBlockIndex);

        // New actions landed since the last poll, so there are rows to announce.
        if (currentActionIndex > prev.actionIndex)
            await emitNewActions(this, coin, config, prev, currentActionIndex);

        // Runs after the action loop, mirroring the chain: the latch pass executes
        // after every user tx in its block (spec §6), so a market page sees the last
        // bet before it is told betting closed.
        await this.checkBetLatches(coin, config, currentBlockIndex, prev);
        // Same placement rationale: the callback interlock runs after the block's
        // actions, so a subscriber sees the injected callback EXECUTE before it is
        // told the call it belonged to is finished.
        await this.checkXcallPhases(coin, config, currentBlockIndex, prev);
    }
}

// The tip step: the reorg verdict and the two high-water marks, read in that order.
async function readTip(detector, config) {
    // Invalidate the db-layer id/action LRU caches when this poll observes a
    // reorg (M-3). The indexer reassigns ^id / action_index on a reorg, so a
    // cached entry keyed by an index can otherwise serve a different entity's
    // detail/history until natural eviction. This is the tip-poll loop the
    // caches piggyback on; a failed read throws and is caught by poll, which
    // leaves the last-seen tip unchanged so no spurious invalidation occurs.
    // The returned flag also drives the cursor rewind below: a reorg can roll
    // the indexer tip BACKWARD, and our cursors are a high-water mark, so without
    // a rewind the strictly-greater comparisons would stop emitting until the
    // chain re-climbed past the pre-reorg tip (feed stall while the new tip sits
    // lower; replaced tail otherwise skipped).
    let reorged = false;
    if (typeof detector.db.checkReorgAndInvalidate === 'function')
        reorged = await detector.db.checkReorgAndInvalidate(config);

    const currentBlockIndex  = await detector.db.getMaxBlockIndex(config) || 0;
    // Zero-default is 0n, not 0: getMaxActionIndex answers in BigInt so the
    // action cursor stays exact above 2^53, and `0n || 0` would have
    // flipped an empty chain's cursor back to Number for the rest of the poll.
    const currentActionIndex = await detector.db.getMaxActionIndex(config) || 0n;

    return { reorged, currentBlockIndex, currentActionIndex };
}

// First poll for a coin: every cursor starts at the observed tip, and nothing is
// emitted.
function seedCursors(prev, currentBlockIndex, currentActionIndex) {
    prev.blockIndex  = currentBlockIndex;
    prev.actionIndex = currentActionIndex;
    // The latch cursor seeds to the tip for the same reason the other two do:
    // every deadline latch at or below the current tip already happened before
    // this process started, and replaying them as live pushes would tell every
    // subscriber that historical markets are closing right now.
    prev.closedBlock = currentBlockIndex;
    // Same seed rule for the XCALL phase cursor: every call that resolved at or
    // below the tip resolved before this process started.
    prev.xcallBlock  = currentBlockIndex;
    prev.initialized = true;
}

// The reorg clamp: each cursor above the new tip comes down to it.
function rewindCursors(prev, currentBlockIndex, currentActionIndex) {
    if (prev.blockIndex  > currentBlockIndex)  prev.blockIndex  = currentBlockIndex;
    if (prev.actionIndex > currentActionIndex) prev.actionIndex = currentActionIndex;
    // The latch cursor rewinds with them, and here it is more than a stall fix:
    // rollback.js CLEARS closed_block on a reorg past the latch block, so a feed
    // that re-latches on the new chain gets a fresh stamp that must be pushed
    // again. Without the rewind that second latch sits below the high-water mark
    // and is never emitted (spec §12 E8).
    if (prev.closedBlock > currentBlockIndex) prev.closedBlock = currentBlockIndex;
    // And the XCALL phase cursor, for the same reason in a stronger form: a
    // reorg past the resolving block rolls xcalls.resolved_block back to NULL,
    // so a call that re-resolves on the new chain gets a fresh stamp that must
    // be pushed again. Without the rewind that second resolution sits below the
    // high-water mark and is never emitted.
    if (prev.xcallBlock > currentBlockIndex) prev.xcallBlock = currentBlockIndex;
}

// The block step: one `block` emit per fetched row, then the block cursor advances.
async function emitNewBlocks(detector, coin, config, prev, currentBlockIndex) {
    const newBlocks = await detector.db.getBlocksSince(config, prev.blockIndex, detector.fetchLimit);
    if (newBlocks && newBlocks.length > 0) {
        for (const block of newBlocks) {
            detector.emit('block', coin, block);
        }
    }
    // Advance by what was actually fetched, NOT to the observed tip:
    // getBlocksSince returns the LOWEST `fetchLimit` rows (block_index ASC),
    // so a burst larger than fetchLimit must drain over successive polls.
    // Jumping straight to currentBlockIndex would permanently skip every
    // block past the first fetchLimit seen in one interval.
    prev.blockIndex = detector.nextCursor(newBlocks, 'block_index', currentBlockIndex);
}

// The action step: every fetched action fans out in order, then the action cursor
// advances.
async function emitNewActions(detector, coin, config, prev, currentActionIndex) {
    const newActions = await detector.db.getActionsSince(config, prev.actionIndex, detector.fetchLimit);
    if (newActions && newActions.length > 0) {
        // Per-poll entity-read cache (grouped by type). Without it emitEntityUpdates would
        // re-issue getAddressBalances / getTokenInfo / getDispenserInfo / getMarketInfo
        // for every subscribed entity ON EVERY action, fanning a poll out to
        // (new actions) x (subscribed entities) serial single-row reads. Each of those
        // reads returns the CURRENT committed aggregate state, which does not change
        // across a single poll (no writes happen mid-loop, and the action rows are
        // already committed), so the same entity read repeated within a poll always
        // yields the same value. Caching it once per distinct entity per poll therefore
        // emits byte-identical events while collapsing the read count to at most one per
        // distinct subscribed entity per poll, independent of the action count.
        const entityCache = {
            addr:      new Map(),
            token:     new Map(),
            dispenser: new Map(),
            market:    new Map()
        };
        // Each new action fans out four ways: the raw indexed row on `actions`,
        // the typed lifecycle events its type maps to, entity updates for whatever
        // has a subscriber, and, for ATTEST only, the `attestation` channel.
        for (const action of newActions) {
            detector.emit('action', coin, action);
            await detector.emitLifecycleEvents(coin, config, action);
            await detector.emitEntityUpdates(coin, config, action, entityCache);
            await detector.emitAttestationEvents(coin, config, action);
        }
    }
    // Same drain semantics as blocks (getActionsSince is action_index ASC,
    // capped at fetchLimit): advance to the last emitted action, not the tip.
    prev.actionIndex = detector.nextCursor(newActions, 'action_index', currentActionIndex);
}

module.exports = CoinPass.prototype;
