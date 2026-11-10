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
 * XChain Explorer - Hub operational-state cache
 *
 * Serves the hub-LOCAL operational tables (validator_capabilities,
 * governance_proposals, governance_votes, reorg_attestations, slash_proposals) over the hub's JSON-RPC surface
 * with a short TTL cache, instead of reading a co-located hub-owned MariaDB
 * schema. These tables are off-chain federation state that mutates in place
 * (vote upserts, proposal tallies), so they cannot ride the append-only
 * hub-DB mirror the consensus tables use; a periodic RPC read of a small,
 * bounded dataset is the honest transport.
 *
 * Endpoint resolution: HUB_API_URL (comma-separated, same env the embedded
 * hub-DB mirror client uses) takes precedence so a standalone NO_HUB=1
 * deployment can still point operational reads at a hub without enabling
 * hub config discovery; otherwise the regular discovery endpoints from
 * XChainHubConnector.parseEndpoints(). When neither is configured the cache
 * is disabled (enabled() false) and db/index.js reads the co-located hub schema
 * instead. That schema read is the NO-HUB deployment shape only; it is never
 * a fallback for a configured-but-unreachable hub.
 *
 * Failure model: a fresh cache entry is served without a hub round-trip;
 * on hub unreachability a stale entry is served up to a bounded ceiling
 * (EXPLORER_HUB_CACHE_STALE_MAX_MS, default 600s) so a hub restart doesn't
 * blank the pages. Past that ceiling getRows returns null and the caller
 * FAILS LOUD (db/index.js hubOperationalOutage): the co-located schema carries
 * no freshness bound, so falling through to it would make the ceiling
 * unenforceable and serve indefinitely stale operational state that reads
 * as live. Rows are fetched with server-side filters (the datasets are
 * bounded to 500 rows per query hub-side), so cache keys include the
 * filter params.
 *
 * Outage cost: one failed read costs the connector's whole retry window
 * (two attempts plus backoff, about 2 s on an unreachable hub). A failed
 * read is therefore remembered per key for one TTL window, and requests
 * inside that window answer at once from the same stale-or-null rule
 * without another hub round-trip; concurrent misses on one key share a
 * single in-flight read. Without both, every request during an outage held
 * its request slot for the full retry window.
 *
 * Both are per key, and a HUNG hub costs about 12 s per read, so distinct-key
 * misses each held a slot of the API's global concurrency gate that long and
 * shed every unrelated DB-only route. Hub reads are therefore bounded
 * process-wide (MAX_HUB_READS running, a short bounded queue); any other miss,
 * or one arriving while the oldest read has outlived the queue wait, answers
 * at once from the stale-or-null rule. A read no endpoint answered at all
 * latches the hub down for one TTL window (a JSON-RPC error answer never does).
 *
 ********************************************************************/

const XChainHubConnector = require('../connectors/hub');
// One logger for the whole service: getLogger() resolves to the shipper once api.js
// installs observability, and falls through to bare console before that.
const { getLogger } = require('../observability');
const log = getLogger();

// Every environment read goes through config.js's live read-through view of
// process.env, so config.js stays the one place the gate lets env be read. The
// view is looked up per read so that requiring this module never loads config.js,
// whose SSL probe and log line would otherwise run in every tool and suite that
// never reads a variable.
const configEnv = () => require('../config.js').env;

// Cap the map so a flood of distinct filter values cannot grow it
// without bound (same pattern as db/index.js's holders cache).
const MAX_CACHE_ENTRIES = 500;

// Hub reads running across ALL keys, misses that may queue, and the queue wait.
// A healthy hub drains the queue in milliseconds; a hung one holds at most
// MAX_HUB_READS requests for its retry window.
const MAX_HUB_READS = 8;
const MAX_HUB_READ_WAITERS = 16;
const HUB_READ_WAIT_MS = 1000;

// Drop undefined params so the cache key is stable and the hub sees
// only the filters actually set.
function cleanParams(params){
    let cleaned = {};
    for(const [k, v] of Object.entries(params))
        if(v !== undefined && v !== null) cleaned[k] = v;
    return cleaned;
}

// Store a fresh read under `key`, evicting the oldest entry when the map is full.
function rememberRows(cache, key, at, rows){
    if(cache.size >= MAX_CACHE_ENTRIES && !cache.has(key))
        cache.delete(cache.keys().next().value);
    cache.set(key, { at, rows });
}

