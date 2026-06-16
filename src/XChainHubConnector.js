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
 * XChain Explorer - Hub Connector
 *
 * This file handles connecting to XChain hub instances with
 * multi-endpoint fallback for high availability.
 *
 ********************************************************************/

// Load required libraries
const axios = require('axios');

// Fold a getallconfigs delta (only the rows that changed since our cursor) into
// the cached nested config map, mutating and returning `base`. The hub's configs
// table is upsert-only — rows are never deleted — so applying successive deltas
// reconstructs exactly the tree a full fetch would have produced.
function mergeConfigDelta(base, delta){
    for(let coin in delta){
        if(!base[coin]) base[coin] = {};
        for(let network in delta[coin]){
            if(!base[coin][network]) base[coin][network] = {};
            for(let module in delta[coin][network]){
                if(!base[coin][network][module]) base[coin][network][module] = {};
                let params = delta[coin][network][module];
                for(let param in params){
                    base[coin][network][module][param] = params[param];
                }
            }
        }
    }
    return base;
}

class XChainHubConnector {

    // Accept an array of endpoint URLs or a single host+port for backward compatibility
    constructor(endpoints, port) {
        if(Array.isArray(endpoints)){
            this.urls = endpoints;
        } else {
            this.urls = ["http://" + endpoints + ":" + port];
        }
        // Retry policy for config fetches. After a power cycle the hub (and its
        // MariaDB) may take several seconds to come up; a single-pass attempt
        // loses that race and leaves the explorer with no config. Retrying a
        // few times with exponential backoff bridges the gap. ping() opts out
        // (passes attempts:1) so liveness checks stay fast. Overridable via
        // HUB_RETRY_ATTEMPTS / HUB_RETRY_DELAY_MS (tests set delay 0).
        this.maxAttempts  = Number(process.env.HUB_RETRY_ATTEMPTS) || 4;
        this.retryDelayMs = process.env.HUB_RETRY_DELAY_MS !== undefined
            ? Number(process.env.HUB_RETRY_DELAY_MS) : 2000;
        // Sticky-last-good endpoint: start each endpoint pass at the last
        // endpoint that answered, so a degraded first endpoint isn't retried
        // first every call (which would cost the full timeout per call before
        // falling back).
        this._lastGoodIdx = 0;
        // Per-endpoint failure detail from the most recent _call() (final retry
        // pass). Populated with "url → code|message" strings for each unreachable
        // endpoint so callers can report exactly what was tried and why, instead
        // of a bare null.
        this.lastFailures = [];
        // Cached full config tree + its high-water mark (epoch seconds). The mark
        // is sent back as `since_updated_at` so the hub returns only rows changed
        // since the previous poll; the delta is merged into this cache and the
        // full map is returned, so config.js sees the same shape as before. 0
        // (initial / post-restart / old hub) requests the full tree.
        this.configs       = null;
        this.lastWatermark = 0;
    }

    // Internal: call a JSON-RPC method, trying each endpoint starting from the
    // last one that succeeded and wrapping around through the rest. Repeats the
    // full endpoint pass up to `attempts` times with exponential backoff before
    // giving up and returning null.
    async _call(data, { timeout = 5000, attempts = this.maxAttempts, delayMs = this.retryDelayMs } = {}){
        // A reachable-but-unhealthy hub responds with a non-2xx status (e.g. the
        // 503 "degraded" health body returned when its DB pool is down) that
        // still carries a valid JSON-RPC body. Axios throws on any non-2xx, so
        // without inspecting err.response that state is indistinguishable from an
        // unreachable endpoint. Remember such a body as a fallback but keep
        // retrying — a degraded DB may recover within the backoff window — and
        // only surface it if no endpoint comes back healthy.
        let degraded = null;
        for(let attempt = 1; attempt <= attempts; attempt++){
            // Reset each pass so lastFailures reflects the final attempt's
            // outcome rather than accumulating duplicates across retries.
            this.lastFailures = [];
            for(let i = 0; i < this.urls.length; i++){
                let idx = (this._lastGoodIdx + i) % this.urls.length;
                let url = this.urls[idx];
                try {
                    let response = await axios.post(url, data, { timeout });
                    if(response.data && response.data.result !== undefined){
                        this._lastGoodIdx = idx;
                        return response.data.result;
                    }
                } catch(err){
                    if(err.response && err.response.data && err.response.data.result !== undefined){
                        degraded = err.response.data.result;
                    } else {
                        this.lastFailures.push(url + ' → ' + (err.code || err.message));
                        console.warn('Hub endpoint ' + url + ' failed (attempt ' + attempt + '/' + attempts + '): ', err);
                    }
                }
            }
            // All endpoints failed this pass — back off before the next, unless
            // this was the final attempt.
            if(attempt < attempts){
                const backoff = delayMs * Math.pow(2, attempt - 1);
                console.warn('All hub endpoints unreachable (attempt ' + attempt + '/' + attempts + '); retrying in ' + backoff + 'ms');
                await new Promise(resolve => setTimeout(resolve, backoff));
            }
        }
        // No endpoint returned a healthy result after all retries. Surface a
        // reachable-but-degraded response (if any) so the caller can distinguish
        // "up but DB down" from "unreachable"; otherwise null.
        return degraded;
    }

