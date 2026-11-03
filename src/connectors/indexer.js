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
const { budgetIn, INTERNAL_CLIENT } = require('./egress_budget.js');

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
// The indexer rate-limits per connecting IP and this whole process is one IP to it,
// so the explorer keeps its own fair-share budget per indexer URL below the
// indexer's ceiling (see egress_budget.js for the mechanism).
// Below the indexer's default 600 per minute, leaving room for the odd call that
// slips between the admission check and the call itself.
const DEFAULT_EGRESS_RPM  = 540;

const egressClient  = new AsyncLocalStorage();
const egressBudgets = new Map();   // indexer url -> EgressBudget

function egressLimit(){
    let n = parseInt(configEnv().EXPLORER_INDEXER_EGRESS_RPM, 10);
    return n > 0 ? n : DEFAULT_EGRESS_RPM;
}

function budgetFor(url){
    return budgetIn(egressBudgets, url);
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

// FAILURE CLASSIFICATION
//
// A proxy route tells its caller whether the same request is worth sending again,
// so the connector, the one place that sees the transport error, marks the failures
// that are: `retryable` on the thrown error, plus `retryAfter` (seconds) when the
// indexer named one. Transient means the indexer is slow, busy or briefly out of
// reach: a 429 or 503, a 504 or client timeout, or a connection that never got an
// answer. A 4xx refusal, an auth rejection or a JSON-RPC error result is a verdict
// on this request and is never marked. ENOTFOUND is left out on purpose: a host
// name that does not resolve is a configuration fault, and EAI_AGAIN already
// covers a resolver that failed for the moment.
const TRANSIENT_STATUSES   = new Set([429, 503, 504]);
const TRANSIENT_NET_CODES  = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNREFUSED', 'ECONNRESET',
    'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ERR_NETWORK']);

// Retry-After only in the seconds form, 1 to 6 digits; anything else is dropped.
function retryAfterSeconds(headers){
    const ra = String((headers && headers['retry-after']) || '').trim();
    return /^[0-9]{1,6}$/.test(ra) ? Number(ra) : 0;
}

// The error call() throws for a failed axios post. Auth and rate-limit answers get a
// fresh error with fixed text (no header or key material); anything else is the
// original error, marked when it is transient.
function upstreamFailure(err){
    const status = err && err.response && err.response.status;
    if(status === 401 || status === 403)
        return Object.assign(new Error('indexer authentication required'), { code: 'INDEXER_AUTH_REQUIRED' });
    if(status === 429){
        const e = Object.assign(new Error('indexer rate limited'), { code: 'INDEXER_RATE_LIMITED', retryable: true });
        const ra = retryAfterSeconds(err.response.headers);
        if(ra > 0) e.retryAfter = ra;
        return e;
    }
    if(!err || typeof err !== 'object') return err;
    if(status ? TRANSIENT_STATUSES.has(status) : TRANSIENT_NET_CODES.has(err.code)){
        err.retryable = true;
        const ra = status ? retryAfterSeconds(err.response.headers) : 0;
        if(ra > 0) err.retryAfter = ra;
    }
    return err;
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
            e.retryable = true;
            e.retryAfter = budget.retryAfter(now);
            throw e;
        }
        budget.record(egressClient.getStore() || INTERNAL_CLIENT, now);
        let response;
        try {
            response = await axios.post(this.url, { jsonrpc: '2.0', method, params, id: 1 }, config);
        } catch(err){
            // Auth rejections read as a configuration error, rate limits and other
            // transient failures carry `retryable`; see upstreamFailure.
            throw upstreamFailure(err);
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
