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
 * XChain Explorer - WebSocket Server: client messages and subscriptions
 *
 * The inbound side of a connection: the per-client message rate limit, JSON
 * parsing, the action dispatch table, and the subscribe, unsubscribe and
 * list_subscriptions handlers with the confirmation frames each one sends.
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

// The client actions and the handler each one runs. A Map rather than an object
// literal so an action named after an Object.prototype member ('constructor',
// 'toString') falls through to the unknown-action refusal instead of calling
// the inherited function.
const ACTION_HANDLERS = new Map([
    ['ping', (server, client) => {
        server.send(client, {
            type:      'pong',
            timestamp: Date.now(),
            data:      {}
        });
    }],
    ['subscribe',          (server, client, msg) => { server.handleSubscribe(client, msg); }],
    ['unsubscribe',        (server, client, msg) => { server.handleUnsubscribe(client, msg); }],
    ['list_subscriptions', (server, client, msg) => { server.handleListSubscriptions(client, msg); }]
]);

// Charges one message to the client's bucket and answers whether it is now over
// the server's per-second rate.
function overRateLimit(server, client) {
    // Rate limiting: sliding window via continuous decay (leaky bucket).
    // The count drains at maxMsgPerSec per second instead of resetting on a
    // 1s boundary, so a burst straddling a window edge cannot double the
    // effective rate the way the old tumbling reset allowed.
    const now     = Date.now();
    const elapsed = now - client.msgLastRefill;
    if (elapsed > 0) {
        client.msgCount = Math.max(0, client.msgCount - (elapsed / 1000) * server.maxMsgPerSec);
        client.msgLastRefill = now;
    }
    client.msgCount++;
    return client.msgCount > server.maxMsgPerSec;
}

// The filter names a subscribe request sent that no event this server produces
// can ever match, or null when it sent none.
function ignoredFiltersFor(params) {
    // Still accept a `statuses` filter (non-breaking: ChannelManager keeps
    // validating and storing it), but it is a no-op on every event this server
    // currently produces (action.status is a literal SQL NULL from db/index.js
    // getActionsSince, so Broadcaster.passesFilter's status check never fires).
    // Surface that as `ignored_filters` so a client that sent it can observe the
    // no-op instead of silently getting nothing. Same params object for the whole
    // subscribe() call, so this is constant across every confirmation below.
    // `ticks` joins it for the same reason: no action frame carries a
    // tick field, so the ticks check never fires either.
    const ignored = [];
    if (params.statuses) ignored.push('statuses');
    if (params.ticks)    ignored.push('ticks');
    return ignored.length ? ignored : null;
}

// The SUBSCRIBED confirmation frame for one subscribed entity.
function subscribedFrame(sub, filter, ignoredFilters, msg) {
    // 'statuses' and 'ticks' are deliberately not echoed here as ACTIVE filters:
    // confirming either back would let a client rely on a no-op. See the WELCOME
    // features note and the matching omission in ChannelManager.getSubscriptionList
    // (SUBSCRIPTION_LIST). Both are surfaced separately via `ignored_filters`.
    const activeFilters = {
        types:    filter.types    ? [...filter.types]    : null,
        fields:   filter.fields   ? [...filter.fields]   : null,
        once:     filter.once
    };
    const confirmation = {
        type:      'SUBSCRIBED',
        timestamp: Date.now(),
        data: {
            channel: sub.channel,
            // `filters` is the canonical key, shared with SUBSCRIPTION_LIST so a
            // client reads one key path across both frames. `active_filters` is a
            // deprecated alias kept for existing consumers.
            filters:        activeFilters,
            active_filters: activeFilters
        }
    };
    if (ignoredFilters) confirmation.data.ignored_filters = ignoredFilters;
    // Copy entity identifiers into the data
    if (sub.address)      confirmation.data.address      = sub.address;
    if (sub.tick)         confirmation.data.tick          = sub.tick;
    if (sub.tick1)        confirmation.data.tick1         = sub.tick1;
    if (sub.tick2)        confirmation.data.tick2         = sub.tick2;
    if (sub.action_index !== undefined) confirmation.data.action_index = sub.action_index;
    if (sub.call_id !== undefined)      confirmation.data.call_id      = sub.call_id;
    // Echo request id if provided
    if (msg.id !== undefined) confirmation.id = msg.id;
    return confirmation;
}

// Starts or queues the SNAPSHOT fan-out for the entities this subscribe call
// newly added.
function requestSnapshots(server, client, result, prevKeys, msg) {
    // Handle snapshot requests. Only snapshot entities NEWLY subscribed on this
    // call: ChannelManager.subscribe returns already-active entities in
    // result.subscribed too (idempotent add), so without this filter a client could
    // re-send the same batch at the message-rate limit and re-trigger the full
    // per-entity snapshot DB fan-out every message (~50 queries/batch). A per-client
    // in-progress guard (like catch-up) bounds concurrent fan-outs to one batch.
    const fresh = result.subscribed.filter(sub =>
        !prevKeys.has(server.channelManager.channelKeyForSub(client.coin, sub)));
    if (fresh.length) {
        // A second subscribe{snapshot:true} landing mid fan-out must not be
        // dropped on the floor: ChannelManager has already registered the
        // entity, so it is excluded from every later fresh filter too and
        // only unsubscribe/resubscribe could ever recover its SNAPSHOT. Queue
        // it instead, so concurrency stays bounded to one fan-out AND every
        // accepted request is eventually answered.
        if (client.snapshotInProgress) server.queueSnapshots(client, fresh, msg.id);
        else                           server.startSnapshotFanout(client, fresh);
    }
}

