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
 * XChain Explorer - fee quotes and pre-flight
 *
 * The indexer-proxying routes: native and oracle fee quotes, the fee schedule, and
 * the pre-flight dry run, plus the coin-code parser they all resolve their upstream
 * with and the size ceilings pre-flight refuses above.
 *
 * Authored as a class body and installed onto XChainExplorer.prototype by
 * explorer/install.js, so `this` is the explorer instance at call time.
 *
 ********************************************************************/

'use strict';

const IndexerConnector = require('../connectors/indexer.js');
// Module-scope logger, not a method on the class these parts install onto: every
// log line below reaches the shipper api.js installs, exactly as it did inline.
const { getLogger } = require('../observability');
const log = getLogger();

// The entry's live read-through view of process.env, handed over at install time
// (see mirror_gate.js for why this is not required here).
let configEnv = null;

function useHostBindings(host){
    configEnv = host.configEnv;
}

// Upper bound on the pre-flight `params` string, in characters: the protocol's
// OWN ENVELOPE_MAX_PAYLOAD ceiling (xchain-documentation/protocol/constants.js,
// mirrored in xchain-decoder), so this proxy is never the component that refuses
// an action the indexer would have judged.

// Payload SIZE is not a work multiplier upstream: the 250-command consensus cap,
// the 8-pending admission window and the 10s timeout bound the indexer dry-run,
// and the POST route's own rate limiter bounds the bytes per minute.
const MAX_PREFLIGHT_PARAMS_LENGTH = 390000;

// Upper bound on the `source` address string. Unchanged; an address is orders
// of magnitude below this and it only exists to keep the field bounded.
const MAX_PREFLIGHT_SOURCE_LENGTH = 4096;

class FeesPreflight {

    // Resolve an explorer coin code (e.g. 'BTC', 'TBTC', 'RDOGE') to its base coin + network
    // using the configured prefix map. Returns { coin, network } or null when unrecognised.
    parseCoinCode(code, config){
        code = String(code || '').toUpperCase();
        let prefixes = config['COIN_PREFIXES'] || { mainnet: '', testnet: 'T', regtest: 'R' };
        let coins    = config['COIN_NETWORKS'] || {};
        // Non-empty prefixes (T/R) first so 'TBTC' isn't mis-read as a mainnet coin named 'TBTC'.
        for(let network in prefixes){
            let p = prefixes[network];
            if(p && code.startsWith(p)){
                let base = code.slice(p.length);
                if(coins[base]) return { coin: base, network };
            }
        }
        if(coins[code]) return { coin: code, network: 'mainnet' };
        return null;
    }

