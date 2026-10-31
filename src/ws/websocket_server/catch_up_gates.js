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
 * XChain Explorer - WebSocket Server: catch-up gates
 *
 * The two gates a since_action_index replay passes after the stale gate and
 * before the ahead-of-tip and depth gates (catch_up.js runCatchUp): the seed
 * gate, which makes sure the coin's live feed has recorded the mark a replay
 * is bounded by, and the reorg gate, which refuses a cursor a logged rollback
 * may have invalidated. Each answers whether the replay may run, having sent
 * its own refusal when it may not. Also the backpressure check the replay
 * makes at each row's start, and the bounded wait for a backed-up socket to
 * drain below the cap before the replay sheds it.
 *
 * Plain functions over the server; `server` is the WebSocketServer. Also the
 * check a running replay makes after each wait for a rollback announced since
 * its reorg gate passed, which ends the replay with the same refusal.
 *
 ********************************************************************/

'use strict';

// Module-scope logger, not the server's own log() method (see websocket_server.js).
const { getLogger } = require('../../observability');
const log = getLogger();

// The detector's rollback numbering, read over its per-coin state.
const rollback = require('../change_detector/rollback.js');

// The live detector behind this server, or null (a direct caller or a unit double).
function liveDetector(server) {
    const detector = server.broadcaster && server.broadcaster.changeDetector;
    return (detector && typeof detector.liveActionMark === 'function') ? detector : null;
}

// Seeds the coin when its first poll has not yet recorded a mark, and answers whether a
// replay may run: true when the coin has a mark, or when this server has no live
// detector polling it (nothing is sent live, so nothing can repeat). Refuses with the
// retryable CATCH_UP_NOT_READY otherwise, since an unbounded replay could send a row
// the first poll then sends live, or end below the mark the first poll seeds and leave
// the rows between unsent.
async function seedGate(server, client, requestId) {
    const detector = liveDetector(server);
    if (!detector || typeof detector.ensureSeeded !== 'function') return true;
    let seeded;
    try {
        seeded = await detector.ensureSeeded(client.coin);
    } catch (e) {
        seeded = false;
    }
    if (seeded || !detector.state || !detector.state[client.coin]) return true;
    server.sendError(client, 'CATCH_UP_NOT_READY',
        'The live feed for this coin has not recorded its first position yet; retry the catch-up shortly.',
        requestId);
    return false;
}

// Refuses a replay from a cursor a logged rollback may have invalidated, and answers
// whether the replay may run. Replaying from such a cursor would send only rows above
// it, so the replaced rows at or below it would never reach the client: the refusal
// names the rollback instead, with a stable code both bundled clients surface as
// resync_required, and the fork fields a client can reload from. A cursor inside the
// rolled-back range is ambiguous (a client that saw the replacement row at that index
// and one that saw the old row hold the same number), so it is always refused.
function reorgGate(server, client, sinceBig, requestId) {
    const detector = liveDetector(server);
    if (!detector || typeof detector.reorgCovering !== 'function') return true;
    const entry = detector.reorgCovering(client.coin, sinceBig);
    if (!entry) return true;
    sendReorged(server, client, entry, 'A chain reorganization since action_index ' + sinceBig +
        ' replaced rows at or below it. Use REST API to resync.', requestId);
    return false;
}

// Sends the CATCH_UP_REORGED refusal naming one rollback's fork fields.
function sendReorged(server, client, entry, message, requestId) {
    const error = {
        type:      'error',
        timestamp: Date.now(),
        data: {
            code:                       'CATCH_UP_REORGED',
            message,
            fork_block_index:           String(entry.forkBlock),
            first_invalid_action_index: String(entry.firstInvalid)
        }
    };
    if (requestId !== undefined) error.id = requestId;
    server.send(client, error);
}

// The coin's rollback number as a replay starts, read with its reorg gate, or null when no
// live detector numbers rollbacks for this server.
function replayStartSeq(server, client) {
    const detector = liveDetector(server);
    return (detector && detector.state) ? rollback.rollbackSeq(detector.state[client.coin]) : null;
}

// A check the replay runs after each wait, answering whether a rollback announced since
// `startSeq` may have voided a row it read (any row up to the batch's highest index, or the
// cursor for an empty batch). On one it sends CATCH_UP_REORGED in place of the COMPLETE, so no
// old-chain frame follows the live REORG and the client does not close its gap past it.
function midReplayReorg(server, client, startSeq, actions, sinceBig, requestId) {
    const detector  = liveDetector(server);
    const highWater = actions.reduce((high, row) => (BigInt(row.action_index) > high ? BigInt(row.action_index) : high), sinceBig);
    let refused = false;
    return () => {
        if (refused) return true;
        if (startSeq === null || !detector) return false;
        const entry = rollback.rollbackSince(detector.state[client.coin], startSeq, highWater);
        if (!entry) return false;
        refused = true;
        log.warn('WS_CATCH_UP_REORGED_MID_REPLAY', { client: client.id, coin: client.coin,
            fork_block_index: String(entry.forkBlock), first_invalid_action_index: String(entry.firstInvalid) });
        sendReorged(server, client, entry, 'A chain reorganization during this replay replaced rows it had read. ' +
            'Use REST API to resync.', requestId);
        return true;
    };
}

// Whether the client's socket holds more unsent bytes than the live fan-out lets a
// subscriber hold (Broadcaster.maxBackpressure). Answers false without a broadcaster.
function replayBackedUp(server, client) {
    const broadcaster = server.broadcaster;
    if (!broadcaster || typeof broadcaster.shedBackedUpClient !== 'function') return false;
    return client.ws.bufferedAmount > broadcaster.maxBackpressure;
}

// How often a replay waiting on a backed-up socket looks at it again.
const DRAIN_POLL_MS = 25;

// Waits for a backed-up socket to drain below the cap, and answers whether it did
// within the server's replay drain window (catchUpDrainMs). A socket that closes
// while waiting answers false at once. Unlike live delivery, a replay serves one
// client at its own pace, so a slow link gets its rows a little later instead of a
// 4008 close: clients drop an unfinished catch-up on close and replay it again from
// the same cursor, so shedding a slow link at every row would loop forever.
async function replayDrained(server, client) {
    const started = Date.now();
    while (replayBackedUp(server, client)) {
        if (client.ws.readyState !== 1 || Date.now() - started > server.catchUpDrainMs) return false;
        await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
    return true;
}

module.exports = { liveDetector, seedGate, reorgGate, replayStartSeq, midReplayReorg, replayBackedUp, replayDrained };