// Record when a read for `key` last failed, under the same bound as the rows map.
function rememberFailure(failures, key, at){
    failures.delete(key);
    if(failures.size >= MAX_CACHE_ENTRIES)
        failures.delete(failures.keys().next().value);
    failures.set(key, at);
}

// The stale-or-null answer without the hub: the cached rows while they are
// inside the stale ceiling at `at`, else null (the caller fails loud).
function staleOrNull(hit, at, staleMaxMs){
    return (hit && (at - hit.at) < staleMaxMs) ? hit.rows : null;
}

// The answer for a read the hub did not satisfy with rows: throw on a capability
// gap, else the cached rows while they are inside the stale ceiling, else null.
function settleMissedRead(method, result, call, hit, after, staleMaxMs){
    const rpcErr = call.rpcError;
    // A -32601 (Method not found) from EVERY configured endpoint is a definitive
    // answer: no hub build in the fleet serves the method. That is a capability
    // gap, not an outage, so neither the stale-cache bridge below nor db/index.js's
    // unreachable-past-ceiling diagnosis applies; both would misname a
    // version mismatch as downtime.
    if(rpcErr && Number(rpcErr.code) === -32601 && call.allEndpointsAnswered === true)
        throw new Error("Hub JSON-RPC method '" + method + "' is not supported by the " +
            'configured hub (JSON-RPC -32601 Method not found). The hub is reachable; ' +
            'upgrade it to a build that serves ' + method + '.');
    // Only some endpoints answered -32601: an unreachable or degraded one may be the
    // upgraded hub that serves the method, so this is an outage and takes the bridge.
    if(rpcErr && Number(rpcErr.code) === -32601)
        log.warn('HUB_OPERATIONAL_PARTIAL_CAPABILITY', { method, failures: call.failures });
    if(result && result.error)
        log.warn('HUB_OPERATIONAL_READ_ERROR', { method, err: result.error });
    // Hub unreachable or degraded: serve the last-known rows while they
    // are not unreasonably old, so a hub restart doesn't blank the pages.
    const rows = staleOrNull(hit, after, staleMaxMs);
    if(rows)
        log.warn('HUB_OPERATIONAL_SERVING_CACHED', { method, age_s: Math.round((after - hit.at) / 1000) });
    return rows;
}

class HubOperationalCache {

    constructor(explorer){
        this.util = explorer.util;
        this.ttlMs      = parseInt(configEnv().EXPLORER_HUB_CACHE_MS, 10) || 15000;
        this.staleMaxMs = parseInt(configEnv().EXPLORER_HUB_CACHE_STALE_MAX_MS, 10) || 600000;
        this._cache = new Map();
        // key -> time the last read for it failed as an outage (never a
        // capability gap); cleared by the next successful read.
        this.failedAt = new Map();
        // key -> the read in flight for it, so concurrent misses share one call.
        this.inflight = new Map();

        // Process-wide hub read bound and down latch (see the header).
        this.maxHubReads = MAX_HUB_READS;
        this.maxHubReadWaiters = MAX_HUB_READ_WAITERS;
        this.hubReadWaitMs = HUB_READ_WAIT_MS;
        this.runningReads = new Set();
        this.readWaiters = [];
        this.hubDownUntil = 0;
        this.shedLog = { windowStart: 0, suppressed: 0 };

        let endpoints = null;
        if(configEnv().HUB_API_URL){
            endpoints = String(configEnv().HUB_API_URL).split(',')
                .map(e => e.trim())
                .filter(e => e)
                .map(e => e.startsWith('http') ? e : 'http://' + e);
        } else {
            endpoints = XChainHubConnector.parseEndpoints();
        }
        this.connector = (endpoints && endpoints.length) ? new XChainHubConnector(endpoints) : null;
    }

    enabled(){
        return this.connector !== null;
    }

