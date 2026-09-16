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
 * XChain Explorer - coin tables and per-coin resolution
 *
 * One part of src/config.js (the entry requires it directly). Everything that
 * turns a validated config document into the coin tables every consumer reads:
 * the fixed coin and network tables, the code expansion for every combination
 * XChain knows of, the explorer's own API block, and the walk over the entries
 * the hub or config.json named.
 *
 * The functions run in the order the entry calls them and write their keys onto
 * the same config object in that order, because the object IS the published
 * config: reordering the writes reorders the keys a consumer serializes.
 *
 * coin-config/<COIN>.js is loaded through the entry's loadCoinConfig callback
 * rather than by requiring fs here. The config suite stubs `fs` by proxyquire on
 * src/config.js, and proxyquire substitutes only the stubbed module's own direct
 * requires, so a part that read the filesystem itself would escape the stub and
 * reach real disk under test.
 *
 ********************************************************************/

'use strict';

/**
 * The fixed coin and network tables every explorer config starts from. Built
 * fresh per call: the object is handed to consumers, so a shared one would let
 * a mutation reach back into the next config.
 *
 * @returns {object} a config carrying COIN_NETWORKS and COIN_PREFIXES
 */
function baseCoinTables(){
    let config = {};

    // The coins XChain supports, keyed by their abbreviation.
    config['COIN_NETWORKS'] = {
        BTC:  'Bitcoin',
        LTC:  'Litecoin',
        DOGE: 'Dogecoin'
    };

    // Network prefix on a coin code: T is testnet, R is regtest, mainnet
    // carries none (so BTC, TBTC, RBTC).
    config['COIN_PREFIXES'] = {
        'mainnet': '',
        'testnet': 'T',
        'regtest': 'R'
    };

    return config;
}

/**
 * The explorer-wide sections that do not depend on which coins resolved: the
 * full supported set, the empty available set the walk below fills in, the
 * indexer settings the hub config does not carry, and the API block.
 *
 * @param {object} config the config being built, written in place
 * @param {object} jsonConfig the validated config document
 * @param {object} api the explorer's own API details (host, ports, ssl)
 */
function applyExplorerSection(config, jsonConfig, api){
    // Every coin and network combination XChain knows of (BTC, TBTC, RBTC, ...),
    // whether or not this instance serves it.
    config['COIN_SUPPORTED'] = {};
    for(let coin in config['COIN_NETWORKS']){
        for(let network in config['COIN_PREFIXES']){
            let prefix = config['COIN_PREFIXES'][network],
                code   = prefix + coin,
                name   = config['COIN_NETWORKS'][coin] + ' (' + network + ')';
            config['COIN_SUPPORTED'][code] = name;
        }
    }

    // The narrower set this instance actually serves, filled in by the
    // per-coin loop below.
    config['COIN_AVAILABLE'] = {};

    // Indexer settings the explorer needs its own copy of, because the
    // hub config it is handed does not carry them.
    // TODO: See if we can clean this up by passing indexer config to explorer
    config['DISPENSER_LIST_DELAY'] = 3600;

    // The explorer's own API details, carried forward to every consumer
    // of the config.
    config['API'] = api;

    // Optional icon-downloader settings, carried forward for icons/downloader.js.
    if(jsonConfig.iconDownload)
        config['iconDownload'] = jsonConfig.iconDownload;
}

/**
 * The per-network block a coin entry publishes.
 *
 * @param {object} info one flattened config entry (coin, network, services)
 * @param {object} coinConfig the coin-config/<COIN>.js block for that network
 * @returns {object} the database endpoints and the address rules for it
 */
function networkEntry(info, coinConfig){
    // Define NETWORK information object.
    // Hub config flattens services keyed as 'xchain-indexer' /
    // 'xchain-decoder'; legacy config.json uses 'indexer' /
    // 'decoder' directly. Accept either so both paths work.
    return {
        database: {
            indexer: info['xchain-indexer'] || info.indexer,
            decoder: info['xchain-decoder'] || info.decoder,
            // Checkpoint source schema (config.json only). Either an
            // externally-maintained hub schema (e.g. XChain_Hub on a
            // single-server deployment) or, with self_sync: true, a
            // local mirror this explorer populates itself from the
            // hub's /hub-db feed (HubMirrorSyncManager; needs a hub
            // endpoint, carried as hub_url in this same block or
            // else the HUB_API_URL env). Needed because xchain-sync deliberately
            // excludes the hub-mirror tables (state_checkpoints /
            // capability_snapshots / cross_chain_matches) from
            // replication. See db/index.js checkpointDb.
            checkpoint: info.checkpoint
        },
        address: coinConfig.address
    };
}

/**
 * Walk every coin and network the config names and load its specific data.
 *
 * @param {object} config the config being built, written in place
 * @param {object} jsonConfig the validated config document ({configs:[...]})
 * @param {function} loadCoinConfig (coin, network) to the coin's config block,
 *        or null when this build carries no config for that coin
 */
function resolveCoins(config, jsonConfig, loadCoinConfig){
    // coinConfig is the per-coin block loaded from coin-config/ inside the loop.
    let coinConfig = {};

    for(let info of jsonConfig.configs ){

        // Per-coin settings live in their own file under coin-config/.
        //
        // Load COIN specific configuration file, or skip this entry.
        // A missing file means the config carried a coin this explorer
        // build has no config for (or an unmappable/junk key). Skip it
        // with a warning rather than throwing, so one stray entry can't
        // take the whole explorer down at startup.
        coinConfig = loadCoinConfig(info.coin, info.network);
        if(!coinConfig)
            continue;

        // First network seen for a coin creates the coin's own entry.
        if(!config[info.coin]){
            config[info.coin] = {
                chain: coinConfig.chain
            };
        }

        if(!config[info.coin][info.network]){
            config[info.coin][info.network] = networkEntry(info, coinConfig);
        }

        let prefix = config['COIN_PREFIXES'][info.network],
            code   = prefix + info.coin,
            name   = info.coin + ' (' + info.network + ')';
        config['COIN_AVAILABLE'][code] = name;

    }
}

module.exports = { baseCoinTables, applyExplorerSection, resolveCoins };
