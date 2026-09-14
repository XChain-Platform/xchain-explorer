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
 * XChain Explorer - Broadcaster, channel fan-out
 *
 * Delivery of one frame to every subscriber of a channel key: the per-client
 * filter pipeline (types -> statuses -> ticks), the fields projection, the
 * schema-version and stale stamps, and the once auto-unsubscribe.
 *
 * HOW THIS ATTACHES
 *
 * Authored as a class body and exported as that class's prototype, so
 * broadcaster.js can copy the methods onto Broadcaster.prototype by descriptor.
 * Nothing here is ever instantiated: `this` is the Broadcaster instance at call
 * time, exactly as it was when the methods sat inline. The per-subscriber delivery
 * and once-removal steps broadcastToChannelKey was cut into are plain module
 * functions, so the Broadcaster's method surface is the same set of names it
 * always had.
 *
 ********************************************************************/

'use strict';

// BigInt-safe JSON serializer (shared with WebSocketServer via serialize.js so the
// two socket-send paths cannot drift). See serialize.js for the BigInt rationale.
const { safeStringify } = require('../serialize.js');
const { WS_SCHEMA_VERSION } = require('../schema_version.js');

class ChannelFanout {

    // Send an event to every client subscribed to one channel. An entityId narrows the
    // key to a single entity (coin:channel:id); without one the frame goes to the
    // coin-wide channel (coin:channel) that anyone can watch.
    broadcastToChannel(coin, channel, event, actionData, entityId) {
        let channelKey;
        if (entityId) {
            channelKey = coin + ':' + channel + ':' + entityId;
        } else {
            channelKey = coin + ':' + channel;
        }
        this.broadcastToChannelKey(channelKey, event, actionData);
    }

    // Broadcast to a specific channel key with filter evaluation
    broadcastToChannelKey(channelKey, event, actionData) {
        const channelManager = this.wsServer.channelManager;
        const subscribers    = channelManager.getSubscribers(channelKey);
        if (!subscribers || subscribers.size === 0) return;

        const clients  = this.wsServer.getClients();
        const toRemove = []; // once: true subscriptions to remove after send

        for (const [clientId, filter] of subscribers) {
            const client = clients.get(clientId);
            if (!client) continue;

            if (!deliverToSubscriber(this, client, filter, event, actionData)) continue;

            // Track once subscriptions for removal
            if (filter.once) {
                toRemove.push({ clientId, channelKey });
            }
        }

        // Remove once subscriptions and send UNSUBSCRIBED
        removeOnceSubscriptions(this, channelManager, subscribers, clients, toRemove);
    }

    // Evaluate filter pipeline against an event
    passesFilter(filter, event, actionData) {
        // Types filter: check event type or action field
        if (filter.types) {
            const actionType = (actionData && actionData.action) || (event.data && event.data.action) || event.type;
            if (!filter.types.has(actionType) && !filter.types.has(event.type)) {
                return false;
            }
        }

        // Statuses filter. This is currently a no-op for every event this
        // server produces (action.status is always the literal SQL NULL from db/index.js
        // getActionsSince, so `status` below is always falsy and the `has()` check
        // never runs). Left evaluating rather than short-circuited: proving it dead
        // requires tracing every passesFilter caller (live actions/lifecycle/ATTEST
        // path and the catch-up replay path in WebSocketServer.handleCatchUp) plus
        // every producer in ws/change_detector.js, which is not a change safe to make
        // as a drive-by; WebSocketServer.handleSubscribe now echoes
        // `ignored_filters: ['statuses']` so a client sending it can observe the
        // no-op without relying on this evaluation being removed.
        if (filter.statuses) {
            const status = (actionData && actionData.status) || (event.data && event.data.status);
            if (status && !filter.statuses.has(status)) return false;
        }

        // Ticks filter (for global actions channel): filter by token
        if (filter.ticks) {
            const tick = (actionData && actionData.tick) || (event.data && event.data.tick) ||
                         (event.data && event.data.give_tick) || (event.data && event.data.get_tick);
            if (tick && !filter.ticks.has(tick)) return false;
            // If no tick field at all, let it through (e.g., block events)
        }

        return true;
    }

