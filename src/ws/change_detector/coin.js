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

// The rollback notice, the catch-up's reorg log and the short-fetch flag (rollback.js).
const rollback = require('./rollback.js');
const { announceRollback, noteShortFetch } = rollback;
// The ceiling and rewind of the two (block, action_index) cursors (pair_cursor.js).
const { deliveredBlock, lowerPairCursor } = require('./pair_cursor.js');

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
            await seedHistory(this, config, prev, currentBlockIndex, currentActionIndex);
            return;
        }

        // On a reorg, rewind each cursor to just below the fork point: the lowest
        // remembered height whose block hash changed or vanished, and never above the
        // (possibly lower) new tip. A replacement at an unchanged height therefore
        // re-enters the feed instead of sitting under the high-water mark. The
        // pending flag, not this poll's verdict, gates it (see readTip).
        if (prev.pendingReorg) {
            const before = { blockIndex: prev.blockIndex, actionIndex: prev.actionIndex };
            const fork = await findForkPoint(this, config, prev);
            rewindCursors(prev, fork, currentBlockIndex, currentActionIndex);
            prev.pendingReorg = false;
            // Announce the rollback before any replacement row goes out, so a subscriber
            // can drop what it holds at or above the fork first (see announceRollback).
            announceRollback(this, coin, prev, before, fork);
        }

        // The chain grew since the last poll, so there are new blocks to announce.
        if (currentBlockIndex > prev.blockIndex)
            await emitNewBlocks(this, coin, config, prev, currentBlockIndex);

        // New actions landed since the last poll, so there are rows to announce.
        let lastActionBlock = null;
        if (currentActionIndex > prev.actionIndex)
            lastActionBlock = await emitNewActions(this, coin, config, prev, currentActionIndex);
        // Both cursors below read no higher than the last block whose actions all went out.
        const delivered = deliveredBlock(prev, currentBlockIndex, currentActionIndex, lastActionBlock);

        // Runs after the action loop, mirroring the chain: the latch pass executes
        // after every user tx in its block (spec §6), so a market page sees the last
        // bet before it is told betting closed.
        await this.checkBetLatches(coin, config, currentBlockIndex, prev, delivered);
        // Same placement rationale: the callback interlock runs after the block's
        // actions, so a subscriber sees the injected callback EXECUTE before it is
        // told the call it belonged to is finished.
        await this.checkXcallPhases(coin, config, currentBlockIndex, prev, delivered);
    }

    // The coin's live-start mark: the action_index at or below which the live feed sends
    // no further NEW_ACTION, or null while the coin is unseeded. A subscription key
    // freezes it as its replay ceiling in the same turn it goes live.
    liveActionMark(coin) {
        const prev = this.state[coin];
        return (prev && prev.initialized && prev.liveActionMark !== undefined) ? prev.liveActionMark : null;
    }

    // The last block_index sent live (or seeded past), or null while unseeded; every later NEW_BLOCK is above it.
    liveBlockMark(coin) { return this.state[coin] && this.state[coin].initialized ? this.state[coin].blockIndex : null; }

    // The mark this coin was seeded at, or null while it is unseeded: the ceiling of a key
    // that went live before the first poll, every row above which the feed sends live.
    seedActionMark(coin) {
        const prev = this.state[coin];
        return (prev && prev.initialized && prev.seedActionMark !== undefined) ? prev.seedActionMark : null;
    }

    // Seed a polled coin now if its first poll has not yet recorded a mark, and answer
    // whether the coin is seeded. The connection path calls it before it hands out a
    // cursor (WELCOME) or bounds a replay, so neither ever reads an unseeded coin: the
    // poll loop seeds coins in turn, and one slow coin would otherwise leave the next
    // one with no mark while clients connect. A coin this detector does not poll
    // answers false and is never seeded here.
    //
    // Concurrent connection-path calls share one seed. The poll loop does not wait on
    // it: whichever seed reaches seedCursors first wins, the other sees the coin
    // initialized and carries on as an ordinary poll, so neither path can hold the
    // other behind a stalled read.
    async ensureSeeded(coin) {
        const prev = this.state[coin];
        if (!prev) return false;
        if (prev.initialized) return true;
        if (!prev.seeding) prev.seeding = seedOnDemand(this, coin).finally(() => { prev.seeding = null; });
        await prev.seeding;
        return !!prev.initialized;
    }

    // The newest logged rollback that may have invalidated a row at `cursor`, or null
    // (rollback.js reorgCovering states the rule).
    reorgCovering(coin, cursor) {
        return rollback.reorgCovering(this.state[coin], cursor);
    }
}

// Moves the live-start mark to `index` (rows at or below it are never sent live again).
function setLiveMark(prev, index) {
    try {
        prev.liveActionMark = BigInt(index);
    } catch (e) {
        // A malformed index is no mark: keep the last one, as nextCursor keeps the tip.
    }
}

