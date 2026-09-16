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
 * XChain Explorer - the JSON-RPC dispatcher mount
 *
 * One boot step of src/api.js, taken last so the explorer's own routes answer
 * first and only unmatched requests reach the dispatcher. The controller whose
 * methods it dispatches is built on the entry, because ping probes the DB pool
 * the entry owns; this step is the guards in front of the router and the mount
 * itself, which have to stay in this order.
 *
 ********************************************************************/

'use strict';

const jsonRouter = require('express-json-rpc-router')
const { resolveMaxBatch, makeRpcBatchGuard } = require('../rpc_batch_guard.js');   // JSON-RPC batch cardinality cap
const { makeFederationKeyGate } = require('../../federation/key_gate.js');         // x-api-key gate for the federation reads
const { FEDERATION_READ_METHODS } = require('../../federation');
const { getLogger } = require('../../observability');

/**
 * Mount the batch cap, the body default, the federation key gate and the router, in that order.
 *
 * @param {object} app the express app
 * @param {object} configInfo src/config.js, for its live env view
 * @param {object} jsonRpcController the method map the router dispatches to
 */
function mountJsonRpc(app, configInfo, jsonRpcController){
    // Bound JSON-RPC batch cardinality (src/http/rpc_batch_guard.js). The router below runs
    // Promise.all over every element of a batch array, while both the per-IP rate
    // limiter and the concurrency gate above count the whole batch as ONE request, and
    // ping draws a pooled connection for its SELECT 1 probe. Mounted here, in front of
    // the router rather than globally, so it governs the dispatcher that amplifies and
    // never sees POST /{COIN}/api/preflight, which parses its own much larger body.
    // Both bounds above have already been charged by this point, so an oversize batch
    // is never free. Default 20, matching encoder/decoder/utxo-tracker.
    app.use(makeRpcBatchGuard(resolveMaxBatch(configInfo.env.EXPLORER_MAX_RPC_BATCH, 20)));

    // The JSON-RPC handler, registered last so explorer routes take priority.
    // Express 5 / body-parser 2.x leaves req.body undefined when a request carries
    // no JSON body (a GET, or a POST without application/json), whereas body-parser
    // 1.x set it to {}. express-json-rpc-router requires req.body to be an object or
    // it throws ("req.body is required"). Restore the {} default so unmatched requests
    // that fall through to this root-mounted router get a normal JSON-RPC error
    // response instead of crashing the request.
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

    // The federation reads need EXPLORER_FEDERATION_READ_KEY in x-api-key, and refuse
    // everyone while it is unset. After the body default, because the gate reads the
    // method names out of the body; before the router, so no gated method ever runs.
    if(!configInfo.federationReadKey())
        getLogger().info('FEDERATION_READS_LOCKED', { detail: 'EXPLORER_FEDERATION_READ_KEY is unset; federation reads answer 401' });
    app.use(makeFederationKeyGate(() => configInfo.federationReadKey(), FEDERATION_READ_METHODS));
    app.use(jsonRouter({methods: jsonRpcController}))
}

module.exports = { mountJsonRpc };
