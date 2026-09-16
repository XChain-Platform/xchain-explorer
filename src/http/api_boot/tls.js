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
 * XChain Explorer - the optional HTTPS listener
 *
 * One boot step of src/api.js. The plain HTTP listener is the primary serving
 * socket and stays on the entry; this is the secondary one, which exists only
 * where the deployment ships its own certificates.
 *
 ********************************************************************/

'use strict';

const https = require('https');

/**
 * The HTTPS listener, which serves requests securely.
 * Skipped when SSL files are absent (HTTP-only dev/regtest mode).
 *
 * @param {object} app the express app
 * @param {object} config the explorer config (API.ssl decides)
 * @param {object} runtime the drain's published pieces, written in place
 * @param {number|string} port the HTTPS port to bind
 * @param {object} log the service logger
 * @returns {object|null} the listener, or null when there is nothing to start
 */
function startTlsListener(app, config, runtime, port, log){
    if (!config.API.ssl)
        return null;

    let httpsServer = https.createServer(config.API.ssl, app);
    // The HTTPS listener is secondary (prod fronts TLS at Apache and ships no SSL
    // files, so this path is dev/regtest only). A bind failure here must not take the
    // process down: log a warning and keep serving over HTTP. Same async-'error'
    // caveat as the HTTP listener, so attach the handler before listen().
    httpsServer.on('error', (err) => {
        log.warn('HTTPS_LISTEN_FAILED', { port: port, code: err.code, err: err.message, detail: 'continuing HTTP-only' });
        httpsServer = null;
        // Cleared here too: a listener that never bound must not be handed to
        // the drain, which would wait on a close() callback that never fires.
        runtime.httpsServer = null;
    });
    httpsServer.listen(port, () => {
        log.info('HTTPS_SERVER_LISTENING', { port: port });
    });
    runtime.httpsServer = httpsServer;

    return httpsServer;
}

module.exports = { startTlsListener };
