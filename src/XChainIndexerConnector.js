/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
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

// Resolve the indexer JSON-RPC API URL for a coin + network from the environment. Mirrors the
// FEE_DESTINATION env-override convention used elsewhere in the stack:
//   INDEXER_API_URL_<COIN>_<NETWORK>   (e.g. INDEXER_API_URL_BTC_REGTEST)
//   INDEXER_API_URL                     (generic fallback)
// Returns null when none is configured — the caller then surfaces "pre-flight unavailable" so a
// client falls back to paying the fee in XCHAIN rather than risking a forfeited native fee.
function resolveIndexerUrl(coin, network){
    let c = String(coin || '').toUpperCase();
    let n = String(network || '').toUpperCase();
    return process.env['INDEXER_API_URL_' + c + '_' + n]
        || process.env['INDEXER_API_URL']
        || null;
}

class XChainIndexerConnector {

    constructor(url){
        this.url     = url;
        this.timeout = Number(process.env.INDEXER_API_TIMEOUT_MS) || 5000;
    }

    async _call(method, params){
        let response = await axios.post(this.url, { jsonrpc: '2.0', method, params, id: 1 }, { timeout: this.timeout });
        if(response.data && response.data.error)
            throw new Error(response.data.error.message || 'indexer error');
        return (response.data && response.data.result !== undefined) ? response.data.result : null;
    }

    // Native-coin fee pre-flight for a single action. See xchain-indexer Actions.computeFeeQuote.
    async feequote({ action, params, source, feeOutputSats }){
        return this._call('feequote', { action, params, source, feeOutputSats });
    }

    // Fee schedule + current oracle prices. See xchain-indexer Actions.getFeeSchedule.
    async feeschedule(){
        return this._call('feeschedule', {});
    }
}

module.exports = XChainIndexerConnector;
module.exports.resolveIndexerUrl = resolveIndexerUrl;
