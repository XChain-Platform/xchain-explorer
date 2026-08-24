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
const concurrencyGate = require('./concurrencyGate.js');
const { createShutdown, createExplorerDrain } = require('./shutdown.js');
const { installObservability } = require('./observability');   // default-off /metrics + structured log shim
const coins           = require('./coins');

dotenv.config();

//xchain-hub endpoints (multi-instance with fallback)
const xchainHubConnector = require('./XChainHubConnector');
const HUB_ENDPOINTS = xchainHubConnector.parseEndpoints();
const EXPLORER_API_PORT_HTTP  = process.env.EXPLORER_API_PORT_HTTP  || 8080;
const EXPLORER_API_PORT_HTTPS = process.env.EXPLORER_API_PORT_HTTPS || 8081;

// Everything the shutdown drain has to take down, published from startApi() as it
// is built. Module scope because the signal handler is registered at load, before
// startApi() has run: a SIGTERM that lands during startup finds the pieces that
// exist so far and skips the rest, which is the correct partial-boot behaviour.
const runtime = {
    httpServer:     null,
    httpsServer:    null,
    wsServer:       null,
    changeDetector: null,
    explorer:       null
};

async function startApi(){
    // Verify the bundled coin files against CONSENSUS_CONFIG_PIN before the hub
    // config fetch, the DB pool, the proof server or any route exists. The
    // explorer answers proof-liveness questions and serves burn/gas/protocol
    // addresses straight out of this pinned consensus subset, so a bundle that
    // drifted on THIS host must halt rather than answer from a registry nobody
    // verified. CI hashes the checkout, never the running artifact. All networks
    // (the XChainHub.start form) because the explorer bundles and serves all
    // three. A null pin (mainnet, pre-arm) skips; a mismatch throws, uncaught.
    for(const net of coins.NETWORKS) coins.verifyConsensusPin(net);

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
                // cloudflareinsights.com receives the RUM beacon's measurement POSTs
                // (older beacon builds post cross-origin instead of to /cdn-cgi/rum).
                connectSrc:  ["'self'", "wss:", "ws:", "https://cloudflareinsights.com"],
                // Font Awesome is self-hosted at /fontawesome (CSS + webfonts served
                // from the bundled Free package), so 'self' covers its fonts too.
                fontSrc:     ["'self'"],
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

    // Public read API: cross-origin GETs are the norm (docs examples, wallets,
    // third-party dashboards), so with nothing configured every origin is
    // admitted. Deployments that need to fence the API set EXPLORER_CORS_ORIGIN
    // to a comma-separated allowlist of exact origins.
    const corsAllowlist = String(process.env.EXPLORER_CORS_ORIGIN || '')
        .split(',').map(s => s.trim()).filter(s => s.length && s !== '*');
    app.use(cors({
        // Callback form rather than a static wildcard: an allowlisted deployment
        // reflects only listed origins, an open one reflects the caller's origin,
        // and requests without an Origin header (curl, same-origin) always pass.
        origin: (origin, cb) => {
            if (!origin || corsAllowlist.length === 0 || corsAllowlist.includes(origin)) return cb(null, true);
            return cb(null, false);
        },
        methods: ['GET', 'POST'],
    }));

    // Static assets (icons, images) are served from disk, cost no DB work, and
    // every page pulls a burst of them at once, so they are exempt from both
    // the per-IP rate limit and the global concurrency gate below. Counting
    // them would shed real queries to make room for favicons.
    const isStaticAsset = (req) =>
        /\.(png|jpg|jpeg|gif|ico|svg|webp)$/i.test(req.path) ||
        req.path.startsWith('/icon') ||
        req.path.startsWith('/images');

    // Rate limiting: requests per minute per IP (image requests are excluded;
    // override the default with EXPLORER_RATE_LIMIT_RPM)
    app.use(rateLimit({
        windowMs:        60 * 1000,
        limit:           parseInt(process.env.EXPLORER_RATE_LIMIT_RPM, 10) || 500,
        standardHeaders: true,
        legacyHeaders:   false,
        message:         { error: 'Too many requests', code: 'RATE_LIMITED' },
        skip: isStaticAsset,
    }));

    // Global in-flight concurrency cap. The limiter above is per-IP,
    // so a stampede spread across thousands of distinct IPs never trips it and
    // can still pin every MariaDB pool connection. This caps how many requests
    // are being served at any instant across ALL callers and sheds the excess
    // with an immediate 429 rather than queueing it. Override with
    // EXPLORER_MAX_CONCURRENT_REQUESTS; 0 disables the cap.
    const requestGate = concurrencyGate.createConcurrencyGate({
        limit:      concurrencyGate.resolveLimit(process.env.EXPLORER_MAX_CONCURRENT_REQUESTS, 200),
        retryAfter: 1,
        skip:       isStaticAsset,
        body:       { error: 'Server busy, retry shortly', code: 'SERVER_BUSY' }
    });
    app.use(requestGate);

    // Prometheus /metrics plus a structured log shim, both DEFAULT OFF: nothing
    // registers or starts a timer unless METRICS_ENABLED (and, for log shipping,
    // LOG_SHIP_ENABLED + LOG_SHIP_URL) is set. Wired after the rate limiter and
    // concurrency gate so an enabled scrape endpoint sheds like any other route;
    // gate it with METRICS_TOKEN or a proxy ACL on a public box. See
    // src/observability/README.md.
    let explorerVersion = '';
    try { explorerVersion = require('../package.json').version; } catch { /* version label is cosmetic */ }
    installObservability(app, {
        service: 'xchain-explorer',
        version: explorerVersion,
        network: process.env.NETWORK || ''
    });

    // Trust only the first proxy hop (prevents X-Forwarded-For spoofing)
    app.set('trust proxy', 1);

    // Declared here so the ping closure can reference it after explorer is created.
    let explorer = null;

    const DB_PROBE_TIMEOUT_MS = 2000;

    const jsonRpcController = {
        // Checks that the explorer is up and can reach at least one DB pool.
        // Returns status:"degraded" + 503 when all pool probes time out or fail.
        async ping(params, {res}) {
            // request_gate exposes the global concurrency cap plus how many
            // requests it has shed; a climbing shed count is the only
            // outward sign that a distinct-IP stampede is being refused.
            const base = {
                slowRequests: XChainExplorer.getSlowRequests(),
                ...XChainExplorer.getLatencyStats(),
                request_gate: requestGate.getStats()
            };
            // Try a SELECT 1 against the first available DB pool. This catches the
            // case where the process is up but MariaDB is unreachable.
            try {
                const db    = explorer && explorer.db;
                const pools = db && db.pools ? db.pools : {};
                const coin  = Object.keys(pools)[0];
                // No pool at all is unhealthy, not a check to skip. The HTTP server
                // listens before explorer.init() finishes populating pools, and a cold
                // container that cannot reach the hub for its config never populates
                // them, so falling through to success previously reported a node that
                // can serve nothing as healthy. The WebSocket start below already
                // treats an empty pool set as "do not serve"; the probe now agrees.
                if(!coin){
                    res.status(503);
                    return { status: 'degraded', db: false, ...base };
                }
                await Promise.race([
                    db.doQuery({ coin, data: {} }, 'SELECT 1', []),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_PROBE_TIMEOUT_MS))
                ]);
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
    // Published as soon as it exists, not at the end of startApi(): a SIGTERM
    // arriving mid-boot must still be able to close a listener already bound.
    runtime.httpServer = httpServer;

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
            // Cleared here too: a listener that never bound must not be handed to
            // the drain, which would wait on a close() callback that never fires.
            runtime.httpsServer = null;
        });
        httpsServer.listen(EXPLORER_API_PORT_HTTPS, () => {
            console.log('HTTPS server listening on port', EXPLORER_API_PORT_HTTPS);
        });
        runtime.httpsServer = httpsServer;
    }

    explorer = new XChainExplorer(app, configInfo);
    // Published before init(): init() is what builds the pools, and a signal landing
    // partway through it must still reach db.close() for whatever was built so far.
    runtime.explorer = explorer;
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

        // Handed to the drain so subscribers get a clean 1001 close and the live-feed
        // poll timer stops, instead of both dying with the process.
        runtime.wsServer       = wsServer;
        runtime.changeDetector = changeDetector;
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

