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
 * XChain Explorer - the fee estimate and the USD coin price
 *
 * One part of src/db/readers/health.js (the entry composes it through
 * composeReaderParts). The two reads that answer "what does this cost right
 * now": the per-coin fee estimate and the USD price of a coin.
 *
 * Both quote a number this instance did not compute, so both keep serving
 * the last good value when the source declines, which is why they sit
 * together and apart from the tip probes that must fail closed instead.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

// Structured logging. Cached at require time: getLogger() resolves lazily on
// every call, so this reaches the real shipper once api.js has run
// installObservability and falls through to bare console.* before that.
const { getLogger } = require('../../../observability');
const log = getLogger();

// Resolve the base mainnet symbol. The oracle only prices the real asset,
// so a request is eligible only when its route code IS the base symbol
// (mainnet): 'BTC' === 'BTC'. Testnet/regtest codes ('TBTC','RDOGE') differ.
//
// A module function rather than a method: Database.prototype carries the family's
// public readers and nothing else, so a cut made for length adds no name to it.
async function resolveMainnetPriceSymbol(db, config){
    let code = String(config.coin);
    let sym = null;
    try {
        const full  = await db.configInfo.getConfig();
        const bases = Object.keys(full['COIN_NETWORKS'] || {});   // ['BTC','LTC','DOGE']
        const b     = bases.find(c => code.endsWith(c));
        if(b && code === b) sym = b;
    } catch(e){ return null; }
    return sym;
}

// One getprice call to the hub, returning the JSON-RPC `result` for the caller to
// read. A transport or HTTP failure throws, so the caller's catch is what decides
// whether to keep serving the last good value; only a well-formed answer returns.
async function hubPriceResult(hubUrl, sym){
    const url = hubUrl.replace(/\/+$/, '') + '/';
    const res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ jsonrpc: '2.0', method: 'getprice', params: { coin_pair: sym + '/USD' }, id: 1 }),
        signal:  AbortSignal.timeout(6000)
    });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    return j && j.result;
}

class HealthPriceReaders {
    // Suggested fee tiers (sat/vByte) for this coin, fetched from its encoder's
    // `estimatefee` JSON-RPC method (which reads the node's estimatesmartfee).
    // The explorer is DB-only and can't reach a node, so it asks the encoder.
    // Endpoint comes from ENCODER_URL (e.g. https://encoder.xchain.io); the coin
    // path is appended (.../{COIN}/). Result is cached per coin for FEE_CACHE_MS
    // (default 60s) so the coin homepage doesn't trigger a node RPC on every hit.
    // Returns a conservative {low:1,medium:2,high:3} fallback when no encoder is
    // configured or it's unreachable.
    async getFeeEstimate(config) {
        const fallback = { low: 1, medium: 2, high: 3 };
        const base = this.configInfo.env.ENCODER_URL;
        if(!base) return fallback;
        const code = config.coin;
        const ttl  = parseInt(this.configInfo.env.FEE_CACHE_MS, 10) || 60000;
        const now  = Date.now();
        this._feeCache = this._feeCache || {};
        const hit = this._feeCache[code];
        if(hit && (now - hit.t) < ttl) return hit.v;
        try {
            const url = base.replace(/\/+$/, '') + '/' + encodeURIComponent(code) + '/';
            const res = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ jsonrpc: '2.0', method: 'estimate_fee', id: 1 }),
                signal:  AbortSignal.timeout(6000)
            });
            if(!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json();
            const f = j && j.result;
            if(f && f.low != null && f.medium != null && f.high != null){
                const v = { low: Number(f.low), medium: Number(f.medium), high: Number(f.high) };
                this._feeCache[code] = { t: now, v };
                return v;
            }
            throw new Error('malformed estimatefee response');
        } catch(e){
            log.warn('FEE_ESTIMATE_UNAVAILABLE', { method: 'getFeeEstimate', code, err: e && e.message ? e.message : e });
            // Reuse a prior good value if we have one; otherwise the safe fallback.
            return (hit && hit.v) || fallback;
        }
    }

    // Live USD price for this coin, fetched from the xchain-hub price oracle
    // (its finalized price_snapshots, via the public `getprice` JSON-RPC). The
    // explorer has no market feed of its own. Endpoint comes from HUB_URL
    // (e.g. http://127.0.0.1:10000). Cached per base coin for PRICE_CACHE_MS
    // (default 60s) so the coin homepage doesn't hit the hub on every request.
    // Mirrors getFeeEstimate(). Only mainnet BTC/LTC/DOGE have an oracle market;
    // testnet/regtest route codes (TBTC, RDOGE, …) have no market, so this returns
    // null and getNetwork keeps the $0.00 placeholder. Returns a price string
    // (8-decimal, as published) or null.
    async getCoinPriceUsd(config) {
        const hubUrl = this.configInfo.env.HUB_URL;
        if(!hubUrl) return null;
        const sym = await resolveMainnetPriceSymbol(this, config);
        if(!sym) return null;

        const ttl = parseInt(this.configInfo.env.PRICE_CACHE_MS, 10) || 60000;
        const now = Date.now();
        this._priceCache = this._priceCache || {};
        const hit = this._priceCache[sym];
        if(hit && (now - hit.t) < ttl) return hit.v;
        try {
            const r = await hubPriceResult(hubUrl, sym);
            if(r && !r.error && r.price != null){
                const p = Number(r.price);
                if(Number.isFinite(p) && p > 0){
                    const v = String(r.price);
                    this._priceCache[sym] = { t: now, v };
                    this._priceStaleSince = this._priceStaleSince || {};
                    delete this._priceStaleSince[sym];
                    return v;
                }
            }
            // The hub answers a well-formed verdict when it refuses to quote: a
            // stale snapshot (its reference block aged past the oracle bound, which
            // a long Bitcoin block gap does routinely) or no finalized round at all.
            // Surface that verdict as the hub wrote it; "malformed" is reserved for
            // a body the parser genuinely cannot read.
            if(r && typeof r.error === 'string' && r.error){
                if(/\bstale\b/i.test(r.error)){
                    // Expected between rounds during a long block gap, and the last
                    // good value keeps serving, so log the transition once rather
                    // than every cache expiry until the next round finalizes.
                    this._priceStaleSince = this._priceStaleSince || {};
                    if(!this._priceStaleSince[sym]){
                        this._priceStaleSince[sym] = now;
                        log.info('COIN_PRICE_HUB_DECLINED', { method: 'getCoinPriceUsd', sym, err: r.error,
                            note: 'serving the last finalized value until the next round' });
                    }
                    return (hit && hit.v) || null;
                }
                throw new Error('hub: ' + r.error);
            }
            throw new Error('malformed getprice response');
        } catch(e){
            log.warn('COIN_PRICE_UNAVAILABLE', { method: 'getCoinPriceUsd', sym, err: e && e.message ? e.message : e });
            // Reuse a prior good value if we have one; otherwise null (placeholder).
            return (hit && hit.v) || null;
        }
    }
}

module.exports = HealthPriceReaders.prototype;
