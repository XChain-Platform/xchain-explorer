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

// Resolve the decoder JSON-RPC API URL for a coin + network from the environment.
// Mirrors the INDEXER_API_URL convention used by XChainIndexerConnector:
//   DECODER_API_URL_<COIN>_<NETWORK>   (e.g. DECODER_API_URL_BTC_REGTEST)
//   DECODER_API_URL                     (generic fallback)
// Returns null when none is configured — the caller then reports the coin's
// decoder health as 'unconfigured' rather than guessing at a URL.
function resolveDecoderUrl(coin, network){
    let c = String(coin || '').toUpperCase();
    let n = String(network || '').toUpperCase();
    return process.env['DECODER_API_URL_' + c + '_' + n]
        || process.env['DECODER_API_URL']
        || null;
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
}

module.exports = XChainDecoderConnector;
module.exports.resolveDecoderUrl = resolveDecoderUrl;
