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
 * the stale, seed, reorg, ahead-of-tip and depth gates, then the replayed
 * frames (each missed row's NEW_ACTION and the lifecycle events the live
 * detector derives from that row) closed by one CATCH_UP_COMPLETE. A replay
 * that finds the client's socket past the live feed's backpressure cap waits
 * for it to drain below the cap before the next row, so buffering stays
 * bounded to about one row; a socket that does not drain within the replay's
 * drain window is shed with 4008, as the live fan-out sheds it, and gets no
 * COMPLETE.
 *
 * The db reads stay awaited in sequence in runCatchUp, so a replay yields to the
 * event loop at the same points it always did and its frames interleave with a
 * concurrent snapshot fan-out the same way. The in-progress latch is taken before
 * the first of them.
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

// The live NEW_ACTION and lifecycle routing rules, shared so a replay reaches exactly
// the channels the live fan-out would have.
const { actionChannelKeys, carriesActions, lifecycleChannelKeys } = require('../broadcaster/action_routes.js');

// The live detector, whose own lifecycle emitters rebuild a missed row's lifecycle events.
const ChangeDetector = require('../change_detector.js');

// The seed and reorg gates, the live detector they read, the per-row backpressure wait and the mid-replay rollback check.
const { liveDetector, seedGate, reorgGate, replayStartSeq, midReplayReorg, replayBackedUp, replayDrained } = require('./catch_up_gates.js');

// The replay cursor as a BigInt, or null once an INVALID_PARAMS frame has been sent
// for a malformed cursor.
function catchUpCursor(server, client, sinceActionIndex, requestId) {
    // Reject a non-integer / negative since_action_index BEFORE the depth gate.
    // Number('abc')/Number({}) is NaN and `NaN > depth` is always false, so an
    // unguarded value silently bypasses CATCH_UP_TOO_OLD and reaches the SQL bind
    // param as NaN/Infinity. Anchor with the same non-negative-integer guard the
    // REST checkpoint-range handler uses (XChainExplorer.js) and reply INVALID_PARAMS.
    // String() throws on an object with no usable toString; the async caller is not awaited,
    // so that would be an unhandled rejection with no reply. Unstringifiable means malformed.
    let text = null;
    try { text = String(sinceActionIndex); } catch (_) { /* refused below */ }
    if (text === null || !/^[0-9]+$/.test(text)) {
        server.sendError(client, 'INVALID_PARAMS', 'since_action_index must be a non-negative integer', requestId);
        return null;
    }
    // BigInt, not Number: the client sends its cursor as the decimal string the v2
    // wire contract gave it, and Number() rounded it above 2^53 ("9007199254740995"
    // -> 9007199254740996), so the replay asked for rows AFTER an action the client
    // had never seen and skipped it silently. The regex above already
    // proved the value is a non-negative integer literal, so BigInt() cannot throw.
    return BigInt(sinceActionIndex);
}

// Where one replayed frame goes for this request, each target carrying the filter to
// apply: the request's keys among the frame's live route keys, each with the client's
// CURRENT filter, so a key unsubscribed or spent by a once frame meanwhile gets nothing.
function replayTargets(server, client, routeKeys, filter, channelKeys) {
    // No keys (a direct caller): the frame goes once under `filter`, the coin-wide view.
    if (!channelKeys) return [{ key: null, filter }];
    const targets = [];
    for (const key of routeKeys) {
        if (!channelKeys.has(key)) continue;
        const held = server.channelManager.getSubscribers(key).get(client.id);
        if (held) targets.push({ key, filter: held });
    }
    return targets;
}

