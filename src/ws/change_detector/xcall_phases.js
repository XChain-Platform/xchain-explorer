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
 * XChain Explorer - Change Detector, XCALL phase cursor
 *
 * The cursor over xcalls.resolved_block that emits XCALL_COMPLETED and
 * XCALL_EXPIRED, including its park-and-reprobe handling of an indexer that
 * predates the XCALL tables.
 *
 * HOW THIS ATTACHES
 *
 * Authored as a class body and exported as that class's prototype, so
 * change_detector.js can copy the method onto ChangeDetector.prototype by
 * descriptor. Nothing here is ever instantiated: `this` is the ChangeDetector
 * instance at call time, exactly as it was when the method sat inline. The park,
 * re-arm, block-boundary and event-building steps are plain module functions, so
 * the detector's method surface is the same set of names it always had.
 *
 ********************************************************************/

'use strict';

// Same cached singleton change_detector.js logs through; see the note there.
const { getLogger } = require('../../observability');
const log = getLogger();

class XcallPhaseCursor {

    // Emit XCALL_COMPLETED / XCALL_EXPIRED for every cross-chain call whose
    // request_status went terminal since the last poll (spec
    // explorer-coverage-completion M5.4). A THIRD cursor, over
    // xcalls.resolved_block, and it exists for the same reason the BET latch cursor
    // does: the transition has no action row.
    //
    // The v0 request row IS the call's identity on this chain, and the interlock
    // updates that row in place rather than minting a new action, so the generic
    // NEW_ACTION path emits nothing when a call completes. Expiries are carried on
    // the same cursor even though XCALL v2 does mint an action, because a subscriber
    // filtering on the phase names must see both outcomes or the live timeline shows
    // completions and silently drops expiries.
    async checkXcallPhases(coin, config, currentBlockIndex, prev) {
        if (typeof this.db.getXcallPhasesSince !== 'function') return;
        // Parked-with-cooldown exactly like the BET latch: a coin whose indexer
        // predates the XCALL tables is a deploy-order fact, not a permanent property
        // of that chain, and re-discovering it every poll fills the log.
        if (prev.xcallUnsupported && Date.now() < prev.xcallRetryAt) return;

        let since = Number(prev.xcallBlock);
        if (!Number.isFinite(since)) since = 0;

        let rows;
        try {
            rows = await this.db.getXcallPhasesSince(config, since, this.fetchLimit);
        } catch (e) {
            parkXcallPhases(this, coin, prev, e);
            return;
        }

        // Re-armed after the table appeared: re-seed to the tip and emit nothing, so
        // historical resolutions are not replayed as live pushes.
        if (prev.xcallUnsupported) {
            rearmXcallPhases(coin, prev, currentBlockIndex);
            return;
        }

        if (!rows || rows.length === 0) {
            if (currentBlockIndex > since) prev.xcallBlock = currentBlockIndex;
            return;
        }

        const { emit, next } = completeXcallBlocks(rows, this.fetchLimit, currentBlockIndex);

        for (const call of emit) {
            this.emit('lifecycle_event', coin, xcallPhaseEvent(call));
        }

        prev.xcallBlock = next;
    }
}

// A failed phase read: a missing XCALL table parks this coin's cursor for the
// cooldown and says so once; any other error is rethrown to the poll loop.
function parkXcallPhases(detector, coin, prev, e) {
    if (detector.isMissingTableError(e)) {
        if (!prev.xcallUnsupported) {
            log.info('CHANGE_DETECTOR_XCALLS_TABLE_MISSING',
                     { coin, parked: 'XCALL phase events', reprobe_s: Math.round(detector.betLatchRetryMs / 1000) });
        }
        prev.xcallUnsupported = true;
        prev.xcallRetryAt     = Date.now() + detector.betLatchRetryMs;
        return;
    }
    throw e;
}

// A probe that succeeded after the coin was parked: clear the park and seed the
// cursor to the tip.
function rearmXcallPhases(coin, prev, currentBlockIndex) {
    prev.xcallUnsupported = false;
    prev.xcallRetryAt     = 0;
    prev.xcallBlock       = currentBlockIndex;
    log.info('CHANGE_DETECTOR_XCALLS_TABLE_PRESENT',
             { coin, rearmed: 'XCALL phase events', from_block: currentBlockIndex });
}

// Which fetched rows to emit and where the cursor lands afterwards.
function completeXcallBlocks(rows, fetchLimit, currentBlockIndex) {
    let emit = rows;
    let next = Math.max(currentBlockIndex, Number(rows[rows.length - 1].resolved_block));

    if (rows.length >= fetchLimit) {
        // A capped fetch can cut a block in half, and the cursor is a BLOCK HEIGHT
        // rather than a row id, so resuming mid-block would re-emit the calls
        // already sent from it. Stop on the last COMPLETE block and re-read the
        // remainder next poll; when the whole fetch is one block there is no
        // boundary to stop on, so move past it and let the REST reads stay
        // authoritative for the tail.
        const lastBlock = Number(rows[rows.length - 1].resolved_block);
        const complete  = rows.filter((r) => Number(r.resolved_block) < lastBlock);
        if (complete.length > 0) {
            emit = complete;
            next = Number(complete[complete.length - 1].resolved_block);
        } else {
            next = lastBlock;
        }
    }
    return { emit, next };
}

// The lifecycle event for one resolved call.
function xcallPhaseEvent(call) {
    const expired = String(call.request_status) === 'expired';
    return {
        type:    expired ? 'XCALL_EXPIRED' : 'XCALL_COMPLETED',
        action:  'XCALL',
        channel: 'xcall',
        data: {
            // call_id is the routing key for this channel AND the subject id, so
            // it is the one field a consumer can rely on being present.
            call_id:            call.call_id,
            action_index:       call.action_index,
            block_index:        call.resolved_block,
            source:             call.source || null,
            target_chain:       call.target_chain || null,
            method:             call.method || null,
            contract_index:     call.contract_index,
            // The TRANSITION being reported. request_status is the source
            // chain's own terminal word; result_status is the far chain's
            // outcome and is null on an expiry, which is the point: an expired
            // call has no result, it has an absence of one.
            request_status:     call.request_status,
            result_status:      expired ? null : (call.result_status || null),
            callback_action_index: call.callback_action_index,
            deadline_block:     call.deadline_block,
            // No causing tx for a COMPLETION: the interlock wrote the status
            // directly. An EXPIRY does have an XCALL v2 action behind it, so it
            // is not marked synthetic and a consumer can tell the two apart.
            tx_hash:            null,
            action_format:      null,
            synthetic:          !expired
        }
    };
}

module.exports = XcallPhaseCursor.prototype;
