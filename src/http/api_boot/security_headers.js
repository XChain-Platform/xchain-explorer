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
 * XChain Explorer - browser security headers and the global body ceiling
 *
 * One boot step of src/api.js (the entry calls it first, before anything else
 * touches the app). Helmet's header set with the explorer's own CSP, the tight
 * JSON body limit every route but preflight answers under, and the proxy-hop
 * trust the per-IP guards downstream key on.
 *
 * XChainExplorer arrives as an argument rather than a require: the class is the
 * entry's, the preflight predicate lives beside the route that needs the larger
 * body, and passing it keeps this step free of the explorer's whole dependency
 * tree.
 *
 ********************************************************************/

'use strict';

const express = require('express');
const helmet  = require('helmet');
const { applyTrustProxy } = require('../trust_proxy.js');   // proxy-hop policy, shared with the WS path's hop count

/**
 * Is this deployment TLS-fronted?
 *
 * HTTPS-only hardening: upgrade-insecure-requests + HSTS. These MUST NOT be sent when the
 * explorer is reached over plain HTTP (local dev / regtest), or the browser rewrites every
 * same-origin subresource (icons, assets) to https://<host>:<http-port>, which only speaks
 * HTTP -> SSL protocol error -> broken images. Enable only when TLS-fronted: prod runs
 * NODE_ENV=production behind Apache TLS. EXPLORER_FORCE_HTTPS=1/0 overrides explicitly.
 *
 * @param {object} env the live read-through view of process.env
 * @returns {boolean}
 */
function httpsHardening(env){
    return (env.EXPLORER_FORCE_HTTPS != null)
        ? ['1','true','yes','on'].includes(String(env.EXPLORER_FORCE_HTTPS).toLowerCase())
        : (env.NODE_ENV === 'production');
}

/**
 * The content-security-policy directives, each tuned for what the explorer's
 * own pages need.
 *
 * @param {boolean} HTTPS_HARDENING see httpsHardening()
 * @returns {object} helmet's contentSecurityPolicy.directives
 */
function cspDirectives(HTTPS_HARDENING){
    return {
        // Default: only allow resources from self
        defaultSrc:  ["'self'"],
        // Inline scripts are required for per-page $(document).ready() blocks in HTML
        // templates. static.cloudflareinsights.com is Cloudflare's RUM beacon, which the
        // edge auto-injects into proxied pages; blocking it logs a CSP violation on every
        // page load. Deployments not behind Cloudflare never receive the script, so the
        // allowance is inert for them.
        scriptSrc:     ["'self'", "'unsafe-inline'", "https://static.cloudflareinsights.com"],
        // Helmet sets script-src-attr: 'none' by default; override to allow inline event handlers required by jQuery
        scriptSrcAttr: ["'unsafe-inline'"],
        // Inline styles are required for Bootstrap components and HTML attribute styles
        styleSrc:    ["'self'", "'unsafe-inline'"],
        // data: URIs are required for QR code generation; https: allows external images in token descriptions
        imgSrc:      ["'self'", "data:", "https:"],
        // Token descriptions can carry <video>/<audio> sources on any https host,
        // and the sandboxed custom-content srcdoc frame inherits THIS policy (a
        // srcdoc document has no origin of its own to carry one), so without an
        // explicit media-src the default-src 'self' fallback refuses every
        // external clip. Same shape as img-src: any https origin, nothing else.
        mediaSrc:    ["'self'", "https:"],
        // cloudflareinsights.com receives the RUM beacon's measurement POSTs
        // (older beacon builds post cross-origin instead of to /cdn-cgi/rum).
        connectSrc:  ["'self'", "wss:", "ws:", "https://cloudflareinsights.com"],
        // Font Awesome is self-hosted at /fontawesome (CSS + webfonts served
        // from the bundled Free package), so 'self' covers its fonts too.
        fontSrc:     ["'self'"],
        // Token custom content (the TIS `html` field) embeds third-party pages
        // by <iframe>, and the sandboxed srcdoc frame it renders in inherits THIS
        // policy, so a host allowlist here decides what a token page may show.
        // The old allowlist (self, YouTube, SoundCloud) refused every other host
        // with Chrome's "This content is blocked" panel, blanking community tokens
        //. Same shape as img-src and media-src: any https origin, nothing
        // else. The frame runs in an opaque origin with no allow-same-origin, so an
        // embedded page cannot reach the explorer's origin, storage or cookies.
        frameSrc:    ["'self'", "https:"],
        // Block all plugins (Flash, etc.)
        objectSrc:   ["'none'"],
        // Only force-upgrade subresources to HTTPS when TLS-fronted (see HTTPS_HARDENING).
        // null removes Helmet's default directive so http pages keep their http subresource
        // URLs (relative /icon/... and /images/... requests stay on the page's protocol).
        upgradeInsecureRequests: HTTPS_HARDENING ? [] : null,
    };
}

/**
 * Mount the header set and the body ceiling, in that order.
 *
 * @param {object} app the express app
 * @param {object} configInfo src/config.js, for its live env view
 * @param {function} XChainExplorer the explorer class (isPreflightPostRequest)
 */
function applySecurityHeaders(app, configInfo, XChainExplorer){
    const HTTPS_HARDENING = httpsHardening(configInfo.env);

    // Helmet sets the browser security headers; each directive below is tuned
    // for what the explorer's own pages need.
    app.use(helmet({
        // HSTS only applies to HTTPS; omit it on plain-HTTP deployments. Default keeps Helmet's HSTS.
        ...(HTTPS_HARDENING ? {} : { strictTransportSecurity: false }),
        contentSecurityPolicy: {
            directives: cspDirectives(HTTPS_HARDENING)
        },
    }));

    // Tight global body ceiling: nothing on this read-only API legitimately posts more.
    // The one exception is POST /{COIN}/api/preflight, which carries a whole composed
    // action (a 250-command BATCH is ~17,500 characters) and mounts its own parser with
    // its own ceiling at the route. Skipping it here rather than raising the global limit
    // keeps the large-body allowance scoped to the single route that needs it; the
    // predicate lives beside that route so the two cannot drift apart.
    const globalJson = express.json({ limit: '10kb' });
    app.use((req, res, next) => {
        if (XChainExplorer.isPreflightPostRequest(req)) return next();
        return globalJson(req, res, next);
    });
}

/**
 * Trust only the first proxy hop (prevents X-Forwarded-For spoofing).
 * The hop count and the topology it encodes live in src/http/trust_proxy.js,
 * which the WS path's WS_TRUST_PROXY_HOPS default must stay in step with.
 *
 * @param {object} app the express app
 */
function applyProxyTrust(app){
    applyTrustProxy(app);
}

module.exports = { applySecurityHeaders, applyProxyTrust };
