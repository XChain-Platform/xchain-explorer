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
 * XChain Explorer - batch reads
 *
 * The two POST batch endpoints and the in-process read they are assembled from.
 * Nothing here touches the database directly: every entry is built by driving the
 * same dispatcher that answers the per-address GETs.
 *
 * HOW THIS ATTACHES
 *
 * The methods are authored as a class body and exported as that class's prototype,
 * so XChainExplorer.js can copy them onto its own prototype verbatim (see
 * explorer/install.js). Nothing here is ever instantiated: `this` is the explorer
 * instance at call time, exactly as it was when these methods sat inline.
 *
 ********************************************************************/

'use strict';

// Module-scope logger, not a method on the class these parts install onto: every
// log line below reaches the shipper api.js installs, exactly as it did inline.
const { getLogger } = require('../observability');
const log = getLogger();

// Ceiling on one batch body's address list. Twenty covers a wallet's worst
// per-chain address count, so the caller the endpoint exists for never has to
// split a chain across two requests, while an abusive body stays bounded work.
const BATCH_ADDRESS_MAX = 20;

// How many of a batch's inner per-address reads run at once. Well under the
// 200-request global concurrency cap (api.js), so one batch caller cannot
// occupy the whole gate and shed everyone else's queries.
const BATCH_READ_CONCURRENCY = 8;

// Longest rejected entry echoed back in an INVALID_ADDRESS refusal.
// isAddressLike refuses anything above 128 characters, so a rejected entry can
// be arbitrarily long and echoing it whole would let the caller size the error
// body from an unvalidated string.
const BATCH_INVALID_ECHO_MAX = 128;

class BatchReads {

    /**********************************************************
     * BATCH reads: POST /{COIN}/api/balances
     *              POST /{COIN}/api/coinpay_obligations
     *
     * Body {"addresses":[..]}, answered as an object keyed by address so a
     * caller matches results without relying on array order.
     *
     * Nothing new reads the database here. Each entry is assembled by driving
     * the SAME dispatcher that answers the per-address GETs, so a batch body
     * and a GET body cannot disagree about a field, a paging default or a
     * freshness marker; only the number of HTTP requests it takes to get them
     * changes. See readApi for why re-driving is sound.
     *********************************************************/

    /**
     * Drive one per-address API read through processRequest with no HTTP hop.
     *
     * processRequest reads only req.path and req.query and answers through
     * res.set/res.status/res.send, so a synthetic request plus a capturing
     * response reproduces exactly what the equivalent GET would have sent.
     *
     * Returns { code, json }, json parsed back from the bytes that were sent
     * (null when the body was not JSON). A throw is degraded to a 500 entry
     * rather than propagated: one address failing must not lose the other
     * nineteen answers the caller already paid for.
     */
    async readApi(coin, apiPath, query){
        let code = 200;
        const body = [];
        const res  = {
            set:    function(){ return this; },
            status: function(c){ code = c; return this; },
            send:   function(chunk){ body.push(chunk); return this; }
        };
        try {
            await this.processRequest({ path: '/' + coin + '/api' + apiPath, query: query || {} }, res);
        } catch(err){
            log.error('BATCH_READ_FAILED', { api_path: apiPath, err: (err && err.message) ? err.message : err });
            return { code: 500, json: { error: 'An unexpected error occurred while serving this request.', code: 'INTERNAL_ERROR' } };
        }
        let json = null;
        try { json = JSON.parse(body.join('')); } catch(_){ json = null; }
        return { code, json };
    }

    /**
     * Validate a batch body's address list against the endpoint contract.
     * Returns { addresses } (deduplicated, input order preserved) or
     * { refusal } carrying the 400 body to send.
     */
    parseBatchAddresses(body){
        const list = (body && Array.isArray(body.addresses)) ? body.addresses : null;
        if(list === null || list.length === 0 || list.some(entry => typeof entry !== 'string'))
            return { refusal: { error: 'addresses must be a non-empty array of address strings', code: 'INVALID_ADDRESSES' } };
        // Counted before deduplication: the cap bounds what the caller sent, so a
        // body of 500 repeats of one address is refused rather than quietly served.
        if(list.length > BATCH_ADDRESS_MAX)
            return { refusal: { error: 'Too many addresses (max ' + BATCH_ADDRESS_MAX + ')', code: 'TOO_MANY_ADDRESSES' } };
        const addresses = [];
        for(const entry of list){
            if(!this.util.isAddressLike(entry))
                return { refusal: { error: 'Invalid address: ' + entry.slice(0, BATCH_INVALID_ECHO_MAX), code: 'INVALID_ADDRESS' } };
            if(!addresses.includes(entry))
                addresses.push(entry);
        }
        return { addresses };
    }

