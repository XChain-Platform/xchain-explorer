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
 * XChain Explorer - Change Detector, BET latch cursor and cursor drain
 *
 * The cursor over bet_feeds.closed_block that emits BET_CLOSED, with its
 * park-and-reprobe handling of an indexer that predates the BET tables, and
 * nextCursor, the drain rule the block and action cursors advance by.
 *
 * HOW THIS ATTACHES
 *
 * Authored as a class body and exported as that class's prototype, so
 * change_detector.js can copy the methods onto ChangeDetector.prototype by
 * descriptor. Nothing here is ever instantiated: `this` is the ChangeDetector
 * instance at call time, exactly as it was when the methods sat inline. The park,
 * re-arm and event-building steps are plain module functions (the cursor position
 * steps are pair_cursor.js), so
 * the detector's method surface is the same set of names it always had.
 *
 ********************************************************************/

'use strict';

// Same cached singleton change_detector.js logs through; see the note there.
const { getLogger } = require('../../observability');
const log = getLogger();
// The (closed_block, action_index) position steps (pair_cursor.js).
const { readCeiling, subCursor, pairCursorAfter } = require('./pair_cursor.js');

class BetLatchCursor {

    // Emit BET_CLOSED for every market whose deadline latch was stamped since the last
    // poll. This is a SECOND cursor, over bet_feeds.closed_block rather than over
    // `actions`, and it exists because the latch is the one BET transition with no
    // action row: the end-of-block pass writes the status directly and mints nothing
    // for the actions cursor to find, so without this cursor a subscribed market page
    // would learn that betting had closed only on its next fetch (spec §11.1 lists the latch
    // among this channel's events).
    // `upToBlock` is the highest block whose actions have all gone out (checkCoin), so a
    // latch is never pushed ahead of the bets before it; absent, the read runs to the tip.
    async checkBetLatches(coin, config, currentBlockIndex, prev, upToBlock) {
        if (typeof this.db.getBetFeedsClosedSince !== 'function') return;
        // A coin whose indexer predates the BET tables is not an error condition to
        // re-discover every 5 seconds; see the ER_NO_SUCH_TABLE branch below. It is
        // parked, not switched off: the table appears the moment that chain's indexer
        // is upgraded, and this process can outlive several such upgrades.
        if (prev.betLatchUnsupported && Date.now() < prev.betLatchRetryAt) return;

        let since = Number(prev.closedBlock);
        if (!Number.isFinite(since)) since = 0;
        const upTo = readCeiling(currentBlockIndex, since, upToBlock);

        let rows;
        try {
            rows = await this.db.getBetFeedsClosedSince(config, since, this.fetchLimit,
                { afterActionIndex: subCursor(prev.closedAction), upToBlock: upTo });
        } catch (e) {
            parkBetLatches(this, coin, prev, e);
            return;
        }

        if (prev.betLatchUnsupported) {
            rearmBetLatches(coin, prev, currentBlockIndex);
            return;
        }

        if (!rows || rows.length === 0) {
            // Skip the empty span so it is not re-scanned every interval. The read was
            // capped at upTo, so a block above it is still strictly greater than the
            // cursor on the next poll.
            if (upTo >= since) {
                prev.closedBlock  = upTo;
                prev.closedAction = null;
            }
            return;
        }

        for (const feed of rows) {
            this.emit('lifecycle_event', coin, betClosedEvent(feed));
        }

        const next = pairCursorAfter(rows, this.fetchLimit, upTo, 'closed_block');
        prev.closedBlock  = next.block;
        prev.closedAction = next.action;
    }

