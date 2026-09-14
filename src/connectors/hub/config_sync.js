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
 * XChain Explorer - Hub Connector, config sync
 *
 * The getallconfigs half of XChainHubConnector: the delta-cursor poll, its
 * failover and regression handling, the merge into the cached tree, and the
 * consensus-hash transport check. Installed onto the connector's prototype by
 * src/connectors/hub.js; every hub round trip goes through the entry's call().
 *
 ********************************************************************/

const coins = require('../../coins');
// One logger for the whole service: getLogger() resolves to the shipper once api.js
// installs observability, and falls through to bare console before that.
const { getLogger } = require('../../observability');
const log = getLogger();

// Local { coin -> consensusHash } per network, computed on first use. The vendored
// bundle cannot change under a running process, so re-hashing it on every config
// poll would be pure waste.
const LOCAL_CONSENSUS_HASHES = {};
function localConsensusHashes(network){
    if(!LOCAL_CONSENSUS_HASHES[network]) LOCAL_CONSENSUS_HASHES[network] = coins.consensusHashes(network);
    return LOCAL_CONSENSUS_HASHES[network];
}

// Fold a getallconfigs delta (only the rows that changed since our cursor) into
// the cached nested config map, mutating and returning `base`. The hub's configs
// table is upsert-only (rows are never deleted), so merging is lossless (nothing
// already applied is ever lost) - but NOT complete on its own: getAllConfig()
// deliberately sends the cursor one second behind the stored watermark, so a
// row committed in the watermark's epoch-second can be re-delivered here and
// harmlessly re-merged instead of being skipped forever.
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

// One getallconfigs round trip from `cursor`; null when every endpoint failed.
function requestConfigs(connector, cursor){
    return connector.call({
        jsonrpc: '2.0',
        method:  'getallconfigs',
        params:  connector.configParams(cursor),
        id:      1
    });
}

// A {status:"degraded"} body: the hub is reachable but its DB is down.
function isDegraded(r){
    return r && typeof r === 'object' && r.status === 'degraded';
}

// The hub's config-DB read failure envelope: a bare `error` string, no `configs`.
function isErrorEnvelope(r){
    return r && typeof r === 'object' && typeof r.error === 'string' && !r.configs;
}

// False, with the accurate cause logged, for a result that carries no config
// tree; getAllConfig then answers null so config.js keeps its cached config.
function isUsableConfigResult(result){
    // A reachable-but-degraded hub can't serve config (its DB is down) and
    // returns a {status:"degraded"} body. Treat it like an unreachable hub
    // for config purposes: return null so config.js falls back to its
    // last-known-good cache, but log the accurate cause so the operator
    // sees "degraded" rather than a misleading "unreachable".
    if(isDegraded(result)){
        log.warn('HUB_CONFIG_DB_DEGRADED', { detail: 'hub reachable but DB degraded; cannot fetch config, falling back to cached config' });
        return false;
    }
    // A config-DB read failure is signaled by the hub as an HTTP-200 { error: ... }
    // *result* (not a JSON-RPC error), so call resolves rather than throwing. Without
    // this guard the envelope falls through applyConfigResult's else branch and is
    // returned as if it were the bare config map, so config.js wipes every coin to zero
    // AND refreshes its staleness timestamp on a failed fetch. Treat it like an
    // unreachable/degraded hub (mirrors the indexer's unwrapHubConfigResponse ok:false
    // path): return null so config.js keeps last-known-good config with an honest
    // staleness signal. Scoped to the exact envelope shape (a bare `error` string, no
    // `configs`) so a legitimate config tree can never match.
    if(isErrorEnvelope(result)){
        log.warn('HUB_CONFIG_READ_ERROR', { detail: 'hub reachable but reported a config-DB read error; cannot fetch config, falling back to cached config' });
        return false;
    }
    return true;
}

// Hub restart / restore from an older snapshot: the same endpoint now serves a
// seq or watermark BELOW the last one it gave us. The delta we asked for (cursor
// from the lost window) cannot carry rows the restored hub holds at an OLDER
// updated_at, and mergeConfigDelta only upserts, so merging it would serve
// lost-window values forever while config.js stamps hubConfigFetchedAt fresh.
// Mirror the indexer's HUB CONFIG REGRESSION handling: alarm (a hub that lost
// config state is an operator event), drop the cache, reset the cursor and
// re-fetch the full tree once, exactly as the failover block above does.
async function refetchAfterRegression(connector, result){
    log.error('HUB_CONFIG_REGRESSION', {
        seq: Number(result.seq) || 0, watermark: Number(result.watermark) || 0,
        last_seq: connector.lastSeq, last_watermark: connector.lastWatermark,
        detail: 'hub restart or restore from an older snapshot; discarding cached config and re-fetching the full tree'
    });
    connector.lastWatermark = 0;
    connector.configs       = null;
    const refetched = await requestConfigs(connector, 0);
    if(refetched === null || isDegraded(refetched) || isErrorEnvelope(refetched)){
        log.warn('HUB_CONFIG_REFETCH_FAILED', { detail: 'full re-fetch after config regression failed; falling back to cached config until the next poll' });
        return null;
    }
    return refetched;
}

class HubConfigSync {

