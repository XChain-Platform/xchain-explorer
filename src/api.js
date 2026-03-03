/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
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

// Parse in .env config data
dotenv.config();

//xchain-hub url and port
const HUB_HOST = process.env.HUB_API_HOST
const HUB_PORT = process.env.HUB_PORT
const EXPLORER_API_PORT_HTTP = process.env.EXPLORER_API_PORT_HTTP
const EXPLORER_API_PORT_HTTPS = process.env.EXPLORER_API_PORT_HTTPS

// Setup the basic API functionality
async function startApi(){
    // Parse in the explorer config information
    let config = await configInfo.getConfig(HUB_HOST, HUB_PORT);

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
                // data: URIs are required for QR code generation
                imgSrc:      ["'self'", "data:"],
                // FontAwesome kit fetches CSS from ka-p.fontawesome.com and kit.fontawesome.com,
                // and icon data from ka-f.fontawesome.com via XHR/fetch
                connectSrc:  ["'self'", "https://ka-f.fontawesome.com", "https://ka-p.fontawesome.com", "https://kit.fontawesome.com"],
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

    // Allow JSON requests
    app.use(express.json());

    // Allow CORS from any origin (public read-only explorer)
    app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));

    // Rate limiting — 120 requests per minute per IP
    app.use(rateLimit({
        windowMs:        60 * 1000,
        max:             120,
        standardHeaders: true,
        legacyHeaders:   false,
    }));

    // Allow reverse proxy (X-Forwarded-Proto header)
    app.enable('trust proxy');

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
            return {status:"success"};
        }
    }

    // HTTP server for redirection
    http.createServer(app).listen(EXPLORER_API_PORT_HTTP, () => {
        console.log('HTTP  server listening on port', EXPLORER_API_PORT_HTTP);
    });

    // HTTPS server for serving out requests in a secure manner
    https.createServer(config.API.ssl, app).listen(EXPLORER_API_PORT_HTTPS, () => {
        console.log('HTTPS server listening on port', EXPLORER_API_PORT_HTTPS);
    });

    // Start up the explorer instance
    const explorer = new XChainExplorer(app, configInfo);
    await explorer.init()

    // Allow JSON-RPC requests (registered last so explorer routes take priority)
    app.use(jsonRouter({methods: jsonRpcController}))
}

// Start up the explorer services
startApi().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
});