    async ping(){
        // Liveness check — a single attempt, no retry/backoff.
        let result = await this._call({ jsonrpc: '2.0', method: 'ping', id: 1 }, { attempts: 1 });
        // A reachable-but-degraded hub returns a non-null {status:"degraded"}
        // body. The hub is up, so report it as reachable — but log the degraded
        // state so it stays visible to operators.
        if(result && typeof result === 'object' && result.status === 'degraded'){
            console.warn('Hub reachable but reporting degraded state: ', result);
        }
        return result !== null;
    }

    async getAllConfig(){
        let result = await this._call({
            jsonrpc: '2.0',
            method:  'getallconfigs',
            // Echo the high-water mark so the hub returns only rows changed since
            // our last poll; 0 requests the full tree (initial fetch / old hub).
            params:  { since_updated_at: this.lastWatermark },
            id:      1
        });
        // _call returns null when every endpoint failed after retries; preserve
        // that signal so config.js can fall back to its last-known-good cache.
        if(result === null) return null;
        // A reachable-but-degraded hub can't serve config (its DB is down) and
        // returns a {status:"degraded"} body. Treat it like an unreachable hub
        // for config purposes — return null so config.js falls back to its
        // last-known-good cache — but log the accurate cause so the operator
        // sees "degraded" rather than a misleading "unreachable".
        if(result && typeof result === 'object' && result.status === 'degraded'){
            console.warn('Hub reachable but DB degraded; cannot fetch config — falling back to cached config.');
            return null;
        }
        this.configs = this._applyConfigResult(result);
        return this.configs;
    }

    // Fold a getallconfigs result into this.configs and return the full nested
    // map. Newer hubs wrap the payload as { configs, seq, watermark }: when a
    // watermark is present the payload is a delta (only rows changed since the
    // cursor we sent), so we MERGE it into the cache and advance the cursor.
    // Older hubs return the bare map (or a { configs, seq } wrapper without a
    // watermark) — those are always the full tree, so we REPLACE. Callers
    // (config.js) see the same full-map shape regardless of hub version. seq is 0
    // against an old hub, which the caller treats as "no committed change seen".
    // The configs table is upsert-only (no row deletes), so merging successive
    // deltas reconstructs exactly what a full fetch would have returned.
    _applyConfigResult(result){
        let payload, seq, watermark;
        if(result && typeof result === 'object' && result.configs && typeof result.configs === 'object' && ('seq' in result)){
            payload   = result.configs;
            seq       = Number(result.seq) || 0;
            watermark = ('watermark' in result) ? result.watermark : undefined;
        } else {
            payload   = result;
            seq       = 0;
            watermark = undefined;
        }
        this.lastSeq = seq;

        if(watermark === undefined || watermark === null){
            // Hub doesn't report a watermark — payload is the full tree. Reset the
            // cursor so the next poll also requests in full.
            this.lastWatermark = 0;
            return payload;
        }

        let sentCursor = this.lastWatermark > 0;
        this.lastWatermark = Number(watermark) || 0;

        if(sentCursor && this.configs){
            // Delta against the cursor we sent: merge changed rows into the cache.
            return mergeConfigDelta(this.configs, payload || {});
        }
        // First fetch (or post-restart) — payload is the full tree.
        return payload;
    }
}

// Parse hub endpoints from environment variables
// Returns an array of URL strings (e.g., ["http://host1:10000", "http://host2:10000"]),
// or null when the hub is intentionally disabled (standalone mode).
XChainHubConnector.parseEndpoints = function(){
    // Standalone mode: when the hub is disabled (NO_HUB=1) the explorer reads its
    // coin/network + DB config from src/config.json instead of the hub. Returning
    // null makes getConfig()/startSync() take the file/NODE_CONFIG path (see
    // config.js) — this is how a single-server instance points at a local/synced
    // MariaDB the hub doesn't advertise (the hub publishes docker-internal db_host).
    if(['1','true','yes'].includes(String(process.env.NO_HUB || '').toLowerCase()))
        return null;
    if(process.env.HUB_VALIDATORS){
        return process.env.HUB_VALIDATORS.split(',')
            .map(e => e.trim())
            .filter(e => e)
            .map(e => e.startsWith('http') ? e : 'http://' + e);
    }
    let host = process.env.HUB_API_HOST || 'localhost';
    let port = process.env.HUB_PORT || '10000';
    return ['http://' + host + ':' + port];
};

module.exports = XChainHubConnector
