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
 * XChain Explorer - Channel Manager
 *
 * Manages per-client WebSocket subscriptions with optional filters
 * (types, statuses, ticks, fields, once, snapshot, since_action_index).
 * Supports batch entity subscriptions and subscription limits.
 *
 ********************************************************************/

// Valid global channels (no entity params needed)
const GLOBAL_CHANNELS = new Set(['blocks', 'actions', 'mempool', 'network', 'attestation']);

// Valid entity channels (require params)
// bet_feed is action_index-keyed exactly like dispenser: one market per feed id,
// carrying place / latch / resolve / cancel / expire events so a market page and a
// wallet see live pools (§11.1).
const ENTITY_CHANNELS = new Set(['address', 'token', 'market', 'dispenser', 'bet_feed']);

// All valid channels
const ALL_CHANNELS = new Set([...GLOBAL_CHANNELS, ...ENTITY_CHANNELS]);

// Valid action types for the types filter
const VALID_TYPES = new Set([
    // Indexed action types
    'ORDER', 'ORDER_MATCH', 'ORDER_EXPIRE',
    'COINPAY', 'COINPAY_EXPIRE',
    'SWAP', 'SWAP_MATCH', 'SWAP_EXPIRE',
    'DISPENSER', 'DISPENSE', 'DISPENSER_CLOSE', 'DISPENSER_EXPIRE',
    'SEND', 'SWEEP', 'AIRDROP', 'DIVIDEND',
    'ISSUE', 'MINT', 'DESTROY',
    'BROADCAST', 'CALLBACK', 'FILE', 'MESSAGE', 'LIST', 'LINK', 'SLEEP',
    'DEPLOY', 'EXECUTE', 'DEPOSIT', 'WITHDRAW',
    'STAKE', 'UNSTAKE', 'DELEGATE', 'COLLECT', 'ATTEST',
    // BET is one action name over four formats (create/cancel/place/resolve);
    // BET_EXPIRE is the system refund pass's minted action. Both are emitted on the
    // `bet_feed` channel, so both must be filterable: without them a subscriber
    // passing types:['BET'] was rejected outright with INVALID_TYPE, which failed
    // the whole subscribe rather than narrowing it.
    'BET', 'BET_EXPIRE',
    // Federation / cross-chain / oracle action types (real decoded actions
    // dispatched in xchain-indexer actions.js; they broadcast on the global
    // `actions` channel, so a client must be able to narrow to them too).
    // NOTE: CONTROLLER is intentionally absent: it is a field on ISSUE/ADDRESS
    // (data['CONTROLLER']), not an `action` type, so it never appears as an
    // actionData.action value and whitelisting it would silently match nothing.
    'PRICE', 'ANCHOR', 'XCALL', 'NODEPROOF',
    // Lifecycle event types (emitted by ChangeDetector, not indexed directly).
    // Only names the producer actually emits belong here (LIFECYCLE_MAP in
    // ChangeDetector.js plus its inline COINPAY_REQUIRED enrichment): the
    // WELCOME envelope advertises this set verbatim, so a phantom name would
    // be accepted by subscribe() yet silently match zero events - same
    // anti-pattern as the CONTROLLER note above.
    'COINPAY_REQUIRED', 'COINPAY_FULFILLED', 'COINPAY_EXPIRED',
    'ORDER_EXPIRED',
    'SWAP_EXPIRED',
    'DISPENSER_CLOSED', 'DISPENSER_EXPIRED',
    // BET_EXPIRED rides LIFECYCLE_MAP; BET_CLOSED is emitted by the ChangeDetector's
    // second cursor over bet_feeds.closed_block, because the deadline latch is a
    // direct status write with no action row behind it .
    'BET_EXPIRED', 'BET_CLOSED'
]);

class ChannelManager {

    constructor(options) {
        this.maxSubscriptions = options.maxSubscriptions || 25;

        // channelKey -> Map<clientId, filterObject>
        // e.g. "BTC:mainnet:blocks" -> Map { 1 => { types: null, ... } }
        // e.g. "BTC:mainnet:address:1A1zP1..." -> Map { 1 => { types: Set, ... } }
        this.subscriptions = new Map();
    }