    // Native-coin fee pre-flight (proxy to the colocated indexer's `feequote`).
    // GET /{COIN}/api/feequote?action=ISSUE&params=0|NEWTICK&source=...&feeOutputSats=...
    async processFeeQuoteRequest(req, res){
        try {
            let config = await this.configInfo.getConfig();
            let parsed = this.parseCoinCode(req.params.coin, config);
            if(!parsed)
                return res.status(404).json({ error: 'unknown coin', code: 'UNKNOWN_COIN' });
            let url = IndexerConnector.resolveIndexerUrl(parsed.coin, parsed.network);
            if(!url)
                return res.status(501).json({ error: 'native fee pre-flight unavailable (indexer API not configured for ' + parsed.coin + '/' + parsed.network + ')', code: 'INDEXER_NOT_CONFIGURED' });
            if(this.util.isNull(req.query.action))
                return res.status(400).json({ error: 'action is required', code: 'MISSING_PARAMETER' });
            // Validate the proxied query params before forwarding to the indexer.
            // Express yields arrays for repeated keys (?action=A&action=B) and none of
            // these are type/charset/length-checked on this hop, so an arbitrary-shape or
            // unbounded value would reach the indexer's feequote endpoint. Mirror the
            // sibling proof routes in this file, which anchor every query param before use.
            let action        = req.query.action;
            let params        = req.query.params;   // pipe-delimited string; the indexer splits it
            let source        = req.query.source;
            let feeOutputSats = req.query.feeOutputSats;
            if(Array.isArray(action) || Array.isArray(params) || Array.isArray(source) || Array.isArray(feeOutputSats))
                return res.status(400).json({ error: 'repeated query parameters are not allowed', code: 'INVALID_PARAMETER' });
            action = String(action);
            if(!/^[A-Z0-9_]{1,32}$/.test(action))
                return res.status(400).json({ error: 'invalid action', code: 'INVALID_ACTION' });
            if(!this.util.isNull(feeOutputSats) && !/^[0-9]+$/.test(String(feeOutputSats)))
                return res.status(400).json({ error: 'invalid feeOutputSats', code: 'INVALID_PARAMETER' });
            params = this.util.isNull(params) ? undefined : String(params);
            source = this.util.isNull(source) ? undefined : String(source);
            if((params && params.length > 8192) || (source && source.length > 4096))
                return res.status(400).json({ error: 'parameter too long', code: 'INVALID_PARAMETER' });
            let connector = new IndexerConnector(url);
            let result = await this.feeQuoteWithBusyRetry(connector, {
                action:        action,
                params:        params,
                source:        source,
                feeOutputSats: this.util.isNull(feeOutputSats) ? undefined : String(feeOutputSats)
            });
            return res.json(result);
        } catch(e){
            log.error('FEE_QUOTE_REQUEST_FAILED', { err: e.message || e });
            // `retryable` so a client can tell a transient upstream blip from a verdict; the
            // code and status stay as they were, because callers already branch on them.
            return res.status(502).json({ error: 'fee quote upstream error', code: 'UPSTREAM_ERROR', retryable: true });
        }
    }

    // Absorb the indexer's RETRYABLE busy answer on the fee-quote hop: it time-boxes
    // its wait for the block-processing mutex and answers `busy, retryable` in
    // milliseconds. The wallet reads this endpoint on every fee-bearing compose with no
    // retry of its own, so forwarding busy verbatim refuses the compose. Absorbing it
    // here is cheap, this hop being colocated with the indexer.

    // Retry ONLY `busy && retryable`: a real verdict, valid or invalid, is never
    // re-asked, and neither is a transport failure, which the caller's catch turns into
    // a 502. The budget is a wall-clock deadline checked before each retry, so a
    // saturated indexer still answers rather than holding the request open.
    async feeQuoteWithBusyRetry(connector, args){
        let budgetMs = parseInt(configEnv().EXPLORER_FEEQUOTE_BUSY_RETRY_MS, 10);
        if(!(budgetMs > 0)) budgetMs = 6000;
        let deadline = Date.now() + budgetMs;
        let delayMs  = 250;
        let result   = await connector.feequote(args);
        while(result && result.busy === true && result.retryable === true && Date.now() < deadline){
            await new Promise(resolve => setTimeout(resolve, delayMs));
            delayMs = Math.min(delayMs * 2, 1000);
            result  = await connector.feequote(args);
        }
        return result;
    }

    // Oracle usage fee quote for a Mode B dispenser, a proxy to the colocated indexer's
    // `oraclefeequote`. A dispenser naming an ORACLE_ADDRESS must carry a native-coin
    // output paying the oracle operator; this tells a payer how much.

