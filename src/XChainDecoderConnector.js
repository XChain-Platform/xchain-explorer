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
 * XChain Explorer - Decoder Connector
 *
 * Minimal JSON-RPC client for a coin's xchain-decoder API. The explorer reads
 * only the indexer/decoder DATABASES and never talks to a coin node, so the
 * chain→decoder half of the pipeline (how far the decoder trails the actual
 * chain tip) is invisible from the DBs. The decoder's own health() endpoint
 * exposes it (chainTipBlock / blockLag); this connector lets /api/status
 * aggregate that per coin instead of forcing operators to poll every
 * decoder's port separately.
 *
 ********************************************************************/

const axios = require('axios');

// Resolve the decoder JSON-RPC API URL for a coin + network. Priority:
//   1. DECODER_API_URL_<COIN>_<NETWORK>  (e.g. DECODER_API_URL_BTC_REGTEST)
//   2. configUrl, the per-chain endpoint the caller derived from the config the
//      explorer already holds (db.js decoderApiUrl; see _decoderApiUrlFromConfig)
//   3. DECODER_API_URL                   (generic fallback)
// The env keys mirror the INDEXER_API_URL convention used by
// XChainIndexerConnector, but the per-chain configUrl deliberately outranks the
// GENERIC env var: DECODER_API_URL names one decoder and is applied to every
// coin, so on a multi-chain deployment it is right for at most one of them,
// while configUrl is resolved per coin/network. The coin/network-specific env
// var still wins over both, so an operator override always holds.
//
// configUrl exists so a coin whose decoder endpoint is already in the
// explorer's config resolves without also requiring a per-chain env var.
//
// Returns null when none is configured; the caller then reports the coin's
// decoder health as 'unconfigured' rather than guessing at a URL.
function resolveDecoderUrl(coin, network, configUrl){
    let c = String(coin || '').toUpperCase();
    let n = String(network || '').toUpperCase();
    // Only consult the specific key when both halves are known: a code the
    // caller could not parse would otherwise read DECODER_API_URL__.
    if(c && n && process.env['DECODER_API_URL_' + c + '_' + n])
        return process.env['DECODER_API_URL_' + c + '_' + n];
    if(configUrl) return configUrl;
    return process.env['DECODER_API_URL'] || null;
}

class XChainDecoderConnector {

    constructor(url){
        this.url     = url;
        // Tighter default than the indexer connector: health aggregation runs on
        // the /api/status hot path, so a stalled decoder must not hold the whole
        // status response for long.
        this.timeout = Number(process.env.DECODER_API_TIMEOUT_MS) || 2500;
    }

    async _call(method, params){
        let response = await axios.post(this.url, { jsonrpc: '2.0', method, params, id: 1 }, { timeout: this.timeout });
        if(response.data && response.data.error)
            throw new Error(response.data.error.message || 'decoder error');
        return (response.data && response.data.result !== undefined) ? response.data.result : null;
    }

    // Decoder self-reported health: status (healthy/unhealthy), chainTipBlock
    // (the coin node's tip as the decoder sees it), blockLag (chain→decoder gap).
    async health(){
        return this._call('health', {});
    }

    // Live mempool snapshot from the decoder: node_tx_count (the coin node's
    // TOTAL mempool size, XChain or not; -1 before the decoder's first poll),
    // total (XChain-carrying rows), and up to `limit` (max 500) rows of
    // {tx_hash, source, data, first_seen}. This is the ONLY live-mempool path
    // for an explorer serving from synced replicas: mempool_transactions is
    // deliberately excluded from xchain-sync replication.
    async getmempool(limit){
        return this._call('getmempool', { limit: limit });
    }
}

module.exports = XChainDecoderConnector;
module.exports.resolveDecoderUrl = resolveDecoderUrl;
