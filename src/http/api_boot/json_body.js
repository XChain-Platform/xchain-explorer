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
 * XChain Explorer - the global JSON body ceiling and its refusals
 *
 * Two boot steps of src/api.js. The parser mounts after CORS, the shedding
 * guards and observability, so a bad body is charged, logged and answered
 * with the CORS headers a browser needs to read it. The refusal handler
 * mounts last and answers every body-parser failure, from this parser or a
 * route's own, with a registered code instead of the framework's HTML page.
 *
 ********************************************************************/

'use strict';

const express = require('express');

// The failure types body-parser stamps on its errors; any other error keeps the default handler.
const BODY_ERROR_TYPES = new Set([
    'entity.parse.failed', 'entity.too.large', 'entity.verify.failed',
    'encoding.unsupported', 'charset.unsupported', 'request.aborted',
    'request.size.invalid', 'stream.encoding.set', 'stream.not.readable'
]);

/**
 * Whether a path is one of the JSON-RPC dispatcher's two entry points.
 *
 * The dispatcher is root-mounted and reached at POST / and POST /{COIN}/api/
 * (the federation reads), so a refusal there is a JSON-RPC error object.
 *
 * @param {string} reqPath the request path
 * @returns {boolean} true for / and /{COIN}/api with or without the slash
 */
function isJsonRpcPath(reqPath){
    return reqPath === '/' || /^\/[^/]+\/api\/?$/.test(String(reqPath || ''));
}

/**
 * Answer a body-parser failure in the registered shape.
 *
 * @param {object} err the error body-parser passed to next()
 * @param {object} req the request
 * @param {object} res the response
 * @returns {boolean} true when the error was a body failure and is answered
 */
function sendBodyError(err, req, res){
    const status = Number(err && (err.status || err.statusCode));
    if(!(status >= 400 && status < 500) || !BODY_ERROR_TYPES.has(err.type)) return false;

    const tooLarge = err.type === 'entity.too.large';
    if(isJsonRpcPath(req.path)){
        const rpcError = tooLarge
            ? { code: -32600, message: 'Request body too large' }
            : { code: -32700, message: 'Parse error' };
        res.status(status).json({ jsonrpc: '2.0', id: null, error: rpcError });
        return true;
    }
    if(tooLarge) res.status(status).json({ error: 'Request body too large', code: 'BODY_TOO_LARGE' });
    else res.status(status).json({ error: 'Request body could not be read as JSON', code: 'INVALID_JSON_BODY' });
    return true;
}

/**
 * Mount the tight global body ceiling.
 *
 * Nothing on this read-only API legitimately posts more than 10kb. The
 * exceptions are POST /{COIN}/api/preflight and POST /{COIN}/api/feequote, which
 * each carry a whole composed action (a 250-command BATCH is ~17,500 characters)
 * and mount their own parser with their own ceiling at the route. The
 * predicates live beside those routes so a predicate cannot drift from its route.
 *
 * @param {object} app the express app
 * @param {function} XChainExplorer the explorer class (isPreflightPostRequest, isFeeQuotePostRequest)
 */
function applyJsonBody(app, XChainExplorer){
    const globalJson = express.json({ limit: '10kb' });
    app.use((req, res, next) => {
        if (XChainExplorer.isPreflightPostRequest(req) || XChainExplorer.isFeeQuotePostRequest(req)) return next();
        return globalJson(req, res, next);
    });
}

/**
 * Mount the body refusal handler; it must stay the last mount in createApp.
 *
 * @param {object} app the express app
 */
function applyBodyErrorHandler(app){
    // Four arguments make this an error handler; a non-body error falls through unchanged.
    app.use((err, req, res, next) => {
        if(res.headersSent || !sendBodyError(err, req, res)) return next(err);
    });
}

module.exports = { applyJsonBody, applyBodyErrorHandler, sendBodyError, isJsonRpcPath };
