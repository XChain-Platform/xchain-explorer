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
const express        = require('express');
const XChainExplorer = require('./XChainExplorer.js');
const configInfo     = require('./config.js');
const vmQuery         = require('./contract/vm_query.js');
const staticMounts    = require('./http/static_mounts.js');     // the one file-serving mount list, shared with XChainExplorer
const { createShutdown, createExplorerDrain } = require('./http/shutdown.js');
const { getLogger } = require('./observability');
const coins           = require('./coins');
const { buildFederationRpc } = require('./federation');         // the five keyed federation reads validators without a DOGE indexer use

// The boot steps startApi() runs, in mount order. Each one takes the app plus
// whatever it needs from this entry, so no step requires a module the api
// suites stub here, and the order the service comes up in stays readable in
// startApi() itself.
const { applySecurityHeaders, applyProxyTrust } = require('./http/api_boot/security_headers.js');
const { applyCors }          = require('./http/api_boot/cors.js');
const { applyRateLimits }    = require('./http/api_boot/rate_limits.js');
const { applyObservability } = require('./http/api_boot/observability.js');
const { startTlsListener }   = require('./http/api_boot/tls.js');
const { mountJsonRpc }       = require('./http/api_boot/json_rpc.js');
const { startWebsockets }    = require('./http/api_boot/websocket.js');

// Read the .env file before anything below reads an environment variable.
dotenv.config();

// Before anything else logs. installObservability does not run until
// ~150 lines further down, inside startApi(), and this covers every line
// between here and there (config-fetch failures, the consensus-pin check).
const { patchConsole } = require('./observability');
patchConsole({
    service: 'xchain-explorer',
    version: require('../package.json').version,
    network: configInfo.env.NETWORK || ''
});
// Resolves to the shipper once installObservability runs in startApi(), and to
// bare console before that.
const log = getLogger();

//xchain-hub endpoints (multi-instance with fallback)
const xchainHubConnector = require('./connectors/hub');
const HUB_ENDPOINTS = xchainHubConnector.parseEndpoints();
const EXPLORER_API_PORT_HTTP  = configInfo.env.EXPLORER_API_PORT_HTTP  || 8080;
const EXPLORER_API_PORT_HTTPS = configInfo.env.EXPLORER_API_PORT_HTTPS || 8081;

// Public reads used by token.html's bridge panels. They are mounted by api.js,
// before XChainExplorer installs its wildcard page route, because one read is a
// hub RPC and the other comes from the co-located hub-mirror schema rather than
// the explorer's ordinary API-method table.
function createBridgePanelHandlers(getExplorer, hubConnector){
    const error = (res, status, message, code) =>
        res.status(status).json({ error: message, code });

    const nativeTickFor = (tick, chain) => {
        const dot = tick.indexOf('.');
        const root = dot > 0 ? tick.slice(0, dot).toUpperCase() : '';
        return coins.ALLOWED_COINS.includes(root) && root !== String(chain || '').toUpperCase()
            ? tick.slice(dot + 1) : tick;
    };

    const tickParam = (req, res) => {
        const tick = String((req.params && req.params.tick) || '').trim();
        if(!tick || tick.length > 250 || /[\x00-\x1f\x7f]/.test(tick)){
            error(res, 400, 'Invalid token tick.', 'INVALID_TICK');
            return null;
        }
        return tick;
    };

    return {
        invariant: bridgeInvariantHandler(hubConnector, tickParam, error, nativeTickFor),
        transfers: bridgeTransfersHandler(getExplorer, tickParam, error, nativeTickFor)
    };
}

function bridgeInvariantHandler(hubConnector, tickParam, error, nativeTickFor){
    return async function invariant(req, res){
            const tick = tickParam(req, res);
            if(tick === null) return;
            if(!hubConnector)
                return error(res, 503, 'Bridge invariant is unavailable.', 'BRIDGE_INVARIANT_UNAVAILABLE');
            const routeCoin = String((req.params && req.params.coin) || '').toUpperCase();
            const chain = coins.ALLOWED_COINS.find(coin => routeCoin.endsWith(coin)) || routeCoin;
            const nativeTick = nativeTickFor(tick, chain);
            try {
                const result = await hubConnector.call({
                    jsonrpc: '2.0', method: 'getbridgeinvariant', params: { tick: nativeTick }, id: 1
                }, { attempts: 1 });
                if(result === null || result === undefined)
                    return error(res, 503, 'Bridge invariant is unavailable.', 'BRIDGE_INVARIANT_UNAVAILABLE');
                // The renderer indexes the response by the displayed tick. Hub
                // records use the native spelling, while a destination token page
                // uses ORIGIN.TICK, so rename that one key at the HTTP boundary.
                if(nativeTick !== tick && result && typeof result === 'object' &&
                   Object.prototype.hasOwnProperty.call(result, nativeTick))
                    return res.json({ [tick]: result[nativeTick] });
                return res.json(result);
            } catch(err){
                log.warn('BRIDGE_INVARIANT_READ_FAILED', { err: err && err.message ? err.message : err });
                return error(res, 503, 'Bridge invariant is unavailable.', 'BRIDGE_INVARIANT_UNAVAILABLE');
            }
    };
}