// Each request key's replay ceiling, resolved now: its frozen ceiling, lowered to the
// coin's live mark. Every key in the request is live from this turn on, so a row above
// the mark reaches it live and must not be replayed as well; that holds for a key with
// no frozen ceiling too. null means unbounded for that key, which happens only while
// the coin has no mark (runCatchUp seeds the coin first, so only a coin the detector
// does not poll). Returns null (nothing bounded) without keys or without a live detector.
function resolveCeilings(server, client, channelKeys) {
    const detector = liveDetector(server);
    if (!channelKeys || !detector) return null;
    const frozen = client.replayCeilings || new Map();
    const mark   = detector.liveActionMark(client.coin);
    const ceilings = new Map();
    for (const key of channelKeys) {
        // A key frozen while the coin was unseeded went live before the seed, so every row
        // above the seed reached it live.
        let ceiling = frozen.has(key) ? frozen.get(key) : null;
        if (frozen.has(key) && ceiling === null) ceiling = detector.seedActionMark(client.coin);
        if (mark !== null && (ceiling === null || mark < ceiling)) ceiling = mark;
        ceilings.set(key, ceiling);
    }
    return ceilings;
}

// The read's inclusive upper bound: the highest key ceiling, or null when any key is unbounded.
function replayUpperBound(ceilings) {
    if (!ceilings) return null;
    let bound = null;
    for (const ceiling of ceilings.values()) {
        if (ceiling === null) return null;
        if (bound === null || ceiling > bound) bound = ceiling;
    }
    return bound;
}

// The request keys still owed this row: a key whose ceiling is below it gets the row live.
function keysOwedRow(channelKeys, ceilings, action) {
    if (!channelKeys || !ceilings) return channelKeys;
    let index;
    try {
        index = BigInt(action.action_index);
    } catch (e) {
        return channelKeys;
    }
    const owed = new Set();
    for (const key of channelKeys) {
        const ceiling = ceilings.get(key);
        if (ceiling === null || ceiling === undefined || index <= ceiling) owed.add(key);
    }
    return owed;
}

// The envelope of one replayed frame: the live envelope plus the catch_up flag, and the
// stale marker when the replay is bounded by a tip that is behind.
function replayEnvelope(type, info, tipStale, data) {
    return {
        type,
        chain:     info.chain,
        network:   info.network,
        timestamp: Date.now(),
        catch_up:  true,
        ...(tipStale ? { stale: true } : {}),
        data
    };
}

// The NEW_ACTION payload for one replayed row, the same shape the live onAction sends.
function newActionData(action) {
    return {
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
    };
}

// The lifecycle events the live detector derives from one action row, built by its own
// emitters against a collecting receiver, so a replayed frame is the frame live sent.
async function rowLifecycleEvents(db, coin, action) {
    const events = [];
    const receiver = {
        db,
        constructor: ChangeDetector,
        emit: (name, eventCoin, event) => { if (name === 'lifecycle_event') events.push(event); }
    };
    await ChangeDetector.prototype.emitLifecycleEvents.call(receiver, coin, { coin }, action);
    await ChangeDetector.prototype.emitAttestationEvents.call(receiver, coin, { coin }, action);
    return events;
}

// Send one replayed frame to every target whose filter it passes and return how many
// went. Same filter pipeline and fields projection as the live Broadcaster path, so a
// reconnecting client never sees a wider or unprojected shape than live.
function sendToTargets(server, client, event, actionData, targets) {
    let sent = 0;
    for (const target of targets) {
        if (!server.broadcaster.passesFilter(target.filter, event, actionData)) continue;
        const msg = target.filter.fields ? server.broadcaster.applyFieldsProjection(event, target.filter.fields) : event;
        server.send(client, msg);
        sent++;
        // A once subscription is spent by a replayed frame exactly as by a live one.
        if (target.key && target.filter.once) server.broadcaster.spendOnceSubscription(client.id, target.key);
    }
    return sent;
}

