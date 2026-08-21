// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Pins the container exit path. `docker stop` sends SIGTERM to node (PID 1 via the
// Dockerfile's exec-form CMD). The handler this replaces called process.exit(0) as
// soon as the VM worker was down: it dropped in-flight requests, cut WebSockets
// mid-frame and never closed the MariaDB pools, and under npm as PID 1 it never
// ran at all. Both halves are asserted here.

const assert = require('assert');
const { createShutdown, createExplorerDrain, closeServer, resolveTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS } = require('../../src/shutdown');
const configInfo = require('../../src/config.js');

const silentLog = { log(){}, warn(){}, error(){} };

function makeServer(order, name){
    return {
        closed: false,
        idleDropped: false,
        close(cb){ this.closed = true; order.push(name + '.close'); setImmediate(cb); },
        closeIdleConnections(){ this.idleDropped = true; }
    };
}

function makeRuntime(order){
    return {
        log: silentLog,
        httpServer:  makeServer(order, 'http'),
        httpsServer: makeServer(order, 'https'),
        wsServer:       { stopped: false, stop(){ this.stopped = true; order.push('ws.stop'); } },
        changeDetector: { stopped: false, stop(){ this.stopped = true; order.push('detector.stop'); } },
        configInfo:     { stopped: false, stopSync(){ this.stopped = true; order.push('configSync.stop'); } },
        vmQuery:        { stopped: false, async shutdown(){ this.stopped = true; order.push('vm.shutdown'); } },
        explorer:       { db: { closed: false, async close(){ this.closed = true; order.push('db.close'); } } }
    };
}

