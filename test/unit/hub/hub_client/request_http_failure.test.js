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

const assert = require('assert');
const http = require('http');
const { sendHubRequest } = require('../../../../src/hub/hub_client/request.js');

function startHub(status, body, headers) {
    return new Promise(resolve => {
        const server = http.createServer((_req, res) => {
            res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, headers));
            res.end(JSON.stringify(body));
        });
        server.listen(0, '127.0.0.1', () => resolve({
            server,
            url: 'http://127.0.0.1:' + server.address().port + '/'
        }));
    });
}

function closeHub(hub) {
    return new Promise(resolve => hub.server.close(resolve));
}

async function call(hub) {
    return sendHubRequest(hub.url, 'gethubs', {}, '', 5000);
}

describe('hub mirror transport rejects JSON HTTP failures', function () {
    it('rejects a JSON 503 instead of returning an undefined result', async function () {
        const hub = await startHub(503, { message: 'Service Unavailable' });
        try {
            const err = await call(hub).then(() => null, rejection => rejection);
            assert.ok(err);
            assert.strictEqual(err.httpStatus, 503);
            assert.match(err.message, /HTTP 503/);
        } finally {
            await closeHub(hub);
        }
    });

    it('classifies an envelope-less JSON 429 as rate limited', async function () {
        const hub = await startHub(429, { message: 'Too Many Requests' }, { 'Retry-After': '30' });
        try {
            const err = await call(hub).then(() => null, rejection => rejection);
            assert.strictEqual(err.rateLimited, true);
            assert.strictEqual(err.retryAfterMs, 30000);
        } finally {
            await closeHub(hub);
        }
    });

    it('accepts a result and rejects a 2xx body with no acknowledgement', async function () {
        let hub = await startHub(200, { jsonrpc: '2.0', id: 1, result: { hubs: [] } });
        try {
            assert.deepStrictEqual(await call(hub), { hubs: [] });
        } finally {
            await closeHub(hub);
        }
        hub = await startHub(200, { jsonrpc: '2.0', id: 1 });
        try {
            const err = await call(hub).then(() => null, rejection => rejection);
            assert.match(err.message, /neither result nor error/);
        } finally {
            await closeHub(hub);
        }
    });
});
