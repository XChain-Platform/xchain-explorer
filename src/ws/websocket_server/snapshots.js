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
 * XChain Explorer - WebSocket Server: SNAPSHOT fan-out
 *
 * A subscribe carrying snapshot:true answers each newly subscribed entity with
 * its current state. This part runs that fan-out one batch per client at a
 * time, queues a request that lands mid fan-out, and reads and shapes one
 * SNAPSHOT frame per channel through the SNAPSHOTS table.
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

// How each channel's SNAPSHOT is built. `reads` are the db calls it needs, each
// returning the getter's promise unwrapped; sendSnapshots awaits them one at a
// time in order, so each read starts only after the previous one settles and the
// fan-out yields to the event loop exactly as often as the inline awaits did.
// `shape` builds the frame's data from the sub and the read results. A channel
// with no entry (actions, mempool, attestation) sends no SNAPSHOT. A Map, not an
// object literal, so no inherited name can ever resolve to an entry.
const SNAPSHOTS = new Map([
    ['blocks', {
        reads: [(db, config) => db.getMaxBlockIndex(config)],
        shape: (sub, [maxBlock]) => {
            // One tip key across both frame families on this channel. The
            // snapshot named the tip latest_block_index (matching WELCOME)
            // while every live NEW_BLOCK on the same channel names it
            // block_index (Broadcaster.onBlock), so a subscriber seeding
            // from the snapshot read undefined off its first live frame.
            // Both keys are emitted here rather than latest_block_index
            // being added to NEW_BLOCK: a per-block frame is NOT the tip
            // during a catch-up burst (ChangeDetector emits up to
            // fetchLimit blocks per poll), so 'latest' would be false on
            // every frame but the last.
            const tip = String(maxBlock || 0);
            return { channel: 'blocks', latest_block_index: tip, block_index: tip };
        }
    }],
    ['network', {
        reads: [(db, config) => db.getMaxBlockIndex(config), (db, config) => db.getMaxActionIndex(config)],
        shape: (sub, [maxBlock, maxAction]) =>
            ({ channel: 'network', block_height: String(maxBlock || 0), total_actions: String(maxAction || 0) })
    }],
    ['address', {
        reads: [(db, config, sub) => db.getAddressBalances(config, sub.address), (db, config) => db.getMaxActionIndex(config)],
        shape: (sub, [balances, maxAction]) =>
            ({ channel: 'address', address: sub.address, balances: balances || [], last_action_index: String(maxAction || 0) })
    }],
    ['token', {
        reads: [(db, config, sub) => db.getTokenInfo(config, sub.tick)],
        shape: (sub, [tokenInfo]) => ({ channel: 'token', tick: sub.tick, ...(tokenInfo || {}) })
    }],
    ['market', {
        reads: [(db, config, sub) => db.getMarketInfo(config, sub.tick1, sub.tick2)],
        shape: (sub, [marketInfo]) => ({ channel: 'market', tick1: sub.tick1, tick2: sub.tick2, ...(marketInfo || {}) })
    }],
    ['dispenser', {
        reads: [(db, config, sub) => db.getDispenserInfo(config, sub.action_index)],
        shape: (sub, [dispenserInfo]) => ({ channel: 'dispenser', action_index: sub.action_index, ...(dispenserInfo || {}) })
    }],
    // bet_feed is action_index-keyed exactly like dispenser above
    // (ChannelManager.ENTITY_CHANNELS). Without this case snapshotData
    // stayed null and the guard below skipped the send, so a market
    // page subscribing with snapshot:true got SUBSCRIBED, no initial
    // pools/status, and no error saying why.
    ['bet_feed', {
        reads: [(db, config, sub) => db.getBetFeedInfo(config, sub.action_index)],
        shape: (sub, [betFeedInfo]) => ({ channel: 'bet_feed', action_index: sub.action_index, ...(betFeedInfo || {}) })
    }],
    // xcall is call_id-keyed. The snapshot is the SAME lifecycle
    // composition the detail page reads (getXcall), so a client that
    // subscribes gets the call's current phase immediately and the live
    // frames then describe transitions from that point rather than
    // arriving with no baseline. `data` is spread the way the sibling
    // cases do; an unknown call_id leaves only the identity fields,
    // which is the honest snapshot of a call this chain has no row for.
    ['xcall', {
        reads: [(db, config, sub) => db.getXcallInfo(config, sub.call_id)],
        shape: (sub, [xcallInfo]) => ({ channel: 'xcall', call_id: sub.call_id, ...(xcallInfo || {}) })
    }]
]);

