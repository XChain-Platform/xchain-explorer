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
 * XChain Explorer - native coin history: POST /{COIN}/api/native_history
 *
 * A pass-through to the coin's xchain-utxo-tracker POST /history, which a
 * wallet reaches only through the explorer. The address list is checked here
 * on the batch routes' terms (at most 20, address-shaped, canonical spelling);
 * every other field is forwarded for the tracker to judge, and its answer,
 * refusals and their codes included, is passed back as the tracker gave it.
 * One upstream call per request, charged to the caller against the explorer's
 * fair-share tracker budget (connectors/utxo_tracker.js), carrying the caller's
 * address in X-Forwarded-For so the tracker's per-IP watch budget is per wallet.
 * That address is req.ip, the explorer's own trust-proxy resolution; a header
 * the client sent is never forwarded. Per-address fields (history_status,
 * history_from_height, history_refused) and the tracker's 503 NOT_READY pass
 * through unchanged like every other tracker answer.
 *
 * Installed onto XChainExplorer.prototype by explorer/install.js.
 *
 ********************************************************************/

'use strict';

const { canonicalCoinAddress } = require('./request/address_shape.js');
const { postTrackerHistory } = require('../connectors/utxo_tracker.js');

// The body fields the tracker's /history reads; anything else is not forwarded.
const FORWARDED_FIELDS = ['from_height', 'to_height', 'from_time', 'to_time', 'limit', 'cursor'];

// Tracker headers passed back under the spelling the tracker sends.
const HEADER_NAMES = {
    'x-next-cursor': 'X-Next-Cursor', 'x-tracker-height': 'X-Tracker-Height', 'x-node-height': 'X-Node-Height',
    'x-sync-lag': 'X-Sync-Lag', 'x-synced': 'X-Synced', 'x-reorg-count': 'X-Reorg-Count',
    'x-tracker-tip-hash': 'X-Tracker-Tip-Hash', 'x-mempool-ready': 'X-Mempool-Ready', 'retry-after': 'Retry-After'
};

function trackerBase(env, coin){
    return (env && (env['UTXO_TRACKER_URL_' + coin] || env.UTXO_TRACKER_URL)) || null;
}

function forwardedBody(body, addresses){
    const out = { addresses };
    for(const field of FORWARDED_FIELDS)
        if(body[field] !== undefined) out[field] = body[field];
    return out;
}

class NativeHistoryPassThrough {

    async processNativeHistoryRequest(req, res){
        const body   = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
        const parsed = this.parseBatchAddresses(body);
        if(parsed.refusal) return this.sendBatchJson(res, 400, parsed.refusal);
        const coin   = String((req.params && req.params.coin) || '').toUpperCase();
        const config = await this.configInfo.getConfig();
        if(this.util.isNull(((config && config['COIN_SUPPORTED']) || {})[coin]))
            return this.sendBatchJson(res, 503, { error: 'Explorer not configured to support data requests for this coin.', code: 'COIN_NOT_AVAILABLE' });
        const base = trackerBase(this.configInfo.env, coin);
        if(!base)
            return this.sendBatchJson(res, 503, { error: 'No UTXO tracker is configured for this coin.', code: 'TRACKER_NOT_CONFIGURED' });
        const addresses = [];
        for(const address of parsed.addresses){
            const canonical = canonicalCoinAddress(config, coin, address);
            if(canonical === false)
                return this.sendBatchJson(res, 400, { error: 'Invalid address: ' + address.slice(0, 128), code: 'INVALID_ADDRESS' });
            const spelled = (canonical === null) ? address : canonical;
            if(!addresses.includes(spelled)) addresses.push(spelled);
        }
        const answer = await postTrackerHistory({ base, body: forwardedBody(body, addresses), client: req.ip, coin, env: this.configInfo.env });
        return this.sendTrackerAnswer(res, answer);
    }

    // The tracker's own status, body and headers, or a retryable refusal of our
    // own when it was not asked (over budget, paused) or gave no usable answer.
    sendTrackerAnswer(res, answer){
        if(answer.unavailable){
            if(answer.retryAfter) res.set('Retry-After', String(answer.retryAfter));
            const shed = answer.unavailable === 'shed';
            return this.sendBatchJson(res, shed ? 503 : 502, {
                error: shed ? 'The UTXO tracker is over its request budget for this client; retry shortly.'
                    : 'The UTXO tracker did not answer.',
                code: 'TRACKER_UNAVAILABLE',
                retryable: true
            });
        }
        for(const [name, value] of Object.entries(answer.headers || {}))
            if(HEADER_NAMES[name]) res.set(HEADER_NAMES[name], value);
        return this.sendBatchJson(res, answer.status, answer.json);
    }
}

module.exports = { methods: NativeHistoryPassThrough.prototype };
