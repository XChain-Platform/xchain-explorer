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
 * XChain Explorer - Graceful shutdown
 *
 * Bounded, idempotent drain for SIGTERM/SIGINT. The Dockerfile CMD runs node as
 * PID 1, so `docker stop` delivers SIGTERM here.
 *
 * This replaces an earlier handler that called process.exit(0) as soon as the
 * contract-simulation VM worker was down. That exit dropped every in-flight HTTP
 * request and every open WebSocket mid-frame, and it never closed the MariaDB
 * pools, so a rolling upgrade cut readers off at the socket. It also never ran
 * in production, because npm was PID 1 and swallowed the signal - so the code
 * read as drain coverage while providing none.
 *
 * Registering a handler REMOVES node's default terminate, so the handler carries
 * its own hard-exit timer: a drain that hangs must still end the process, or a
 * stop becomes an indefinitely lingering container under any supervisor with a
 * long or unbounded grace period.
 *
 ********************************************************************/

// Hard-exit budget for the whole drain. Docker's default stop grace is 10s and
// xchain-node issues a bare `docker stop`, so the default sits under it: an
// overrun that ends in our own logged exit is diagnosable, one that ends in the
// daemon's SIGKILL is not. SHUTDOWN_TIMEOUT_MS overrides.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;

function resolveTimeoutMs(timeoutMs, env){
    if(Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs;
    const raw = parseInt((env || process.env).SHUTDOWN_TIMEOUT_MS, 10);
    return (Number.isFinite(raw) && raw > 0) ? raw : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

// Close an http.Server and resolve once it has stopped listening. Idle keep-alive
// sockets would otherwise hold close() open indefinitely while no request is in
// flight, so they are dropped explicitly; requests already being served are left
// to finish, which is the whole point of draining rather than exiting.
function closeServer(server){
    return new Promise((resolve) => {
        if(!server || typeof server.close !== 'function') return resolve();
        let settled = false;
        const done = () => { if(!settled){ settled = true; resolve(); } };
        try {
            server.close(done);
            if(typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        } catch(_){
            done();
        }
    });
}

/**
 * Build an idempotent signal handler that runs `drain` under a hard-exit bound.
 *
 * @param {object}   opts
 * @param {function} opts.drain      async work to finish before exiting
 * @param {number}   [opts.timeoutMs] hard-exit budget (default SHUTDOWN_TIMEOUT_MS / 8000)
 * @param {function} [opts.exit]     process-exit seam (tests pass their own)
 * @param {object}   [opts.log]      console-shaped logger
 * @returns {function(string): void} handler to register on SIGTERM / SIGINT
 */
function createShutdown({ drain, timeoutMs, exit, log } = {}){
    const onExit  = exit || ((code) => process.exit(code));
    const logger  = log || console;
    const budget  = resolveTimeoutMs(timeoutMs);
    let signalled = false;

    return function shutdown(signal){
        // A second signal must not restart the sequence: re-entering would close
        // servers and pools underneath a drain already using them.
        if(signalled){
            logger.log('Shutdown already in progress; ignoring ' + (signal || 'signal') + '.');
            return;
        }
        signalled = true;
        logger.log('Received ' + (signal || 'signal') + ', draining (hard exit in ' + budget + 'ms)...');

        let finished = false;
        const timer = setTimeout(() => {
            if(finished) return;
            finished = true;
            // Non-zero: the drain did NOT complete, so requests were cut off exactly
            // as a SIGKILL would have cut them. A clean drain below exits 0.
            logger.error('Shutdown drain exceeded ' + budget + 'ms; exiting hard.');
            onExit(1);
        }, budget);

        Promise.resolve().then(() => drain()).then(
            () => {
                if(finished) return;
                finished = true;
                clearTimeout(timer);
                logger.log('Shutdown drain complete; exiting.');
                onExit(0);
            },
            (err) => {
                if(finished) return;
                finished = true;
                clearTimeout(timer);
                logger.error('Shutdown drain failed:', err);
                onExit(1);
            }
        );
    };
}

/**
 * The explorer's drain, as its own function so the exit path is unit-testable
 * without booting startApi().
 *
 * Order is load-bearing:
 *   1. stop the pollers that write into the live feed and the pools;
 *   2. close WebSocket clients with a clean 1001 so they reconnect elsewhere;
 *   3. close the listeners, letting in-flight HTTP requests finish;
 *   4. tear down the VM worker;
 *   5. close DB pools LAST, because steps 3 and 4 still read through them.
 *
 * Every step is guarded: this runs against a partially-built runtime whenever a
 * signal lands before startApi() finished, and a missing piece must be skipped
 * rather than turned into a failed drain.
 *
 * `runtime` is read WHEN THE DRAIN RUNS, never destructured here. The handler is
 * registered at module load, before startApi() has built anything, so capturing
 * the fields at factory time would freeze every one of them at null and silently
 * drain nothing.
 *
 * @param {object} runtime
 * @param {object} [runtime.httpServer]     primary listener
 * @param {object} [runtime.httpsServer]    secondary listener (dev/regtest only)
 * @param {object} [runtime.wsServer]       WebSocketServer, has its own stop()
 * @param {object} [runtime.changeDetector] live-feed poller, has its own stop()
 * @param {object} [runtime.configInfo]     config module, for stopSync()
 * @param {object} [runtime.vmQuery]        contract-simulation VM, for shutdown()
 * @param {object} [runtime.explorer]       XChainExplorer, for explorer.db.close()
 * @param {object} [runtime.log]            console-shaped logger
 */
function createExplorerDrain(runtime){
    const state = runtime || {};

    return async function drain(){
        const logger = state.log || console;
        const guard = async (what, fn) => {
            try { await fn(); }
            catch(err){ logger.warn('Shutdown: ' + what + ' failed: ' + (err && err.message ? err.message : err)); }
        };

        const changeDetector = state.changeDetector;
        const configInfo     = state.configInfo;
        const wsServer       = state.wsServer;
        const vmQuery        = state.vmQuery;
        const explorer       = state.explorer;

        if(changeDetector && typeof changeDetector.stop === 'function')
            await guard('stopping the change detector', () => changeDetector.stop());

        if(configInfo && typeof configInfo.stopSync === 'function')
            await guard('stopping the hub-config sync', () => configInfo.stopSync());

        if(wsServer && typeof wsServer.stop === 'function')
            await guard('closing the WebSocket server', () => wsServer.stop());

        await guard('closing the HTTP listener',  () => closeServer(state.httpServer));
        await guard('closing the HTTPS listener', () => closeServer(state.httpsServer));

        if(vmQuery && typeof vmQuery.shutdown === 'function')
            await guard('shutting down the VM worker', () => vmQuery.shutdown());

        if(explorer && explorer.db && typeof explorer.db.close === 'function')
            await guard('closing the database pools', () => explorer.db.close());
    };
}

module.exports = {
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    resolveTimeoutMs,
    closeServer,
    createShutdown,
    createExplorerDrain
};