function bridgeTransfersHandler(getExplorer, tickParam, error, nativeTickFor){
    return async function transfers(req, res){
            const tick = tickParam(req, res);
            if(tick === null) return;
            const coin = String((req.params && req.params.coin) || '').toUpperCase();
            const explorer = getExplorer();
            const db = explorer && explorer.db;
            const source = db && db.checkpointDb && db.checkpointDb[coin];
            if(!db || typeof db.getBridgeTransfers !== 'function' || !source ||
               !/^[A-Za-z0-9_$]+$/.test(String(source.name || '')))
                return error(res, 503, 'Bridge transfers are unavailable.', 'BRIDGE_TRANSFERS_UNAVAILABLE');

            // General-token rows store the native tick in the mirror. A bridged
            // copy is displayed as ORIGIN.TICK, so remove a known foreign-chain
            // root before binding the value. Native subassets retain their dot.
            const nativeTick = nativeTickFor(tick, source.chain);

            try {
                const rows = await db.getBridgeTransfers({ coin, schema: source.name, network: source.network,
                    tick: nativeTick, chain: source.chain, limit: 100 });
                return res.json(Array.isArray(rows) ? rows : []);
            } catch(err){
                log.warn('BRIDGE_TRANSFERS_READ_FAILED', { coin, err: err && err.message ? err.message : err });
                return error(res, 503, 'Bridge transfers are unavailable.', 'BRIDGE_TRANSFERS_UNAVAILABLE');
            }
    };
}

function mountBridgePanelRoutes(app, getExplorer, hubConnector){
    const handlers = createBridgePanelHandlers(getExplorer, hubConnector);
    app.get('/:coin/api/bridge-invariant/:tick', (req, res) => handlers.invariant(req, res));
    app.get('/:coin/api/bridge-transfers/:tick', (req, res) => handlers.transfers(req, res));
}

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

// Static assets (icons, images) are served from disk, cost no DB work, and
// every page pulls a burst of them at once, so they are exempt from both
// the per-IP rate limit and the global concurrency gate in api_boot/rate_limits.js.
// Counting them would shed real queries to make room for favicons.
//
// Exempt by FIRST PATH SEGMENT, from the one mount list in
// src/http/static_mounts.js, never by file extension: a suffix is a claim about
// what a URL looks like, not about what serves it. Match on it and
// /BTC/api/search/needle.png reads as an image, skips both guards, and
// still routes to the catch-all API handler, so any suffixed path buys
// unlimited DB-backed search.
const isStaticAsset = staticMounts.isStaticAsset;

// The method map the JSON-RPC dispatcher serves. Built on this entry rather than
// in the boot step that mounts it because ping probes the DB pool the entry
// owns. The explorer arrives as a getter: it does not exist yet when startApi()
// builds the controller, and the closure must see the instance assigned later.
function createJsonRpcController(getExplorer, requestGate){
    const DB_PROBE_TIMEOUT_MS = 2000;

    return {
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
                const explorer = getExplorer();
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
                    db.pingPool({ coin, data: {} }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), DB_PROBE_TIMEOUT_MS))
                ]);
                return { status: 'success', db: true, ...base };
            } catch(err) {
                res.status(503);
                return { status: 'degraded', db: false, ...base };
            }
        },

        // getrollcallsigners, getanchoraction, getanchorconfirmations, getarchiveanchor and
        // getpricebatches, served off the routed coin's replica, public like every other
        // route and bounded by the same per-IP rate limit.
        ...buildFederationRpc(getExplorer, configInfo)
    }
}

