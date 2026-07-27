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
 * XChain Explorer - API
 * 
 * This file parses in environmental variables and starts up the explorer instance
 * 
 ********************************************************************/

const dotenv         = require('dotenv');
const http           = require('http');
const https          = require('https');
const express        = require('express');
const helmet         = require('helmet');
const cors           = require('cors');
const rateLimit      = require('express-rate-limit');
const XChainExplorer = require('./XChainExplorer.js');
const configInfo     = require('./config.js');
const jsonRouter     = require('express-json-rpc-router')
const WebSocketServer = require('./ws/WebSocketServer.js');
const ChangeDetector  = require('./ws/ChangeDetector.js');
const Broadcaster     = require('./ws/Broadcaster.js');
const vmQuery         = require('./vm-query.js');
const fontawesomeKit  = require('./fontawesome-kit.js');

dotenv.config();

//xchain-hub endpoints (multi-instance with fallback)
const xchainHubConnector = require('./XChainHubConnector');
const HUB_ENDPOINTS = xchainHubConnector.parseEndpoints();
const EXPLORER_API_PORT_HTTP  = process.env.EXPLORER_API_PORT_HTTP  || 8080;
const EXPLORER_API_PORT_HTTPS = process.env.EXPLORER_API_PORT_HTTPS || 8081;

// Font Awesome origins are added to the CSP only when a kit is actually
// configured for this deployment; see src/fontawesome-kit.js .
const FA_KIT_ENABLED = fontawesomeKit.buildKitConfig(process.env) !== null;
const FA_CONNECT_SRC = FA_KIT_ENABLED ? ["https://ka-f.fontawesome.com", "https://ka-p.fontawesome.com", "https://kit.fontawesome.com"] : [];
const FA_STYLE_SRC   = FA_KIT_ENABLED ? ["https://ka-p.fontawesome.com", "https://kit.fontawesome.com"] : [];
const FA_FONT_SRC    = FA_KIT_ENABLED ? ["https://ka-f.fontawesome.com", "https://ka-p.fontawesome.com"] : [];

