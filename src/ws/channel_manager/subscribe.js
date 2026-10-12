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
 * XChain Explorer - Channel Manager: subscribe and unsubscribe
 *
 * The write side of the subscription map: validating a subscribe request into
 * the filter every subscription it names shares, registering each channel and
 * entity under the per-client limit, and removing them again one at a time or
 * all at once when the client disconnects.
 *
 * HOW THIS ATTACHES
 *
 * The methods are authored as a class body and exported as that class's
 * prototype, so channel_manager.js can copy them onto ChannelManager.prototype
 * verbatim. Nothing here is ever instantiated: `this` is the ChannelManager
 * instance at call time, exactly as it was when these methods sat inline.
 *
 ********************************************************************/

'use strict';

const { GLOBAL_CHANNELS, ALL_CHANNELS, VALID_TYPES } = require('./channels.js');

// The first refusal a channels list earns, or null when every name is valid.
function channelsError(channels) {
    // Validate channels
    if (!Array.isArray(channels) || channels.length === 0) {
        return { code: 'INVALID_CHANNEL', message: 'channels must be a non-empty array' };
    }
    for (const ch of channels) {
        if (!ALL_CHANNELS.has(ch)) {
            return { code: 'INVALID_CHANNEL', message: `Unknown channel: ${ch}` };
        }
    }
    return null;
}

function buildTypesFilter(params) {
    // Validate types filter
    if (!params.types) return { filter: null };
    if (!Array.isArray(params.types)) {
        return { error: { code: 'INVALID_TYPE', message: 'types must be an array' } };
    }
    for (const t of params.types) {
        if (!VALID_TYPES.has(t)) {
            return { error: { code: 'INVALID_TYPE', message: `Unknown action type: ${t}` } };
        }
    }
    return { filter: new Set(params.types) };
}

function buildStatusesFilter(params) {
    // Validate statuses filter
    if (!params.statuses) return { filter: null };
    if (!Array.isArray(params.statuses)) {
        return { error: { code: 'INVALID_ACTION', message: 'statuses must be an array' } };
    }
    return { filter: new Set(params.statuses) };
}

function buildTicksFilter(channels, params) {
    // Validate ticks filter (for global actions channel)
    if (params.ticks && Array.isArray(params.ticks) && channels.includes('actions')) {
        return new Set(params.ticks);
    }
    return null;
}

function buildFieldsFilter(params) {
    // Validate fields filter. Mirrors the types/statuses guard: without it a
    // non-iterable `fields` (e.g. {"fields":1} or {"fields":{}}) reaches
    // `new Set(params.fields)` below and throws a synchronous TypeError out of
    // the ws message handler, which no uncaughtException handler catches -
    // an unauthenticated single-frame process kill / crash loop.
    if (!params.fields) return { filter: null };
    if (!Array.isArray(params.fields) || params.fields.some(f => typeof f !== 'string')) {
        return { error: { code: 'INVALID_PARAMS', message: 'fields must be an array of strings' } };
    }
    return { filter: new Set(params.fields) };
}

// Validates the filter params in the order the checks always ran and returns
// { error } for the first refusal, or { filter } shared by every subscription
// the request names.
function buildFilter(channels, params) {
    const types = buildTypesFilter(params);
    if (types.error) return types;

    const statuses = buildStatusesFilter(params);
    if (statuses.error) return statuses;

    const ticks = buildTicksFilter(channels, params);

    const fields = buildFieldsFilter(params);
    if (fields.error) return fields;

    // Build filter object
    const filter = {
        types:              types.filter,
        statuses:           statuses.filter,
        ticks,
        fields:             fields.filter,
        once:               !!params.once,
        snapshot:           !!params.snapshot,
        since_action_index: params.since_action_index || null
    };
    return { filter };
}

// Resolves every entry a request names, in request order, without saving any of
// them: { error } for the first channel whose entity keys do not resolve, else
// { entries } of { channel, entityKey } (entityKey null for a global channel).
function resolveEntries(manager, channels, params) {
    const entries = [];
    for (const channel of channels) {
        // Global channel (no entity key)
        if (GLOBAL_CHANNELS.has(channel)) {
            entries.push({ channel, entityKey: null });
            continue;
        }
        // Entity channel: resolve entity key(s) from params
        const entityKeys = manager.resolveEntityKeys(channel, params);
        if (entityKeys.error) return { error: entityKeys.error };
        for (const entityKey of entityKeys.keys) entries.push({ channel, entityKey });
    }
    return { entries };
}

