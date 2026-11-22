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
 * with the CORS headers a browser needs to read it. The one exception is the
 * two JSON-RPC paths: the concurrency gate needs the method, so rate_limits.js
 * reads those bodies first through this module's own parser instance. A body
 * refused there is charged by the limiter but never reaches observability.
 * The refusal handler mounts last and answers every body-parser failure, from
 * this parser or a route's own, with a registered code instead of the
 * framework's HTML page.
 *
 ********************************************************************/

'use strict';

const express = require('express');

// The failure types body-parser stamps on its errors; decompressor stream
// failures are untyped and are recognized separately below.
const BODY_ERROR_TYPES = new Set([
    'entity.parse.failed', 'entity.too.large', 'entity.verify.failed',
    'encoding.unsupported', 'charset.unsupported', 'request.aborted',
    'request.size.invalid', 'stream.encoding.set', 'stream.not.readable'
]);

function isBodyDecodeError(err){
    const status = Number(err && (err.status || err.statusCode));
    const code = String(err && err.code || '');
    return status === 400 && err.type === undefined &&
        typeof err.errno === 'number' &&
        (/^Z_[A-Z_]+$/.test(code) || /^ERR__ERROR_FORMAT_[A-Z0-9_]+$/.test(code));
}

// The one global ceiling, built once: applyJsonBody mounts it for every route and
// rate_limits.js mounts the same instance ahead of the concurrency gate, so the
// two cannot hold different limits. A body it has already read is passed through.
const globalJsonBody = express.json({ limit: '10kb' });

/**
 * Whether a path is one of the JSON-RPC dispatcher's two published entry points.
 *
 * The dispatcher is root-mounted and reached at POST / and POST /{COIN}/api/
 * (the federation reads), so a refusal there is a JSON-RPC error object. The
 * router also answers any other POST no route claimed, but those paths are not
 * entry points: a body refused there takes the REST shape, and a ping there
 * gets no gate exemption.
 *
 * @param {string} reqPath the request path
 * @returns {boolean} true for / and /{COIN}/api with or without the slash
 */
function isJsonRpcPath(reqPath){
    return reqPath === '/' || /^\/[^/]+\/api\/?$/.test(String(reqPath || ''));
}

/**
 * Answer a body-parser or body-decompression failure, or a malformed-path
 * URIError, in the registered shape.
 *
 * @param {object} err the error body-parser passed to next()
 * @param {object} req the request
 * @param {object} res the response
 * @returns {boolean} true when the error was a body or path-decoding failure and is answered
 */
function sendBodyError(err, req, res){
    // A malformed percent-escape in a route param makes the router throw a URIError (status 400);
    // answer it as a registered refusal so no stack or HTML page reaches the client.
    if(err instanceof URIError && Number(err.status || err.statusCode) === 400){
        res.status(400).json({ error: "Malformed percent-encoding in the request path", code: "INVALID_PARAMETER" });
        return true;
    }
    const status = Number(err && (err.status || err.statusCode));
    if(!(status >= 400 && status < 500) ||
        (!BODY_ERROR_TYPES.has(err.type) && !isBodyDecodeError(err))) return false;

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
 * each carry a whole composed action (a 250-command BATCH is ~17,500 characters),
 * and POST /{COIN}/api/contract/{idx}/call, whose validator accepts 32 params of
 * 1024 bytes. Each mounts its own parser with its own ceiling at the route. The
 * predicates live beside those routes so a predicate cannot drift from its route.
 *
 * @param {object} app the express app
 * @param {function} XChainExplorer the explorer class (isPreflightPostRequest, isFeeQuotePostRequest, isContractCallPostRequest)
 */
function applyJsonBody(app, XChainExplorer){
    app.use((req, res, next) => {
        if (XChainExplorer.isPreflightPostRequest(req) || XChainExplorer.isFeeQuotePostRequest(req) ||
            XChainExplorer.isContractCallPostRequest(req)) return next();
        return globalJsonBody(req, res, next);
    });
}

/**
 * Mount the body refusal handler; it must stay the last mount in createApp.
 *
 * @param {object} app the express app
 */
function applyBodyErrorHandler(app){
    // Four arguments make this an error handler. Body and path failures get their registered
    // code; every other error gets a bounded JSON answer, because the framework's default
    // handler prints err.stack (module paths, dependency layout) whenever NODE_ENV is not production.
    app.use((err, req, res, next) => {
        if(res.headersSent) return next(err);
        if(sendBodyError(err, req, res)) return undefined;
        const status = Number(err && (err.status || err.statusCode));
        if(status >= 400 && status < 500){
            return res.status(status).json({ error: 'Request could not be processed', code: 'BAD_REQUEST' });
        }
        return res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
    });
}

module.exports = { applyJsonBody, applyBodyErrorHandler, sendBodyError, isJsonRpcPath,
    isBodyDecodeError, globalJsonBody };