    // Same query-param hardening as processFeeQuoteRequest: reject repeated keys,
    // anchor every value, bound the lengths. Nothing is type-checked on this hop, so an
    // arbitrary-shape value would otherwise reach the indexer.
    async processOracleFeeQuoteRequest(req, res){
        try {
            let config = await this.configInfo.getConfig();
            let parsed = this.parseCoinCode(req.params.coin, config);
            if(!parsed)
                return res.status(404).json({ error: 'unknown coin', code: 'UNKNOWN_COIN' });
            let url = IndexerConnector.resolveIndexerUrl(parsed.coin, parsed.network);
            if(!url)
                return res.status(501).json({ error: 'oracle fee quote unavailable (indexer API not configured for ' + parsed.coin + '/' + parsed.network + ')', code: 'INDEXER_NOT_CONFIGURED' });

            let fields = ['oracleAddress','giveCoin','giveTick','fiatCode','getCoin','giveEscrow','blockTime'];
            let q = {};
            for(let f of fields){
                if(Array.isArray(req.query[f]))
                    return res.status(400).json({ error: 'repeated query parameters are not allowed', code: 'INVALID_PARAMETER' });
                q[f] = this.util.isNull(req.query[f]) ? undefined : String(req.query[f]);
                if(q[f] !== undefined && q[f].length > 256)
                    return res.status(400).json({ error: 'parameter too long', code: 'INVALID_PARAMETER' });
            }
            if(this.util.isNull(q.oracleAddress) || this.util.isNull(q.giveTick) || this.util.isNull(q.fiatCode))
                return res.status(400).json({ error: 'oracleAddress, giveTick and fiatCode are required', code: 'MISSING_PARAMETER' });
            if(!/^[A-Z]{3,5}$/.test(q.fiatCode))
                return res.status(400).json({ error: 'invalid fiatCode', code: 'INVALID_PARAMETER' });
            for(let f of ['giveCoin','getCoin'])
                if(q[f] !== undefined && !/^[A-Z]{2,10}$/.test(q[f]))
                    return res.status(400).json({ error: 'invalid ' + f, code: 'INVALID_PARAMETER' });
            if(q.giveEscrow !== undefined && !/^[0-9]+(\.[0-9]{1,18})?$/.test(q.giveEscrow))
                return res.status(400).json({ error: 'invalid giveEscrow', code: 'INVALID_PARAMETER' });
            if(q.blockTime !== undefined && !/^[0-9]+$/.test(q.blockTime))
                return res.status(400).json({ error: 'invalid blockTime', code: 'INVALID_PARAMETER' });

            let connector = new IndexerConnector(url);
            let result = await connector.oraclefeequote(q);
            return res.json(result);
        } catch(e){
            log.error('ORACLE_FEE_QUOTE_REQUEST_FAILED', { err: e.message || e });
            return res.status(502).json({ error: 'oracle fee quote upstream error', code: 'UPSTREAM_ERROR' });
        }
    }

    // Public validity-first pre-flight ("would the indexer accept this action?"), a
    // thin proxy to the indexer's `preflight` JSON-RPC, whose height-keyed verdict memo
    // lives there. Same validation shape as processFeeQuoteRequest: reject repeated
    // params, charset-check the action, cap param/source lengths.