// Replays each missed row in live order: its NEW_ACTION, then each lifecycle event the
// live detector derives from it, to every subscribed channel it routes to. Returns the
// frames sent and whether the client was shed or a rollback overtook the replay. Over
// the cap at a row's start, the replay waits for the socket to drain (replayDrained) and
// sheds it with 4008 at that row boundary if it does not. After each wait it stops once
// `reorged` reports a rollback that voided a row it read, before sending another frame.
async function replayActions(server, client, actions, info, filter, tipStale, requestKeys, ceilings, reorged) {
    let eventsReplayed = 0;
    for (const action of actions) {
        if (replayBackedUp(server, client) && !await replayDrained(server, client)) {
            server.broadcaster.shedBackedUpClient(client);
            return { eventsReplayed, shed: true };
        }
        if (reorged()) return { eventsReplayed, shed: false, reorged: true };
        const channelKeys = keysOwedRow(requestKeys, ceilings, action);
        const event = replayEnvelope('NEW_ACTION', info, tipStale, newActionData(action));
        const routes = actionChannelKeys(client.coin, action.source, action.destinations);
        eventsReplayed += sendToTargets(server, client, event, action,
            replayTargets(server, client, routes, filter, channelKeys));

        const lifecycleEvents = await rowLifecycleEvents(server.explorer.db, client.coin, action);
        if (reorged()) return { eventsReplayed, shed: false, reorged: true };
        for (const lifecycleEvent of lifecycleEvents) {
            const frame = replayEnvelope(lifecycleEvent.type, info, tipStale, lifecycleEvent.data);
            const keys  = lifecycleChannelKeys(server.broadcaster, client.coin, lifecycleEvent);
            eventsReplayed += sendToTargets(server, client, frame, lifecycleEvent,
                replayTargets(server, client, keys, filter, channelKeys));
        }
    }
    return { eventsReplayed, shed: false };
}

// The frame types this request's channels carry live that no replay rebuilds: the
// lifecycle types with no action row behind them, plus NEW_BLOCK when the request names
// the blocks channel. A replay is keyed on action_index, and a block row has none, so a
// reconnecting client backfills blocks over REST.
function notReplayedFor(coin, keys) {
    const types = ChangeDetector.NON_ACTION_LIFECYCLE_TYPES.slice();
    if (keys && keys.has(coin + ':blocks')) types.push('NEW_BLOCK');
    return types;
}

// The CATCH_UP_COMPLETE frame that closes a replay.
function catchUpComplete(info, actions, sinceBig, replay, requestId, notReplayed) {
    // Determine latest action index from replayed events. Emit as a decimal STRING
    // to match the v2 wire contract (ws/schema_version.js, the "v2 (BIGINT-as-string)"
    // note): every other action_index on WS v2 serializes as a string, and Number()
    // here would both break that type contract and lose precision above 2^53.
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
            truncated:          replay.truncated,
            // Additive: the lifecycle types live sends with no action row behind them,
            // which no replay can rebuild, so a client backfills them over REST.
            // NEW_BLOCK joins them when the request names the blocks channel.
            not_replayed:       notReplayed || ChangeDetector.NON_ACTION_LIFECYCLE_TYPES.slice()
        }
    };
    if (requestId !== undefined) complete.id = requestId;
    return complete;
}

class WebSocketCatchUp {

    // Handle catch-up replay of missed events. `channelKeys` are the keys the subscribe
    // resolved to; a direct caller that omits them gets the coin-wide actions view.
    async handleCatchUp(client, sinceActionIndex, filter, requestId, channelKeys) {
        const sinceBig = catchUpCursor(this, client, sinceActionIndex, requestId);
        if (sinceBig === null) return;

        // A request with no actions or address channel gets no replay: the actions channel
        // carries every lifecycle frame an entity channel does. Close it at once, unlatched.
        const keys = channelKeys ? new Set(channelKeys) : null;
        if (keys && !carriesActions(client.coin, keys)) {
            this.send(client, catchUpComplete(this.getCoinInfo(client.coin), [], sinceBig,
                { eventsReplayed: 0, truncated: false, tipStale: false }, requestId,
                notReplayedFor(client.coin, keys)));
            return;
        }

        // One catch-up per client, latched BEFORE the first await: a second request
        // arriving during the gates below is refused rather than replayed twice.
        if (client.catchUpInProgress) {
            this.sendError(client, 'CATCH_UP_IN_PROGRESS', 'A catch-up request is already running', requestId);
            return;
        }
        client.catchUpInProgress = true;
        try {
            await runCatchUp(this, client, sinceBig, filter, requestId, keys);
        } catch (e) {
            log.error('WS_CATCH_UP_FAILED', { client: client.id, err: e.message, stack: e.stack });
        } finally {
            client.catchUpInProgress = false;
        }
    }
}

