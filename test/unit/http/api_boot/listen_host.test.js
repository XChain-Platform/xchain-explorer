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
 * Both API listeners bind EXPLORER_BIND_HOST, loopback by default
 *
 * Express trusts one proxy hop, so a port reachable from anywhere but the
 * fronting proxy lets a caller forge X-Forwarded-For and pick its rate-limit
 * bucket. These tests bind the real listeners and read back the address the
 * kernel holds, then try the port from a non-loopback interface of this host.
 * src/api.js boots on require, so its wiring is pinned through its source.
 *
 * Run: mocha test/unit/http/api_boot/listen_host.test.js --timeout 20000
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const fs         = require('fs');
const net        = require('net');
const os         = require('os');
const path       = require('path');
const { srcText } = require('../../../helpers/source_text');

const { DEFAULT_BIND_HOST, resolveBindHost } = require('../../../../src/http/api_boot/bind_host.js');
const { startHttpListener } = require('../../../../src/http/api_boot/http_listener.js');
const { startTlsListener }  = require('../../../../src/http/api_boot/tls.js');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

const quietLog = { info(){}, warn(){}, error(){} };
const noopApp  = (req, res) => res.end('ok');

function listening(server){
    return new Promise((resolve, reject) => {
        if(server.listening) return resolve(server);
        server.once('listening', () => resolve(server));
        server.once('error', reject);
    });
}

function closed(server){
    return new Promise((resolve) => server.close(() => resolve()));
}

// The first IPv4 address of this host that is not loopback, or null on a host
// with none (a bare CI sandbox), where the reachability test has nothing to try.
function externalIPv4(){
    for(const addrs of Object.values(os.networkInterfaces()))
        for(const a of addrs || [])
            if(a.family === 'IPv4' && !a.internal) return a.address;
    return null;
}

// Resolves 'connected' or the connect error code.
function tryConnect(host, port){
    return new Promise((resolve) => {
        const sock = net.connect({ host, port });
        sock.setTimeout(3000);
        sock.once('connect', () => { sock.destroy(); resolve('connected'); });
        sock.once('timeout', () => { sock.destroy(); resolve('ETIMEDOUT'); });
        sock.once('error', (err) => resolve(err.code));
    });
}

describe('API listeners: EXPLORER_BIND_HOST', function(){

    describe('resolveBindHost()', function(){

        it('defaults to the literal loopback address', function(){
            expect(DEFAULT_BIND_HOST).to.equal('127.0.0.1');
            expect(resolveBindHost({})).to.equal('127.0.0.1');
        });

        it('treats an empty or blank value as unset, never as every interface', function(){
            expect(resolveBindHost({ EXPLORER_BIND_HOST: '' })).to.equal('127.0.0.1');
            expect(resolveBindHost({ EXPLORER_BIND_HOST: '   ' })).to.equal('127.0.0.1');
        });

        it('passes an explicit host through', function(){
            expect(resolveBindHost({ EXPLORER_BIND_HOST: '0.0.0.0' })).to.equal('0.0.0.0');
            expect(resolveBindHost({ EXPLORER_BIND_HOST: '::' })).to.equal('::');
            expect(resolveBindHost({ EXPLORER_BIND_HOST: ' 10.0.0.5 ' })).to.equal('10.0.0.5');
        });
    });

    describe('startHttpListener()', function(){

        it('binds the host it is given and publishes the server for the drain', async function(){
            const runtime = {};
            const server = await listening(startHttpListener(noopApp, runtime, 0, DEFAULT_BIND_HOST, quietLog));
            try {
                expect(server.address().address).to.equal('127.0.0.1');
                expect(runtime.httpServer).to.equal(server);
            } finally {
                await closed(server);
            }
        });

        it('on the default host, refuses a peer that reaches this machine on a non-loopback interface', async function(){
            // Control first: a 0.0.0.0 listener must be reachable on that interface,
            // or the sandbox filters it and a refusal below would prove nothing.
            const ext = externalIPv4();
            if(!ext) this.skip();
            const open = await listening(startHttpListener(noopApp, {}, 0, '0.0.0.0', quietLog));
            const reachable = await tryConnect(ext, open.address().port);
            await closed(open);
            if(reachable !== 'connected') this.skip();

            const server = await listening(startHttpListener(noopApp, {}, 0, resolveBindHost({}), quietLog));
            try {
                const port = server.address().port;
                expect(await tryConnect('127.0.0.1', port)).to.equal('connected');
                expect(await tryConnect(ext, port)).to.not.equal('connected');
            } finally {
                await closed(server);
            }
        });
    });

    describe('startTlsListener()', function(){

        it('binds the host it is given', async function(){
            // No key or cert: listen() needs neither, and the bound address is the claim.
            const runtime = {};
            const config = { API: { ssl: {} } };
            const server = await listening(startTlsListener(noopApp, config, runtime, 0, DEFAULT_BIND_HOST, quietLog));
            try {
                expect(server.address().address).to.equal('127.0.0.1');
                expect(runtime.httpsServer).to.equal(server);
            } finally {
                await closed(server);
            }
        });

        it('starts nothing without SSL config', function(){
            expect(startTlsListener(noopApp, { API: {} }, {}, 0, DEFAULT_BIND_HOST, quietLog)).to.equal(null);
        });
    });

    describe('wiring', function(){

        it('src/api.js resolves the host through the config env view', function(){
            const src = srcText('src/api.js');
            expect(src).to.match(/const EXPLORER_BIND_HOST\s*=\s*resolveBindHost\(configInfo\.env\);/);
        });

        it('src/api.js hands that host to both listeners', function(){
            const src = srcText('src/api.js');
            expect(src).to.match(/startHttpListener\(app, runtime, EXPLORER_API_PORT_HTTP, EXPLORER_BIND_HOST, log\)/);
            expect(src).to.match(/startTlsListener\(app, config, runtime, EXPLORER_API_PORT_HTTPS, EXPLORER_BIND_HOST, log\)/);
        });

        it('the Docker image widens the bind so its published port reaches the server', function(){
            // Every container launch path builds this Dockerfile; a loopback bind
            // inside one leaves the port mapping dead while the in-container
            // healthcheck on 127.0.0.1 stays green.
            const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
            const envAt = dockerfile.search(/^ENV EXPLORER_BIND_HOST=0\.0\.0\.0$/m);
            const cmdAt = dockerfile.search(/^CMD /m);
            expect(envAt, 'Dockerfile sets no ENV EXPLORER_BIND_HOST=0.0.0.0').to.be.above(-1);
            expect(envAt).to.be.below(cmdAt);
        });
    });
});
