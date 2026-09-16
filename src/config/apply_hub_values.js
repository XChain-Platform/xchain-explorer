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
 * XChain Explorer - hub config tree to the flat configs list
 *
 * One part of src/config.js (the entry requires it directly). The hub serves a
 * nested coin/network/service tree; every consumer downstream reads the flat
 * {configs:[...]} shape the standalone config.json already uses, so the two
 * sources meet here and nowhere else.
 *
 * Pure: the warn set and the logger are passed in, so nothing here reaches the
 * network, the disk or module state, and the entry keeps deciding what to do
 * with the result.
 *
 ********************************************************************/

'use strict';

/**
 * Flatten the hub's coin/network/service tree into the configs list.
 *
 * @param {object} jsonConfig the hub tree, keyed by full coin name
 * @param {object} coinNetworks abbreviation to full coin name (config.COIN_NETWORKS)
 * @param {Set<string>} warnedUnknownCoins keys already warned about, added to in place
 * @param {object} log the service logger
 * @returns {object[]} one entry per coin and network the hub named
 */
function flattenHubConfig(jsonConfig, coinNetworks, warnedUnknownCoins, log){
    const coinNetworksKeys = Object.keys(coinNetworks)
    let newJsonConfig = []
    for (let nextCoin in jsonConfig){
        let nextCoinLabel = coinNetworksKeys.find(key => coinNetworks[key].toLowerCase() == nextCoin)

        // The hub config tree can carry top-level keys that are
        // not coins (e.g. chain_tips pushed by indexers under the
        // coin abbreviation 'BTC' rather than the full name
        // 'bitcoin'). Those don't map to a known coin label, so
        // skip them instead of emitting an entry with coin:undefined
        // that the coin-config loader below would choke on.
        if(!nextCoinLabel){
            if(!warnedUnknownCoins.has(nextCoin)){
                warnedUnknownCoins.add(nextCoin);
                log.warn('CONFIG_UNKNOWN_COIN_KEY_SKIPPED', { key: nextCoin });
            }
            continue;
        }

        for (let nextNetwork in jsonConfig[nextCoin]){
            let coinNetworkJson = {"coin":nextCoinLabel, "network":nextNetwork}

            for (let nextService in jsonConfig[nextCoin][nextNetwork]){
                coinNetworkJson[nextService] = jsonConfig[nextCoin][nextNetwork][nextService]
            }
            newJsonConfig.push(coinNetworkJson)
        }
    }
    return newJsonConfig;
}

/**
 * What to serve when the hub answered with nothing usable. Decides only; the
 * entry owns the module state, so the caller applies `clearLastObtained` and
 * hands back its own cache on `serveCache`.
 *
 * @param {string} cause the classified reason, for the operator-facing line
 * @param {object} deps cachedConfig (the in-memory config or null),
 *        loadDiskCache() and the service logger
 * @returns {{serveCache?: boolean, jsonConfig?: object, clearLastObtained?: boolean}}
 */
function hubFallbackOutcome(cause, deps){
    // A transient blip during a periodic sync tick must not wipe
    // a good config; keep serving what we already have. Surface
    // it at error level (the connector only logs per-endpoint
    // warns) so operators get one unambiguous signal that the
    // hub is down and the served config is now stale, instead of
    // discovering it only when downstream DB queries start failing.
    if (deps.cachedConfig){
        deps.log.error('CONFIG_HUB_UNUSABLE_SERVING_CACHE', { cause: cause, detail: 'serving last-known-good cached config (may be stale until the hub recovers)' });
        return { serveCache: true };
    }

    // Cold start with the hub unreachable: fall back to the
    // last-known-good config persisted on disk so the explorer
    // comes up serving real coins instead of an empty config.
    // The disk copy is already in the flattened {configs:[...]}
    // shape, so skip the hub-shape transform above.
    const diskConfig = deps.loadDiskCache();
    if (diskConfig){
        deps.log.warn('CONFIG_HUB_UNUSABLE_LOADING_DISK_CACHE', { cause: cause, entries: diskConfig.configs.length });
        return { jsonConfig: diskConfig };
    }

    // No cache anywhere (first-ever boot during an outage).
    // Come up degraded with zero coins rather than crash;
    // the sync loop will populate once the hub returns.
    deps.log.warn('CONFIG_HUB_UNUSABLE_DEGRADED_START', { cause: cause, detail: 'no config cache is available; starting in degraded mode (no coins configured); the sync loop retries every UPDATE_CONFIG_INTERVAL ms' });
    return { jsonConfig: {"configs":[]}, clearLastObtained: true };
}

module.exports = { flattenHubConfig, hubFallbackOutcome };
