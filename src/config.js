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

// The parts this entry composes. They are pure: everything that touches the
// filesystem, the hub connector or module state stays here, so the config
// suite's proxyquire stubs on this file still govern the whole flow.
const { baseCoinTables, applyExplorerSection, resolveCoins } = require('./config/resolve_coins.js');
const { flattenHubConfig, hubFallbackOutcome }               = require('./config/apply_hub_values.js');
const { describeHubResponse, requireUsableConfig }           = require('./config/validate.js');

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

// Load a coin's own configuration file. Kept on this entry because it is the one
// step of the resolution walk that reads the filesystem, and the config suite
// stubs `fs` by proxyquire on THIS module; a part that required fs itself would
// escape the stub. Returns null when the file is absent, which the walk treats
// as "skip this entry".
function loadCoinConfig(coin, network){
    let coinFile = path.join(__dirname, 'coin-config', coin + '.js');
    if(!fs.existsSync(coinFile)){
        log.warn('CONFIG_COIN_FILE_MISSING', { file: coinFile });
        return null;
    }
    let cfg = require(coinFile);
    return cfg.getConfig(network);
}

// The explorer's own API details. Built per call, like the config that carries
// it, so a consumer that mutates config.API cannot reach the next config.
function apiSection(){
    return {
        host: API_HOST,
        user: API_USER,
        pass: API_PASS,
        ssl:  API_SSL,
        port: {
            http:  API_PORT_HTTP,
            https: API_PORT_HTTPS
        }
    };
}

// Ask the hub for the whole config tree, creating the connector on first use.
function pollHubConfig(endpoints){
    if (!hubConnector){
        hubConnector = new xchainHubConnector(endpoints)
    }

    return hubConnector.getAllConfig()
}

// While the explorer serves no coins it is useless, and nothing in the
// log says whether each poll got nothing, got an empty tree, or got
// coins it then discarded. Records that, and only in that state.
function recordEmptyPoll(jsonConfig){
    if(!configCache || Object.keys(configCache['COIN_AVAILABLE'] || {}).length === 0){
        const polled = (jsonConfig && typeof jsonConfig === 'object') ? Object.keys(jsonConfig) : null;
        log.warn('CONFIG_POLL_NO_COINS', {
            hub_returned: polled === null ? 'null' : polled.length + ' key(s) [' + polled.join(',') + ']',
            next_cursor: hubConnector.lastWatermark
        });
    }
}

// The hub answered with nothing usable. The decision lives in the part; module
// state is written here, where it lives.
function hubUnusableFallback(cause){
    const outcome = hubFallbackOutcome(cause, {
        cachedConfig:  configCache,
        loadDiskCache: loadConfigCacheFromDisk,
        log:           log
    });
    if (outcome.clearLastObtained) lastObtainedConfigValue = JSON.stringify(null);
    return outcome;
}

// The hub returned a usable config. Records the fetch time, decides whether the
// content actually moved, and flattens it when it did.
function hubUsableUpdate(jsonConfig, coinNetworks){
    // Record the fetch time even when the content is unchanged below, so the age
    // exposed in /status reflects the last genuine contact with the hub, not the
    // last config change.
    hubConfigFetchedAt = Date.now();

    // Compare by JSON content, not reference. getAllConfig returns
    // a fresh object every call, so the prior `!=` check fired on
    // every refresh, triggering downstream pool rebuilds 60x/hour
    // even when the hub returned identical config. Stringify lets
    // unchanged content short-circuit out via the else branch.
    const fetchedStr = JSON.stringify(jsonConfig)
    if (fetchedStr === lastObtainedConfigValue)
        return { serveCache: true };

    lastObtainedConfigValue = fetchedStr

    let newJsonConfig = flattenHubConfig(jsonConfig, coinNetworks, warnedUnknownCoins, log)
    jsonConfig = {"configs":newJsonConfig}

    // Persist last-known-good so an unreachable hub on a
    // later (re)start doesn't bring us up with zero coins.
    if (newJsonConfig.length > 0)
        persistConfigCache(jsonConfig);

    // Deferred to after `configCache = config`: subscribers re-read the
    // config through the CACHE (db/index.js setupConnectionPools), so firing here
    // hands them the PREVIOUS config and the rebuild silently does nothing.
    return { jsonConfig: jsonConfig, changed: true };
}

// The hub path end to end: poll, classify, then either fall back or take the
// new tree.
async function fetchHubConfig(endpoints, coinNetworks, configUtil){
    const jsonConfig = await pollHubConfig(endpoints)
    recordEmptyPoll(jsonConfig);

    const verdict = describeHubResponse(configUtil, jsonConfig);
    if (verdict.returnedNothing)
        return hubUnusableFallback(verdict.cause);

    return hubUsableUpdate(jsonConfig, coinNetworks);
}

// Standalone: the config comes from the environment instead.
// TODO: Verify this works once Javier has the code written into xchain-node or xchain-hub
function loadStandaloneConfig(){
    const nodeConfig = process.env.NODE_CONFIG;

    // A local config.json is optional; its absence is normal and only logged.
    let fileConfig = false;
    try {
        fileConfig = require('./config.json');
    } catch (error){
        log.info('CONFIG_FILE_NOT_LOADED', { err: String(error) });
    }

    // The file wins over the environment value when both are present.
    return (fileConfig) ? fileConfig : nodeConfig;
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

    defaultTheme: () => env.EXPLORER_DEFAULT_THEME || 'classic',
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
            // config is the explorer-wide object built out from the fixed coin
            // and network tables; the per-coin blocks land on it further down.
            let config = baseCoinTables();

            const configUtil = new util();
            let jsonConfig = null
            // Announced only after configCache is replaced below; see the trigger call.
            let configChanged = false

            // Endpoints present means the hub is the config source; the else
            // branch below is the standalone path with no hub to ask.
            if (endpoints){
                const fetched = await fetchHubConfig(endpoints, config['COIN_NETWORKS'], configUtil);
                // Nothing moved, or nothing usable arrived and we already hold a
                // config: serve what the cache has rather than rebuild from it.
                if (fetched.serveCache)
                    return configCache

                jsonConfig    = fetched.jsonConfig
                configChanged = fetched.changed === true
            } else {
                jsonConfig = loadStandaloneConfig()
            }

            requireUsableConfig(configUtil, jsonConfig);

            applyExplorerSection(config, jsonConfig, apiSection());
            resolveCoins(config, jsonConfig, loadCoinConfig);

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