    // Next poll cursor after a capped `*Since` fetch. The queries return the lowest
    // `fetchLimit` rows above the cursor (ORDER BY <idx> ASC LIMIT fetchLimit) with no
    // filter, so every index between the cursor and the observed tip is a row the
    // fetch would have returned had it still been there. The cursor therefore never
    // moves past the last row fetched while that row is below the tip read earlier in
    // the poll: a full fetch means a backlog that drains over the next polls, and a
    // short or empty one means the rows between the last fetched row and the tip were
    // rolled back after the tip was read. Jumping to the tip in either case would
    // skip every replacement row the indexer later commits at those indexes. The
    // range is read again on the next poll, which is one cheap indexed query.
    // `rows` that are empty or absent keep `previous`, the cursor the fetch started
    // from; a caller that passes no `previous` gets the tip, as a fetch with nothing
    // to compare against has nothing to hold.
    // Compares as BigInt: both index columns are BIGINT, and Number() collapsed two
    // consecutive action indices above 2^53 onto one value, so a backlog cursor could
    // land at or past an action that was never emitted. The return keeps
    // currentMax's own type so the block cursor stays a Number and only the action
    // cursor, whose currentMax is now BigInt, becomes exact.
    nextCursor(rows, indexKey, currentMax, previous) {
        if (!rows || rows.length === 0) return (previous === undefined) ? currentMax : previous;
        let last, max;
        // A malformed/absent index on the last row is not a cursor: fall back to the
        // tip rather than throw out of the poll loop, matching the old isFinite guard.
        try {
            last = BigInt(rows[rows.length - 1][indexKey]);
            max  = BigInt(currentMax);
        } catch (e) {
            return currentMax;
        }
        // Below the tip, full fetch or not: stop at the last row fetched.
        if (last < max)
            return (typeof currentMax === 'bigint') ? last : Number(last);
        // Never fall below an emitted row: the fetch has no upper bound, so a row the
        // indexer committed after the tip read is already sent and must not be re-sent.
        if (last > max)
            return (typeof currentMax === 'bigint') ? last : Number(last);
        return currentMax;
    }
}

// A failed latch read, the ER_NO_SUCH_TABLE branch checkBetLatches points at.
//
// Observed live on the regtest fleet: the LTC indexer DB had no bet_feeds
// table (its build predates P4's migrations), so every poll threw and
// filled the log. The BET tables are per-coin-database, so one chain
// lacking them says nothing about the others: latch this coin off and
// report it once, rather than letting a per-coin schema gap look like a
// recurring fault. Any OTHER error still propagates to the poll loop's
// handler, where a genuine DB failure belongs.
function parkBetLatches(detector, coin, prev, e) {
    if (detector.isMissingTableError(e)) {
        // Announce the transition only. A re-probe that finds the table still
        // missing must stay silent, or the cooldown just turns a per-poll log
        // into a per-cooldown one.
        if (!prev.betLatchUnsupported) {
            log.info('CHANGE_DETECTOR_BET_FEEDS_TABLE_MISSING',
                     { coin, parked: 'BET_CLOSED events', reprobe_s: Math.round(detector.betLatchRetryMs / 1000) });
        }
        prev.betLatchUnsupported = true;
        prev.betLatchRetryAt     = Date.now() + detector.betLatchRetryMs;
        return;
    }
    throw e;
}

// The probe succeeded after the coin had been parked, which means that chain's
// indexer gained the BET tables while this process was running. Re-seed to the
// tip and emit nothing, for the same reason the first poll seeds rather than
// emits: every latch at or below the tip already happened, and pushing them now
// tells every subscriber that historical markets are closing this second. The
// REST timeline still reports those latches correctly (it synthesizes `closed`
// from bet_feeds.closed_block), so nothing is unreachable, only un-pushed.
function rearmBetLatches(coin, prev, currentBlockIndex) {
    prev.betLatchUnsupported = false;
    prev.betLatchRetryAt     = 0;
    prev.closedBlock         = currentBlockIndex;
    prev.closedAction        = null;
    log.info('CHANGE_DETECTOR_BET_FEEDS_TABLE_PRESENT',
             { coin, rearmed: 'BET_CLOSED events', from_block: currentBlockIndex });
}

// The BET_CLOSED lifecycle event for one latched feed.
function betClosedEvent(feed) {
    return {
        type:    'BET_CLOSED',
        action:  'BET_CLOSED',
        channel: 'bet_feed',
        data: {
            // Both keys carry the feed id: action_index because every event on
            // this channel identifies its subject that way, feed_action_index
            // because that is what the Broadcaster routes on. For the latch they
            // are the same number, since the market IS its creating action.
            action_index:      feed.action_index,
            feed_action_index: feed.action_index,
            block_index:       feed.closed_block,
            // No causing tx by design, and no format: the latch is not an action.
            tx_hash:           null,
            action_format:     null,
            source:            feed.source || null,
            // The TRANSITION this event reports, which is not necessarily the
            // feed's status by the time we poll: an oracle can resolve in a
            // later block before this fires, and reporting `resolved` on the
            // close event would be a lie about what happened at block_index.
            // The live status rides alongside for a consumer that wants it.
            status:            'closed',
            feed_status:       feed.feed_status || null,
            // Same flag the REST timeline stamps on its synthesized `closed`
            // entry: this transition has no action row behind it.
            synthetic:         true
        }
    };
}

module.exports = BetLatchCursor.prototype;
