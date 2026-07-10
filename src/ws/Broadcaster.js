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
 * XChain Explorer - Broadcaster
 *
 * Receives events from the ChangeDetector and broadcasts them to
 * subscribed WebSocket clients. Evaluates per-client filter pipeline:
 * types -> statuses -> ticks (AND logic), then applies fields
 * projection. Handles once auto-unsubscribe after first match.
 *
 ********************************************************************/

// Map coin prefix to chain/network for event envelope
const COIN_MAP = {};
['BTC', 'LTC', 'DOGE'].forEach(chain => {
    COIN_MAP[chain]       = { chain, network: 'mainnet' };
    COIN_MAP['T' + chain] = { chain, network: 'testnet' };
    COIN_MAP['R' + chain] = { chain, network: 'regtest' };
});

// BigInt-safe JSON serializer (shared with WebSocketServer via serialize.js so the
// two socket-send paths cannot drift). See serialize.js for the BigInt rationale.
const { safeStringify } = require('./serialize.js');
const { WS_SCHEMA_VERSION } = require('./schema-version.js');

class Broadcaster {

    constructor(options) {
        this.wsServer        = options.wsServer;
        this.changeDetector  = options.changeDetector;
        this.maxBackpressure = options.maxBackpressure || 65536;

        // Wire up ChangeDetector events
        this.changeDetector.on('block',           (coin, block)  => this._onBlock(coin, block));
        this.changeDetector.on('action',          (coin, action) => this._onAction(coin, action));
        this.changeDetector.on('lifecycle_event',  (coin, event)  => this._onLifecycleEvent(coin, event));
        this.changeDetector.on('entity_update',    (coin, event)  => this._onEntityUpdate(coin, event));
        this.changeDetector.on('mempool_action',   (coin, row)    => this._onMempoolAction(coin, row));
        this.changeDetector.on('mempool_removed',  (coin, row)    => this._onMempoolRemoved(coin, row));
    }

    // Handle a newly seen unconfirmed action (decoder mempool). Rows are
    // PRE-VALIDATION: the indexer can still reject them at confirmation,
    // so the payload deliberately carries the raw decoded action string
    // (`data`) for clients to parse, and no validity claim.
    _onMempoolAction(coin, row) {
        const info = COIN_MAP[coin];
        if (!info) return;

        const event = {
            type:      'MEMPOOL_ACTION',
            chain:     info.chain,
            network:   info.network,
            timestamp: Date.now(),
            data: {
                tx_hash: row.tx_hash || null,
                source:  row.source  || null,
                action:  row.action  || null,
                data:    row.data    || null
            }
        };

        // Global mempool channel + the source's address channel (destinations
        // live inside the undecoded action fields; clients parse those).
        this._broadcastToChannel(coin, 'mempool', event, row);
        if (row.source)
            this._broadcastToChannel(coin, 'address', event, row, row.source);
    }

    // Handle a tx leaving the mempool. Confirmed and evicted are indistinguishable
    // here; subscribers reconcile against confirmed NEW_ACTION events.
    _onMempoolRemoved(coin, row) {
        const info = COIN_MAP[coin];
        if (!info) return;

        const event = {
            type:      'MEMPOOL_REMOVED',
            chain:     info.chain,
            network:   info.network,
            timestamp: Date.now(),
            data:      { tx_hash: row.tx_hash || null }
        };
        this._broadcastToChannel(coin, 'mempool', event, row);
    }

    // Handle new block from ChangeDetector
    _onBlock(coin, block) {
        const info = COIN_MAP[coin];
        if (!info) return;

        const event = {
            type:      'NEW_BLOCK',
            chain:     info.chain,
            network:   info.network,
            timestamp: Date.now(),
            data: {
                block_index:  block.block_index,
                block_hash:   block.block_hash   || null,
                block_time:   block.block_time    || null,
                tx_count:     block.tx_count      || 0,
                action_count: block.action_count  || 0
            }
        };

        // Broadcast to 'blocks' channel subscribers
        this._broadcastToChannel(coin, 'blocks', event, null);

        // Also push NETWORK_STATS to 'network' subscribers
        const stats = {
            type:      'NETWORK_STATS',
            chain:     info.chain,
            network:   info.network,
            timestamp: Date.now(),
            data: {
                block_height:  block.block_index,
                total_actions: block.action_count || 0
            }
        };
        this._broadcastToChannel(coin, 'network', stats, null);
    }

    // Handle new action from ChangeDetector
    _onAction(coin, action) {
        const info = COIN_MAP[coin];
        if (!info) return;

        const event = {
            type:      'NEW_ACTION',
            chain:     info.chain,
            network:   info.network,
            timestamp: Date.now(),
            data: {
                action_index: action.action_index,
                action:       action.action       || null,
                tx_hash:      action.tx_hash      || null,
                block_index:  action.block_index   || null,
                source:       action.source        || null,
                destination:  action.destination   || null,
                status:       action.status        || null
            }
        };

        // Broadcast to 'actions' channel subscribers
        this._broadcastToChannel(coin, 'actions', event, action);

        // Also broadcast to address channel if the source/destination is subscribed
        if (action.source) {
            this._broadcastToChannel(coin, 'address', event, action, action.source);
        }
        if (action.destination && action.destination !== action.source) {
            this._broadcastToChannel(coin, 'address', event, action, action.destination);
        }
    }

