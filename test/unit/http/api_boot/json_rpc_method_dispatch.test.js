/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

// An inherited Object.prototype name is not a JSON-RPC method. The router checks
// `method in controller`, so a plain-object controller let constructor echo the
// caller's params, toString answer "[object Object]", valueOf and the accessor
// helpers surface V8 TypeError text, and __proto__ fail with a hook-type error.
// Every one of them must answer -32601 Method not found.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');

const { mountJsonRpc } = require('../../../../src/http/api_boot/json_rpc.js');

const NAMES = [
    'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
    'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__defineSetter__',
    '__lookupGetter__', '__lookupSetter__', '__proto__',
];

async function post(body) {
    const app = express();
    app.use(express.json());
    mountJsonRpc(app, { env: {} }, { ping: () => 'pong' });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: typeof body === 'string' ? body : JSON.stringify(body),
        });
        return await res.json();
    } finally {
        server.close();
    }
}

function assertNotFound(r, name) {
    assert.strictEqual(r.error && r.error.code, -32601, `${name}: ${JSON.stringify(r)}`);
    assert.ok(!('result' in r), `${name}: has result`);
    assert.ok(!/TypeError|Cannot convert/.test(r.error.message), `${name}: ${r.error.message}`);
}

test('control: ping still answers', async () => {
    const r = await post({ jsonrpc: '2.0', id: 1, method: 'ping', params: [] });
    assert.strictEqual(r.result, 'pong');
});

for (const name of NAMES) {
    test(`single call to ${name} is Method not found`, async () => {
        const r = await post(`{"jsonrpc":"2.0","id":1,"method":"${name}","params":["leak"]}`);
        assertNotFound(r, name);
    });
}

test('batch: ping answers, prototype names are Method not found', async () => {
    const r = await post([
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'constructor', params: ['leak'] },
        { jsonrpc: '2.0', id: 3, method: 'valueOf' },
        { jsonrpc: '2.0', id: 4, method: '__proto__' },
    ]);
    assert.strictEqual(r[0].result, 'pong');
    assertNotFound(r[1], 'constructor');
    assertNotFound(r[2], 'valueOf');
    assertNotFound(r[3], '__proto__');
});