// The plain HTTP listener, the primary serving socket; HTTPS is optional.
function startHttpListener(app){
    const httpServer = http.createServer(app);
    // A listen() that fails (EADDRINUSE when a second instance grabs the port, EACCES
    // on a privileged port) surfaces as an async 'error' event, not a throw, so a
    // try/catch can't catch it; without a handler Node crashes with an unhandled-error
    // stack dump. The HTTP server is the primary serving socket: log one clear line and
    // exit non-zero so the supervisor (systemd) reports and restarts cleanly.
    httpServer.on('error', (err) => {
        log.error('HTTP_LISTEN_FAILED', { port: EXPLORER_API_PORT_HTTP, code: err.code, err: err.message });
        process.exit(1);
    });
    httpServer.listen(EXPLORER_API_PORT_HTTP, () => {
        log.info('HTTP_SERVER_LISTENING', { port: EXPLORER_API_PORT_HTTP });
    });
    // Published as soon as it exists, not at the end of startApi(): a SIGTERM
    // arriving mid-boot must still be able to close a listener already bound.
    runtime.httpServer = httpServer;
    return httpServer;
}

function createApp(options = {}){
    const appConfigInfo = options.configInfo || configInfo;
    const hubEndpoints = Object.prototype.hasOwnProperty.call(options, 'hubEndpoints')
        ? options.hubEndpoints : HUB_ENDPOINTS;
    const app = options.app || express();

    applySecurityHeaders(app, appConfigInfo, XChainExplorer);
    applyCors(app, appConfigInfo);
    const requestGate = applyRateLimits(app, appConfigInfo, isStaticAsset);
    applyObservability(app, appConfigInfo);
    applyProxyTrust(app);

    let explorer = null;
    const jsonRpcController = createJsonRpcController(() => explorer, requestGate);
    mountBridgePanelRoutes(app, () => explorer,
        hubEndpoints ? new xchainHubConnector(hubEndpoints) : null);

    explorer = new XChainExplorer(app, appConfigInfo);
    mountJsonRpc(app, appConfigInfo, jsonRpcController);

    return { app, explorer };
}

// Brings the whole service up in order: consensus pin, config, guards, routes,
// listeners, then the live feed.
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

    // The explorer config, fetched from the hub when endpoints are configured.
    let config = await configInfo.getConfig(HUB_ENDPOINTS);

    const app = express();
    const built = createApp({ app, configInfo, hubEndpoints: HUB_ENDPOINTS });
    const explorer = built.explorer;

    const httpServer = startHttpListener(app);
    // Secondary and optional. Both the drain and the WS upgrade below read
    // runtime.httpsServer, which a bind failure clears, so neither ever holds a
    // listener that never bound.
    startTlsListener(app, config, runtime, EXPLORER_API_PORT_HTTPS, log);

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

    startWebsockets({ configInfo: configInfo, explorer: explorer, httpServer: httpServer,
                      httpsServer: runtime.httpsServer, runtime: runtime });
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
    log.error('UNHANDLED_REJECTION', { detail: 'process kept alive', err: reason && reason.message ? reason.message : reason, stack: reason && reason.stack });
});

// Say at boot that contract simulation is refusing, not only under the first
// request. Setting EXPLORER_VM_QUERY_ENABLED is an operator turning
// the endpoint on; if the vendored VM drifted, vm-query's gate keeps it closed,
// and the boot log is where that disagreement is cheapest to notice. Silent when
// the flag is off: a stale VM nothing loads is not an operational fault.
if(vmQuery.isEnabled()){
    const vmFault = vmQuery.consensusFault();
    if(vmFault)
        log.error('VM_QUERY_REFUSING', {
            fault: vmFault,
            detail: 'EXPLORER_VM_QUERY_ENABLED is set but contract simulation is refusing; check the deployed VM with ' +
                'bin/check-explorer-vm-drift.sh, refresh it, then restart'
        });
}

// Graceful shutdown. node is PID 1 in the image, so `docker stop` delivers
// SIGTERM here. This replaces a handler that tore down the VM worker and then
// called process.exit(0) immediately: that dropped every in-flight HTTP request
// and cut every WebSocket mid-frame, and it never closed the MariaDB pools. It
// also never ran in production, because npm was PID 1 and swallowed the signal,
// so it read as drain coverage while providing none.
//
// The drain is bounded by its own hard-exit timer (src/http/shutdown.js): installing
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

module.exports = { createApp, createBridgePanelHandlers, mountBridgePanelRoutes };

if(!require.main || require.main === module || module.parent === require.main){
    startApi().catch(err => {
        log.error('FATAL_STARTUP_ERROR', { err: err && err.message ? err.message : err, stack: err && err.stack });
        process.exit(1);
    });
}
