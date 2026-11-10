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
 * XChain Explorer - the plain HTTP listener
 *
 * One boot step of src/api.js: the primary serving socket. HTTPS is the
 * optional secondary one (tls.js), and both bind the same host.
 *
 ********************************************************************/

'use strict';

const http = require('http');

// The longest a client may take to deliver one whole request (headers and
// body). Node's own ceiling is 300 s, and the concurrency gate counts a
// request from the moment it arrives, so a client that trickles a body
// holds a gate slot for that whole ceiling: a few identities that never
// finish sending can fill every slot and get everyone else a 429. Real API
// bodies are small JSON, so 15 s is generous. EXPLORER_REQUEST_TIMEOUT_MS
// overrides it; an unparseable or non-positive value keeps the default
// (a typo must not restore the 300 s hold).
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function resolveRequestTimeoutMs(raw){
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * The plain HTTP listener, the primary serving socket.
 *
 * @param {object} app the express app
 * @param {object} runtime the drain's published pieces, written in place
 * @param {number|string} port the HTTP port to bind
 * @param {string} host the interface to bind (bind_host.js)
 * @param {object} log the service logger
 * @returns {object} the listener
 */
function startHttpListener(app, runtime, port, host, log){
    const requestTimeout = resolveRequestTimeoutMs(process.env.EXPLORER_REQUEST_TIMEOUT_MS);
    // Node enforces requestTimeout only when its connection sweep runs (30 s
    // by default), so the sweep must tick faster than the timeout it enforces.
    const httpServer = http.createServer({
        requestTimeout: requestTimeout,
        headersTimeout: Math.min(requestTimeout, 60000),
        connectionsCheckingInterval: Math.max(50, Math.min(5000, Math.floor(requestTimeout / 3)))
    }, app);
    // A listen() that fails (EADDRINUSE when a second instance grabs the port, EACCES
    // on a privileged port, EADDRNOTAVAIL for a host this machine does not hold)
    // surfaces as an async 'error' event, not a throw, so a try/catch can't catch it;
    // without a handler Node crashes with an unhandled-error stack dump. The HTTP
    // server is the primary serving socket: log one clear line and exit non-zero so
    // the supervisor (systemd) reports and restarts cleanly.
    httpServer.on('error', (err) => {
        log.error('HTTP_LISTEN_FAILED', { host: host, port: port, code: err.code, err: err.message });
        process.exit(1);
    });
    httpServer.listen(port, host, () => {
        log.info('HTTP_SERVER_LISTENING', { host: host, port: port });
    });
    // Published as soon as it exists, not at the end of startApi(): a SIGTERM
    // arriving mid-boot must still be able to close a listener already bound.
    runtime.httpServer = httpServer;
    return httpServer;
}

module.exports = { startHttpListener, resolveRequestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS };
