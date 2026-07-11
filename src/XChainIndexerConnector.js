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

// Resolve the indexer JSON-RPC API URL for a coin + network from the environment. Mirrors the
// FEE_DESTINATION env-override convention used elsewhere in the stack:
//   INDEXER_API_URL_<COIN>_<NETWORK>   (e.g. INDEXER_API_URL_BTC_REGTEST)
//   INDEXER_API_URL                     (generic fallback)
// Returns null when none is configured. The caller then surfaces "pre-flight unavailable" so a
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
        // Optional API key for the indexer's fail-closed federation-read gate
        // (getstakeweightsbycapability is a FEDERATION_READ method). When the peer
        // indexer has INDEXER_API_KEY set, this must be presented or the gated call
        // gets a 401; plumbing it here lets a hardened indexer serve the explorer's
        // validator-set proof without INDEXER_ALLOW_UNAUTHENTICATED=true. Unset
        // keeps behavior byte-identical for open-gate/regtest indexers. Never logged.
        this.apiKey  = process.env.EXPLORER_INDEXER_API_KEY || '';
    }

    async _call(method, params){
        const config = { timeout: this.timeout };
        if(this.apiKey) config.headers = { 'x-api-key': this.apiKey };
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
            throw err;
        }
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

    // Source-deduped stake weights for a capability at a block (each effective signing
    // key's { pubkey, source, weight }). Powers the validator-set proof: the explorer
    // needs the (source, weight) PREIMAGES (the stakes_root leaf is a hash) to build
    // membership proofs; the SMT proof binds them, so a wrong preimage cannot verify.
    async stakeWeights(capability, blockIndex){
        return this._call('getstakeweightsbycapability', { capability, block_index: Number(blockIndex) });
    }
}

module.exports = XChainIndexerConnector;
module.exports.resolveIndexerUrl = resolveIndexerUrl;
