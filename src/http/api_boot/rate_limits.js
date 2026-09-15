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

const rateLimit = require('express-rate-limit');
const concurrencyGate = require('../concurrency_gate.js');
const { limitedHandler } = require('../rate_limit_log.js');  // limiter counter line, shared with XChainExplorer's per-route limiters

/**
 * The app-wide limiter's ceiling, the knob's name and the refusal body.
 *
 * Rate limiting: requests per minute per IP (image requests are excluded;
 * override the default with EXPLORER_RATE_LIMIT_RPM).
 *
 * Where 1080 comes from: a five-address wallet's worst minute is a cold
 * open plus the two 20-second polls that fit in the same window, measured
 * at 180 explorer reads; x2 because the wallet's SDK retries once, and x3
 * for headroom because a NAT with three testers shares one bucket. The
 * number is per REAL CLIENT ADDRESS, which is what the origin sees once
 * the fronting proxy resolves real clients; it was a per-CDN-edge-address
 * number before that, where the same wallet traffic scattered across
 * buckets and hid the requirement. It replaces a 500 that predates any
 * measurement of the client.
 *
 * Three of the explorer's eight origin limits moved on that profile: this
 * one, the action/balance proof limiter and the checkpoint-verify limiter
 * (both to 90, in XChainExplorer.js). The other five (fee quote 120,
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
        limit:    parseInt(configInfo.env.EXPLORER_RATE_LIMIT_RPM, 10) || 1080,
        envVar:   'EXPLORER_RATE_LIMIT_RPM',
        windowMs: 60 * 1000,
        message:  { error: 'Too many requests', code: 'RATE_LIMITED' }
    };
}

/**
 * Mount the per-IP limiter and then the global concurrency cap.
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
        skip: isStaticAsset,
    }));

    // Global in-flight concurrency cap. The limiter above is per-IP,
    // so a stampede spread across thousands of distinct IPs never trips it and
    // can still pin every MariaDB pool connection. This caps how many requests
    // are being served at any instant across ALL callers and sheds the excess
    // with an immediate 429 rather than queueing it. Override with
    // EXPLORER_MAX_CONCURRENT_REQUESTS; 0 disables the cap.
    const requestGate = concurrencyGate.createConcurrencyGate({
        limit:      concurrencyGate.resolveLimit(configInfo.env.EXPLORER_MAX_CONCURRENT_REQUESTS, 200),
        retryAfter: 1,
        skip:       isStaticAsset,
        body:       { error: 'Server busy, retry shortly', code: 'SERVER_BUSY' }
    });
    app.use(requestGate);

    return requestGate;
}

module.exports = { applyRateLimits };