describe('graceful shutdown', function(){

    describe('createShutdown', function(){

        it('runs the drain and exits zero when it completes', async function(){
            const codes = [];
            let drained = false;
            const shutdown = createShutdown({
                drain: async () => { drained = true; },
                exit: (c) => codes.push(c),
                log: silentLog
            });
            shutdown('SIGTERM');
            await new Promise((r) => setTimeout(r, 10));
            assert.strictEqual(drained, true);
            assert.deepStrictEqual(codes, [0]);
        });

        it('is idempotent: a second signal does not re-enter the drain', async function(){
            const codes = [];
            let calls = 0;
            const shutdown = createShutdown({
                drain: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); },
                exit: (c) => codes.push(c),
                log: silentLog
            });
            shutdown('SIGTERM');
            shutdown('SIGINT');
            await new Promise((r) => setTimeout(r, 60));
            assert.strictEqual(calls, 1);
            assert.deepStrictEqual(codes, [0]);
        });

        // The reason the handler is safe to install at all: registering one REMOVES
        // node's default terminate, so without this bound a hung drain turns every
        // stop into a container that lingers until the supervisor's grace expires.
        it('hard-exits non-zero when the drain overruns its budget', async function(){
            const codes = [];
            const shutdown = createShutdown({
                drain: () => new Promise(() => {}),
                timeoutMs: 20,
                exit: (c) => codes.push(c),
                log: silentLog
            });
            shutdown('SIGTERM');
            await new Promise((r) => setTimeout(r, 80));
            assert.deepStrictEqual(codes, [1]);
        });

        it('exits non-zero when the drain throws, and only once', async function(){
            const codes = [];
            const shutdown = createShutdown({
                drain: async () => { throw new Error('pool refused to close'); },
                timeoutMs: 50,
                exit: (c) => codes.push(c),
                log: silentLog
            });
            shutdown('SIGTERM');
            await new Promise((r) => setTimeout(r, 120));
            assert.deepStrictEqual(codes, [1]);
        });
    });

    describe('resolveTimeoutMs', function(){
        it('prefers an explicit budget, then the env var, then the default', function(){
            assert.strictEqual(resolveTimeoutMs(1234, {}), 1234);
            assert.strictEqual(resolveTimeoutMs(undefined, { SHUTDOWN_TIMEOUT_MS: '4321' }), 4321);
            assert.strictEqual(resolveTimeoutMs(undefined, {}), DEFAULT_SHUTDOWN_TIMEOUT_MS);
        });

        it('stays under Docker\'s 10s default stop grace', function(){
            assert.ok(DEFAULT_SHUTDOWN_TIMEOUT_MS < 10000);
        });
    });

    describe('closeServer', function(){
        it('drops idle keep-alive sockets that would otherwise hold close() open', async function(){
            const server = makeServer([], 'http');
            await closeServer(server);
            assert.strictEqual(server.closed, true);
            assert.strictEqual(server.idleDropped, true);
        });

        it('resolves on a missing server rather than hanging the drain', async function(){
            await closeServer(null);
            await closeServer({});
        });
    });

    describe('createExplorerDrain', function(){

        it('stops the pollers, closes sockets and listeners, then the VM and the pools', async function(){
            const order = [];
            const runtime = makeRuntime(order);
            await createExplorerDrain(runtime)();

            assert.strictEqual(runtime.changeDetector.stopped, true);
            assert.strictEqual(runtime.configInfo.stopped, true);
            assert.strictEqual(runtime.wsServer.stopped, true);
            assert.strictEqual(runtime.httpServer.closed, true);
            assert.strictEqual(runtime.httpsServer.closed, true);
            assert.strictEqual(runtime.vmQuery.stopped, true);
            assert.strictEqual(runtime.explorer.db.closed, true,
                'the replaced handler never closed the pools; this one must');

            // Pools last: the listeners and the VM teardown both still read through them.
            assert.ok(order.indexOf('db.close') > order.indexOf('http.close'));
            assert.ok(order.indexOf('db.close') > order.indexOf('vm.shutdown'));
            // Feed pollers stop before the sockets they write into.
            assert.ok(order.indexOf('detector.stop') < order.indexOf('ws.stop'));
            // Config sync stops before the pools it would otherwise rebuild.
            assert.ok(order.indexOf('configSync.stop') < order.indexOf('db.close'));
        });

        // The old handler exited immediately on signal. server.close() is what lets a
        // request already being served finish, so a drain that skips it is the same
        // dropped-response behaviour under a different name.
        it('lets an in-flight request finish before the process exits', async function(){
            const order = [];
            const runtime = makeRuntime(order);
            let releaseRequest;
            const inFlight = new Promise((res) => { releaseRequest = res; });
            runtime.httpServer.close = function(cb){
                order.push('http.close');
                inFlight.then(() => { this.closed = true; cb(); });
            };

            let done = false;
            const running = createExplorerDrain(runtime)().then(() => { done = true; });
            await new Promise((r) => setTimeout(r, 30));
            assert.strictEqual(done, false, 'the drain must wait on the in-flight request');
            assert.strictEqual(runtime.explorer.db.closed, false,
                'pools must still be open while a request is being served');

            releaseRequest();
            await running;
            assert.strictEqual(runtime.explorer.db.closed, true);
        });

        // The handler is registered at module load, before startApi() has built
        // anything, so the runtime object is read at drain time and not captured.
        it('picks up pieces published after the drain was built', async function(){
            const order = [];
            const runtime = { log: silentLog };
            const drain = createExplorerDrain(runtime);

            Object.assign(runtime, makeRuntime(order));
            await drain();

            assert.strictEqual(runtime.explorer.db.closed, true,
                'capturing the fields at factory time would freeze them at null and drain nothing');
        });

        it('drains a partially-built process without throwing', async function(){
            await createExplorerDrain({ log: silentLog })();
            await createExplorerDrain()();
        });

        it('keeps going when one step fails', async function(){
            const order = [];
            const runtime = makeRuntime(order);
            runtime.vmQuery.shutdown = async () => { throw new Error('vm worker wedged'); };
            await createExplorerDrain(runtime)();
            assert.strictEqual(runtime.explorer.db.closed, true,
                'one wedged step must not strand the pool close behind it');
        });
    });

    describe('config.stopSync', function(){
        it('is idempotent and stops the refresh ticker the drain relies on', function(){
            assert.strictEqual(typeof configInfo.stopSync, 'function');
            configInfo.stopSync();
            configInfo.stopSync();
        });
    });
});