    // Handle lifecycle events (ORDER_MATCH, COINPAY_REQUIRED, SWAP_MATCH, etc.)
    _onLifecycleEvent(coin, lifecycleEvent) {
        const info = COIN_MAP[coin];
        if (!info) return;

        const event = {
            type:      lifecycleEvent.type,
            chain:     info.chain,
            network:   info.network,
            timestamp: Date.now(),
            data:      lifecycleEvent.data
        };

        // Broadcast to 'actions' channel
        this._broadcastToChannel(coin, 'actions', event, lifecycleEvent);

        // If the lifecycle event names a dedicated channel (e.g. 'attestation'),
        // also broadcast there so clients can subscribe to just that stream.
        if (lifecycleEvent.channel) {
            this._broadcastToChannel(coin, lifecycleEvent.channel, event, lifecycleEvent);
        }

        // Broadcast to relevant address channels
        const addresses = this._extractAddresses(lifecycleEvent.data);
        for (const addr of addresses) {
            this._broadcastToChannel(coin, 'address', event, lifecycleEvent, addr);
        }
    }

    // Handle entity update events (ADDRESS_UPDATE, TOKEN_UPDATE, MARKET_UPDATE, DISPENSER_UPDATE)
    _onEntityUpdate(coin, updateEvent) {
        const info = COIN_MAP[coin];
        if (!info) return;

        const event = {
            type:      updateEvent.type,
            chain:     info.chain,
            network:   info.network,
            timestamp: Date.now(),
            data:      updateEvent.data
        };

        // Route to the correct entity channel
        let entityId = null;
        switch (updateEvent.channel) {
            case 'address':   entityId = updateEvent.data.address;      break;
            case 'token':     entityId = updateEvent.data.tick;         break;
            case 'dispenser': entityId = updateEvent.data.action_index; break;
        }

        if (updateEvent.channel === 'market') {
            // Market uses composite key
            const channelKey = coin + ':market:' + updateEvent.data.tick1 + ':' + updateEvent.data.tick2;
            this._broadcastToChannelKey(channelKey, event, updateEvent);
        } else if (entityId !== null && entityId !== undefined) {
            const channelKey = coin + ':' + updateEvent.channel + ':' + entityId;
            this._broadcastToChannelKey(channelKey, event, updateEvent);
        }
    }

    // Broadcast an event to all clients subscribed to a specific channel
    _broadcastToChannel(coin, channel, event, actionData, entityId) {
        let channelKey;
        if (entityId) {
            channelKey = coin + ':' + channel + ':' + entityId;
        } else {
            channelKey = coin + ':' + channel;
        }
        this._broadcastToChannelKey(channelKey, event, actionData);
    }

    // Broadcast to a specific channel key with filter evaluation
    _broadcastToChannelKey(channelKey, event, actionData) {
        const channelManager = this.wsServer.channelManager;
        const subscribers    = channelManager.getSubscribers(channelKey);
        if (!subscribers || subscribers.size === 0) return;

        const clients  = this.wsServer.getClients();
        const toRemove = []; // once: true subscriptions to remove after send

        for (const [clientId, filter] of subscribers) {
            const client = clients.get(clientId);
            if (!client) continue;

            // Backpressure check
            if (client.ws.bufferedAmount > this.maxBackpressure) continue;

            // Filter pipeline (AND logic): all non-null filters must pass
            if (!this._passesFilter(filter, event, actionData)) continue;

            // Apply fields projection
            const msg = filter.fields ? this._applyFieldsProjection(event, filter.fields) : event;

            // Send (stamped with the envelope schema version AFTER projection,
            // so the marker survives a fields filter; see ws/schema-version.js)
            if (client.ws.readyState === 1) {
                try {
                    if (msg && typeof msg === 'object' && msg.schema_version === undefined)
                        msg.schema_version = WS_SCHEMA_VERSION;
                    client.ws.send(safeStringify(msg));
                } catch (e) {
                    // Connection error
                    continue;
                }
            }

            // Track once subscriptions for removal
            if (filter.once) {
                toRemove.push({ clientId, channelKey });
            }
        }

        // Remove once subscriptions and send UNSUBSCRIBED
        for (const { clientId, channelKey: key } of toRemove) {
            const client = clients.get(clientId);
            subscribers.delete(clientId);
            if (subscribers.size === 0) channelManager.subscriptions.delete(key);
            if (client) {
                client.subscriptions.delete(key);
                this._send(client, {
                    type:      'UNSUBSCRIBED',
                    timestamp: Date.now(),
                    data:      { channel: key, reason: 'once' }
                });
            }
        }
    }

    // Evaluate filter pipeline against an event
    _passesFilter(filter, event, actionData) {
        // Types filter: check event type or action field
        if (filter.types) {
            const actionType = (actionData && actionData.action) || (event.data && event.data.action) || event.type;
            if (!filter.types.has(actionType) && !filter.types.has(event.type)) {
                return false;
            }
        }

        // Statuses filter
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
    _applyFieldsProjection(event, fields) {
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
    _extractAddresses(data) {
        const addrs = new Set();
        if (data.source)        addrs.add(data.source);
        if (data.destination)   addrs.add(data.destination);
        if (data.payer_address) addrs.add(data.payer_address);
        if (data.payee_address) addrs.add(data.payee_address);
        if (data.address)       addrs.add(data.address);
        return addrs;
    }

    // Send a message to a specific client
    _send(client, msg) {
        if (client.ws.readyState === 1) {
            try {
                client.ws.send(safeStringify(msg));
            } catch (e) {
                // ignore
            }
        }
    }
}

module.exports = Broadcaster;
