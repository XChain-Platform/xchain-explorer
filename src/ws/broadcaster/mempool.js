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
 * XChain Explorer - Broadcaster, mempool frames
 *
 * MEMPOOL_ACTION and MEMPOOL_REMOVED: the per-coin serial queue they ride, the
 * frame builders, and the subscribed-destination matching with its per-coin
 * address-id memo.
 *
 * HOW THIS ATTACHES
 *
 * Authored as a class body and exported as that class's prototype, so
 * broadcaster.js can copy the methods onto Broadcaster.prototype by descriptor.
 * Nothing here is ever instantiated: `this` is the Broadcaster instance at call
 * time, exactly as it was when the methods sat inline, so the queue and memo
 * state the constructor creates (_mempoolTails, _addressIdMemo) resolves the same
 * way.
 *
 ********************************************************************/

'use strict';

const { COIN_MAP } = require('./coin_map.js');

class MempoolFrames {

    // Handle a newly seen unconfirmed action (decoder mempool). Rows are
    // PRE-VALIDATION: the indexer can still reject them at confirmation,
    // so the payload deliberately carries the raw decoded action string
    // (`data`) for clients to parse, and no validity claim.
    // Queued on the per-coin serial chain because the fan-out below awaits
    // address-id resolution (see _mempoolTails in the constructor).
    onMempoolAction(coin, row) {
        this.queueMempoolFrame(coin, () => this.emitMempoolAction(coin, row));
    }

    // Handle a tx leaving the mempool. Confirmed and evicted are indistinguishable
    // here; subscribers reconcile against confirmed NEW_ACTION events.
    onMempoolRemoved(coin, row) {
        this.queueMempoolFrame(coin, () => this.emitMempoolRemoved(coin, row));
    }

    // Append one mempool frame emission to this coin's serial chain. The catch
    // keeps a failed emission from poisoning the chain for later frames, matching
    // the NETWORK_STATS tail in onBlock.
    queueMempoolFrame(coin, fn) {
        const tail = this._mempoolTails.get(coin) || Promise.resolve();
        this._mempoolTails.set(coin, tail.then(fn).catch(() => {}));
    }

    async emitMempoolAction(coin, row) {
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

        const destinations = await this.matchMempoolDestinations(coin, row);

        // Address-channel frame carries `destinations`; the global frame does NOT
        // (I-43): the matched set is derived from THIS server's subscriber list, so
        // on the global channel it would either be empty for everyone or leak which
        // addresses other clients watch.
        const addressEvent = this.mempoolEvent('MEMPOOL_ACTION', info,
            Object.assign({}, base, { destinations: destinations }));
        if (row.source)
            this.broadcastToChannel(coin, 'address', addressEvent, row, row.source);
        for (const destination of destinations)
            this.broadcastToChannel(coin, 'address', addressEvent, row, destination);

        this.broadcastToChannel(coin, 'mempool', this.mempoolEvent('MEMPOOL_ACTION', info, base), row);
    }

    async emitMempoolRemoved(coin, row) {
        const info = COIN_MAP[coin];
        if (!info) return;

        // `source` is additive (spec M1.1): without it a removal cannot be routed
        // to an address channel at all, so a wallet could show a pending entry the
        // network had already dropped with no event to reconcile it away.
        //
        // `action` is additive too, and is what makes this frame survive a `types`
        // filter: passesFilter resolves an action name before falling back to the
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
        const destinations = await this.matchMempoolDestinations(coin, row);

        const addressEvent = this.mempoolEvent('MEMPOOL_REMOVED', info,
            Object.assign({}, base, { destinations: destinations }));
        if (row.source)
            this.broadcastToChannel(coin, 'address', addressEvent, row, row.source);
        for (const destination of destinations)
            this.broadcastToChannel(coin, 'address', addressEvent, row, destination);

        this.broadcastToChannel(coin, 'mempool', this.mempoolEvent('MEMPOOL_REMOVED', info, base), row);
    }

    mempoolEvent(type, info, data) {
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
    async matchMempoolDestinations(coin, row) {
        const channelManager = this.wsServer && this.wsServer.channelManager;
        if (!channelManager || typeof channelManager.getSubscribedAddresses !== 'function') return [];
        // No address subscribers for this coin means every broadcastToChannel to an
        // address channel would early-return anyway, so skip the id work entirely:
        // an unwatched coin costs zero DB reads per mempool row.
        const addresses = channelManager.getSubscribedAddresses(coin);
        if (!addresses || addresses.size === 0) return [];

        const db = this.wsServer.explorer && this.wsServer.explorer.db;
        if (!db || typeof db.mempoolRowMatchesAddress !== 'function') return [];

        const matched = [];
        for (const address of addresses) {
            if (address === row.source) continue;
            const addressId = await this.resolveAddressId(coin, address);
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
    async resolveAddressId(coin, address) {
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
}

module.exports = MempoolFrames.prototype;
