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
 * COIN specific configuration data is loaded from coin-config/<COIN>.js
 *
 ********************************************************************/

const fs                    = require('fs');
const path                  = require('path');
const util                  = require('./lib/utility.js');
const xchainHubConnector    = require('./connectors/hub')

// One logger for the whole service: getLogger() resolves to the shipper once api.js
// installs observability, and falls through to bare console before that.
const { getLogger }         = require('./observability');
const log                   = getLogger();

// Where the explorer's own API listens. Every value carries a local default so
// an unconfigured checkout still starts.
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
    log.info('SSL_FILES_NOT_FOUND', { ssl_dir: SSL_DIR, detail: 'HTTPS server will not start' });
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
// Interval handle for the periodic hub-config refresh, retained so stopSync()
// can clear it during the shutdown drain (src/http/shutdown.js). Null when sync was
// never started, which is the standalone NO_HUB case.
let syncTimer = null;

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
        log.warn('CONFIG_CACHE_PERSIST_FAILED', { file: CONFIG_CACHE_FILE, err: err && err.message ? err.message : err, stack: err && err.stack });
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
        log.warn('CONFIG_CACHE_LOAD_FAILED', { file: CONFIG_CACHE_FILE, err: err && err.message ? err.message : err, stack: err && err.stack });
    }
    return null;
}

// A live read-through view onto process.env, so the gate's
// process_env_outside_config rule has one home (config.js is itself exempt
// from it) without db/index.js or the readers losing any call-time or computed-key
// semantics. Several of the reads this replaces are dynamic keys
// (envPrefix + '_MS', 'UTXO_TRACKER_URL_' + code, per-coin
// EXPLORER_TIP_MAX_AGE_S_<COIN> / EXPLORER_TIP_MAX_FUTURE_SKEW_S_<COIN>), so
// a hand-listed key set (flat or nested) either misses a computed lookup or
// silently drops a coin added later without a config.js edit; a Proxy needs
// no list and can't fall behind one. get/has forward straight to
// process.env on every access (never cached, so a var set after this module
// loads still reads through, matching what direct process.env.X reads did
// before); values are the RAW string or undefined, with NO coercion and NO
// default, so every call site keeps its own `|| default` /
// `parseInt(...) || x` / `!== undefined ? ... : ...` unchanged. set/
// deleteProperty/defineProperty are neutered so env.X = ... can't silently
// diverge from process.env; the frozen empty target backs that up.
const env = new Proxy(Object.freeze({}), {
    get: (t, k) => (typeof k === 'string' ? process.env[k] : undefined),
    has: (t, k) => typeof k === 'string' && k in process.env,
    set: () => false,
    deleteProperty: () => false,
    defineProperty: () => false,
});

