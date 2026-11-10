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
 * XChain Explorer - the two app-wide shedding guards
 *
 * One boot step of src/api.js: the per-IP rate limiter and the global in-flight
 * concurrency cap, mounted in that order. They are the same concern read two
 * ways (one caller too loud, all callers too many at once) and they share the
 * static-asset exemption, so they live together and the entry mounts them in
 * one call.
 *
 * The exemption predicate is passed in rather than resolved here: the entry owns
 * the one mount list (src/http/static_mounts.js) it comes from, and the
 * per-route limiters in XChainExplorer.js read the same list.
 *
 ********************************************************************/

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { isJsonRpcPath } = require('./json_body.js');         // the dispatcher's two entry paths
const concurrencyGate = require('../concurrency_gate.js');
const { limitedHandler } = require('../rate_limit_log.js');  // limiter counter line, shared with XChainExplorer's per-route limiters
const { isFileMount } = require('../static_mounts.js');     // disk-served mounts, which take the static bucket below

/**
 * The app-wide limiter's ceiling, the knob's name and the refusal body.
 *
 * Rate limiting: requests per minute per IP (image requests are excluded;
 * override the default with EXPLORER_RATE_LIMIT_RPM).
 *
 * Where 180 comes from: a five-address wallet using the batch routes makes
 * 30 explorer reads in its worst minute: 15 proofs, 12 batch reads and 3
 * checkpoint verifications. The ceiling includes one SDK retry and headroom
 * for three testers sharing a NAT. The number is per real client address,
 * which is what the origin sees once the fronting proxy resolves real clients.
 *
 * The action/balance proof limiter remains 90 on that profile, while
 * checkpoint verify is 60 after the SDK caches the validator set. The other
 * five route-specific limits (fee quote 120,
 * preflight POST 60, checkpoint list 120, validator-set proof 30, VM query
 * 20) are not on an idle wallet's path, so the profile does not exercise
 * them and they keep their shipped values on purpose.
 *
 * Resolved once here and spread into both the limiter and its counter line, so
 * the number an operator reads in the log is always the number that actually
 * refused.
 *
 * @param {object} configInfo src/config.js, for its live env view
 * @returns {object} the policy the limiter and its handler share
 */
function appWidePolicyFor(configInfo){
    return {
        limit:    parseInt(configInfo.env.EXPLORER_RATE_LIMIT_RPM, 10) || 180,
        envVar:   'EXPLORER_RATE_LIMIT_RPM',
        windowMs: 60 * 1000,
        message:  { error: 'Too many requests', code: 'RATE_LIMITED' }
    };
}

/**
 * The static-file bucket: scripts, stylesheets, components, themes and fonts.
 * 1200 is ten cold page loads of about 110 files each; these are disk reads, so
 * the bucket only has to stop a flood, and a warm visitor sends almost none.
 *
 * @param {object} configInfo src/config.js, for its live env view
 * @returns {object} the policy the static limiter and its handler share
 */
function staticPolicyFor(configInfo){
    return {
        limit:    parseInt(configInfo.env.EXPLORER_STATIC_RATE_LIMIT_RPM, 10) || 1200,
        envVar:   'EXPLORER_STATIC_RATE_LIMIT_RPM',
        windowMs: 60 * 1000,
        message:  { error: 'Too many requests', code: 'RATE_LIMITED' }
    };
}

/**
 * Whether a request is a single JSON-RPC ping, the call that reports the
 * gate's own stats and that the container healthcheck sends. A batch is never
 * one: the dispatcher runs every element, so a batch of pings draws one pool
 * connection each.
 *
 * @param {object} req the request, after the JSON-RPC body is parsed
 * @returns {boolean} true for a lone { method: 'ping' } object
 */
function isPingRequest(req){
    const body = req.body;
    return req.method === 'POST' && isJsonRpcPath(req.path) &&
        body !== null && typeof body === 'object' && !Array.isArray(body) && body.method === 'ping';
}

/**
 * Mount the per-IP limiters and then the global concurrency cap.
 *
 * @param {object} app the express app
 * @param {object} configInfo src/config.js, for its live env view
 * @param {function} isStaticAsset the mount-list exemption both guards skip on
 * @returns {function} the concurrency gate, which also publishes getStats()
 */
function applyRateLimits(app, configInfo, isStaticAsset){
    const appWidePolicy = appWidePolicyFor(configInfo);
    app.use(rateLimit({
        windowMs:        appWidePolicy.windowMs,
        limit:           appWidePolicy.limit,
        standardHeaders: true,
        legacyHeaders:   false,
        handler:         limitedHandler({ service: 'Explorer', name: 'app-wide', ...appWidePolicy }),
        skip: (req) => isStaticAsset(req) || isFileMount(req),
    }));

    // File mounts leave the app-wide bucket for their own: counting them there
    // refused a page's scripts after two page views. The image exemption still
    // applies first, so /images and /icon stay unlimited as before.
    const staticPolicy = staticPolicyFor(configInfo);
    app.use(rateLimit({
        windowMs:        staticPolicy.windowMs,
        limit:           staticPolicy.limit,
        standardHeaders: true,
        legacyHeaders:   false,
        handler:         limitedHandler({ service: 'Explorer', name: 'static', ...staticPolicy }),
        skip: (req) => isStaticAsset(req) || !isFileMount(req),
    }));

    // Global in-flight concurrency cap. The limiter above is per-IP,
    // so a stampede spread across thousands of distinct IPs never trips it and
    // can still pin every MariaDB pool connection. This caps how many requests
    // are being served at any instant across ALL callers and sheds the excess
    // with an immediate 429 rather than queueing it. Override with
    // EXPLORER_MAX_CONCURRENT_REQUESTS; 0 disables the cap.
    //
    // The gate reports on itself through JSON-RPC ping (request_gate), and the
    // container healthcheck is that same ping. Behind the cap, both answered
    // 429 exactly while the gate was saturated, so in_flight and shed were
    // unreadable when they mattered and a full gate failed the healthcheck.
    // The skip needs the RPC method, which lives in the body, so the two
    // dispatcher paths are parsed here, ahead of the gate, at the same 10kb
    // ceiling the global parser applies; that parser then finds the body
    // already read and passes it through. A lone ping skips the cap and stays
    // bounded per IP by the limiter above.
    const jsonRpcBody = express.json({ limit: '10kb' });
    app.use((req, res, next) => {
        if(req.method !== 'POST' || !isJsonRpcPath(req.path)) return next();
        return jsonRpcBody(req, res, next);
    });

    const requestGate = concurrencyGate.createConcurrencyGate({
        limit:      concurrencyGate.resolveLimit(configInfo.env.EXPLORER_MAX_CONCURRENT_REQUESTS, 200),
        retryAfter: 1,
        // A disk read holds no pool connection, so file mounts skip the cap too.
        skip:       (req) => isStaticAsset(req) || isFileMount(req),
        probe:      isPingRequest,
        body:       { error: 'Server busy, retry shortly', code: 'SERVER_BUSY' },
        envVar:     'EXPLORER_MAX_CONCURRENT_REQUESTS'
    });
    app.use(requestGate);

    return requestGate;
}

module.exports = { applyRateLimits, isPingRequest };