class WebSocketSnapshots {

    // Run one snapshot fan-out for this client, then drain anything that queued
    // behind it. The in-progress flag is the concurrency bound (one batch of DB
    // fan-out per client at a time); the queue is what keeps that bound from
    // silently swallowing a request.
    startSnapshotFanout(client, subs) {
        client.snapshotInProgress = true;
        Promise.resolve(this.sendSnapshots(client, subs))
            .catch(() => {})
            .finally(() => {
                client.snapshotInProgress = false;
                const queued = client.pendingSnapshots;
                if (queued && queued.length) {
                    client.pendingSnapshots = [];
                    // Nothing to fan out to once the socket is gone.
                    if (client.ws && client.ws.readyState === 1) this.startSnapshotFanout(client, queued);
                }
            });
    }

    // Defer a snapshot request that arrived mid fan-out. Deduped by entity key and
    // capped at the per-client subscription limit, so a resubscribe loop cannot
    // grow the queue without bound; an overflow gets an explicit refusal frame
    // rather than the silent drop this replaced.
    queueSnapshots(client, subs, requestId) {
        if (!Array.isArray(client.pendingSnapshots)) client.pendingSnapshots = [];
        const queue = client.pendingSnapshots;
        const have  = new Set(queue.map(s => this.channelManager.channelKeyForSub(client.coin, s)));
        const limit = this.channelManager.maxSubscriptions;
        let refused = false;

        for (const sub of subs) {
            const key = this.channelManager.channelKeyForSub(client.coin, sub);
            if (have.has(key)) continue;
            if (queue.length >= limit) { refused = true; break; }
            have.add(key);
            queue.push(sub);
        }

        if (refused) {
            this.sendError(client, 'SNAPSHOT_QUEUE_FULL',
                'A snapshot fan-out is already running and its queue is full (max ' + limit +
                ' pending entities); retry the subscribe with snapshot:true once it completes.', requestId);
        }
    }

    // Send snapshot data for subscribed entities
    async sendSnapshots(client, subscribed) {
        const db     = this.explorer.db;
        const config = { coin: client.coin };

        // A SNAPSHOT is the WS answer to "what is the current state of this
        // address/token/market". On a stale replica it is answered out of tables
        // that are behind, so it carries `stale: true` (the same additive marker
        // WELCOME uses) rather than being withheld: the HTTP read of the same rows
        // is served with the same marker, and a subscriber must not get a
        // different answer for the same question over a different transport. The
        // fail-closed opt-in keeps the old error frame.
        const snapshotStale = await this.isCoinTipStale(client.coin);
        if (snapshotStale && this.staleFailClosed()) {
            this.sendError(client, 'COIN_DATA_STALE',
                'Indexed data for this coin is stale beyond its maximum tip age; refusing to snapshot it as current.');
            return;
        }

        for (const sub of subscribed) {
            try {
                let snapshotData = null;

                // Same v2 decimal-string contract as WELCOME above: these indices
                // come from the db getters as Number, and the live frame the
                // subscriber sees next carries the same field as a string, so a
                // snapshot that seeds state must not seed it with the other type.
                const snapshot = SNAPSHOTS.get(sub.channel);
                if (snapshot) {
                    const values = [];
                    for (const read of snapshot.reads) values.push(await read(db, config, sub));
                    snapshotData = snapshot.shape(sub, values);
                }

                if (snapshotData) {
                    this.send(client, {
                        type:      'SNAPSHOT',
                        chain:     client.chain,
                        network:   client.network,
                        timestamp: Date.now(),
                        ...(snapshotStale ? { stale: true } : {}),
                        data:      snapshotData
                    });
                }
            } catch (e) {
                // Non-fatal: skip this snapshot
                log.error('WS_SNAPSHOT_FAILED', { channel: sub.channel, err: e.message, stack: e.stack });
            }
        }
    }
}

module.exports = WebSocketSnapshots.prototype;