    // Fetch rows for one hub RPC read method, TTL-cached per (method, params).
    // Null means the hub is unreachable past the stale ceiling. The three
    // list callers in db/index.js must FAIL LOUD on null; getFederationRegistry
    // alone falls through, since it only decorates the on-chain /validators set.
    async getRows(method, params = {}){
        if(!this.connector) return null;
        let cleaned = cleanParams(params);
        let key = method + '|' + JSON.stringify(cleaned, Object.keys(cleaned).sort());
        let now = Date.now();
        let hit = this._cache.get(key);
        if(hit && (now - hit.at) < this.ttlMs)
            return hit.rows;

        // A read for this key failed less than one TTL ago: the hub has just
        // been shown unreachable or degraded, so answer from the same
        // stale-or-null rule without paying the retry window again.
        let failedAt = this.failedAt.get(key);
        if(failedAt !== undefined && (now - failedAt) < this.ttlMs)
            return staleOrNull(hit, now, this.staleMaxMs);

        let pending = this.inflight.get(key);
        if(pending) return pending;

        // The hub was just shown unreachable for some key: answer every miss at
        // once until the latch window ends, then let one miss probe again.
        if(now < this.hubDownUntil)
            return staleOrNull(hit, now, this.staleMaxMs);

        pending = this.readWithSlot(method, key, cleaned, hit, now);
        this.inflight.set(key, pending);
        try {
            return await pending;
        } finally {
            if(this.inflight.get(key) === pending) this.inflight.delete(key);
        }
    }

    // Run the hub read for `key` inside the process-wide read bound, or answer
    // from the stale-or-null rule when no read slot can be had promptly.
    async readWithSlot(method, key, cleaned, hit, now){
        const token = await this.acquireReadSlot();
        if(!token){
            this.noteShed(method);
            return staleOrNull(hit, Date.now(), this.staleMaxMs);
        }
        try {
            // The latch may have been set while this miss waited for a slot.
            if(Date.now() < this.hubDownUntil)
                return staleOrNull(hit, Date.now(), this.staleMaxMs);
            return await this.readFromHub(method, key, cleaned, hit, now);
        } finally {
            this.releaseReadSlot(token);
        }
    }

    // A read slot token, or null when the miss must not wait for one: the
    // queue is full, or the oldest running read has outlived the queue wait.
    acquireReadSlot(){
        const now = Date.now();
        if(this.runningReads.size < this.maxHubReads){
            const token = { at: now };
            this.runningReads.add(token);
            return Promise.resolve(token);
        }
        if(this.readWaiters.length >= this.maxHubReadWaiters) return Promise.resolve(null);
        for(const running of this.runningReads)
            if(now - running.at >= this.hubReadWaitMs) return Promise.resolve(null);
        return new Promise(resolve => {
            const waiter = { resolve, timer: null };
            waiter.timer = setTimeout(() => {
                const i = this.readWaiters.indexOf(waiter);
                if(i >= 0) this.readWaiters.splice(i, 1);
                resolve(null);
            }, this.hubReadWaitMs);
            if(typeof waiter.timer.unref === 'function') waiter.timer.unref();
            this.readWaiters.push(waiter);
        });
    }

    // Free a read slot, handing it straight to the oldest queued miss.
    releaseReadSlot(token){
        this.runningReads.delete(token);
        const waiter = this.readWaiters.shift();
        if(!waiter) return;
        clearTimeout(waiter.timer);
        const next = { at: Date.now() };
        this.runningReads.add(next);
        waiter.resolve(next);
    }

    // Warn about misses answered without a hub read, once per TTL window.
    noteShed(method){
        const now = Date.now();
        if(now - this.shedLog.windowStart < this.ttlMs){
            this.shedLog.suppressed++;
            return;
        }
        log.warn('HUB_OPERATIONAL_READ_SHED', { method, running: this.runningReads.size, suppressed: this.shedLog.suppressed });
        this.shedLog = { windowStart: now, suppressed: 0 };
    }

