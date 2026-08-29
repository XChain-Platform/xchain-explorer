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
 * XChain Explorer - JSON-RPC batch-size cap
 *
 * express-json-rpc-router dispatches EVERY element of a batch array
 * concurrently. Both protections in front of it count an HTTP REQUEST, not a
 * call: the per-IP rate limiter charges one token per request, and the global
 * concurrency gate occupies one in-flight slot per request. The 10 KB body
 * ceiling holds roughly 200 call objects, and the only exposed method, ping,
 * draws a pooled MariaDB connection for its SELECT 1 probe - so one request
 * from one IP can pin the pool while the gate that exists precisely to stop a
 * pool-pinning stampede counts it as a single caller. Cap the CARDINALITY
 * before dispatch.
 *
 * Its own module, like src/concurrencyGate.js, so it is unit-testable without
 * booting the API. The error shape matches the same guard already shipping in
 * xchain-encoder, xchain-decoder and xchain-utxo-tracker.
 *
 ********************************************************************/

'use strict';

// Parse the cap from the environment. A missing or unparseable value keeps the
// caller's default (fail-safe: a typo must not silently remove the cap), and so
// does a non-positive one - unlike the concurrency gate, there is no legitimate
// reason to disable a batch ceiling, and 0 would otherwise reject every batch.
function resolveMaxBatch(rawValue, defaultMax){
    const parsed = parseInt(rawValue, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMax;
}

/**
 * Build the batch-cap middleware.
 *
 * Only an ARRAY body is a JSON-RPC batch; a single call object, an absent body
 * and a non-JSON request all fall straight through to next().
 *
 * @param {number} maxBatch Maximum call objects in one batch array.
 * @returns {function} Express middleware.
 */
function makeRpcBatchGuard(maxBatch){
    return function rpcBatchGuard(req, res, next){
        if(Array.isArray(req.body) && req.body.length > maxBatch){
            return res.status(400).json({
                jsonrpc: '2.0', id: null,
                error: { code: -32600, message: 'Batch too large (max ' + maxBatch + ' requests per call)' }
            });
        }
        next();
    };
}

module.exports = { resolveMaxBatch, makeRpcBatchGuard };