// Refuses a batch whose NEW keys would carry the client past the limit. A key
// the client already holds, or one repeated in the batch, counts once, which is
// the answer the per-entry check in addSubscription gives when entries save one by one.
function limitError(manager, client, entries) {
    const newKeys = new Set();
    for (const { channel, entityKey } of entries) {
        const channelKey = manager.buildChannelKey(client.coin, channel, entityKey);
        if (!client.subscriptions.has(channelKey)) newKeys.add(channelKey);
    }
    if (client.subscriptions.size + newKeys.size <= manager.maxSubscriptions) return null;
    return { code: 'SUBSCRIPTION_LIMIT', message: `Maximum ${manager.maxSubscriptions} subscriptions exceeded` };
}

class ChannelSubscriptions {

    // Subscribe a client to one or more channels, all or nothing: every entry resolves and
    // the whole batch passes the limit before any is saved, so a refusal leaves nothing behind.
    // Returns { success: true, subscribed: [...] } or { success: false, error: { code, message } }
    subscribe(client, channels, params) {
        params = params || {};

        const invalidChannel = channelsError(channels);
        if (invalidChannel) return { success: false, error: invalidChannel };

        const built = buildFilter(channels, params);
        if (built.error) return { success: false, error: built.error };
        const filter = built.filter;

        // Resolve entity keys for batch and single subscriptions
        const resolved = resolveEntries(this, channels, params);
        if (resolved.error) return { success: false, error: resolved.error };

        // Check the limit for the whole batch before saving any of it
        const overLimit = limitError(this, client, resolved.entries);
        if (overLimit) return { success: false, error: overLimit };

        const subscribed = [];
        for (const { channel, entityKey } of resolved.entries) {
            // addSubscription keeps its own limit check as a backstop; the batch check above already passed
            const result = this.addSubscription(client, channel, entityKey, filter);
            if (result.error) return { success: false, error: result.error };
            subscribed.push(entityKey ? { channel, ...entityKey } : { channel });
        }

        return { success: true, subscribed, filter };
    }

    // Unsubscribe a client from channels. Returns the list of entities actually
    // targeted so the caller (WebSocketServer) can send back an UNSUBSCRIBED
    // frame naming each one -- without this a client cannot tell an honoured
    // unsubscribe from a message the server dropped.
    unsubscribe(client, channels, params) {
        params = params || {};
        const unsubscribed = [];

        for (const channel of channels) {
            if (GLOBAL_CHANNELS.has(channel)) {
                const was_subscribed = this.removeSubscription(client, channel, null);
                unsubscribed.push({ channel, was_subscribed });
            } else {
                const entityKeys = this.resolveEntityKeys(channel, params);
                if (entityKeys.error) continue;
                for (const entityKey of entityKeys.keys) {
                    const was_subscribed = this.removeSubscription(client, channel, entityKey);
                    unsubscribed.push({ channel, ...entityKey, was_subscribed });
                }
            }
        }

        return { unsubscribed };
    }

    // Remove all subscriptions for a client (on disconnect)
    removeClient(client) {
        for (const [channelKey, clientMap] of this.subscriptions) {
            clientMap.delete(client.id);
            if (clientMap.size === 0) {
                this.subscriptions.delete(channelKey);
            }
        }
        client.subscriptions.clear();
    }

    // ---- Internal methods ----

    addSubscription(client, channel, entityKey, filter) {
        // Check subscription limit
        const channelKey = this.buildChannelKey(client.coin, channel, entityKey);

        // If not already subscribed, check limit
        if (!client.subscriptions.has(channelKey)) {
            if (client.subscriptions.size >= this.maxSubscriptions) {
                return { error: { code: 'SUBSCRIPTION_LIMIT', message: `Maximum ${this.maxSubscriptions} subscriptions exceeded` } };
            }
        }

        // Get or create the channel's client map
        if (!this.subscriptions.has(channelKey)) {
            this.subscriptions.set(channelKey, new Map());
        }

        // Register the subscription
        this.subscriptions.get(channelKey).set(client.id, filter);
        client.subscriptions.add(channelKey);

        return { success: true };
    }

    // Returns true when the client actually held this subscription (and it was
    // removed), false when it was already absent (a no-op unsubscribe).
    removeSubscription(client, channel, entityKey) {
        const channelKey = this.buildChannelKey(client.coin, channel, entityKey);
        const clientMap  = this.subscriptions.get(channelKey);
        const was_subscribed = !!(clientMap && clientMap.has(client.id));
        if (clientMap) {
            clientMap.delete(client.id);
            if (clientMap.size === 0) this.subscriptions.delete(channelKey);
        }
        client.subscriptions.delete(channelKey);
        return was_subscribed;
    }
}

module.exports = ChannelSubscriptions.prototype;