    // One hub read for `key`, shared by every concurrent getRows that missed it.
    async readFromHub(method, key, cleaned, hit, now){
        // Call-scoped diagnostics sink. The connector is one object for the whole
        // process and its lastRpcError is last-call-wins, so reading it after this
        // await let a CONCURRENT call's -32601 decide this call's outcome: the
        // capability-gap throw below fired for a method the hub serves fine and
        // skipped the stale-cache bridge, and the reverse (a concurrent healthy
        // call clearing the field on entry) erased a real -32601.
        let call = {};
        let result = await this.connector.call(
            { jsonrpc: '2.0', method, params: cleaned, id: 1 },
            { attempts: 2, out: call }
        );
        // Read the clock AGAIN. `now` above was taken before the RPC, and the RPC
        // is the slow part of this function: two attempts plus their timeouts, so
        // an unreachable hub burns real seconds here. Measuring the stale ceiling
        // with the pre-await stamp measures the age the rows had when this request
        // STARTED, which lets an entry be served past
        // EXPLORER_HUB_CACHE_STALE_MAX_MS by the whole retry window and understates
        // the age in the operator warning by the same amount. The ceiling is the
        // only freshness bound on this path (db/index.js fails loud rather than falling
        // through to the co-located schema, which has no bound at all), so it has
        // to be measured against the clock now, not the clock then.
        //
        // The cache WRITE below deliberately keeps `now`. An entry's `at` is a
        // claim about how old its DATA is, and the rows the hub just returned
        // describe hub state at some point from the request onward; stamping them
        // at the response instead would credit them with the RPC's duration of
        // freshness they do not have. Request-start is the conservative end of
        // that interval, and both the TTL and the ceiling should read it that way.
        let after = Date.now();
        if(Array.isArray(result)){
            rememberRows(this._cache, key, now, result);
            this.failedAt.delete(key);
            this.hubDownUntil = 0;
            return result;
        }
        // settleMissedRead throws on a capability gap, which is a definitive
        // answer and is never remembered as an outage.
        const rows = settleMissedRead(method, result, call, hit, after, this.staleMaxMs);
        rememberFailure(this.failedAt, key, after);
        // No endpoint answered at all (no JSON-RPC error, no degraded body): the
        // hub itself is unreachable or hung, which no other key can read past.
        if((result === null || result === undefined) && !call.rpcError)
            this.hubDownUntil = after + this.ttlMs;
        return rows;
    }

    getValidatorCapabilities({ capability, signing_pubkey } = {}){
        return this.getRows('getvalidatorcapabilities', { capability, signing_pubkey, limit: 500 });
    }

    // The hub's own federation registry (`validators`: addr, chains,
    // registration status). It is NOT a page of its own; the rows are folded onto
    // the on-chain /validators active set so the staked pubkey and the hub's
    // knowledge of it read as one table. getvalidators takes no filters and
    // returns only status='active' rows.
    getFederationValidators(){
        return this.getRows('getvalidators', {});
    }

    getGovernanceProposals({ status, parameter, proposal_id } = {}){
        // proposal_id has no server-side filter on getproposals; fetch the
        // bounded list and let the caller's row filter narrow it. status and
        // parameter filter hub-side.
        return this.getRows('getproposals', { status, parameter, limit: 500 })
            .then(rows => {
                if(!rows || proposal_id === undefined || proposal_id === null) return rows;
                return rows.filter(r => String(r.proposal_id) === String(proposal_id));
            });
    }

    getGovernanceVotes({ proposal_id, voter_pubkey } = {}){
        return this.getRows('getvotes', { proposal_id, voter_pubkey, limit: 500 });
    }

    // getreorghistory has NO server-side filter beyond limit: xchain-hub's
    // findReorgAttestations (src/db/reorg_attestations.js) reads every column of
    // the reorg_attestations table, newest-created row first, capped by a row-count
    // bound, with no filtering clause of any kind, so chain scoping AND the
    // optional status/reorg_height narrowing both happen here, client-side, after
    // one cached fetch. This is deliberately the SAME cache entry for every
    // coin/filter combination (the getRows cache key is built from {limit:500}
    // only), so ten coins' pages share one hub round trip per TTL window rather
    // than fragmenting the cache per chain.
    getReorgHistory({ chain, status, reorg_height } = {}){
        return this.getRows('getreorghistory', { limit: 500 })
            .then(rows => {
                if(!rows) return rows;
                let out = rows;
                if(chain !== undefined && chain !== null)
                    out = out.filter(r => String(r.source_chain) === String(chain));
                if(status !== undefined && status !== null)
                    out = out.filter(r => String(r.status) === String(status));
                if(reorg_height !== undefined && reorg_height !== null)
                    out = out.filter(r => String(r.reorg_height) === String(reorg_height));
                return out;
            });
    }

    // getslashproposals filters status and validator_pubkey SERVER-side (unlike
    // getreorghistory, which has no filters at all and forces client-side
    // narrowing), so both params ride the RPC and the cache key fragments per
    // filter combination the same way getvalidatorcapabilities/getvotes already
    // do. limit:500 matches the hub's own page cap (SlashDetector.MAX_PAGE), so
    // the explorer never asks for more than the hub will serve. The rows the hub
    // returns carry evidence_hash, never the verbatim evidence blob: that
    // redaction is hub-side by design, because the hub's POST surface serves the
    // same RPC to any caller.
    getSlashProposals({ status, validator_pubkey } = {}){
        return this.getRows('getslashproposals', { status, validator_pubkey, limit: 500 });
    }
}

module.exports = HubOperationalCache;
