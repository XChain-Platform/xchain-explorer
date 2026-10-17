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
 * XChain Explorer - fee schedule cache
 *
 * The indexer's `feeschedule` answer is the same for every caller and changes
 * only when its tip or an oracle price moves, yet computing it costs the
 * indexer well over a second. This cache holds one answer per indexer URL for a
 * short lifetime and runs at most one upstream call per URL at a time, so a
 * burst of page loads costs one indexer read.
 *
 * Lifetime: 15 s by default (EXPLORER_FEESCHEDULE_CACHE_MS). The route already
 * tells browsers and the CDN max-age=5 (the tip class in http/cache_control.js);
 * 15 s keeps the server copy within a few CDN windows of the indexer while the
 * fastest production chain still takes a minute per block, and the answer
 * carries its own blockIndex and blockTime, so a reader can see what it reflects.
 *
 * Failure model: an upstream throw, a null result, or a result carrying an
 * `error` field (the indexer reports "not ready" and its own failures that way)
 * is never stored. While the last good answer is younger than
 * EXPLORER_FEESCHEDULE_STALE_MAX_MS (default 120 s, long enough to bridge an
 * indexer restart) it is served in place of the failure; past that the failure
 * reaches the caller. The answer is served exactly as the indexer shaped it,
 * with no added staleness field, because the route documents the indexer's
 * shape verbatim.
 *
 ********************************************************************/

'use strict';

const { getLogger } = require('../../observability');
const log = getLogger();

// Every environment read goes through config.js's live read-through view of
// process.env, looked up per read so requiring this module never loads config.js.
const configEnv = () => require('../../config.js').env;

const DEFAULT_TTL_MS       = 15000;
const DEFAULT_STALE_MAX_MS = 120000;

function envMs(name, fallback){
    const value = parseInt(configEnv()[name], 10);
    return value > 0 ? value : fallback;
}

// A result worth storing: an object the indexer produced as a schedule, not its
// `{ error }` report of a failure.
function isGoodSchedule(result){
    return result !== null && typeof result === 'object' && result.error === undefined;
}

class FeeScheduleCache {

    // Keyed by indexer URL. URLs come only from the operator's environment, so
    // both maps are bounded by configuration, not by request input.
    constructor({ now = Date.now } = {}){
        this.now      = now;
        this.entries  = new Map();   // url -> { at, value }
        this.inflight = new Map();   // url -> Promise
    }

    // The schedule for `url`: a fresh stored answer, else the one shared upstream
    // read `fetch()` performs for every caller waiting on this URL.
    async get(url, fetch){
        const hit = this.entries.get(url);
        if(hit && (this.now() - hit.at) < envMs('EXPLORER_FEESCHEDULE_CACHE_MS', DEFAULT_TTL_MS))
            return hit.value;
        const active = this.inflight.get(url);
        if(active) return active;
        const promise = this.load(url, fetch);
        this.inflight.set(url, promise);
        try {
            return await promise;
        } finally {
            if(this.inflight.get(url) === promise)
                this.inflight.delete(url);
        }
    }

    // Stamps a good answer with the request-start time, the conservative end of
    // the interval the indexer state it describes could come from.
    async load(url, fetch){
        const startedAt = this.now();
        let result;
        try {
            result = await fetch();
        } catch(err){
            return this.settleFailure(url, err);
        }
        if(isGoodSchedule(result)){
            this.entries.set(url, { at: startedAt, value: result });
            return result;
        }
        return this.settleFailure(url, null, result);
    }

    // The last good answer while it is inside the stale ceiling; otherwise the
    // thrown error is rethrown, or the indexer's own error result is passed on.
    settleFailure(url, err, result){
        const hit = this.entries.get(url);
        const age = hit ? this.now() - hit.at : Infinity;
        if(age < envMs('EXPLORER_FEESCHEDULE_STALE_MAX_MS', DEFAULT_STALE_MAX_MS)){
            log.warn('FEE_SCHEDULE_SERVING_CACHED', { age_s: Math.round(age / 1000), err: err ? (err.message || String(err)) : (result && result.error) });
            return hit.value;
        }
        if(err) throw err;
        return result;
    }

    clear(){
        this.entries.clear();
        this.inflight.clear();
    }
}

// The process-wide instance the route reads through.
const feeScheduleCache = new FeeScheduleCache();

module.exports = { FeeScheduleCache, feeScheduleCache, DEFAULT_TTL_MS, DEFAULT_STALE_MAX_MS };
