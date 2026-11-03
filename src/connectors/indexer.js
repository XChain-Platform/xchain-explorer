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
 * XChain Explorer - Indexer Connector
 *
 * Minimal JSON-RPC client for the colocated xchain-indexer API. The explorer uses it to
 * proxy read-only native-coin fee endpoints (`feequote`, `feeschedule`) so the authoritative
 * fee + oracle-price logic stays single-sourced in the indexer rather than being duplicated
 * (and drifting) here.
 *
 ********************************************************************/

const axios = require('axios');
const { AsyncLocalStorage } = require('async_hooks');

// Every environment read goes through config.js's live read-through view of
// process.env, so config.js stays the one place the gate lets env be read. The
// view is looked up per read so that requiring this module never loads config.js,
// whose SSL probe and log line would otherwise run in every tool and suite that
// never reads a variable.
const configEnv = () => require('../config.js').env;

// Resolve the indexer JSON-RPC API URL for a coin + network from the environment. Mirrors the
// FEE_DESTINATION env-override convention used elsewhere in the stack:
//   INDEXER_API_URL_<COIN>_<NETWORK>   (e.g. INDEXER_API_URL_BTC_REGTEST)
//   INDEXER_API_URL                     (generic fallback)
// Returns null when none is configured. The caller then surfaces "pre-flight unavailable" so a
// client falls back to paying the fee in XCHAIN rather than risking a forfeited native fee.
function resolveIndexerUrl(coin, network){
    let c = String(coin || '').toUpperCase();
    let n = String(network || '').toUpperCase();
    return configEnv()['INDEXER_API_URL_' + c + '_' + n]
        || configEnv()['INDEXER_API_URL']
        || null;
}

// EGRESS BUDGET
//
// The indexer rate-limits per connecting IP, and every call this process makes
// leaves from one IP, so every explorer client shares one upstream bucket. Left to
// the indexer, that bucket refuses whoever happens to arrive after it drains, which
// is usually a client well inside its own explorer limits. The explorer therefore
// keeps its own budget per indexer URL, below the indexer's ceiling, and decides who
// is shed before the indexer has to.
//
// The window is sliding (a log of call times), not fixed: the indexer's fixed window
// is not aligned with ours, and a fixed window here could put two full budgets
// inside one of its windows across our boundary.
const EGRESS_WINDOW_MS    = 60 * 1000;
// Below the indexer's default 600 per minute, leaving room for the odd call that
// slips between the admission check and the call itself.
const DEFAULT_EGRESS_RPM  = 540;
// Under this share of the budget every client is admitted. Above it, only a client
// still under its fair share (budget over active clients) is, so the clients
// draining the budget are the ones shed and a light client keeps its share.
const EGRESS_SOFT_FRACTION = 0.75;
// Calls made outside any client request (background reads, tip snapshots).
const INTERNAL_CLIENT     = '-';

const egressClient  = new AsyncLocalStorage();
const egressBudgets = new Map();   // indexer url -> EgressBudget

function egressLimit(){
    let n = parseInt(configEnv().EXPLORER_INDEXER_EGRESS_RPM, 10);
    return n > 0 ? n : DEFAULT_EGRESS_RPM;
}

class EgressBudget {
    constructor(){
        this.times     = [];        // call times, oldest first
        this.clients   = [];        // client key per call, parallel to times
        this.head      = 0;         // first live entry
        this.perClient = new Map(); // client key -> calls in the window
    }

    prune(now){
        while(this.head < this.times.length && this.times[this.head] <= now - EGRESS_WINDOW_MS){
            let k = this.clients[this.head];
            let n = (this.perClient.get(k) || 1) - 1;
            if(n > 0) this.perClient.set(k, n); else this.perClient.delete(k);
            this.head++;
        }
        if(this.head > 1024 && this.head * 2 > this.times.length){
            this.times   = this.times.slice(this.head);
            this.clients = this.clients.slice(this.head);
            this.head    = 0;
        }
    }

    used(now){
        this.prune(now);
        return this.times.length - this.head;
    }

    // Fair-share admission for a client request about to reach the indexer.
    admits(client, now, limit){
        let total = this.used(now);
        if(total >= limit) return false;
        if(total < Math.floor(limit * EGRESS_SOFT_FRACTION)) return true;
        let active = this.perClient.size + (this.perClient.has(client) ? 0 : 1);
        return (this.perClient.get(client) || 0) < limit / active;
    }

    record(client, now){
        this.times.push(now);
        this.clients.push(client);
        this.perClient.set(client, (this.perClient.get(client) || 0) + 1);
    }

    // Whole seconds until the oldest call in the window ages out.
    retryAfter(now){
        if(this.head >= this.times.length) return 1;
        return Math.max(1, Math.ceil((this.times[this.head] + EGRESS_WINDOW_MS - now) / 1000));
    }
}

function budgetFor(url){
    let key = String(url || '');
    let b = egressBudgets.get(key);
    if(!b){ b = new EgressBudget(); egressBudgets.set(key, b); }
    return b;
}

// Would a request from `client` to the indexer at `url` be admitted now? The route
// guard asks this before the handler runs, so a shed client is refused locally.
// Returns { ok, retryAfter }.
function egressAdmit(url, client){
    let now = Date.now();
    let b = budgetFor(url);
    if(b.admits(String(client || INTERNAL_CLIENT), now, egressLimit())) return { ok: true, retryAfter: 0 };
    return { ok: false, retryAfter: b.retryAfter(now) };
}