async function startApi(){
    let config = await configInfo.getConfig(HUB_ENDPOINTS);

    const app = express();

    // HTTPS-only hardening: upgrade-insecure-requests + HSTS. These MUST NOT be sent when the
    // explorer is reached over plain HTTP (local dev / regtest), or the browser rewrites every
    // same-origin subresource (icons, assets) to https://<host>:<http-port>, which only speaks
    // HTTP -> SSL protocol error -> broken images. Enable only when TLS-fronted: prod runs
    // NODE_ENV=production behind Apache TLS. EXPLORER_FORCE_HTTPS=1/0 overrides explicitly.
    const HTTPS_HARDENING = (process.env.EXPLORER_FORCE_HTTPS != null)
        ? ['1','true','yes','on'].includes(String(process.env.EXPLORER_FORCE_HTTPS).toLowerCase())
        : (process.env.NODE_ENV === 'production');

    app.use(helmet({
        // HSTS only applies to HTTPS; omit it on plain-HTTP deployments. Default keeps Helmet's HSTS.
        ...(HTTPS_HARDENING ? {} : { strictTransportSecurity: false }),
        contentSecurityPolicy: {
            directives: {
                // Default: only allow resources from self
                defaultSrc:  ["'self'"],
                // Inline scripts are required for per-page $(document).ready() blocks in HTML templates
                scriptSrc:     ["'self'", "'unsafe-inline'"],
                // Helmet sets script-src-attr: 'none' by default; override to allow inline event handlers required by jQuery
                scriptSrcAttr: ["'unsafe-inline'"],
                // Inline styles are required for Bootstrap components and HTML attribute styles
                styleSrc:    ["'self'", "'unsafe-inline'"],
                // data: URIs are required for QR code generation; https: allows external images in token descriptions
                imgSrc:      ["'self'", "data:", "https:"],
                // FontAwesome kit fetches CSS from ka-p.fontawesome.com and kit.fontawesome.com,
                // and icon data from ka-f.fontawesome.com via XHR/fetch. The kit is only loaded
                // when this deployment supplies a kit token , so a deployment running
                // without one never has to allow those origins at all.
                connectSrc:  ["'self'", "wss:", "ws:", ...FA_CONNECT_SRC],
                // FontAwesome dynamically injects CSS from ka-p and kit subdomains
                styleSrc:    ["'self'", "'unsafe-inline'", ...FA_STYLE_SRC],
                // FontAwesome kit loads web fonts from ka-f.fontawesome.com
                fontSrc:     ["'self'", ...FA_FONT_SRC],
                // Token descriptions can embed YouTube and SoundCloud players
                frameSrc:    ["'self'", "https://www.youtube.com", "https://w.soundcloud.com"],
                // Block all plugins (Flash, etc.)
                objectSrc:   ["'none'"],
                // Only force-upgrade subresources to HTTPS when TLS-fronted (see HTTPS_HARDENING).
                // null removes Helmet's default directive so http pages keep their http subresource
                // URLs (relative /icon/... and /images/... requests stay on the page's protocol).
                upgradeInsecureRequests: HTTPS_HARDENING ? [] : null,
            }
        },
    }));

    app.use(express.json({ limit: '10kb' }));

    app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

    // Rate limiting: requests per minute per IP (image requests are excluded;
    // override the default with EXPLORER_RATE_LIMIT_RPM)
    app.use(rateLimit({
        windowMs:        60 * 1000,
        limit:           parseInt(process.env.EXPLORER_RATE_LIMIT_RPM, 10) || 500,
        standardHeaders: true,
        legacyHeaders:   false,
        message:         { error: 'Too many requests', code: 'RATE_LIMITED' },
        skip: (req) => /\.(png|jpg|jpeg|gif|ico|svg|webp)$/i.test(req.path) || req.path.startsWith('/icon') || req.path.startsWith('/images'),
    }));

    // Trust only the first proxy hop (prevents X-Forwarded-For spoofing)
    app.set('trust proxy', 1);

    // Declared here so the ping closure can reference it after explorer is created.
    let explorer = null;

    const DB_PROBE_TIMEOUT_MS = 2000;

    const jsonRpcController = {
        // Checks that the explorer is up and can reach at least one DB pool.
        // Returns status:"degraded" + 503 when all pool probes time out or fail.
        async ping(params, {res}) {
            const base = { slowRequests: XChainExplorer.getSlowRequests(), ...XChainExplorer.getLatencyStats() };
            // Try a SELECT 1 against the first available DB pool. This catches the
            // case where the process is up but MariaDB is unreachable.
            try {
                const db    = explorer && explorer.db;
                const pools = db && db.pools ? db.pools : {};
                const coin  = Object.keys(pools)[0];
                if(coin){
                    await Promise.race([
                        db.doQuery({ coin, data: {} }, 'SELECT 1', []),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_PROBE_TIMEOUT_MS))
                    ]);
                }
                return { status: 'success', db: true, ...base };
            } catch(err) {
                res.status(503);
                return { status: 'degraded', db: false, ...base };
            }
        }
    }

    const httpServer = http.createServer(app);
    // A listen() that fails (EADDRINUSE when a second instance grabs the port, EACCES
    // on a privileged port) surfaces as an async 'error' event, not a throw, so a
    // try/catch can't catch it; without a handler Node crashes with an unhandled-error
    // stack dump. The HTTP server is the primary serving socket: log one clear line and
    // exit non-zero so the supervisor (systemd) reports and restarts cleanly.
    httpServer.on('error', (err) => {
        console.error('HTTP server failed to listen on port ' + EXPLORER_API_PORT_HTTP + ': ' + err.code + ' (' + err.message + ')');
        process.exit(1);
    });
    httpServer.listen(EXPLORER_API_PORT_HTTP, () => {
        console.log('HTTP  server listening on port', EXPLORER_API_PORT_HTTP);
    });

    // Skipped when SSL files are absent (HTTP-only dev/regtest mode).
    let httpsServer = null;
    if (config.API.ssl) {
        httpsServer = https.createServer(config.API.ssl, app);
        // The HTTPS listener is secondary (prod fronts TLS at Apache and ships no SSL
        // files, so this path is dev/regtest only). A bind failure here must not take the
        // process down: log a warning and keep serving over HTTP. Same async-'error'
        // caveat as above, so attach the handler before listen().
        httpsServer.on('error', (err) => {
            console.warn('HTTPS server failed to listen on port ' + EXPLORER_API_PORT_HTTPS + ': ' + err.code + ' (' + err.message + '); continuing HTTP-only');
            httpsServer = null;
        });
        httpsServer.listen(EXPLORER_API_PORT_HTTPS, () => {
            console.log('HTTPS server listening on port', EXPLORER_API_PORT_HTTPS);
        });
    }

    explorer = new XChainExplorer(app, configInfo);
    await explorer.init()

    // Schedule periodic refresh so new coin/network entries published by
    // the hub after startup get picked up without a container restart.
    // Started only after the explorer instance exists so the database's
    // config-changed listener is registered before the first sync tick can
    // fire; otherwise an early tick could rebuild config with no subscriber
    // listening and the connection pools would silently miss the update.
    // In standalone mode (NO_HUB=1) HUB_ENDPOINTS is null and config comes from
    // src/config.json, which doesn't change at runtime, so skip the periodic
    // hub refresh entirely rather than tick a disabled hub.
    if(HUB_ENDPOINTS) configInfo.startSync(HUB_ENDPOINTS);

    // Registered last so explorer routes take priority.
    // Express 5 / body-parser 2.x leaves req.body undefined when a request carries
    // no JSON body (a GET, or a POST without application/json), whereas body-parser
    // 1.x set it to {}. express-json-rpc-router requires req.body to be an object or
    // it throws ("req.body is required"). Restore the {} default so unmatched requests
    // that fall through to this root-mounted router get a normal JSON-RPC error
    // response instead of crashing the request.
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
    app.use(jsonRouter({methods: jsonRpcController}))

    // WebSocket support (feature-flagged via WS_ENABLED env var)
    const WS_ENABLED = process.env.WS_ENABLED !== 'false';
    if (WS_ENABLED) {
        const WS_POLL_INTERVAL = parseInt(process.env.WS_POLL_INTERVAL) || 5000;
        const WS_PING_INTERVAL = parseInt(process.env.WS_PING_INTERVAL) || 30000;
        const WS_IDLE_TIMEOUT  = parseInt(process.env.WS_IDLE_TIMEOUT)  || 300000;
        const WS_MAX_PER_IP    = parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP) || 5;
        const WS_MAX_BACKPRESSURE = parseInt(process.env.WS_MAX_BACKPRESSURE) || 65536;

        const WS_MAX_SUBS = parseInt(process.env.WS_MAX_SUBSCRIPTIONS) || 25;
        const wsServer = new WebSocketServer({
            explorer:         explorer,
            broadcaster:      null, // set below
            pingInterval:     WS_PING_INTERVAL,
            idleTimeout:      WS_IDLE_TIMEOUT,
            maxPerIp:         WS_MAX_PER_IP,
            maxSubscriptions: WS_MAX_SUBS,
            // Mirror the HTTP side's `trust proxy: 1` (line ~108) so the WS per-IP cap
            // keys on the real client address, not a spoofable X-Forwarded-For token.
            // The upgrade is handled on the raw HTTP server, where Express trust-proxy
            // does not apply, so the hop count must be passed through explicitly.
            trustProxyHops:   parseInt(process.env.WS_TRUST_PROXY_HOPS, 10) || 1
        });

        const changeDetector = new ChangeDetector({
            db:             explorer.db,
            channelManager: wsServer.channelManager,
            pollInterval:   WS_POLL_INTERVAL
        });

        const broadcaster = new Broadcaster({
            wsServer:        wsServer,
            changeDetector:  changeDetector,
            maxBackpressure: WS_MAX_BACKPRESSURE
        });
        wsServer.broadcaster = broadcaster;

        wsServer.attach(httpsServer ? [httpServer, httpsServer] : [httpServer]);

        const availableCoins = Object.keys(explorer.db.pools || {});
        if (availableCoins.length > 0) {
            changeDetector.start(availableCoins);
        }
    }
}

// Last-resort backstop against a single request killing the whole process.
// The route handlers are fire-and-forget (`(req,res) => this.processX(...)`), so a
// throw in an async handler outside its own try/catch surfaces here as an unhandled
// rejection; under Node's default (--unhandled-rejections=throw) that terminates the
// process, i.e. an unauthenticated crash-loop DoS. The catch-all route already
// degrades its own rejections to a 500; this covers every other handler. The explorer
// is read-only and holds no per-request shared mutable state, so logging and staying
// alive is the correct availability posture (the error is still logged for triage).
process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED_REJECTION (process kept alive):', (reason && reason.stack) ? reason.stack : reason);
});

// Tear down the contract-simulation VM's subprocess worker before exit
// (vm-query.js; no-op when the feature is off or never used). The worker also
// exits on IPC disconnect, so this is belt-and-suspenders.
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
        vmQuery.shutdown().finally(() => process.exit(0));
    });
}

startApi().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
