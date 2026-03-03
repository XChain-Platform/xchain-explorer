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
const bodyParser     = require('body-parser');
const helmet         = require('helmet');
const cors           = require('cors');
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
        // TODO: circle back and add a content-security-policy that makes sense
        contentSecurityPolicy: false,
        // contentSecurityPolicy: {
        //  directives: {
        //      "script-src": ["'self'", "example.com"],
        //  },
        // },
    }));

    // Allow JSON requests
    app.use(bodyParser.json());

    // Allow CORS for development
    app.use(cors());

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
startApi();
