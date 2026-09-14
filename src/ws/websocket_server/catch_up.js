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
 * XChain Explorer - WebSocket Server: catch-up replay
 *
 * A subscribe carrying since_action_index replays the actions the client
 * missed. The replay runs in three steps: the cursor and in-progress guard,
 * the stale and depth gates, then the replayed NEW_ACTION frames closed by
 * one CATCH_UP_COMPLETE.
 *
 * The db reads stay awaited inline in handleCatchUp rather than behind helper
 * functions, so a replay yields to the event loop at exactly the points it
 * always did and its frames interleave with a concurrent snapshot fan-out the
 * same way.
 *
 * HOW THIS ATTACHES
 *
 * The methods are authored as a class body and exported as that class's
 * prototype, so websocket_server.js can copy them onto WebSocketServer.prototype
 * verbatim. Nothing here is ever instantiated: `this` is the WebSocketServer
 * instance at call time, exactly as it was when these methods sat inline.
 *
 ********************************************************************/

'use strict';

// Module-scope logger, not the server's own log() method (see websocket_server.js).
const { getLogger } = require('../../observability');
const log = getLogger();

// The replay cursor as a BigInt, or null once a refusal frame has been sent for
// a malformed cursor or a catch-up already running for this client.
function catchUpCursor(server, client, sinceActionIndex, requestId) {
    // Reject a non-integer / negative since_action_index BEFORE the depth gate.
    // Number('abc')/Number({}) is NaN and `NaN > depth` is always false, so an
    // unguarded value silently bypasses CATCH_UP_TOO_OLD and reaches the SQL bind
    // param as NaN/Infinity. Anchor with the same non-negative-integer guard the
    // REST checkpoint-range handler uses (XChainExplorer.js) and reply INVALID_PARAMS.
    if (!/^[0-9]+$/.test(String(sinceActionIndex))) {
        server.sendError(client, 'INVALID_PARAMS', 'since_action_index must be a non-negative integer', requestId);
        return null;
    }
    // BigInt, not Number: the client sends its cursor as the decimal string the v2
    // wire contract gave it, and Number() rounded it above 2^53 ("9007199254740995"
    // -> 9007199254740996), so the replay asked for rows AFTER an action the client
    // had never seen and skipped it silently. The regex above already
    // proved the value is a non-negative integer literal, so BigInt() cannot throw.
    const sinceBig = BigInt(sinceActionIndex);

    // Check if catch-up already in progress
    if (client.catchUpInProgress) {
        server.sendError(client, 'CATCH_UP_IN_PROGRESS', 'A catch-up request is already running', requestId);
        return null;
    }
    return sinceBig;
}

// Sends one NEW_ACTION frame per replayed action that passes the subscription's
// filter, and returns how many were sent.
function replayActions(server, client, actions, info, filter, tipStale) {
    let eventsReplayed = 0;
    for (const action of actions) {
        // Build catch-up event with catch_up flag
        const event = {
            type:      'NEW_ACTION',
            chain:     info.chain,
            network:   info.network,
            timestamp: Date.now(),
            catch_up:  true,
            ...(tipStale ? { stale: true } : {}),
            data: {
                action_index: action.action_index,
                action:       action.action       || null,
                tx_hash:      action.tx_hash      || null,
                block_index:  action.block_index   || null,
                source:       action.source        || null,
                status:       action.status        || null,
                // Additive (spec M1.4), and it MUST be copied here. These
                // rows come from the same getActionsSince the live feed
                // uses, so the destinations are already on them; omitting
                // the field would hand a reconnecting client a narrower
                // NEW_ACTION than the live channel sends, which is the
                // live-versus-replay shape divergence the retired singular
                // `destination` was removed to prevent (see Broadcaster
                // onAction). Same array-or-empty guarantee as live.
                destinations: Array.isArray(action.destinations) ? action.destinations : []
            }
        };

        // Apply the same filter pipeline (types/statuses/ticks) and fields
        // projection the live Broadcaster path applies, so a reconnecting
        // client can't see a wider or unprojected shape during catch-up
        // than it would on the live channel.
        if (!server.broadcaster.passesFilter(filter, event, action)) continue;
        const msg = filter.fields ? server.broadcaster.applyFieldsProjection(event, filter.fields) : event;

        server.send(client, msg);
        eventsReplayed++;
    }
    return eventsReplayed;
}