module.exports = {

    // Live read-through view of process.env (see the env const above for
    // the full contract). Consumed read-only: the db readers and api.js reach
    // it as configInfo.env.<KEY> through the configInfo they already hold,
    // and modules with no configInfo look it up per read through
    // require('./config.js').env, never at load: this file requires the hub
    // connector before these exports exist, and a load-time require would run
    // this file's SSL probe in every tool that only wanted a module.
    env: env,

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
        //
        // The handle is retained (and any prior one cleared, so a re-start replaces
        // rather than doubles the ticker) because the shutdown drain must stop it:
        // a tick landing mid-drain refetches hub config and emits 'changed', which
        // rebuilds the very connection pools the drain is closing.
        this.stopSync();
        syncTimer = setInterval(() => {
            this.getConfig(endpoints, false) //cache=false to replace the current cache
                .catch(err => log.warn('CONFIG_SYNC_TICK_FAILED', { err: err && err.message || err, detail: 'continuing with cached config' }));
        }, UPDATE_CONFIG_INTERVAL);
    },

    // Stop the periodic hub-config refresh. Idempotent, and a no-op when sync was
    // never started (standalone NO_HUB mode never calls startSync).
    stopSync: function(){
        if(!syncTimer) return;
        clearInterval(syncTimer);
        syncTimer = null;
    },

    // Handle returning the current indexer configuration
    // endpoints: array of URL strings
    getConfig: async function(endpoints=null, cache=true){
        if (cache && configCache){
            return configCache
        } else {
            // config is the explorer-wide object built below; coinConfig is the
            // per-coin block loaded from coin-config/ inside the loop.
            let config     = {};
            let coinConfig = {};
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

            let coinNetworksKeys = Object.keys(config['COIN_NETWORKS'])
            
            
            const configUtil = new util();
            let jsonConfig = null
            // Announced only after configCache is replaced below; see the trigger call.
            let configChanged = false

            // Endpoints present means the hub is the config source; the else
            // branch below is the standalone path with no hub to ask.
            if (endpoints){
                if (!hubConnector){
                    hubConnector = new xchainHubConnector(endpoints)
                }
                
                jsonConfig = await hubConnector.getAllConfig()

                // While the explorer serves no coins it is useless, and nothing in the
                // log says whether each poll got nothing, got an empty tree, or got
                // coins it then discarded. Records that, and only in that state.
                if(!configCache || Object.keys(configCache['COIN_AVAILABLE'] || {}).length === 0){
                    const polled = (jsonConfig && typeof jsonConfig === 'object') ? Object.keys(jsonConfig) : null;
                    log.warn('CONFIG_POLL_NO_COINS', {
                        hub_returned: polled === null ? 'null' : polled.length + ' key(s) [' + polled.join(',') + ']',
                        next_cursor: hubConnector.lastWatermark
                    });
                }

                // Detect an unusable hub response (null after all retries, or an
                // empty object) up front so a hub outage never tears down a
                // working config or hard-fails startup.
                const hubUnreachable = configUtil.isNull(jsonConfig);
                const hubReturnedNothing = hubUnreachable ||
                    (typeof jsonConfig === 'object' && Object.keys(jsonConfig).length === 0);

                // A hub that answers with an empty tree is NOT down: it is up and has no
                // coin config yet, which is the normal state while a stack is still being
                // installed. Reporting both as "unreachable" sends operators after a
                // network fault that does not exist.
                const hubCause = hubUnreachable
                    ? 'Hub unreachable (all endpoints failed after retries)'
                    : 'Hub reachable but serving no coin config';

                if (hubReturnedNothing){
                    // A transient blip during a periodic sync tick must not wipe
                    // a good config; keep serving what we already have. Surface
                    // it at error level (the connector only logs per-endpoint
                    // warns) so operators get one unambiguous signal that the
                    // hub is down and the served config is now stale, instead of
                    // discovering it only when downstream DB queries start failing.
                    if (configCache){
                        log.error('CONFIG_HUB_UNUSABLE_SERVING_CACHE', { cause: hubCause, detail: 'serving last-known-good cached config (may be stale until the hub recovers)' });
                        return configCache;
                    }

                    // Cold start with the hub unreachable: fall back to the
                    // last-known-good config persisted on disk so the explorer
                    // comes up serving real coins instead of an empty config.
                    // The disk copy is already in the flattened {configs:[...]}
                    // shape, so skip the hub-shape transform below.
                    const diskConfig = loadConfigCacheFromDisk();
                    if (diskConfig){
                        log.warn('CONFIG_HUB_UNUSABLE_LOADING_DISK_CACHE', { cause: hubCause, entries: diskConfig.configs.length });
                        jsonConfig = diskConfig;
                    } else {
                        // No cache anywhere (first-ever boot during an outage).
                        // Come up degraded with zero coins rather than crash;
                        // the sync loop will populate once the hub returns.
                        log.warn('CONFIG_HUB_UNUSABLE_DEGRADED_START', { cause: hubCause, detail: 'no config cache is available; starting in degraded mode (no coins configured); the sync loop retries every UPDATE_CONFIG_INTERVAL ms' });
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

                        jsonConfig = {"configs":newJsonConfig}

                        // Persist last-known-good so an unreachable hub on a
                        // later (re)start doesn't bring us up with zero coins.
                        if (newJsonConfig.length > 0)
                            persistConfigCache(jsonConfig);

                        // Deferred to after `configCache = config`: subscribers re-read the
                        // config through the CACHE (db/index.js setupConnectionPools), so firing here
                        // hands them the PREVIOUS config and the rebuild silently does nothing.
                        configChanged = true;
                    } else {
                        return configCache
                    }
                }
            } else {
                // Standalone: the config comes from the environment instead.
                // TODO: Verify this works once Javier has the code written into xchain-node or xchain-hub
                const nodeConfig = process.env.NODE_CONFIG;

                // A local config.json is optional; its absence is normal and only logged.
                let fileConfig = false;
                try {
                    fileConfig = require('./config.json');
                } catch (error){
                    log.info('CONFIG_FILE_NOT_LOADED', { err: String(error) });
                }

                // The file wins over the environment value when both are present.
                jsonConfig = (fileConfig) ? fileConfig : nodeConfig;
            }
            
            // Refuse to run without a usable config, whichever source supplied it.
            if(configUtil.isNull(jsonConfig))
                configUtil.throwError('No valid configuration information detected');

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

            // Optional icon-downloader settings, carried forward for icons/downloader.js.
            if(jsonConfig.iconDownload)
                config['iconDownload'] = jsonConfig.iconDownload;

            // Walk every coin and network the config names and load its specific data.
            for(let info of jsonConfig.configs ){

                // Per-coin settings live in their own file under coin-config/.
                let coinFile   = path.join(__dirname, 'coin-config', info.coin + '.js');

                // Load COIN specific configuration file, or skip this entry.
                // A missing file means the config carried a coin this explorer
                // build has no config for (or an unmappable/junk key). Skip it
                // with a warning rather than throwing, so one stray entry can't
                // take the whole explorer down at startup.
                if(fs.existsSync(coinFile)){
                    let cfg    = require(coinFile);
                    coinConfig = cfg.getConfig(info.network);
                } else {
                    log.warn('CONFIG_COIN_FILE_MISSING', { file: coinFile });
                    continue;
                }

                // First network seen for a coin creates the coin's own entry.
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

                let prefix = config['COIN_PREFIXES'][info.network],
                    code   = prefix + info.coin,
                    name   = info.coin + ' (' + info.network + ')';
                config['COIN_AVAILABLE'][code] = name;

            }
            
            configCache = config
            if(configChanged) this.triggerConfigChanged();
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