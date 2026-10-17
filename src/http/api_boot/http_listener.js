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
    const httpServer = http.createServer(app);
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

module.exports = { startHttpListener };
