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

const http = require('http');
const axios = require('axios');
const { expect } = require('chai');
const { directEgressOptions, egressSignal } = require('../../src/http/ssrf_guard.js');

async function openDripServer(){
    const intervals = new Set();
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.write('x');
        const interval = setInterval(() => res.write('x'), 25);
        intervals.add(interval);
        res.once('close', () => {
            clearInterval(interval);
            intervals.delete(interval);
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        url: 'http://127.0.0.1:' + server.address().port + '/drip',
        close: async () => {
            for(const interval of intervals) clearInterval(interval);
            await new Promise((resolve) => server.close(resolve));
        }
    };
}

describe('Security: egress wall-clock deadline', function () {
    it('ends a body that stays active past the axios idle timeout', async function () {
        const drip = await openDripServer();
        const cleanup = new AbortController();
        try {
            let idleSettled = false;
            const idleOnly = axios.get(drip.url, {
                ...directEgressOptions(), timeout: 80, signal: cleanup.signal
            }).then(() => null, (error) => error);
            idleOnly.then(() => { idleSettled = true; });
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(idleSettled).to.equal(false);
            cleanup.abort();
            await idleOnly;

            const started = Date.now();
            const error = await axios.get(drip.url, {
                ...directEgressOptions(), timeout: 80, signal: egressSignal(120)
            }).then(() => null, (caught) => caught);
            expect(error).to.be.an('error');
            expect(error.code).to.equal('ERR_CANCELED');
            expect(Date.now() - started).to.be.lessThan(500);
        } finally {
            cleanup.abort();
            await drip.close();
        }
    });
});