// A seed run from the connection path (ensureSeeded): the same tip read and seed the
// first poll runs, skipped when the coin was seeded while the tip was being read.
async function seedOnDemand(detector, coin) {
    const config = { coin };
    const prev   = detector.state[coin];
    const { currentBlockIndex, currentActionIndex } = await readTip(detector, config);
    if (prev.initialized) return;
    seedCursors(prev, currentBlockIndex, currentActionIndex);
    await seedHistory(detector, config, prev, currentBlockIndex, currentActionIndex);
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
    // checkReorgAndInvalidate reports a reorg once (it records the new tip before
    // returning), so the verdict is kept on the coin's state until the rewind
    // completes: a read that throws before then must not lose it.
    let reorged = false;
    if (typeof detector.db.checkReorgAndInvalidate === 'function')
        reorged = await detector.db.checkReorgAndInvalidate(config);
    if (reorged) detector.state[config.coin].pendingReorg = true;

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
    // Both hold whole blocks (pair_cursor.js).
    prev.closedAction = null;
    prev.xcallAction  = null;
    // No row at or below the seed is ever sent live, so the seed is the first mark.
    setLiveMark(prev, currentActionIndex);
    prev.seedActionMark = prev.liveActionMark;
    // Every cursor now sits at the observed tip, so no rewind is owed.
    prev.pendingReorg = false;
    prev.initialized = true;
}

// Heights of emitted-block identity kept per coin; a reorg deeper than this
// rewinds only as far as the oldest remembered height.
const HISTORY_DEPTH = 256;

function historyOf(prev) {
    if (!prev.history) prev.history = new Map();
    return prev.history;
}

function trimHistory(history, tip) {
    for (const height of history.keys())
        if (height <= tip - HISTORY_DEPTH) history.delete(height);
}

// Remember each announced block's hash so a later poll can tell a replaced height
// from an unchanged one.
function rememberBlocks(prev, blocks) {
    const history = historyOf(prev);
    for (const block of blocks) {
        const height = Number(block.block_index);
        const entry  = history.get(height);
        history.set(height, { hash: block.block_hash || null, firstAction: entry ? entry.firstAction : null });
    }
    if (blocks.length) trimHistory(history, Number(blocks[blocks.length - 1].block_index));
}

// The blocks and actions already at the tip when this process starts are never
// announced, but a reorg of them must still be recognised. action_index is a
// contiguous chain cursor, so each block's action_count locates its first action
// while walking backward from the current maximum.
async function seedHistory(detector, config, prev, currentBlockIndex, currentActionIndex) {
    const rows = await detector.db.getBlocksSince(config, currentBlockIndex - HISTORY_DEPTH, HISTORY_DEPTH * 2) || [];
    rememberBlocks(prev, rows);
    if (!rows.length || Number(rows[rows.length - 1].block_index) !== Number(currentBlockIndex)) return;

    const history = historyOf(prev);
    let nextAction = BigInt(currentActionIndex) + 1n;
    for (let i = rows.length - 1; i >= 0; i--) {
        const count = BigInt(rows[i].action_count || 0);
        if (count > 0n) history.get(Number(rows[i].block_index)).firstAction = nextAction - count;
        nextAction -= count;
    }
}

// Remember the lowest action index announced per block, which is where the
// action cursor must return to if that block is replaced.
function rememberActions(prev, actions) {
    const history = historyOf(prev);
    for (const action of actions) {
        const height = Number(action.block_index);
        if (!Number.isFinite(height)) continue;
        const index = BigInt(action.action_index);
        const entry = history.get(height) || { hash: null, firstAction: null };
        if (entry.firstAction === null || index < entry.firstAction) entry.firstAction = index;
        history.set(height, entry);
    }
}

// The lowest remembered height whose block no longer matches what was announced,
// or null when every remembered height still matches.
async function findForkPoint(detector, config, prev) {
    const history = historyOf(prev);
    const heights = [...history.keys()].sort((a, b) => a - b);
    if (!heights.length) return null;
    const lowest = heights[0];
    const rows   = await detector.db.getBlocksSince(config, lowest - 1, HISTORY_DEPTH * 2) || [];
    const now    = new Map(rows.map((row) => [Number(row.block_index), row.block_hash || null]));
    for (const height of heights) {
        if (!now.has(height)) return height;
        const known = history.get(height).hash;
        if (known !== null && now.get(height) !== known) return height;
    }
    return null;
}

