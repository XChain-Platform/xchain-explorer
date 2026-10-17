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
 * Disk-served files carry a cache lifetime, and the file mounts take their own
 * rate-limit bucket.
 *
 * express.static's default max-age=0 kept Cloudflare and browsers from holding
 * any of a page's hundred-odd scripts, and counting those scripts against the
 * 180/min app-wide bucket refused a page's jQuery on the third page view.
 */

'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const { STATIC_OPTIONS, VERSIONED, UNVERSIONED } = require('../../../src/http/static_cache.js');
const { isFileMountPath, isStaticAssetPath, STATIC_DIRECTORIES } = require('../../../src/http/static_mounts.js');
const { applyRateLimits } = require('../../../src/http/api_boot/rate_limits.js');
const staticMounts = require('../../../src/http/static_mounts.js');

function listen(app){
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function get(server, path){
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
            res.resume();
            res.on('end', () => resolve(res));
        }).on('error', reject);
    });
}

describe('static cache headers', function(){
    let server;
    before(async function(){
        const app = express();
        app.use('/js', express.static(require('path').join(__dirname, '..', '..', '..', 'src', 'content', 'js'), STATIC_OPTIONS));
        server = await listen(app);
    });
    after(function(){ server.close(); });

    it('keeps a content-hashed URL for a year as immutable', async function(){
        const res = await get(server, '/js/jquery.min.js?v=abc123');
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers['cache-control'], VERSIONED);
    });

    it('gives a bare URL a short lifetime, since a deploy may change it', async function(){
        const res = await get(server, '/js/jquery.min.js');
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers['cache-control'], UNVERSIONED);
    });

    it('treats an empty v as unversioned', async function(){
        const res = await get(server, '/js/jquery.min.js?v=');
        assert.strictEqual(res.headers['cache-control'], UNVERSIONED);
    });
});

describe('file mount predicate', function(){
    it('matches every static directory and the Font Awesome tree by first segment', function(){
        for(const dir of STATIC_DIRECTORIES)
            assert.ok(isFileMountPath('/' + dir + '/x.js'), dir);
        assert.ok(isFileMountPath('/fontawesome/css/all.min.css'));
    });

    it('never matches an API path, a lookalike segment or a traversal', function(){
        for(const p of ['/BTC/api/blocks', '/BTC/js/x.js', '/jsx/a.js', '/js/../BTC/api/blocks', '/', '', null])
            assert.ok(!isFileMountPath(p), String(p));
    });

    it('leaves the unlimited image exemption exactly as it was', function(){
        assert.ok(!isStaticAssetPath('/js/xchain.js'));
        assert.ok(isStaticAssetPath('/images/a.png'));
    });
});

describe('file mounts take their own rate-limit bucket', function(){
    let server;
    before(async function(){
        const app = express();
        const configInfo = { env: { EXPLORER_RATE_LIMIT_RPM: '3', EXPLORER_STATIC_RATE_LIMIT_RPM: '5', EXPLORER_MAX_CONCURRENT_REQUESTS: '0' } };
        applyRateLimits(app, configInfo, staticMounts.isStaticAsset);
        app.use((req, res) => res.status(200).send('ok'));
        server = await listen(app);
    });
    after(function(){ server.close(); });

    it('serves more scripts than the app-wide limit allows, then sheds at the static limit', async function(){
        const codes = [];
        for(let i = 0; i < 6; i++) codes.push((await get(server, '/js/a.js')).statusCode);
        assert.deepStrictEqual(codes, [200, 200, 200, 200, 200, 429]);
    });

    it('still counts API reads against the app-wide bucket, untouched by script loads', async function(){
        const codes = [];
        for(let i = 0; i < 4; i++) codes.push((await get(server, '/BTC/api/blocks')).statusCode);
        assert.deepStrictEqual(codes, [200, 200, 200, 429]);
    });
});
