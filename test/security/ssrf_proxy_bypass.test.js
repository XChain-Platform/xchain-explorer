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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const axios = require('axios');
const net = require('net');
const { makeSafeLookup, directEgressOptions } = require('../../src/http/ssrf_guard.js');

describe('Security: SSRF: proxy bypass', function () {
    it('keeps environment proxies outside guarded requests', async function () {
        let connections = 0;
        const proxy = net.createServer((socket) => { connections++; socket.destroy(); });
        await new Promise((resolve, reject) => {
            proxy.once('error', reject);
            proxy.listen(0, '127.0.0.1', resolve);
        });
        const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy'];
        const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
        const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
        for (const key of keys.slice(0, 4)) process.env[key] = proxyUrl;
        delete process.env.NO_PROXY;
        delete process.env.no_proxy;
        const lookup = makeSafeLookup({ lookup: (host, options, callback) => {
            callback(null, '10.0.0.5', 4);
        }});
        try {
            let error;
            try {
                await axios.get('http://blocked.invalid/file', {
                    ...directEgressOptions(), lookup, timeout: 500
                });
            } catch (err) { error = err; }
            expect(error).to.be.an('error');
            expect(error.code).to.equal('RELAY_DENIED');
            expect(connections).to.equal(0);
        } finally {
            for (const key of keys) {
                if (saved[key] === undefined) delete process.env[key];
                else process.env[key] = saved[key];
            }
            await new Promise((resolve) => proxy.close(resolve));
        }
    });

    describe('ignored proxy notice', function () {
        const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
        const modulePath = require.resolve('../../src/http/ssrf_guard.js');
        let saved;
        beforeEach(function () {
            saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
            for (const key of keys) delete process.env[key];
            delete require.cache[modulePath];
        });
        afterEach(function () {
            for (const key of keys) {
                if (saved[key] === undefined) delete process.env[key];
                else process.env[key] = saved[key];
            }
            delete require.cache[modulePath];
        });

        it('names each configured proxy variable once and still pins direct egress', function () {
            process.env.HTTPS_PROXY = 'http://127.0.0.1:3128';
            const guard = require(modulePath);
            const lines = [];
            const first = guard.directEgressOptions((line) => lines.push(line));
            const second = guard.directEgressOptions((line) => lines.push(line));
            expect(lines).to.have.length(1);
            expect(lines[0]).to.contain('HTTPS_PROXY');
            expect(first.proxy).to.equal(false);
            expect(second.proxy).to.equal(false);
        });

        it('stays silent when no proxy variable is configured', function () {
            const guard = require(modulePath);
            const lines = [];
            guard.directEgressOptions((line) => lines.push(line));
            expect(lines).to.have.length(0);
        });
    });
});