    async getAllConfig(){
        let cursorEndpoint = this._watermarkEndpointIdx;
        let sentCursor     = this.lastWatermark;
        // The hub reads its watermark BEFORE it reads the config rows, so a row
        // committed after that read but stamped in the SAME epoch-second as the
        // returned watermark is only delivered because the hub's cursor is now
        // inclusive (`since_updated_at >= cursor`, item #2265); an older hub compared
        // `>` and stranded that row forever (the cursor had already advanced past it).
        // Keep sending the cursor one second behind the stored watermark so the
        // boundary second is re-fetched against either hub generation (do not
        // "simplify" the - 1 away); mergeConfigDelta's upsert-only merge makes
        // re-receiving it a harmless no-op. 0 still means "send me the full tree"
        // (initial fetch, post-restart, or a hub too old to report a watermark).
        let deltaCursor = this.lastWatermark > 0 ? this.lastWatermark - 1 : 0;
        let result = await requestConfigs(this, deltaCursor);
        // call returns null when every endpoint failed after retries; preserve
        // that signal so config.js can fall back to its last-known-good cache.
        if(result === null) return null;

        // If call failed over to a different endpoint than the one our cursor came
        // from, the wall-clock cursor is stale against the new hub (each hub stamps
        // updated_at = NOW() at its own apply time), so the delta may have skipped rows.
        // Discard it and re-fetch the full tree from the new endpoint with a reset cursor.
        // Skip when the first result is a degraded body (handled just below).
        if(sentCursor > 0 && this._lastGoodIdx !== cursorEndpoint && !isDegraded(result)){
            this.lastWatermark = 0;
            this.configs       = null;
            result = await requestConfigs(this, 0);
            if(result === null) return null;
        }

        if(!isUsableConfigResult(result)) return null;
        if(this.lastWatermark > 0 && this.configs && this.hubConfigRegressed(result)){
            result = await refetchAfterRegression(this, result);
            if(result === null) return null;
        }
        this.warnIfRedacted(result);
        this.configs = this.applyConfigResult(result);
        // Bind the (possibly advanced) cursor to the endpoint that answered.
        this._watermarkEndpointIdx = this._lastGoodIdx;
        return this.configs;
    }

    // True when a watermarked envelope from the cursor's own endpoint reports a
    // seq or watermark BELOW the last one it served us (hub restart / restore
    // from an older snapshot). A missing watermark is the full tree (handled by
    // applyConfigResult) and a zero watermark means an empty configs table, so
    // neither counts; the next poll re-fetches in full either way.
    hubConfigRegressed(result){
        let wrapped = result && typeof result === 'object' && result.configs && typeof result.configs === 'object' && ('seq' in result);
        if(!wrapped || result.watermark === undefined || result.watermark === null) return false;
        let watermark = Number(result.watermark) || 0;
        let seq       = Number(result.seq) || 0;
        return (watermark > 0 && watermark < this.lastWatermark) ||
               ((this.lastSeq || 0) > 0 && seq < this.lastSeq);
    }

    // Fold a getallconfigs result into this.configs and return the full nested
    // map. Newer hubs wrap the payload as { configs, seq, watermark }: when a
    // watermark is present the payload is a delta (only rows changed since the
    // cursor we sent), so we MERGE it into the cache and advance the cursor.
    // Older hubs return the bare map (or a { configs, seq } wrapper without a
    // watermark); those are always the full tree, so we REPLACE. Callers
    // (config.js) see the same full-map shape regardless of hub version. seq is 0
    // against an old hub, which the caller treats as "no committed change seen".
    // The configs table is upsert-only (no row deletes), so merging is lossless,
    // but only COMPLETE because getAllConfig() sends the cursor one second behind
    // the stored watermark (see the deltaCursor comment there); this.lastWatermark
    // itself is still set to the hub's true watermark below.
    applyConfigResult(result){
        // Every envelope, initial fetch and delta poll alike, funnels through here.
        this.checkHubConsensusHash(result && typeof result === 'object' ? result.coin_consensus_hashes : null);

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
            // Hub doesn't report a watermark, so payload is the full tree. Reset the
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
        // First fetch (or post-restart): payload is the full tree.
        return payload;
    }

    // Transport-integrity check: compare the consensus-config hashes the hub serves
    // on getallconfigs against our OWN bundled ones. Hub-served consensus values are
    // never applied (the explorer derives them from the vendored src/coins bundle via
    // coin-config/to_explorer_config.js), so this only logs; what it buys is that a hub built from a
    // divergent bundle surfaces at the first poll rather than as wrong served or
    // refused proof reads. Mirrors XChainIndexer.checkHubConsensusHash, widened to
    // every coin and network because the explorer bundles and serves all three.
    checkHubConsensusHash(hubHashes){
        if(!hubHashes || typeof hubHashes !== 'object') return;   // older hub: field absent
        let mismatches = [];
        for(const network of coins.NETWORKS){
            let served = hubHashes[network];
            if(!served || typeof served !== 'object') continue;
            let local = localConsensusHashes(network);
            for(const tick of Object.keys(local)){
                // A coin the hub does not serve is version skew, not drift; only a
                // hash the hub DOES serve and that differs counts as a mismatch.
                if(served[tick] && served[tick] !== local[tick])
                    mismatches.push(tick + '/' + network + ': hub ' + served[tick] + ' vs bundled ' + local[tick]);
            }
        }
        // This runs on every poll, so log only when the mismatch SET changes: a
        // standing divergence must not flood the log, and a drift that widens or
        // clears must still report.
        let key = mismatches.join('|');
        if(key === (this._lastConsensusMismatchKey || '')) return;
        this._lastConsensusMismatchKey = key;
        if(mismatches.length)
            log.error('CONSENSUS_HASH_MISMATCH', {
                mismatches: mismatches.join('; '),
                detail: 'the hub serves consensus config differing from this service\'s bundled coin files; hub consensus values are never applied (they are pinned locally); upgrade the lagging side'
            });
    }
}

module.exports = HubConfigSync;