    // Subscribe a client to one or more channels
    // Returns { success: true, subscribed: [...] } or { success: false, error: { code, message } }
    subscribe(client, channels, params) {
        params = params || {};

        // Validate channels
        if (!Array.isArray(channels) || channels.length === 0) {
            return { success: false, error: { code: 'INVALID_CHANNEL', message: 'channels must be a non-empty array' } };
        }
        for (const ch of channels) {
            if (!ALL_CHANNELS.has(ch)) {
                return { success: false, error: { code: 'INVALID_CHANNEL', message: `Unknown channel: ${ch}` } };
            }
        }

        // Validate types filter
        let typesFilter = null;
        if (params.types) {
            if (!Array.isArray(params.types)) {
                return { success: false, error: { code: 'INVALID_TYPE', message: 'types must be an array' } };
            }
            for (const t of params.types) {
                if (!VALID_TYPES.has(t)) {
                    return { success: false, error: { code: 'INVALID_TYPE', message: `Unknown action type: ${t}` } };
                }
            }
            typesFilter = new Set(params.types);
        }

        // Validate statuses filter
        let statusesFilter = null;
        if (params.statuses) {
            if (!Array.isArray(params.statuses)) {
                return { success: false, error: { code: 'INVALID_ACTION', message: 'statuses must be an array' } };
            }
            statusesFilter = new Set(params.statuses);
        }

        // Validate ticks filter (for global actions channel)
        let ticksFilter = null;
        if (params.ticks && Array.isArray(params.ticks) && channels.includes('actions')) {
            ticksFilter = new Set(params.ticks);
        }

        // Validate fields filter. Mirrors the types/statuses guard: without it a
        // non-iterable `fields` (e.g. {"fields":1} or {"fields":{}}) reaches
        // `new Set(params.fields)` below and throws a synchronous TypeError out of
        // the ws message handler, which no uncaughtException handler catches -
        // an unauthenticated single-frame process kill / crash loop (#3135).
        let fieldsFilter = null;
        if (params.fields) {
            if (!Array.isArray(params.fields) || params.fields.some(f => typeof f !== 'string')) {
                return { success: false, error: { code: 'INVALID_PARAMS', message: 'fields must be an array of strings' } };
            }
            fieldsFilter = new Set(params.fields);
        }

        // Build filter object
        const filter = {
            types:              typesFilter,
            statuses:           statusesFilter,
            ticks:              ticksFilter,
            fields:             fieldsFilter,
            once:               !!params.once,
            snapshot:           !!params.snapshot,
            since_action_index: params.since_action_index || null
        };

        // Resolve entity keys for batch and single subscriptions
        const subscribed = [];

        for (const channel of channels) {
            if (GLOBAL_CHANNELS.has(channel)) {
                // Global channel (no entity key)
                const result = this._addSubscription(client, channel, null, filter);
                if (result.error) return { success: false, error: result.error };
                subscribed.push({ channel });
            } else {
                // Entity channel: resolve entity key(s) from params
                const entityKeys = this._resolveEntityKeys(channel, params);
                if (entityKeys.error) return { success: false, error: entityKeys.error };

                for (const entityKey of entityKeys.keys) {
                    const result = this._addSubscription(client, channel, entityKey, filter);
                    if (result.error) return { success: false, error: result.error };
                    subscribed.push({ channel, ...entityKey });
                }
            }
        }

        return { success: true, subscribed, filter };
    }

