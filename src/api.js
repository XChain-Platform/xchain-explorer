/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Explorer - API
 * 
 * This file parses in environmental variables and starts up the explorer instance
 * 
 ********************************************************************/

// Load required libraries
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

// Parse in .env config data
dotenv.config();

//xchain-hub endpoints (multi-instance with fallback)
const xchainHubConnector = require('./XChainHubConnector');
const HUB_ENDPOINTS = xchainHubConnector.parseEndpoints();
const EXPLORER_API_PORT_HTTP = process.env.EXPLORER_API_PORT_HTTP
const EXPLORER_API_PORT_HTTPS = process.env.EXPLORER_API_PORT_HTTPS

// Setup the basic API functionality
async function startApi(){
    // Parse in the explorer config information
    let config = await configInfo.getConfig(HUB_ENDPOINTS);

    // Create the app
    const app = express();

    // Use Helmet to increase security
    app.use(helmet({
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
                // and icon data from ka-f.fontawesome.com via XHR/fetch
                connectSrc:  ["'self'", "wss:", "ws:", "https://ka-f.fontawesome.com", "https://ka-p.fontawesome.com", "https://kit.fontawesome.com"],
                // FontAwesome dynamically injects CSS from ka-p and kit subdomains
                styleSrc:    ["'self'", "'unsafe-inline'", "https://ka-p.fontawesome.com", "https://kit.fontawesome.com"],
                // FontAwesome kit loads web fonts from ka-f.fontawesome.com
                fontSrc:     ["'self'", "https://ka-f.fontawesome.com", "https://ka-p.fontawesome.com"],
                // Token descriptions can embed YouTube and SoundCloud players
                frameSrc:    ["'self'", "https://www.youtube.com", "https://w.soundcloud.com"],
                // Block all plugins (Flash, etc.)
                objectSrc:   ["'none'"],
            }
        },
    }));

    // Allow JSON requests (with explicit body size limit)
    app.use(express.json({ limit: '10kb' }));

    // Allow CORS from any origin (public read-only explorer)
    app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

    // Rate limiting — requests per minute per IP (image requests are excluded;
    // override the default with EXPLORER_RATE_LIMIT_RPM)
    app.use(rateLimit({
        windowMs:        60 * 1000,
        limit:           parseInt(process.env.EXPLORER_RATE_LIMIT_RPM, 10) || 500,
        standardHeaders: true,
        legacyHeaders:   false,
        skip: (req) => /\.(png|jpg|jpeg|gif|ico|svg|webp)$/i.test(req.path) || req.path.startsWith('/icon') || req.path.startsWith('/images'),
    }));

    // Trust only the first proxy hop (prevents X-Forwarded-For spoofing)
    app.set('trust proxy', 1);

    // Redirect HTTP to HTTPS
    // app.use((req, res, next) => {
    //  if(req.secure){
    //      // Request is already HTTPS, continue to the next middleware/route handler
    //      next();
    //  } else {
    //      // Remove HTTP port from host
    //      let hostname = String(req.headers.host).replace(':' + config.API.port.http, '');
    //      let url = 'https://' + hostname + ':' + config.API.port.https + req.url;
    //      res.redirect(url);
    //  }
    // });

    const jsonRpcController = {
        // Function to check if xchain-explorer is up
        async ping() {
            return { status: "success", slowRequests: XChainExplorer.getSlowRequests() };
        }
    }

    // HTTP server for redirection
    const httpServer = http.createServer(app);
    httpServer.listen(EXPLORER_API_PORT_HTTP, () => {
        console.log('HTTP  server listening on port', EXPLORER_API_PORT_HTTP);
    });

    // HTTPS server for serving out requests in a secure manner.
    // Skipped when SSL files are absent (HTTP-only dev/regtest mode).
    let httpsServer = null;
    if (config.API.ssl) {
        httpsServer = https.createServer(config.API.ssl, app);
        httpsServer.listen(EXPLORER_API_PORT_HTTPS, () => {
            console.log('HTTPS server listening on port', EXPLORER_API_PORT_HTTPS);
        });
    }

    // Start up the explorer instance
    const explorer = new XChainExplorer(app, configInfo);
    await explorer.init()

    // Schedule periodic refresh so new coin/network entries published by
    // the hub after startup get picked up without a container restart.
    // Started only after the explorer instance exists so the database's
    // config-changed listener is registered before the first sync tick can
    // fire — otherwise an early tick could rebuild config with no subscriber
    // listening and the connection pools would silently miss the update.
    // In standalone mode (NO_HUB=1) HUB_ENDPOINTS is null and config comes from
    // src/config.json, which doesn't change at runtime — so skip the periodic
    // hub refresh entirely rather than tick a disabled hub.
    if(HUB_ENDPOINTS) configInfo.startSync(HUB_ENDPOINTS);

    // Allow JSON-RPC requests (registered last so explorer routes take priority)
    app.use(jsonRouter({methods: jsonRpcController}))

    // WebSocket support (feature-flagged via WS_ENABLED env var)
    const WS_ENABLED = process.env.WS_ENABLED !== 'false';
    if (WS_ENABLED) {
        const WS_POLL_INTERVAL = parseInt(process.env.WS_POLL_INTERVAL) || 5000;
        const WS_PING_INTERVAL = parseInt(process.env.WS_PING_INTERVAL) || 30000;
        const WS_IDLE_TIMEOUT  = parseInt(process.env.WS_IDLE_TIMEOUT)  || 300000;
        const WS_MAX_PER_IP    = parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP) || 5;
        const WS_MAX_BACKPRESSURE = parseInt(process.env.WS_MAX_BACKPRESSURE) || 65536;

        // Create the WebSocket server first (ChannelManager lives inside it)
        const WS_MAX_SUBS = parseInt(process.env.WS_MAX_SUBSCRIPTIONS) || 25;
        const wsServer = new WebSocketServer({
            explorer:         explorer,
            broadcaster:      null, // set below
            pingInterval:     WS_PING_INTERVAL,
            idleTimeout:      WS_IDLE_TIMEOUT,
            maxPerIp:         WS_MAX_PER_IP,
            maxSubscriptions: WS_MAX_SUBS
        });

        // Create the change detector with reference to the channel manager
        const changeDetector = new ChangeDetector({
            db:             explorer.db,
            channelManager: wsServer.channelManager,
            pollInterval:   WS_POLL_INTERVAL
        });

        // Create the broadcaster and link to WS server + change detector
        const broadcaster = new Broadcaster({
            wsServer:        wsServer,
            changeDetector:  changeDetector,
            maxBackpressure: WS_MAX_BACKPRESSURE
        });
        wsServer.broadcaster = broadcaster;

        // Attach WebSocket upgrade handler to HTTP (and HTTPS when running)
        wsServer.attach(httpsServer ? [httpServer, httpsServer] : [httpServer]);

        // Determine which coins have configured database pools and start polling
        const availableCoins = Object.keys(explorer.db.pools || {});
        if (availableCoins.length > 0) {
            changeDetector.start(availableCoins);
        }
    }
}

// Start up the explorer services
startApi().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
