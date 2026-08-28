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

        // NETWORK_STATS ordering state. ChangeDetector emits 'block' synchronously
        // per block, but the stats frame needs an async DB read (getMaxActionIndex),
        // so a catch-up burst (up to fetchLimit blocks in one poll tick) would issue
        // concurrent reads whose completion order is not the dispatch order - a
        // subscriber could see block_height move backwards. Serialize the frames
        // per coin (_statsTails) and skip heights already superseded by a newer
        // queued block (_newestBlock), which also collapses a burst into a single
        // DB read for the newest height.
        this._statsTails  = new Map(); // coin -> promise tail
        this._newestBlock = new Map(); // coin -> highest block_index seen

        // MEMPOOL_ACTION / MEMPOOL_REMOVED ordering state, same problem and same
        // shape as _statsTails above: both mempool handlers now await a DB-backed
        // address-id resolution, while ChangeDetector's emit is synchronous and
        // awaits nothing, so a poll that emits an action and (for another tx) a
        // removal could otherwise deliver the removal first. One tail per coin
        // keeps the frames in the order the detector produced them.
        this._mempoolTails = new Map(); // coin -> promise tail

        // Per-coin address -> index-id memo for the mempool fan-out.
        // db.getExactAddressId caches only NON-null results (a never-indexed address is
        // re-queried every call), so without this a single subscribed address that
        // has never been indexed would cost one DB read PER MEMPOOL ROW: a 500-row
        // burst against N subscribed addresses would be O(N * 500) queries. Memoize
        // the null too and the same burst is O(N).
        // Invalidation: cleared per coin on the block signal (_onBlock) rather than
        // on a timer. An index id only ever changes meaning at a block boundary
        // (the indexer reassigns ids on a reorg, and a never-indexed address gets
        // its first id when its tx confirms), which is exactly when a block arrives,
        // so a per-block clear is a superset of the db layer's own reorg-generation
        // invalidation and needs no clock.
        this._addressIdMemo = new Map(); // coin -> Map<address, id|null>

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
    // Queued on the per-coin serial chain because the fan-out below awaits
    // address-id resolution (see _mempoolTails in the constructor).
    _onMempoolAction(coin, row) {
        this._queueMempoolFrame(coin, () => this._emitMempoolAction(coin, row));
    }

    // Handle a tx leaving the mempool. Confirmed and evicted are indistinguishable
    // here; subscribers reconcile against confirmed NEW_ACTION events.
    _onMempoolRemoved(coin, row) {
        this._queueMempoolFrame(coin, () => this._emitMempoolRemoved(coin, row));
    }

    // Append one mempool frame emission to this coin's serial chain. The catch
    // keeps a failed emission from poisoning the chain for later frames, matching
    // the NETWORK_STATS tail in _onBlock.
    _queueMempoolFrame(coin, fn) {
        const tail = this._mempoolTails.get(coin) || Promise.resolve();
        this._mempoolTails.set(coin, tail.then(fn).catch(() => {}));
    }

    async _emitMempoolAction(coin, row) {
        const info = COIN_MAP[coin];
        if (!info) return;

        const base = {
            tx_hash: row.tx_hash || null,
            source:  row.source  || null,
            action:  row.action  || null,
            data:    row.data    || null,
            // Unix seconds the decoder first saw the tx; null against a
            // pre-first_seen decoder DB. Additive (spec M1.1): the wallet needs a
            // real observation time, because a client-stamped one cannot survive
            // a reconnect replay or tell a fresh tx from an hour-old one.
            first_seen: (row.first_seen === undefined) ? null : row.first_seen
        };

        const destinations = await this._matchMempoolDestinations(coin, row);

        // Address-channel frame carries `destinations`; the global frame does NOT
        // (I-43): the matched set is derived from THIS server's subscriber list, so
        // on the global channel it would either be empty for everyone or leak which
        // addresses other clients watch.
        const addressEvent = this._mempoolEvent('MEMPOOL_ACTION', info,
            Object.assign({}, base, { destinations: destinations }));
        if (row.source)
            this._broadcastToChannel(coin, 'address', addressEvent, row, row.source);
        for (const destination of destinations)
            this._broadcastToChannel(coin, 'address', addressEvent, row, destination);

        this._broadcastToChannel(coin, 'mempool', this._mempoolEvent('MEMPOOL_ACTION', info, base), row);
    }

    async _emitMempoolRemoved(coin, row) {
        const info = COIN_MAP[coin];
        if (!info) return;

        // `source` is additive (spec M1.1): without it a removal cannot be routed
        // to an address channel at all, so a wallet could show a pending entry the
        // network had already dropped with no event to reconcile it away.
        //
        // `action` is additive too, and is what makes this frame survive a `types`
        // filter: _passesFilter resolves an action name before falling back to the
        // literal event type, so a frame with no name is only ever matched by
        // types:['MEMPOOL_REMOVED'] and a subscriber filtering on families
        // (types:['SEND']) would get the MEMPOOL_ACTION and never its removal,
        // leaving a pending entry with nothing to reconcile it away. Null for a row
        // that never decoded, which claims no family and reaches only a subscriber
        // asking for the type itself or filtering on nothing.
        const base = {
            tx_hash: row.tx_hash || null,
            source:  row.source  || null,
            action:  row.action  || null
        };

        // Same matcher as the action path, re-run against CURRENT subscribers
        // rather than a set remembered at action time, so a client that subscribed
        // between the two frames still gets the removal (I-44).
        const destinations = await this._matchMempoolDestinations(coin, row);

        const addressEvent = this._mempoolEvent('MEMPOOL_REMOVED', info,
            Object.assign({}, base, { destinations: destinations }));
        if (row.source)
            this._broadcastToChannel(coin, 'address', addressEvent, row, row.source);
        for (const destination of destinations)
            this._broadcastToChannel(coin, 'address', addressEvent, row, destination);

        this._broadcastToChannel(coin, 'mempool', this._mempoolEvent('MEMPOOL_REMOVED', info, base), row);
    }

    _mempoolEvent(type, info, data) {
        return {
            type:      type,
            chain:     info.chain,
            network:   info.network,
            timestamp: Date.now(),
            data:      data
        };
    }

    // Which SUBSCRIBED addresses does this mempool row pay, besides its source?
    // Returns the matched literal addresses (a `^<id>` segment resolves back to
    // the literal address of the subscriber it matched), which is what the
    // address-channel frames carry as `destinations`.
    //
    // The source is excluded: it has its own routing above, and `destinations` is
    // the "other parties" list. Matching is delegated to db.mempoolRowMatchesAddress
    // so this path and the REST prefilter can never disagree about who a tx affects.
    async _matchMempoolDestinations(coin, row) {
        const channelManager = this.wsServer && this.wsServer.channelManager;
        if (!channelManager || typeof channelManager.getSubscribedAddresses !== 'function') return [];
        // No address subscribers for this coin means every _broadcastToChannel to an
        // address channel would early-return anyway, so skip the id work entirely:
        // an unwatched coin costs zero DB reads per mempool row.
        const addresses = channelManager.getSubscribedAddresses(coin);
        if (!addresses || addresses.size === 0) return [];

        const db = this.wsServer.explorer && this.wsServer.explorer.db;
        if (!db || typeof db.mempoolRowMatchesAddress !== 'function') return [];

        const matched = [];
        for (const address of addresses) {
            if (address === row.source) continue;
            const addressId = await this._resolveAddressId(coin, address);
            if (db.mempoolRowMatchesAddress(row, address, addressId))
                matched.push(address);
        }
        return matched;
    }

    // Address -> index id for the mempool fan-out, memoized per coin including
    // null results (see _addressIdMemo in the constructor for why null matters and
    // how the memo is invalidated). A thrown lookup is memoized as null too: the
    // alternative is re-querying a broken DB once per row per address, and the cost
    // of the memo is that compacted destinations for that address go unmatched
    // until the next block, which is the same degradation as running without M1.1.
    //
    // The lookup is db.getExactAddressId, the BYTE-EXACT resolver, never the
    // case-insensitive db.getAddressId: index_addresses is a ci table, so the ci
    // resolver answers a wrong-case subscription with the id of the address it
    // resembles and this fan-out would deliver that address's pending payments to
    // the wrong subscriber. A db that cannot resolve exactly resolves to null here,
    // which costs compacted `^<id>` matching and keeps literal matching, rather
    // than falling back to a lookup that routes frames to strangers.
    async _resolveAddressId(coin, address) {
        let memo = this._addressIdMemo.get(coin);
        if (!memo) {
            memo = new Map();
            this._addressIdMemo.set(coin, memo);
        }
        if (memo.has(address)) return memo.get(address);

        let id = null;
        try {
            const db = this.wsServer.explorer && this.wsServer.explorer.db;
            if (db && typeof db.getExactAddressId === 'function')
                id = await db.getExactAddressId({ coin }, address);
        } catch (e) {
            id = null;
        }
        if (id === undefined) id = null;
        memo.set(address, id);
        return id;
    }

    // Handle new block from ChangeDetector. NEW_BLOCK is broadcast synchronously
    // (in ChangeDetector emit order); the NETWORK_STATS frame is queued on the
    // per-coin serial chain (see constructor) so its async DB read cannot reorder
    // frames during a catch-up burst.
    _onBlock(coin, block) {
        const info = COIN_MAP[coin];
        if (!info) return;

        // A block is the only moment an address's index id can change meaning (a
        // reorg reassigns ids; a never-indexed address gets its first one when its
        // tx confirms), so drop this coin's mempool address-id memo here. See
        // _addressIdMemo in the constructor.
        this._addressIdMemo.delete(coin);

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

        this._broadcastToChannel(coin, 'blocks', event, null);

        // Queue the NETWORK_STATS frame on the per-coin serial chain. The final
        // catch keeps a failed emission from poisoning the chain for later blocks.
        if ((this._newestBlock.get(coin) || 0) < block.block_index)
            this._newestBlock.set(coin, block.block_index);
        const tail = this._statsTails.get(coin) || Promise.resolve();
        this._statsTails.set(coin, tail.then(() => this._emitNetworkStats(coin, info, block)).catch(() => {}));
    }

    // Push NETWORK_STATS to 'network' subscribers. total_actions must report
    // the CUMULATIVE max action index (matching the snapshot built in
    // WebSocketServer._sendSnapshots and the documented contract), not the
    // per-block action count, or a subscriber that seeds a counter from the
    // snapshot sees it collapse on the next live frame. Runs only on the
    // per-coin serial chain; a height superseded by a newer queued block is
    // skipped (its frame would be stale on arrival, and skipping collapses a
    // burst into one DB read).
    async _emitNetworkStats(coin, info, block) {
        if ((this._newestBlock.get(coin) || 0) > block.block_index) return;
        let totalActions = block.action_count || 0;
        try {
            totalActions = (await this.wsServer.explorer.db.getMaxActionIndex({ coin })) || 0;
        } catch (e) {
            // Non-fatal: fall back to the per-block count rather than drop the frame
        }
        const stats = {
            type:      'NETWORK_STATS',
            chain:     info.chain,
            network:   info.network,
            timestamp: Date.now(),
            data: {
                // Decimal strings, the v2 wire contract: total_actions comes from
                // the db getter as Number while block_height arrives as a BIGINT
                // row value, so the pair went out with two different JSON types
                // and neither matched the SNAPSHOT the same subscriber seeded
                // from. String() both so seed and live frame compare directly.
                block_height:  String(block.block_index),
                total_actions: String(totalActions)
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
                // 'destination' is intentionally omitted from the NEW_ACTION
                // contract: the block-derived actions feed (getActionsSince)
                // never selects a destination column, so it was always null here
                // while the catch-up replay path already omits it. Emitting an
                // always-null field advertises destination routing we cannot
                // honor; drop it so live and replay shapes match and clients do
                // not rely on it. The PLURAL `destinations` below replaces it and is
                // what address-channel routing now reads.
                status:       action.status        || null,
                // Additive (spec M1.4): the recipients of this action, resolved by
                // db.getActionsSince across the eight destination-bearing families.
                // Same field name and semantics as the mempool frames, so a client
                // reads one shape whether the tx is pending or confirmed.
                //
                // Unlike the mempool frames, this set is NOT derived from this
                // server's subscriber list (I-43 does not apply): it is public chain
                // data read from the indexer DB, so it belongs on EVERY channel the
                // frame reaches, the global `actions` channel included. It leaks
                // nothing a block explorer does not already publish.
                //
                // Always an array. db.getActionsSince guarantees the key on every
                // row and degrades a failed lookup to [], and the fallback here
                // covers a row reaching us from anywhere else (a test double, a
                // future producer), so no subscriber ever has to null-check.
                destinations: Array.isArray(action.destinations) ? action.destinations : []
            }
        };

        this._broadcastToChannel(coin, 'actions', event, action);

        // Also broadcast to the address channel of every party to the action. The
        // `seen` set is what keeps a client subscribed to an address that is BOTH
        // source and destination (a sweep back to yourself, a multi-output SEND with
        // change) from receiving the same frame twice; it also absorbs a repeated
        // destination should one ever survive the dedupe in db.js.
        const seen = new Set();
        for (const address of [action.source, ...event.data.destinations]) {
            if (!address || seen.has(address)) continue;
            seen.add(address);
            this._broadcastToChannel(coin, 'address', event, action, address);
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

        this._broadcastToChannel(coin, 'actions', event, lifecycleEvent);

        // If the lifecycle event names a dedicated channel (e.g. 'attestation'),
        // also broadcast there so clients can subscribe to just that stream.
        // Entity channels (dispenser) are keyed per-entity, so route to the
        // specific entity's channel key rather than the bare channel (which has
        // no subscribers): a dispenser subscription is coin:dispenser:<index>.
        if (lifecycleEvent.channel) {
            const entityId = this._lifecycleChannelEntityId(lifecycleEvent);
            if (entityId !== null && entityId !== undefined) {
                this._broadcastToChannel(coin, lifecycleEvent.channel, event, lifecycleEvent, entityId);
            } else {
                this._broadcastToChannel(coin, lifecycleEvent.channel, event, lifecycleEvent);
            }
        }

        // Broadcast to relevant address channels
        const addresses = this._extractAddresses(lifecycleEvent.data);
        for (const addr of addresses) {
            this._broadcastToChannel(coin, 'address', event, lifecycleEvent, addr);
        }
    }

    // Resolve the per-entity id a lifecycle event should route to when its
    // `channel` is an entity channel. Global lifecycle channels (e.g.
    // 'attestation') return null so the caller falls back to the bare channel.
    // The dispenser channel is keyed on the parent dispenser's action_index,
    // which the ChangeDetector enriches onto data.dispenser_action_index for the
    // DISPENSE / DISPENSER_CLOSED / DISPENSER_EXPIRED events.
    _lifecycleChannelEntityId(lifecycleEvent) {
        if (lifecycleEvent.channel === 'dispenser') {
            const idx = lifecycleEvent.data && lifecycleEvent.data.dispenser_action_index;
            return (idx === null || idx === undefined) ? null : idx;
        }
        // bet_feed is keyed on the parent market's action_index, which the
        // ChangeDetector enriches onto data.feed_action_index for BET / BET_EXPIRED.
        if (lifecycleEvent.channel === 'bet_feed') {
            const idx = lifecycleEvent.data && lifecycleEvent.data.feed_action_index;
            return (idx === null || idx === undefined) ? null : idx;
        }
        return null;
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
            // Stamp the entity channel INTO data, the way WebSocketServer._sendSnapshots
            // stamps it on the SNAPSHOT frame for the same entity. The channel was only
            // ever an internal routing field here, so the two frame families describing
            // one entity were discriminated by two different keys: data.channel for the
            // snapshot, envelope type for the live update. A consumer unifying the two on
            // data.channel (which the ChangeDetector comment about aligned frame shapes
            // invites) silently dropped every live update. Additive optional field, so no
            // schema bump (ws/schema-version.js). Copy rather than mutate: the same data
            // object goes to every other listener on this event.
            data:      { channel: updateEvent.channel, ...updateEvent.data }
        };

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
                // Emit the bare channel name with the entity id as a sibling field,
                // matching SUBSCRIBED/SUBSCRIPTION_LIST, instead of the internal
                // coin-prefixed channel key (e.g. "BTC:address:1abc...") -- a client
                // that tracks subscriptions by the bare name could never match this
                // frame and would leak the bookkeeping entry as still-live.
                const parsed = channelManager._parseChannelKey(key);
                this._send(client, {
                    type:      'UNSUBSCRIBED',
                    timestamp: Date.now(),
                    data:      Object.assign({ channel: parsed.channel }, parsed.entityKey, { reason: 'once' })
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

        // Statuses filter. This is currently a no-op for every event this
        // server produces (action.status is always the literal SQL NULL from db.js
        // getActionsSince, so `status` below is always falsy and the `has()` check
        // never runs). Left evaluating rather than short-circuited: proving it dead
        // requires tracing every _passesFilter caller (live actions/lifecycle/ATTEST
        // path and the catch-up replay path in WebSocketServer._handleCatchUp) plus
        // every producer in ChangeDetector.js, which is not a change safe to make
        // as a drive-by; WebSocketServer._handleSubscribe now echoes
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

    // Send a message to a specific client. Stamps schema_version like the other
    // two send sinks (WebSocketServer._send and _broadcastToChannelKey's
    // per-subscriber send) so the "every outbound frame is stamped" invariant
    // in ws/schema-version.js holds for this sink too (e.g. the UNSUBSCRIBED
    // frame emitted on a once:true subscription).
    _send(client, msg) {
        if (client.ws.readyState === 1) {
            try {
                if (msg && typeof msg === 'object' && msg.schema_version === undefined)
                    msg.schema_version = WS_SCHEMA_VERSION;
                client.ws.send(safeStringify(msg));
            } catch (e) {
                // ignore
            }
        }
    }
}

module.exports = Broadcaster;
