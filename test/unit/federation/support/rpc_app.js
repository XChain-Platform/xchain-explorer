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
 * An express app wired the way src/api.js wires the JSON-RPC dispatcher: the real
 * mountJsonRpc boot step (batch cap, body default, router) over a controller
 * holding ping plus the real federation methods, with the
 * explorer's database replaced by the scripted one. Requests go over a real
 * socket so the HTTP status and body are what a validator's client would see.
 *
 ********************************************************************/

'use strict';

const http    = require('http');
const express = require('express');

const { mountJsonRpc }       = require('../../../../src/http/api_boot/json_rpc.js');
const { buildFederationRpc } = require('../../../../src/federation');

// The coin tables src/config/resolve_coins.js builds, which route parsing reads.
const COIN_TABLES = {
    COIN_NETWORKS: { BTC: 'Bitcoin', LTC: 'Litecoin', DOGE: 'Dogecoin' },
    COIN_PREFIXES: { mainnet: '', testnet: 'T', regtest: 'R' }
};

/**
 * @param {{db?: object|null, withFederation?: boolean}} opts `withFederation:false`
 *   builds the dispatcher as it was before the federation reads existed
 */
function buildRpcApp(opts) {
    const o = opts || {};
    const configInfo = {
        env: {},
        getConfig: async () => COIN_TABLES
    };
    const explorer = { db: o.db || null };
    const controller = Object.assign({ ping: async () => 'pong' },
        o.withFederation === false ? {} : buildFederationRpc(() => explorer, configInfo));
    const app = express();
    app.use(express.json({ limit: '10kb' }));
    mountJsonRpc(app, configInfo, controller);
    return app;
}

// POST a JSON body to `path` on a throwaway listener; returns { status, body }.
async function post(app, path, body, headers) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
            body: JSON.stringify(body)
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

// A JSON-RPC 2.0 call object.
function call(method, params, id) {
    return { jsonrpc: '2.0', id: id === undefined ? 1 : id, method, params: params || {} };
}

module.exports = { buildRpcApp, post, call };