    // Apply fields projection: keep only requested keys in data, preserve envelope
    applyFieldsProjection(event, fields) {
        const projected = {
            type:      event.type,
            chain:     event.chain,
            network:   event.network,
            timestamp: event.timestamp,
            data:      {}
        };
        if (event.id !== undefined) projected.id = event.id;
        if (event.catch_up)         projected.catch_up = true;

        for (const key of fields) {
            if (event.data[key] !== undefined) {
                projected.data[key] = event.data[key];
            }
        }
        return projected;
    }

    // Extract all address fields from an event data object
    extractAddresses(data) {
        const addrs = new Set();
        if (data.source)        addrs.add(data.source);
        if (data.destination)   addrs.add(data.destination);
        if (data.payer_address) addrs.add(data.payer_address);
        if (data.payee_address) addrs.add(data.payee_address);
        if (data.address)       addrs.add(data.address);
        return addrs;
    }
}

// The filter step for one subscriber: backpressure, the filter pipeline, the
// projection, then the stamped send. Answers false when the subscriber was
// skipped or its send threw, which is what keeps a once subscription that was
// never delivered from being removed; true otherwise, including a socket that
// is not open (no send, but the once subscription still counts as spent).
function deliverToSubscriber(broadcaster, client, filter, event, actionData) {
    // Backpressure check
    if (client.ws.bufferedAmount > broadcaster.maxBackpressure) return false;

    // Filter pipeline (AND logic): all non-null filters must pass
    if (!broadcaster.passesFilter(filter, event, actionData)) return false;

    // Apply fields projection
    const msg = filter.fields ? broadcaster.applyFieldsProjection(event, filter.fields) : event;

    // Send (stamped with the envelope schema version AFTER projection,
    // so the marker survives a fields filter; see ws/schema_version.js)
    if (client.ws.readyState === 1) {
        try {
            if (msg && typeof msg === 'object' && msg.schema_version === undefined)
                msg.schema_version = WS_SCHEMA_VERSION;
            // Same additive stale marker send stamps, and for the same
            // reason: a live frame from a coin whose indexed tip is behind
            // must not read as the chain tip. After projection too, so a
            // fields filter cannot strip it.
            if (msg && typeof msg === 'object' && msg.stale === undefined &&
                broadcaster.changeDetector && broadcaster.changeDetector.staleCoins &&
                broadcaster.changeDetector.staleCoins.has(client.coin))
                msg.stale = true;
            client.ws.send(safeStringify(msg));
        } catch (e) {
            // Connection error
            return false;
        }
    }
    return true;
}

// The once step after the fan-out: drop each spent once subscription from the
// channel and the client, and tell the client with an UNSUBSCRIBED frame.
function removeOnceSubscriptions(broadcaster, channelManager, subscribers, clients, toRemove) {
    for (const { clientId, channelKey: key } of toRemove) {
        const client = clients.get(clientId);
        subscribers.delete(clientId);
        if (subscribers.size === 0) channelManager.subscriptions.delete(key);
        if (client) {
            client.subscriptions.delete(key);
            // Emit the bare channel name with the entity id as a sibling field,
            // matching SUBSCRIBED/SUBSCRIPTION_LIST, instead of the internal
            // coin-prefixed channel key (e.g. "BTC:address:1abc...") -- a client
            // that tracks subscriptions by the bare name could never match this
            // frame and would leak the bookkeeping entry as still-live.
            const parsed = channelManager.parseChannelKey(key);
            broadcaster.send(client, {
                type:      'UNSUBSCRIBED',
                timestamp: Date.now(),
                data:      Object.assign({ channel: parsed.channel }, parsed.entityKey, { reason: 'once' })
            });
        }
    }
}

module.exports = ChannelFanout.prototype;