// Say at boot that contract simulation is refusing, not only under the first
// request. Setting EXPLORER_VM_QUERY_ENABLED is an operator turning
// the endpoint on; if the vendored VM drifted, vm-query's gate keeps it closed,
// and the boot log is where that disagreement is cheapest to notice. Silent when
// the flag is off: a stale VM nothing loads is not an operational fault.
if(vmQuery.isEnabled()){
    const vmFault = vmQuery.consensusFault();
    if(vmFault)
        console.error('EXPLORER_VM_QUERY_ENABLED is set but contract simulation is REFUSING: ' + vmFault +
            '. Check the deployed VM with bin/check-explorer-vm-drift.sh, refresh it, then restart.');
}

// Graceful shutdown. node is PID 1 in the image, so `docker stop` delivers
// SIGTERM here. This replaces a handler that tore down the VM worker and then
// called process.exit(0) immediately: that dropped every in-flight HTTP request
// and cut every WebSocket mid-frame, and it never closed the MariaDB pools. It
// also never ran in production, because npm was PID 1 and swallowed the signal,
// so it read as drain coverage while providing none.
//
// The drain is bounded by its own hard-exit timer (src/shutdown.js): installing
// a handler removes node's default terminate, so a drain that hangs must still
// end the process rather than linger until the supervisor's SIGKILL.
// `runtime` is passed by reference and read when the drain RUNS, never captured
// here: startApi() fills it in as each piece comes up, and this handler is
// registered before any of them exist.
runtime.configInfo = configInfo;
runtime.vmQuery    = vmQuery;
const shutdown = createShutdown({ drain: createExplorerDrain(runtime) });
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => shutdown(sig));
}

startApi().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