// Run `fn` with every indexer call inside it counted against `client`.
function withEgressClient(client, fn){
    return egressClient.run(String(client || INTERNAL_CLIENT), fn);
}

// Forget every window. For suites, which share this module across files.
function resetEgressBudgets(){
    egressBudgets.clear();
}

class XChainIndexerConnector {

    constructor(url){
        this.url     = url;
        this.timeout = Number(configEnv().INDEXER_API_TIMEOUT_MS) || 5000;
        // Optional API key for the indexer's fail-closed federation-read gate
        // (getstakeweightsbycapability is a FEDERATION_READ method). When the peer
        // indexer has INDEXER_API_KEY set, this must be presented or the gated call
        // gets a 401; plumbing it here lets a hardened indexer serve the explorer's
        // validator-set proof without INDEXER_ALLOW_UNAUTHENTICATED=true. Unset
        // keeps behavior byte-identical for open-gate/regtest indexers. Never logged.
        this.apiKey  = configEnv().EXPLORER_INDEXER_API_KEY || '';
    }

    async call(method, params){
        const config = { timeout: this.timeout };
        if(this.apiKey) config.headers = { 'x-api-key': this.apiKey };
        // Hard cap: no call leaves once the window holds the whole budget, whoever
        // makes it. It answers the same tagged shape as an indexer 429, so the proxy
        // routes relay it as retryable.
        let now = Date.now();
        let budget = budgetFor(this.url);
        if(budget.used(now) >= egressLimit()){
            const e = new Error('indexer egress budget exhausted');
            e.code = 'INDEXER_RATE_LIMITED';
            e.retryAfter = budget.retryAfter(now);
            throw e;
        }
        budget.record(egressClient.getStore() || INTERNAL_CLIENT, now);
        let response;
        try {
            response = await axios.post(this.url, { jsonrpc: '2.0', method, params, id: 1 }, config);
        } catch(err){
            // Distinguish an indexer auth rejection (gate enabled, no/wrong key)
            // from a transport outage so the caller can surface a clean
            // configuration error rather than a generic "unavailable". The thrown
            // error carries no header/key material.
            const status = err && err.response && err.response.status;
            if(status === 401 || status === 403){
                const e = new Error('indexer authentication required');
                e.code = 'INDEXER_AUTH_REQUIRED';
                throw e;
            }
            // The indexer rate-limits per IP and answers 429 with Retry-After. That is a
            // transient "slow down", not an outage, so tag it for the proxy routes to relay
            // as retryable instead of letting it read as a dead upstream.
            if(status === 429){
                const e = new Error('indexer rate limited');
                e.code = 'INDEXER_RATE_LIMITED';
                const ra = String((err.response.headers && err.response.headers['retry-after']) || '').trim();
                if(/^[0-9]{1,6}$/.test(ra)) e.retryAfter = Number(ra);
                throw e;
            }
            throw err;
        }
        if(response.data && response.data.error)
            throw new Error(response.data.error.message || 'indexer error');
        return (response.data && response.data.result !== undefined) ? response.data.result : null;
    }

    // Native-coin fee pre-flight for a single action. See xchain-indexer Actions.computeFeeQuote.
    async feequote({ action, params, source, feeOutputSats }){
        return this.call('feequote', { action, params, source, feeOutputSats });
    }

    // Oracle usage fee quote for a Mode B dispenser. See xchain-indexer
    // utility.quoteOracleFee, which the consensus check shares.
    async oraclefeequote({ oracleAddress, giveCoin, giveTick, fiatCode, getCoin, giveEscrow, blockTime }){
        return this.call('oraclefeequote', { oracleAddress, giveCoin, giveTick, fiatCode, getCoin, giveEscrow, blockTime });
    }

    // Validity-first pre-flight for a single action: would the indexer accept it?
    // Decoupled from native-fee support. See xchain-indexer Actions.computePreflight.
    // `feeMode` ('xchain' | 'native') selects how the fee settles in the dry-run.
    async preflight({ action, params, source, feeMode }){
        return this.call('preflight', { action, params, source, feeMode });
    }

    // Fee schedule + current oracle prices. See xchain-indexer Actions.getFeeSchedule.
    async feeschedule(){
        return this.call('feeschedule', {});
    }

    async health(){
        return this.call('health', {});
    }

    // Source-deduped stake weights for a capability at a block (each effective signing
    // key's { pubkey, source, weight }). Powers the validator-set proof: the explorer
    // needs the (source, weight) PREIMAGES (the stakes_root leaf is a hash) to build
    // membership proofs; the SMT proof binds them, so a wrong preimage cannot verify.
    async stakeWeights(capability, blockIndex){
        return this.call('getstakeweightsbycapability', { capability, block_index: Number(blockIndex) });
    }
}

// One export shape: the class is the export and the URL resolver hangs on it,
// so a requirer reads IndexerConnector.resolveIndexerUrl exactly as before. The
// egress-budget entry points hang on it the same way.
module.exports = Object.assign(XChainIndexerConnector, { resolveIndexerUrl, egressAdmit, withEgressClient, resetEgressBudgets });