// The CATCH_UP_COMPLETE frame that closes a replay.
function catchUpComplete(info, actions, sinceBig, replay, requestId) {
    // Determine latest action index from replayed events. Emit as a decimal STRING
    // to match the v2 wire contract (ws/schema_version.js:26-29): every other
    // action_index on WS v2 serializes as a string, and Number() here would both
    // break that type contract and lose precision above 2^53.
    const latestIdx = actions.length > 0
        ? String(actions[actions.length - 1].action_index)
        : String(sinceBig);

    // Send CATCH_UP_COMPLETE
    const complete = {
        type:      'CATCH_UP_COMPLETE',
        chain:     info.chain,
        network:   info.network,
        timestamp: Date.now(),
        ...(replay.tipStale ? { stale: true } : {}),
        data: {
            events_replayed:    replay.eventsReplayed,
            latest_action_index: latestIdx,
            truncated:          replay.truncated
        }
    };
    if (requestId !== undefined) complete.id = requestId;
    return complete;
}

class WebSocketCatchUp {

    // Handle catch-up replay of missed events
    async handleCatchUp(client, sinceActionIndex, filter, requestId) {
        const sinceBig = catchUpCursor(this, client, sinceActionIndex, requestId);
        if (sinceBig === null) return;

        const db     = this.explorer.db;
        const config = { coin: client.coin };

        // A catch-up from a stale replica hands back a SHORT replay and a
        // CATCH_UP_COMPLETE whose latest_action_index the client would otherwise
        // treat as caught-up. It is still served (the rows are real, and a wallet
        // reconnecting during an indexer stall must not be told nothing), but
        // every replayed frame and the COMPLETE carry `stale: true` so the client
        // knows the replay is bounded by a tip that is behind, and does not close
        // its gap on it. The HTTP path carries the same marker; the fail-closed
        // opt-in keeps the old refusal through the same error frame and requestId
        // the depth gate below uses.
        const tipStale = await this.isCoinTipStale(client.coin);
        if (tipStale && this.staleFailClosed()) {
            this.sendError(client, 'COIN_DATA_STALE',
                'Indexed data for this coin is stale beyond its maximum tip age; refusing to replay it as current.',
                requestId);
            return;
        }

        // Check depth: reject if too far behind
        try {
            // Both sides BigInt so the subtraction is exact and never mixes types;
            // getMaxActionIndex answers in BigInt, and BigInt() re-wraps a Number a
            // test double may return.
            const currentMax = BigInt(await db.getMaxActionIndex(config) || 0);
            if (currentMax - sinceBig > BigInt(this.catchUpMaxDepth)) {
                this.sendError(client, 'CATCH_UP_TOO_OLD',
                    `Requested action_index ${sinceBig} is more than ${this.catchUpMaxDepth} behind current (${currentMax}). Use REST API to backfill.`,
                    requestId);
                return;
            }
        } catch (e) {
            this.sendError(client, 'CATCH_UP_TOO_OLD', 'Unable to determine current state', requestId);
            return;
        }

        client.catchUpInProgress = true;

        try {
            const actions = await db.getActionsSince(config, sinceBig, this.catchUpMaxEvents);
            const info    = this.getCoinInfo(client.coin);
            const truncated = actions.length >= this.catchUpMaxEvents;
            const eventsReplayed = replayActions(this, client, actions, info, filter, tipStale);
            this.send(client, catchUpComplete(info, actions, sinceBig, { eventsReplayed, truncated, tipStale }, requestId));

        } catch (e) {
            log.error('WS_CATCH_UP_FAILED', { client: client.id, err: e.message, stack: e.stack });
        } finally {
            client.catchUpInProgress = false;
        }
    }
}

module.exports = WebSocketCatchUp.prototype;