    // Same wire convention processRequest ends on: the JSON content type set
    // explicitly rather than through res.type(), and the body serialized by
    // util.jsonStringify, so a batch body and a per-address body are encoded by
    // the same code path.
    sendBatchJson(res, code, json){
        res.status(code);
        res.set('Content-Type', 'application/json; charset=utf-8');
        res.send(this.util.jsonStringify(json));
    }

    /**
     * One address's entry: every read in `parts` answered under that address's
     * own key, with a refusal recorded rather than thrown.
     *
     * `seeded` carries reads the caller already drove (the coin gate probe), so
     * the address that paid for one is not charged for it twice.
     */
    async batchEntry(coin, address, parts, query, seeded){
        const entry = {};
        let failure = null;
        for(const part of parts){
            const readPath = part.path(address);
            const read     = seeded.has(readPath) ? seeded.get(readPath) : await this.readApi(coin, readPath, query);
            if(read.code === 200){
                entry[part.key] = read.json;
                continue;
            }
            // A half that did not answer 200 is null with its own body's
            // reason attached, so the caller degrades this address alone
            // instead of losing the batch. First failure wins, in `parts`
            // order, because that is the more specific read.
            entry[part.key] = null;
            if(failure === null)
                failure = {
                    code:   (read.json && read.json.code)  ? read.json.code  : 'READ_FAILED',
                    error:  (read.json && read.json.error) ? read.json.error : 'The batch read failed for this address.',
                    status: read.code
                };
        }
        entry.error = failure;
        return entry;
    }

    /**
     * Shared body of both batch routes. `parts` names the per-address reads one
     * entry is built from, in the order their failures take precedence:
     * [{ key, path(address) }, ..].
     */
    async processBatchRequest(req, res, parts){
        const coin   = String((req.params && req.params.coin) || '').toUpperCase();
        const parsed = this.parseBatchAddresses(req.body);
        if(parsed.refusal)
            return this.sendBatchJson(res, 400, parsed.refusal);

        const addresses = parsed.addresses;
        const query     = (req.query && typeof req.query === 'object') ? req.query : {};

        // The coin gate (unsupported coin, or a tip stale past the fail-closed
        // threshold) is a whole-request verdict every inner read would repeat, so
        // the first read is driven alone and its refusal answers the batch. Buried
        // inside a 200 it would read to a client as twenty empty addresses, which
        // is the opposite of what a fail-closed gate is for. Its result is carried
        // into the fan-out below rather than re-read.
        const firstPath = parts[0].path(addresses[0]);
        const firstRead = await this.readApi(coin, firstPath, query);
        if(firstRead.code === 503 && firstRead.json && String(firstRead.json.code || '').startsWith('COIN_'))
            return this.sendBatchJson(res, firstRead.code, firstRead.json);

        const seeded  = new Map([[firstPath, firstRead]]);
        const entries = new Map();
        let cursor    = 0;
        const worker  = async () => {
            for(;;){
                const idx = cursor++;
                if(idx >= addresses.length) return;
                const address = addresses[idx];
                entries.set(address, await this.batchEntry(coin, address, parts, query, seeded));
            }
        };

        const workers = [];
        for(let i = 0; i < Math.min(BATCH_READ_CONCURRENCY, addresses.length); i++)
            workers.push(worker());
        await Promise.all(workers);

        // Keyed in the caller's own address order, not completion order, so a
        // response body is deterministic for a given request.
        const out = {};
        for(const address of addresses)
            out[address] = entries.get(address);
        return this.sendBatchJson(res, 200, out);
    }

    async processBalancesBatchRequest(req, res){
        // encodeURIComponent is a no-op on anything isAddressLike admits
        // ([A-Za-z0-9] only); it is here so a future loosening of that predicate
        // cannot turn an entry into extra path segments.
        return this.processBatchRequest(req, res, [
            { key: 'balances', path: (address) => '/balances/' + encodeURIComponent(address) },
            { key: 'address',  path: (address) => '/address/'  + encodeURIComponent(address) }
        ]);
    }

    // One obligations lookup per address in a single round trip, keyed by address
    // rather than by block, which is the query shape a wallet asks for.
    async processCoinpayObligationsBatchRequest(req, res){
        return this.processBatchRequest(req, res, [
            { key: 'coinpay_obligations', path: (address) => '/coinpay_obligations/' + encodeURIComponent(address) + '/address' }
        ]);
    }
}

module.exports = { methods: BatchReads.prototype };