// The gated replay, run with the client's latch held: the stale, seed and reorg gates,
// the ahead-of-tip and depth gates, then the replayed frames closed by one
// CATCH_UP_COMPLETE.
async function runCatchUp(server, client, sinceBig, filter, requestId, keys) {
    const db     = server.explorer.db;
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
    const tipStale = await server.isCoinTipStale(client.coin);
    if (tipStale && server.staleFailClosed()) {
        server.sendError(client, 'COIN_DATA_STALE',
            'Indexed data for this coin is stale beyond its maximum tip age; refusing to replay it as current.',
            requestId);
        return;
    }

    if (!await seedGate(server, client, requestId)) return;
    const startSeq = replayStartSeq(server, client);
    if (!reorgGate(server, client, sinceBig, requestId)) return;

    // Check the cursor against the tip: reject one above it or too far behind it
    try {
        // Both sides BigInt so the subtraction is exact and never mixes types;
        // getMaxActionIndex answers in BigInt, and BigInt() re-wraps a Number a
        // test double may return.
        const currentMax = BigInt(await db.getMaxActionIndex(config) || 0);
        // A cursor above the tip (a reorg lowered MAX(action_index), or a replica is
        // behind) would replay nothing and COMPLETE on the client's own index, never telling it.
        if (sinceBig > currentMax) {
            server.sendError(client, 'CATCH_UP_AHEAD_OF_TIP',
                `Requested action_index ${sinceBig} is ahead of current (${currentMax}). Use REST API to resync.`,
                requestId);
            return;
        }
        if (currentMax - sinceBig > BigInt(server.catchUpMaxDepth)) {
            server.sendError(client, 'CATCH_UP_TOO_OLD',
                `Requested action_index ${sinceBig} is more than ${server.catchUpMaxDepth} behind current (${currentMax}). Use REST API to backfill.`,
                requestId);
            return;
        }
    } catch (e) {
        server.sendError(client, 'CATCH_UP_TOO_OLD', 'Unable to determine current state', requestId);
        return;
    }

    await replayFrom(server, client, sinceBig, filter, requestId, keys, tipStale, startSeq);
}

// The replay step once every gate has passed: the missed rows up to the keys' ceilings,
// their frames, then one CATCH_UP_COMPLETE (none for a client shed or a rollback mid-replay).
async function replayFrom(server, client, sinceBig, filter, requestId, keys, tipStale, startSeq) {
    const db     = server.explorer.db;
    const config = { coin: client.coin };
    // Bounded by the keys' ceilings, so a row the live feed sends these keys is not
    // replayed to them as well (exactly once per key; rows above arrive live).
    const ceilings  = resolveCeilings(server, client, keys);
    const upTo      = replayUpperBound(ceilings);
    const actions   = upTo === null
        ? await db.getActionsSince(config, sinceBig, server.catchUpMaxEvents)
        : await db.getActionsSince(config, sinceBig, server.catchUpMaxEvents, upTo);
    const info      = server.getCoinInfo(client.coin);
    const truncated = actions.length >= server.catchUpMaxEvents;
    const reorged   = midReplayReorg(server, client, startSeq, actions, sinceBig, requestId);
    const replay    = await replayActions(server, client, actions, info, filter, tipStale, keys, ceilings, reorged);
    // A COMPLETE would claim rows a shed client never received, or rows a rollback voided.
    if (replay.shed || replay.reorged || reorged()) return;
    server.send(client, catchUpComplete(info, actions, sinceBig,
        { eventsReplayed: replay.eventsReplayed, truncated, tipStale }, requestId, notReplayedFor(client.coin, keys)));
}

module.exports = WebSocketCatchUp.prototype;