class WebSocketSubscriptions {

    // Handle incoming client message
    onMessage(client, data) {
        client.lastActivity = Date.now();

        if (overRateLimit(this, client)) {
            this.sendError(client, 'RATE_LIMITED', 'Too many messages (max ' + this.maxMsgPerSec + '/sec)');
            return;
        }

        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (e) {
            this.sendError(client, 'INVALID_ACTION', 'Malformed JSON');
            return;
        }

        if (!msg || typeof msg.action !== 'string') {
            this.sendError(client, 'INVALID_ACTION', 'Missing action field');
            return;
        }

        // Defense-in-depth: the ws surface is unauthenticated, and a synchronous
        // throw from any action handler escapes to `ws.on('message', ...)` with no
        // uncaughtException handler installed, terminating the process (a single
        // frame becomes a crash-loop DoS). Individual handlers validate
        // their input, but wrap the whole dispatch so any residual synchronous
        // throw returns an error frame and is logged, rather than killing the node.
        try {
            const handler = ACTION_HANDLERS.get(msg.action);
            if (handler) handler(this, client, msg);
            else         this.sendError(client, 'INVALID_ACTION', `Unknown action: ${msg.action}`, msg.id);
        } catch (err) {
            log.error('WS_HANDLER_THREW', { action: msg.action, err: err.message, stack: err.stack });
            this.sendError(client, 'INTERNAL_ERROR', 'Internal error handling message', msg.id);
        }
    }

    // Handle subscribe message
    handleSubscribe(client, msg) {
        const channels = msg.channels;
        const params   = msg.params || {};

        if (!Array.isArray(channels) || channels.length === 0) {
            this.sendError(client, 'INVALID_CHANNEL', 'channels must be a non-empty array', msg.id);
            return;
        }

        // Snapshot the keys the client already holds BEFORE subscribing, so a snapshot
        // request only fires for entities newly added by THIS call (see below).
        const prevKeys = new Set(client.subscriptions);

        const result = this.channelManager.subscribe(client, channels, params);

        if (!result.success) {
            const err = result.error;
            this.sendError(client, err.code, err.message, msg.id);
            return;
        }

        const ignoredFilters = ignoredFiltersFor(params);

        // Send SUBSCRIBED confirmation for each entity subscribed
        for (const sub of result.subscribed) {
            this.send(client, subscribedFrame(sub, result.filter, ignoredFilters, msg));
        }

        this.log('subscribe', client.id, { channels: channels.join(','), count: result.subscribed.length });

        if (params.snapshot) requestSnapshots(this, client, result, prevKeys, msg);

        // Handle catch-up requests
        if (params.since_action_index !== undefined && params.since_action_index !== null) {
            this.handleCatchUp(client, params.since_action_index, result.filter, msg.id);
        }
    }

    // Handle unsubscribe message
    handleUnsubscribe(client, msg) {
        const channels = msg.channels;
        const params   = msg.params || {};

        if (!Array.isArray(channels) || channels.length === 0) {
            this.sendError(client, 'INVALID_CHANNEL', 'channels must be a non-empty array', msg.id);
            return;
        }

        const result = this.channelManager.unsubscribe(client, channels, params);

        // Send an UNSUBSCRIBED confirmation for each entity targeted, so a client
        // can tell an honoured unsubscribe from a message the server dropped
        //. Shape matches SUBSCRIBED/Broadcaster's server-initiated
        // UNSUBSCRIBED: bare channel name plus entity identifiers as siblings.
        for (const target of result.unsubscribed) {
            const confirmation = {
                type:      'UNSUBSCRIBED',
                timestamp: Date.now(),
                data: {
                    channel:       target.channel,
                    was_subscribed: target.was_subscribed,
                    reason:        'client_request'
                }
            };
            if (target.address)      confirmation.data.address      = target.address;
            if (target.tick)         confirmation.data.tick          = target.tick;
            if (target.tick1)        confirmation.data.tick1         = target.tick1;
            if (target.tick2)        confirmation.data.tick2         = target.tick2;
            if (target.action_index !== undefined) confirmation.data.action_index = target.action_index;
            if (target.call_id !== undefined)      confirmation.data.call_id      = target.call_id;
            if (msg.id !== undefined) confirmation.id = msg.id;
            this.send(client, confirmation);
        }
    }

    // Handle list_subscriptions message
    handleListSubscriptions(client, msg) {
        const subs = this.channelManager.listSubscriptions(client);
        const response = {
            type:      'SUBSCRIPTION_LIST',
            timestamp: Date.now(),
            data: {
                count:         subs.length,
                limit:         this.channelManager.maxSubscriptions,
                subscriptions: subs
            }
        };
        if (msg.id !== undefined) response.id = msg.id;
        this.send(client, response);
    }
}

module.exports = WebSocketSubscriptions.prototype;
