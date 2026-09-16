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
 * This file is the entry and keeps the read side of the subscription map.
 * The write side (subscribe, unsubscribe, the per-entry add and remove) lives
 * in channel_manager/subscribe.js, the channel-key build, parse and entity
 * resolution in channel_manager/keys.js, and the channel and type name sets in
 * channel_manager/channels.js. Both method parts arrive on
 * ChannelManager.prototype through mixinParts below, so every require of this
 * path still gets one class with the same methods and static exports.
 *
 ********************************************************************/

const { ENTITY_CHANNELS, ALL_CHANNELS, VALID_TYPES } = require('./channel_manager/channels.js');
const subscribeMethods = require('./channel_manager/subscribe.js');
const keyMethods       = require('./channel_manager/keys.js');

// Copies a part's methods onto the class prototype. Object.assign cannot do
// this: a class method is non-enumerable, so assign would copy nothing.
// A collision throws rather than resolving by require order, because the loser
// would vanish silently and the caller would run another part's method.
function mixinParts(target, ...sources) {
    for (const source of sources) {
        for (const name of Object.getOwnPropertyNames(source)) {
            if (name === 'constructor') continue;
            if (Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('ChannelManager part collision: ' + name + ' is defined twice');
            Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name));
        }
    }
}

class ChannelManager {

    constructor(options) {
        this.maxSubscriptions = options.maxSubscriptions || 25;

        // channelKey -> Map<clientId, filterObject>
        // e.g. "BTC:mainnet:blocks" -> Map { 1 => { types: null, ... } }
        // e.g. "BTC:mainnet:address:1A1zP1..." -> Map { 1 => { types: Set, ... } }
        this.subscriptions = new Map();
    }

    // List all subscriptions for a client
    listSubscriptions(client) {
        const result = [];
        for (const channelKey of client.subscriptions) {
            const clientMap = this.subscriptions.get(channelKey);
            if (!clientMap) continue;
            const filter = clientMap.get(client.id);
            if (!filter) continue;

            const parsed = this.parseChannelKey(channelKey);
            const entry  = { channel: parsed.channel };

            // Add entity identifiers
            if (parsed.entityKey) Object.assign(entry, parsed.entityKey);

            // Add filter info. 'statuses' and 'ticks' are deliberately omitted to match the
            // SUBSCRIBED confirmation (WebSocketServer.handleSubscribe): the actions feed
            // carries neither a status nor a tick column, so re-advertising either here
            // would let a client rely on a no-op.
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
            const key = this.buildChannelKey(coin, channel, entityIdentifier);
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
}

mixinParts(ChannelManager.prototype, subscribeMethods, keyMethods);

// Hung on the class rather than on module.exports so the file has ONE export
// shape; the class IS the export, so a requirer reads these at the same
// property names it always did.
ChannelManager.VALID_TYPES = VALID_TYPES;
ChannelManager.VALID_CHANNELS = ALL_CHANNELS;
// Exported so the snapshot invariant is derived from this authority rather than
// restated in a test: an entity channel names a thing with current state, so
// each one owes a case in WebSocketServer.sendSnapshots. bet_feed was added
// here and nowhere else, and its snapshot:true then sent no frame at all.
ChannelManager.ENTITY_CHANNELS = ENTITY_CHANNELS;

module.exports = ChannelManager;
