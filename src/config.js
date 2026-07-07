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
 * XChain Explorer - Configuration
 * 
 * This config file contains explorer specific configuration data
 * 
 * COIN specific configuration data is loaded from configs/<COIN>.js
 *
 ********************************************************************/

const fs                    = require('fs');
const path                  = require('path');
const util                  = require('./utility.js');
const xchainHubConnector    = require('./XChainHubConnector')

const API_HOST       = process.env.API_HOST || '127.0.0.1';
const API_USER       = false;
const API_PASS       = false;
const API_PORT_HTTP  = process.env.EXPLORER_API_PORT_HTTP  || 8080;
const API_PORT_HTTPS = process.env.EXPLORER_API_PORT_HTTPS || 8081;

// Parse a non-negative integer from an env var, falling back to defaultVal when
// the value is absent, empty, or non-numeric. Preserves 0 as a valid value.
const parseIntMin0 = (val, defaultVal) => {
    if(val === undefined || val === null || val === '') return defaultVal;
    let parsed = parseInt(val, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultVal;
};

//interval to update the config (default one minute; override via UPDATE_CONFIG_INTERVAL)
//one minute seems ok because adding new coin/network nodes won't occur so often
const UPDATE_CONFIG_INTERVAL = parseIntMin0(process.env.UPDATE_CONFIG_INTERVAL, 60000)

// Define SSL Configuration (SSL_DIR env var overrides the default src/ssl/ path).
// SSL files are untracked (see .gitignore *.pem); when absent we run HTTP-only
// so dev/regtest stacks come up without operator-provided certs.
const SSL_DIR  = process.env.SSL_DIR || path.join(__dirname, "ssl");
let API_SSL = null;
try {
    API_SSL = {
        key:  fs.readFileSync(path.join(SSL_DIR, "private.pem")),
        cert: fs.readFileSync(path.join(SSL_DIR, "cert.pem")),
        ca:   fs.readFileSync(path.join(SSL_DIR, "ca.pem"))
    };
} catch (err) {
    console.log("SSL files not found in " + SSL_DIR + "; HTTPS server will not start");
}

//This will hold the connection with the xchain-hub if a url and port are provided
let hubConnector = null;
//This will hold the last config string value obtained
let lastObtainedConfigValue = null;
//This will hold the last config created from the last obtained value
let configCache = null;
// Epoch ms of the last time the hub returned a usable config to us, regardless of
// whether that config differed from what we already had. Stays null until the first
// success, and is intentionally NOT advanced when we fall back to the disk/in-memory
// cache after an unreachable hub, so the age derived from it reflects genuine
// staleness of the served config when the hub is down.
let hubConfigFetchedAt = null;
// Tracks unrecognized top-level hub config keys we've already warned about, so a
// non-coin key (e.g. chain_tips written under an abbreviation) that reappears on
// every config refresh is logged once rather than on every block.
const warnedUnknownCoins = new Set();
//Emisor for config changed event
const configChangedEmisor = new EventTarget();
// Set to true after the first 'changed' event fires so late subscribers
// registered after startSync() has already ticked get an immediate replay.
let configChangedFired = false;

// Path to the on-disk last-known-good config cache. When the hub is
// unreachable at startup, this lets the explorer come up serving the last
// config it successfully fetched (degraded) instead of with zero coins.
// Override CONFIG_CACHE_FILE to point at a mounted volume so the cache
// survives container recreation.
const CONFIG_CACHE_FILE = process.env.CONFIG_CACHE_FILE || path.join(__dirname, '..', 'tmp', 'config-cache.json');

// Persist the last-known-good hub config (already in the flattened
// {configs:[...]} shape) to disk. Best-effort: a write failure must never
// break config loading, so failures are logged and swallowed.
function persistConfigCache(flattenedConfig){
    try {
        fs.mkdirSync(path.dirname(CONFIG_CACHE_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_CACHE_FILE, JSON.stringify(flattenedConfig));
    } catch (err){
        console.warn('Could not persist config cache to ' + CONFIG_CACHE_FILE + ': ', err);
    }
}

// Load the last-known-good hub config from disk. Returns the flattened
// {configs:[...]} object when present and non-empty, otherwise null.
function loadConfigCacheFromDisk(){
    try {
        if(!fs.existsSync(CONFIG_CACHE_FILE))
            return null;
        const parsed = JSON.parse(fs.readFileSync(CONFIG_CACHE_FILE, 'utf8'));
        if(parsed && Array.isArray(parsed.configs) && parsed.configs.length > 0)
            return parsed;
    } catch (err){
        console.warn('Could not load config cache from ' + CONFIG_CACHE_FILE + ': ', err);
    }
    return null;
}

module.exports = {

    // Epoch ms of the last successful hub-config fetch (null until the first success).
    // Exposed so the status endpoint can report how stale the served hub config is when
    // the hub is unreachable. Kept as a getter rather than a direct export because the
    // backing value lives in module scope and is reassigned on each fetch.
    getHubConfigFetchedAt: function(){
        return hubConfigFetchedAt;
    },

    startSync: function(endpoints){
        // Bare `getConfig` is not in lexical scope here; it lives on
        // module.exports. Arrow + `this` keeps the binding so the
        // scheduled tick actually refreshes the cache.
        //
        // The .catch() is essential: getConfig is async, so any rejection on a
        // tick (e.g. a hub blip) would otherwise surface as an unhandled
        // promise rejection (fatal in Node 15+). Swallow it, log, and keep
        // serving the in-memory cache until the hub recovers.
        setInterval(() => {
            this.getConfig(endpoints, false) //cache=false to replace the current cache
                .catch(err => console.warn('Config sync tick failed; continuing with cached config: ' + (err && err.message || err)));
        }, UPDATE_CONFIG_INTERVAL);
    },

    // Handle returning the current indexer configuration
    // endpoints: array of URL strings or legacy (url, port) pair
    getConfig: async function(endpoints=null, cache=true){
        if (cache && configCache){
            return configCache
        } else {
            let config     = {};
            let coinConfig = {};
            config['COIN_NETWORKS'] = {
                BTC:  'Bitcoin',
                LTC:  'Litecoin',
                DOGE: 'Dogecoin'
            };

            config['COIN_PREFIXES'] = {
                'mainnet': '',
                'testnet': 'T',
                'regtest': 'R'
            };

            let coinNetworksKeys = Object.keys(config['COIN_NETWORKS'])
            
            
            const configUtil = new util();
            let jsonConfig = null

            if (endpoints){
                if (!hubConnector){
                    hubConnector = new xchainHubConnector(endpoints)
                }
                
                jsonConfig = await hubConnector.getAllConfig()

                // Detect an unusable hub response (null after all retries, or an
                // empty object) up front so a hub outage never tears down a
                // working config or hard-fails startup.
                const hubReturnedNothing = configUtil.isNull(jsonConfig) ||
                    (typeof jsonConfig === 'object' && Object.keys(jsonConfig).length === 0);

                if (hubReturnedNothing){
                    // A transient blip during a periodic sync tick must not wipe
                    // a good config; keep serving what we already have. Surface
                    // it at error level (the connector only logs per-endpoint
                    // warns) so operators get one unambiguous signal that the
                    // hub is down and the served config is now stale, instead of
                    // discovering it only when downstream DB queries start failing.
                    if (configCache){
                        console.error('Hub unreachable: all endpoints failed after retries. Serving last-known-good cached config (may be stale until the hub recovers).');
                        return configCache;
                    }

                    // Cold start with the hub unreachable: fall back to the
                    // last-known-good config persisted on disk so the explorer
                    // comes up serving real coins instead of an empty config.
                    // The disk copy is already in the flattened {configs:[...]}
                    // shape, so skip the hub-shape transform below.
                    const diskConfig = loadConfigCacheFromDisk();
                    if (diskConfig){
                        console.warn('Hub unreachable at startup; loading last-known-good config from disk cache (' + diskConfig.configs.length + ' entries)');
                        jsonConfig = diskConfig;
                    } else {
                        // No cache anywhere (first-ever boot during an outage).
                        // Come up degraded with zero coins rather than crash;
                        // the sync loop will populate once the hub returns.
                        console.warn('Hub unreachable at startup and no config cache available; starting in degraded mode (no coins configured)');
                        lastObtainedConfigValue = JSON.stringify(null);
                        jsonConfig = {"configs":[]};
                    }
                } else {
                    // The hub returned a usable config; record the fetch time even when the
                    // content is unchanged below, so the age exposed in /status reflects the
                    // last genuine contact with the hub, not the last config change.
                    hubConfigFetchedAt = Date.now();

                    // Compare by JSON content, not reference. getAllConfig returns
                    // a fresh object every call, so the prior `!=` check fired on
                    // every refresh, triggering downstream pool rebuilds 60x/hour
                    // even when the hub returned identical config. Stringify lets
                    // unchanged content short-circuit out via the else branch.
                    const fetchedStr = JSON.stringify(jsonConfig)
                    if (fetchedStr !== lastObtainedConfigValue){
                        lastObtainedConfigValue = fetchedStr

                        let newJsonConfig = []
                        for (let nextCoin in jsonConfig){
                            let nextCoinLabel = coinNetworksKeys.find(key => config['COIN_NETWORKS'][key].toLowerCase() == nextCoin)

                            // The hub config tree can carry top-level keys that are
                            // not coins (e.g. chain_tips pushed by indexers under the
                            // coin abbreviation 'BTC' rather than the full name
                            // 'bitcoin'). Those don't map to a known coin label, so
                            // skip them instead of emitting an entry with coin:undefined
                            // that the coin-config loader below would choke on.
                            if(!nextCoinLabel){
                                if(!warnedUnknownCoins.has(nextCoin)){
                                    warnedUnknownCoins.add(nextCoin);
                                    console.warn('Config: skipping unrecognized coin key from hub config: ' + nextCoin);
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

                        jsonConfig = {"configs":newJsonConfig}

                        // Persist last-known-good so an unreachable hub on a
                        // later (re)start doesn't bring us up with zero coins.
                        if (newJsonConfig.length > 0)
                            persistConfigCache(jsonConfig);

                        this.triggerConfigChanged();
                    } else {
                        return configCache
                    }
                }
            } else {
                // TODO: Verify this works once Javier has the code written into xchain-node or xchain-hub
                const nodeConfig = process.env.NODE_CONFIG;

                let fileConfig = false;
                try {
                    fileConfig = require('./config.json');
                } catch (error){
                    console.log('caught error :' + error);
                }

                jsonConfig = (fileConfig) ? fileConfig : nodeConfig;
            }
            
            if(configUtil.isNull(jsonConfig))
                configUtil.throwError('No valid configuration information detected');

            config['COIN_SUPPORTED'] = {};
            for(let coin in config['COIN_NETWORKS']){
                for(let network in config['COIN_PREFIXES']){
                    let prefix = config['COIN_PREFIXES'][network],
                        code   = prefix + coin,
                        name   = config['COIN_NETWORKS'][coin] + ' (' + network + ')';
                    config['COIN_SUPPORTED'][code] = name;
                }
            }

            config['COIN_AVAILABLE'] = {};

            // TODO: See if we can clean this up by passing indexer config to explorer
            config['DISPENSER_LIST_DELAY'] = 3600;

            config['API'] = {
                host: API_HOST,
                user: API_USER,
                pass: API_PASS,
                ssl:  API_SSL,
                port: {
                    http:  API_PORT_HTTP,
                    https: API_PORT_HTTPS
                }
            }

            if(jsonConfig.iconDownload)
                config['iconDownload'] = jsonConfig.iconDownload;

            for(let info of jsonConfig.configs ){

                let coinFile   = path.join(__dirname, 'configs', info.coin + '.js');

                // Load COIN specific configuration file, or skip this entry.
                // A missing file means the config carried a coin this explorer
                // build has no config for (or an unmappable/junk key). Skip it
                // with a warning rather than throwing, so one stray entry can't
                // take the whole explorer down at startup.
                if(fs.existsSync(coinFile)){
                    let cfg    = require(coinFile);
                    coinConfig = cfg.getConfig(info.network);
                } else {
                    console.warn('Config: skipping config entry, missing COIN config file : ' + coinFile);
                    continue;
                }

                if(!config[info.coin]){
                    config[info.coin] = {
                        chain: coinConfig.chain
                    };
                }

                // Define NETWORK information object.
                // Hub config flattens services keyed as 'xchain-indexer' /
                // 'xchain-decoder'; legacy config.json uses 'indexer' /
                // 'decoder' directly. Accept either so both paths work.
                if(!config[info.coin][info.network]){
                    config[info.coin][info.network] = {
                        database: {
                            indexer: info['xchain-indexer'] || info.indexer,
                            decoder: info['xchain-decoder'] || info.decoder,
                            // Checkpoint source schema (config.json only). Either an
                            // externally-maintained hub schema (e.g. XChain_Hub on a
                            // single-server deployment) or, with self_sync: true, a
                            // local mirror this explorer populates itself from the
                            // hub's /hub-db feed (HubMirrorSyncManager; needs
                            // HUB_API_URL). Needed because xchain-sync deliberately
                            // excludes the hub-mirror tables (state_checkpoints /
                            // capability_snapshots / cross_chain_matches) from
                            // replication. See db.js checkpointDb.
                            checkpoint: info.checkpoint
                        },
                        address: coinConfig.address
                    };
                }

                let prefix = config['COIN_PREFIXES'][info.network],
                    code   = prefix + info.coin,
                    name   = info.coin + ' (' + info.network + ')';
                config['COIN_AVAILABLE'][code] = name;

            }
            
            configCache = config
            return config;
        }
    },
    
    //Adds a listener to the config change event.
    //If a 'changed' event has already fired (startSync ticked before this
    //subscriber registered), replay it immediately so the caller's handler
    //runs at least once and never misses the initial pool-rebuild signal.
    onConfigChanged: function(callback){
      configChangedEmisor.addEventListener("changed", callback);
      if(configChangedFired) callback(new CustomEvent("changed"));
    },

    //Triggers the config changed event
    triggerConfigChanged: function(){
      configChangedFired = true;
      const event = new CustomEvent("changed");
      configChangedEmisor.dispatchEvent(event);
    }
}