    // Unsubscribe a client from channels
    unsubscribe(client, channels, params) {
        params = params || {};

        for (const channel of channels) {
            if (GLOBAL_CHANNELS.has(channel)) {
                this._removeSubscription(client, channel, null);
            } else {
                const entityKeys = this._resolveEntityKeys(channel, params);
                if (entityKeys.error) continue;
                for (const entityKey of entityKeys.keys) {
                    this._removeSubscription(client, channel, entityKey);
                }
            }
        }
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

    // List all subscriptions for a client
    listSubscriptions(client) {
        const result = [];
        for (const channelKey of client.subscriptions) {
            const clientMap = this.subscriptions.get(channelKey);
            if (!clientMap) continue;
            const filter = clientMap.get(client.id);
            if (!filter) continue;

            const parsed = this._parseChannelKey(channelKey);
            const entry  = { channel: parsed.channel };

            // Add entity identifiers
            if (parsed.entityKey) Object.assign(entry, parsed.entityKey);

            // Add filter info. 'statuses' and 'ticks' are deliberately omitted to match the
            // SUBSCRIBED confirmation (WebSocketServer._handleSubscribe): the actions feed
            // carries neither a status nor a tick column, so re-advertising either here
            // would let a client rely on a no-op (#3860).
            entry.filters = {
                types:    filter.types    ? [...filter.types]    : null,
                fields:   filter.fields   ? [...filter.fields]   : null,
                once:     filter.once
            };

            result.push(entry);
        }
        return result;
    }

    // Get all clients subscribed to a given channel key
    getSubscribers(channelKey) {
        return this.subscriptions.get(channelKey) || new Map();
    }

    // Check if any client is subscribed to a channel pattern
    // Used by ChangeDetector to decide whether to fetch detail data
    hasSubscribers(coin, channel, entityIdentifier) {
        if (entityIdentifier) {
            const key = this._buildChannelKey(coin, channel, entityIdentifier);
            const map = this.subscriptions.get(key);
            return map && map.size > 0;
        }
        // Check if anyone is subscribed to this channel for this coin
        const prefix = coin + ':' + channel;
        for (const key of this.subscriptions.keys()) {
            if (key.startsWith(prefix)) {
                const map = this.subscriptions.get(key);
                if (map && map.size > 0) return true;
            }
        }
        return false;
    }

    // Get all subscribed addresses for a given coin
    getSubscribedAddresses(coin) {
        const addresses = new Set();
        const prefix = coin + ':address:';
        for (const key of this.subscriptions.keys()) {
            if (key.startsWith(prefix)) {
                const map = this.subscriptions.get(key);
                if (map && map.size > 0) {
                    const addr = key.substring(prefix.length);
                    addresses.add(addr);
                }
            }
        }
        return addresses;
    }

    // Get all subscribed ticks for a given coin
    getSubscribedTicks(coin) {
        const ticks = new Set();
        const prefix = coin + ':token:';
        for (const key of this.subscriptions.keys()) {
            if (key.startsWith(prefix)) {
                const map = this.subscriptions.get(key);
                if (map && map.size > 0) {
                    const tick = key.substring(prefix.length);
                    ticks.add(tick);
                }
            }
        }
        return ticks;
    }

    // Get all subscribed market pairs for a given coin
    getSubscribedMarkets(coin) {
        const markets = [];
        const prefix = coin + ':market:';
        for (const key of this.subscriptions.keys()) {
            if (key.startsWith(prefix)) {
                const map = this.subscriptions.get(key);
                if (map && map.size > 0) {
                    const pair = key.substring(prefix.length);
                    const parts = pair.split(':');
                    if (parts.length === 2) markets.push({ tick1: parts[0], tick2: parts[1] });
                }
            }
        }
        return markets;
    }

    // Get all subscribed dispenser action_indexes for a given coin
    getSubscribedDispensers(coin) {
        const dispensers = new Set();
        const prefix = coin + ':dispenser:';
        for (const key of this.subscriptions.keys()) {
            if (key.startsWith(prefix)) {
                const map = this.subscriptions.get(key);
                if (map && map.size > 0) {
                    const idx = key.substring(prefix.length);
                    dispensers.add(idx);
                }
            }
        }
        return dispensers;
    }

    // ---- Internal methods ----

    _addSubscription(client, channel, entityKey, filter) {
        // Check subscription limit
        const channelKey = this._buildChannelKey(client.coin, channel, entityKey);

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

    _removeSubscription(client, channel, entityKey) {
        const channelKey = this._buildChannelKey(client.coin, channel, entityKey);
        const clientMap  = this.subscriptions.get(channelKey);
        if (clientMap) {
            clientMap.delete(client.id);
            if (clientMap.size === 0) this.subscriptions.delete(channelKey);
        }
        client.subscriptions.delete(channelKey);
    }

    // Build a unique key for a channel subscription
    // Format: "COIN:channel" for global, "COIN:channel:entityId" for entity
    _buildChannelKey(coin, channel, entityKey) {
        let key = coin + ':' + channel;
        if (entityKey) {
            if (entityKey.address)      key += ':' + entityKey.address;
            else if (entityKey.tick)    key += ':' + entityKey.tick;
            else if (entityKey.tick1)   key += ':' + entityKey.tick1 + ':' + entityKey.tick2;
            else if (entityKey.action_index !== undefined) key += ':' + entityKey.action_index;
        }
        return key;
    }

    // Public: the channel key for a `subscribed` entry (as returned by subscribe()).
    // Used by the WS server to tell freshly-added subscriptions apart from ones the
    // client already held, so a re-subscribe does not re-trigger the snapshot DB fan-out.
    // A `sub` carries {channel, address?/tick?/tick1?/tick2?/action_index?}, which is
    // exactly the entityKey shape _buildChannelKey reads.
    channelKeyForSub(coin, sub) {
        return this._buildChannelKey(coin, sub.channel, sub);
    }

    // Parse a channel key back into components
    _parseChannelKey(channelKey) {
        const parts   = channelKey.split(':');
        const coin    = parts[0];
        const channel = parts[1];
        let entityKey = null;

        if (channel === 'address' && parts.length > 2)   entityKey = { address: parts.slice(2).join(':') };
        if (channel === 'token' && parts.length > 2)      entityKey = { tick: parts[2] };
        if (channel === 'market' && parts.length > 3)     entityKey = { tick1: parts[2], tick2: parts[3] };
        // Keep the dispenser action_index as the canonical decimal STRING carried in the
        // channel key. Number() here diverged SUBSCRIPTION_LIST/UNSUBSCRIBED (number) from
        // SUBSCRIBED (client value) and lost precision above 2^53; the v2 wire contract is
        // BIGINT-as-string (ws/schema-version.js:26-29).
        if (channel === 'dispenser' && parts.length > 2)  entityKey = { action_index: parts[2] };
        if (channel === 'bet_feed'  && parts.length > 2)  entityKey = { action_index: parts[2] };

        return { coin, channel, entityKey };
    }

    // Resolve entity keys from subscribe params (supports batch via plural keys)
    _resolveEntityKeys(channel, params) {
        const keys = [];

        switch (channel) {
            case 'address':
                if (params.addresses && Array.isArray(params.addresses)) {
                    for (const addr of params.addresses) keys.push({ address: addr });
                } else if (params.address) {
                    keys.push({ address: params.address });
                } else {
                    return { error: { code: 'INVALID_CHANNEL', message: 'address channel requires address or addresses param' } };
                }
                break;

            case 'token':
                // "ticks" as a batch param vs "tick" as singular, but "ticks" is also used as a filter
                // Use context: if subscribing to "token" channel, ticks means entity list
                if (params.tick) {
                    keys.push({ tick: params.tick });
                } else if (params.ticks && Array.isArray(params.ticks)) {
                    for (const t of params.ticks) keys.push({ tick: t });
                } else {
                    return { error: { code: 'INVALID_CHANNEL', message: 'token channel requires tick or ticks param' } };
                }
                break;

            case 'market':
                if (params.pairs && Array.isArray(params.pairs)) {
                    for (const pair of params.pairs) {
                        if (Array.isArray(pair) && pair.length === 2) {
                            keys.push({ tick1: pair[0], tick2: pair[1] });
                        }
                    }
                } else if (params.tick1 && params.tick2) {
                    keys.push({ tick1: params.tick1, tick2: params.tick2 });
                } else {
                    return { error: { code: 'INVALID_CHANNEL', message: 'market channel requires tick1+tick2 or pairs param' } };
                }
                break;

            case 'dispenser':
            case 'bet_feed':
                // Normalize action_index to a canonical decimal STRING at the point of
                // subscription so SUBSCRIBED, SUBSCRIPTION_LIST and UNSUBSCRIBED all carry
                // the same representation (a client may send it as a number or a string).
                // bet_feed shares this shape: the feed id IS its creating action_index.
                if (params.action_indexes && Array.isArray(params.action_indexes)) {
                    for (const idx of params.action_indexes) keys.push({ action_index: String(idx) });
                } else if (params.action_index !== undefined) {
                    keys.push({ action_index: String(params.action_index) });
                } else {
                    return { error: { code: 'INVALID_CHANNEL', message: `${channel} channel requires action_index or action_indexes param` } };
                }
                break;

            default:
                return { error: { code: 'INVALID_CHANNEL', message: `Unknown entity channel: ${channel}` } };
        }

        if (keys.length === 0) {
            return { error: { code: 'INVALID_CHANNEL', message: `No entity keys resolved for channel: ${channel}` } };
        }

        return { keys };
    }
}

module.exports = ChannelManager;
module.exports.VALID_TYPES = VALID_TYPES;
module.exports.VALID_CHANNELS = ALL_CHANNELS;