// The reorg rewind: each cursor drops below the fork point, then is clamped to the
// new tip.
function rewindCursors(prev, fork, currentBlockIndex, currentActionIndex) {
    if (fork !== null) {
        const history = historyOf(prev);
        let firstAction = null;
        for (const [height, entry] of history) {
            if (height < fork) continue;
            if (entry.firstAction !== null && (firstAction === null || entry.firstAction < firstAction))
                firstAction = entry.firstAction;
            history.delete(height);
        }
        if (prev.blockIndex > fork - 1) prev.blockIndex = fork - 1;
        if (firstAction !== null && prev.actionIndex >= firstAction) prev.actionIndex = firstAction - 1n;
        lowerPairCursor(prev, 'closed', fork - 1);
        lowerPairCursor(prev, 'xcall', fork - 1);
    }
    if (prev.blockIndex  > currentBlockIndex)  prev.blockIndex  = currentBlockIndex;
    if (prev.actionIndex > currentActionIndex) prev.actionIndex = currentActionIndex;
    // The latch cursor rewinds with them, and here it is more than a stall fix:
    // rollback.js CLEARS closed_block on a reorg past the latch block, so a feed
    // that re-latches on the new chain gets a fresh stamp that must be pushed
    // again. Without the rewind that second latch sits below the high-water mark
    // and is never emitted (spec §12 E8).
    lowerPairCursor(prev, 'closed', currentBlockIndex);
    // And the XCALL phase cursor, for the same reason in a stronger form: a
    // reorg past the resolving block rolls xcalls.resolved_block back to NULL,
    // so a call that re-resolves on the new chain gets a fresh stamp that must
    // be pushed again. Without the rewind that second resolution sits below the
    // high-water mark and is never emitted.
    lowerPairCursor(prev, 'xcall', currentBlockIndex);
    // Rows above the rewound action cursor are sent live again on the new chain, so the
    // mark drops with it and a key going live now does not replay them as well.
    if (prev.liveActionMark !== undefined && prev.liveActionMark > prev.actionIndex)
        setLiveMark(prev, prev.actionIndex);
}

// The block step: one `block` emit per fetched row, then the block cursor advances.
async function emitNewBlocks(detector, coin, config, prev, currentBlockIndex) {
    const from      = prev.blockIndex;
    const newBlocks = await detector.db.getBlocksSince(config, from, detector.fetchLimit);
    if (newBlocks && newBlocks.length > 0) {
        for (const block of newBlocks) {
            detector.emit('block', coin, block);
        }
        rememberBlocks(prev, newBlocks);
    }
    // Advance by what was actually fetched, NOT to the observed tip: getBlocksSince returns
    // the LOWEST `fetchLimit` rows, so a larger burst drains over successive polls, and a
    // fetch short of the tip holds the cursor at its last row (see nextCursor). No await
    // since the emits, so the cursor (liveBlockMark) never sits below a block already sent.
    prev.blockIndex = detector.nextCursor(newBlocks, 'block_index', currentBlockIndex, from);
    noteShortFetch(detector, prev, newBlocks, 'block_index', from, currentBlockIndex);
}

// The action step: every fetched action fans out in order, then the action cursor
// advances. Answers the block of the last row sent, or null when it sent none.
async function emitNewActions(detector, coin, config, prev, currentActionIndex) {
    const from       = prev.actionIndex;
    const newActions = await detector.db.getActionsSince(config, from, detector.fetchLimit);
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
            market:    new Map(),
            // The batch's ledger ticks, read on first need (entities.js ledgerTicksOf).
            ledger:    { actions: newActions, ticks: undefined }
        };
        // Each new action fans out four ways: the raw indexed row on `actions`,
        // the typed lifecycle events its type maps to, entity updates for whatever
        // has a subscriber, and, for ATTEST only, the `attestation` channel.
        for (const action of newActions) {
            // Advanced with no await before this row's NEW_ACTION, so a subscribe lands
            // wholly before the row (gets it live) or after it (replays it).
            setLiveMark(prev, action.action_index);
            detector.emit('action_row_start', coin, action);
            try {
                detector.emit('action', coin, action);
                await detector.emitLifecycleEvents(coin, config, action);
                await detector.emitEntityUpdates(coin, config, action, entityCache);
                await detector.emitAttestationEvents(coin, config, action);
            } finally {
                detector.emit('action_row_end', coin, action);
            }
        }
        rememberActions(prev, newActions);
    }
    // Same drain semantics as blocks (getActionsSince is action_index ASC,
    // capped at fetchLimit): advance to the last emitted action, not the tip.
    // Rows rolled back after the tip read leave the cursor at the last row sent, and
    // the next poll reads from there (see nextCursor).
    prev.actionIndex = detector.nextCursor(newActions, 'action_index', currentActionIndex, from);
    noteShortFetch(detector, prev, newActions, 'action_index', from, currentActionIndex);
    // A cursor that moved past the last sent row skips indexes it will never send.
    if (prev.liveActionMark === undefined || prev.liveActionMark < prev.actionIndex)
        setLiveMark(prev, prev.actionIndex);
    if (!newActions || newActions.length === 0) return null;
    const lastBlock = Number(newActions[newActions.length - 1].block_index);
    return Number.isFinite(lastBlock) ? lastBlock : null;
}

module.exports = CoinPass.prototype;