    // Serves BOTH registrations, since they are one endpoint over two transports and
    // the verdict must not depend on which the caller picked. The POST exists because
    // the largest legal input cannot ride a query string; see the route registration.
    async processPreflightRequest(req, res){
        try {
            let config = await this.configInfo.getConfig();
            let parsed = this.parseCoinCode(req.params.coin, config);
            if(!parsed)
                return res.status(404).json({ error: 'unknown coin', code: 'UNKNOWN_COIN' });
            let url = IndexerConnector.resolveIndexerUrl(parsed.coin, parsed.network);
            if(!url)
                return res.status(501).json({ error: 'pre-flight unavailable (indexer API not configured for ' + parsed.coin + '/' + parsed.network + ')', code: 'INDEXER_NOT_CONFIGURED' });
            // One input object for both transports. A POST reads its JSON body; anything else
            // reads the query string. `req.body` is undefined on a body-less POST under
            // body-parser 2.x, so it is defaulted rather than dereferenced.
            let input = (String(req.method || 'GET').toUpperCase() === 'POST') ? (req.body || {}) : (req.query || {});
            if(this.util.isNull(input.action))
                return res.status(400).json({ error: 'action is required', code: 'MISSING_PARAMETER' });
            let action = input.action;
            let params = input.params;   // pipe-delimited string; the indexer splits it
            let source = input.source;
            // How the caller's real transaction will settle the protocol fee. The
            // verdict differs by mode, so it is passed through rather than assumed; omitted,
            // the indexer picks the chain's own default mode.
            let feeMode = input.feeMode;
            if(Array.isArray(action) || Array.isArray(params) || Array.isArray(source) || Array.isArray(feeMode))
                return res.status(400).json({ error: 'repeated query parameters are not allowed', code: 'INVALID_PARAMETER' });
            // Non-string scalars/objects reach here from a JSON body (and from bracket-notation
            // query keys), where String() would quietly stringify them into something the
            // indexer then judges. Refuse instead of forwarding "[object Object]".
            for(let field of ['action', 'params', 'source', 'feeMode']){
                let value = input[field];
                if(value !== undefined && value !== null && typeof value !== 'string')
                    return res.status(400).json({ error: field + ' must be a string', code: 'INVALID_PARAMETER' });
            }
            action = String(action);
            if(!/^[A-Z0-9_]{1,32}$/.test(action))
                return res.status(400).json({ error: 'invalid action', code: 'INVALID_ACTION' });
            params = this.util.isNull(params) ? undefined : String(params);
            source = this.util.isNull(source) ? undefined : String(source);
            if((params && params.length > MAX_PREFLIGHT_PARAMS_LENGTH) || (source && source.length > MAX_PREFLIGHT_SOURCE_LENGTH))
                return res.status(400).json({ error: 'parameter too long', code: 'INVALID_PARAMETER' });
            if(!this.util.isNull(feeMode)){
                feeMode = String(feeMode).toLowerCase();
                if(feeMode !== 'xchain' && feeMode !== 'native')
                    return res.status(400).json({ error: 'invalid feeMode (expected xchain or native)', code: 'INVALID_PARAMETER' });
            } else {
                feeMode = undefined;
            }
            let connector = new IndexerConnector(url);
            let result = await connector.preflight({ action, params, source, feeMode });
            return res.json(result);
        } catch(e){
            log.error('PREFLIGHT_REQUEST_FAILED', { err: e.message || e });
            return res.status(502).json({ error: 'pre-flight upstream error', code: 'UPSTREAM_ERROR' });
        }
    }

    // Native-coin fee schedule + current oracle prices (proxy to the indexer's `feeschedule`).
    // GET /{COIN}/api/feeschedule
    async processFeeScheduleRequest(req, res){
        try {
            let config = await this.configInfo.getConfig();
            let parsed = this.parseCoinCode(req.params.coin, config);
            if(!parsed)
                return res.status(404).json({ error: 'unknown coin', code: 'UNKNOWN_COIN' });
            let url = IndexerConnector.resolveIndexerUrl(parsed.coin, parsed.network);
            if(!url)
                return res.status(501).json({ error: 'fee schedule unavailable (indexer API not configured for ' + parsed.coin + '/' + parsed.network + ')', code: 'INDEXER_NOT_CONFIGURED' });
            let connector = new IndexerConnector(url);
            return res.json(await connector.feeschedule());
        } catch(e){
            log.error('FEE_SCHEDULE_REQUEST_FAILED', { err: e.message || e });
            return res.status(502).json({ error: 'fee schedule upstream error', code: 'UPSTREAM_ERROR' });
        }
    }
}

// True for the one request the global json() body parser in api.js must NOT touch:
// POST /{COIN}/api/preflight parses its own body with a far larger ceiling (see the
// route registration), and the tight global parser would 413 a legal 250-command
// BATCH before the route-level parser ever ran. Exported here, beside the route it
// describes, so api.js cannot drift from the path the route actually claims.
function isPreflightPostRequest(req){
    if(!req || String(req.method || '').toUpperCase() !== 'POST') return false;
    return /^\/[^/]+\/api\/preflight\/?$/i.test(String(req.path || ''));
}

module.exports = { methods: FeesPreflight.prototype, useHostBindings, isPreflightPostRequest, MAX_PREFLIGHT_PARAMS_LENGTH };
