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
 * XChain Explorer - Change Detector, entity updates
 *
 * The ADDRESS_UPDATE, TOKEN_UPDATE, DISPENSER_UPDATE and MARKET_UPDATE emits a
 * new action triggers for entities that have a subscriber, and the per-poll
 * read cache that keeps them to one read per entity.
 *
 * HOW THIS ATTACHES
 *
 * Authored as a class body and exported as that class's prototype, so
 * change_detector.js can copy the methods onto ChangeDetector.prototype by
 * descriptor. Nothing here is ever instantiated: `this` is the ChangeDetector
 * instance at call time, exactly as it was when the methods sat inline. The
 * per-entity-type steps are plain module functions, so the detector's method
 * surface is the same set of names it always had.
 *
 ********************************************************************/

'use strict';

class EntityUpdates {

    // Read an entity's enrichment info at most once per poll. `map` is one of the
    // per-poll caches built in checkCoin; a cache miss runs `loader` and stores its
    // result (including null), a hit returns the stored value without a DB round-trip.
    // A loader that throws is NOT cached and propagates to the caller's try/catch, so
    // the per-entity non-fatal skip behaviour is unchanged. When no cache is supplied
    // (e.g. a direct/legacy call) the loader always runs, preserving old behaviour.
    async entityRead(map, key, loader) {
        if (!map) return await loader();
        if (map.has(key)) return map.get(key);
        const value = await loader();
        map.set(key, value);
        return value;
    }

    // Emit entity updates when a new action touches something a client subscribed to.
    // Nothing is read for an entity with no subscriber, which is what keeps a busy
    // chain's poll from turning into one DB round-trip per action per entity.
    async emitEntityUpdates(coin, config, action, entityCache) {
        if (!this.channelManager) return;
        const cache = entityCache || null;

        // Only addresses someone is watching, and only when this action names one of
        // them as its source or one of its destinations.
        const subscribedAddresses = this.channelManager.getSubscribedAddresses(coin);
        if (subscribedAddresses.size > 0) {
            await emitAddressUpdates(this, coin, config, action, cache, subscribedAddresses);
        }

        // Token updates go out only when a tick has a subscriber: getActionsSince doesn't
        // carry the tick, so this is a lightweight action-type check that refreshes every
        // subscribed token (full tick resolution would mean joining more tables).
        const subscribedTicks = this.channelManager.getSubscribedTicks(coin);
        // XBRIDGE is on the list because its locks, burns and settle legs move supply
        // and holders of the bridged token; SWEEP moves every balance of its source in
        // its own single row, so holder counts change with no other action behind it.
        if (subscribedTicks.size > 0 && ['ISSUE', 'MINT', 'DESTROY', 'SEND', 'AIRDROP', 'DIVIDEND', 'XBRIDGE', 'SWEEP'].includes(action.action)) {
            await emitTokenUpdates(this, coin, config, action, cache, subscribedTicks);
        }

        // Same gate for dispensers: refresh only the ones with a subscriber, and only on
        // the dispenser-family actions that can change one.
        const subscribedDispensers = this.channelManager.getSubscribedDispensers(coin);
        if (subscribedDispensers.size > 0 && ['DISPENSE', 'DISPENSER', 'DISPENSER_CLOSE', 'DISPENSER_EXPIRE'].includes(action.action)) {
            await emitDispenserUpdates(this, coin, config, cache, subscribedDispensers);
        }

        // Same gate for markets, keyed by the tick pair and limited to the order and swap
        // actions that can move a book.
        const subscribedMarkets = this.channelManager.getSubscribedMarkets(coin);
        if (subscribedMarkets.length > 0 && ['ORDER', 'ORDER_MATCH', 'ORDER_EXPIRE', 'SWAP', 'SWAP_MATCH'].includes(action.action)) {
            await emitMarketUpdates(this, coin, config, cache, subscribedMarkets);
        }
    }
}

// ADDRESS_UPDATE for each subscribed address the action names as its source or
// one of its destinations (the plural field getActionsSince attaches; no producer
// sets a singular `destination`, the parties NEW_ACTION routes on in onAction).
async function emitAddressUpdates(detector, coin, config, action, cache, subscribedAddresses) {
    const involvedAddresses = new Set();
    const destinations = Array.isArray(action.destinations) ? action.destinations : [];
    for (const party of [action.source, ...destinations]) {
        if (party && subscribedAddresses.has(party)) involvedAddresses.add(party);
    }

    for (const addr of involvedAddresses) {
        try {
            const balances = await detector.entityRead(cache && cache.addr, addr, () => detector.db.getAddressBalances(config, addr));
            detector.emit('entity_update', coin, {
                type:    'ADDRESS_UPDATE',
                channel: 'address',
                data: {
                    address:           addr,
                    balances:          balances || [],
                    last_action_index: action.action_index
                }
            });
        } catch (e) {
            // Non-fatal
        }
    }
}

// TOKEN_UPDATE for every subscribed tick.
async function emitTokenUpdates(detector, coin, config, action, cache, subscribedTicks) {
    for (const tick of subscribedTicks) {
        try {
            const tokenInfo = await detector.entityRead(cache && cache.token, tick, () => detector.db.getTokenInfo(config, tick));
            if (tokenInfo) {
                detector.emit('entity_update', coin, {
                    type:    'TOKEN_UPDATE',
                    channel: 'token',
                    // Spread the full getTokenInfo projection (already loaded
                    // above) so the live frame is a superset of the SNAPSHOT
                    // frame, which spreads the same loader. Hand-picking
                    // supply/holders here made replace-model consumers lose
                    // decimals/description as silent undefined; the sibling
                    // address/market/dispenser channels already keep the two
                    // frame shapes aligned.
                    data: {
                        ...tokenInfo,
                        tick:              tick,
                        last_action_index: action.action_index
                    }
                });
            }
        } catch (e) {
            // Non-fatal
        }
    }
}

// DISPENSER_UPDATE for every subscribed dispenser.
async function emitDispenserUpdates(detector, coin, config, cache, subscribedDispensers) {
    for (const dispenserIdx of subscribedDispensers) {
        try {
            const dispenserInfo = await detector.entityRead(cache && cache.dispenser, dispenserIdx, () => detector.db.getDispenserInfo(config, dispenserIdx));
            if (dispenserInfo) {
                detector.emit('entity_update', coin, {
                    type:    'DISPENSER_UPDATE',
                    channel: 'dispenser',
                    data:    dispenserInfo
                });
            }
        } catch (e) {
            // Non-fatal
        }
    }
}

// MARKET_UPDATE for every subscribed tick pair.
async function emitMarketUpdates(detector, coin, config, cache, subscribedMarkets) {
    for (const market of subscribedMarkets) {
        try {
            const marketInfo = await detector.entityRead(cache && cache.market, market.tick1 + ' ' + market.tick2, () => detector.db.getMarketInfo(config, market.tick1, market.tick2));
            if (marketInfo) {
                // Route on the SUBSCRIBED spelling: Broadcaster keys on data.tick1/tick2 and
                // getMarketInfo returns canonical ticks, so a lower-case subscriber got no
                // live frame (same reason as the token channel's `tick: tick`).
                detector.emit('entity_update', coin, {
                    type:    'MARKET_UPDATE',
                    channel: 'market',
                    data:    { ...marketInfo, tick1: market.tick1, tick2: market.tick2 }
                });
            }
        } catch (e) {
            // Non-fatal
        }
    }
}

module.exports = EntityUpdates.prototype;
