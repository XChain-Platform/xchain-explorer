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
 * The status and scope rules of the Cache-Control stamp: errors and
 * redirects are never cached, a 304 keeps its class, non-GET requests and
 * unclassified API paths are no-store, and pages outside the API keep the
 * header their own handler set.
 */

'use strict';

const { expect } = require('chai');
const { classifyRequest, stampCacheHeaders, CACHE_CLASSES } =
    require('../../../../src/http/cache_control.js');
const { srcText } = require('../../../helpers/source_text');

function fakeRes(headers = {}) {
    const store = Object.assign({}, headers);
    return {
        store,
        setHeader(name, value) { store[name] = value; },
        vary(field) { store.Vary = store.Vary ? store.Vary + ', ' + field : field; }
    };
}

describe('cache control: scope', function () {
    it('makes every non-GET request no-store, wherever it lands', () => {
        for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS'])
            for (const path of ['/BTC/api/balances', '/', '/BTC/api/preflight', '/BTC/token/X'])
                expect(classifyRequest(method, path, undefined), method + ' ' + path).to.equal('noStore');
    });

    it('makes an API path no table names no-store', () => {
        expect(classifyRequest('GET', '/BTC/api/not_a_route/x/block', '/{*path}')).to.equal('noStore');
        expect(classifyRequest('GET', '/BTC/explorer/websocket', '/{*path}')).to.equal('noStore');
    });

    it('makes the relay no-store under its mount', () => {
        expect(classifyRequest('GET', '/relay', undefined)).to.equal('noStore');
        expect(classifyRequest('GET', '/relay/https%3A%2F%2Fexample.com', undefined)).to.equal('noStore');
    });

    it('leaves pages, static files and the docs page outside the API classes', () => {
        for (const path of ['/', '/BTC/token/X', '/BTC/api', '/BTC/api/', '/js/xchain.js', '/icon/X.png'])
            expect(classifyRequest('GET', path, '/{*path}'), path).to.equal(null);
    });

    it('matches the namespace and family case-insensitively', () => {
        expect(classifyRequest('GET', '/BTC/API/MEMPOOL', '/{*path}')).to.equal('noStore');
        expect(classifyRequest('GET', '/BTC/Api/Network', '/{*path}')).to.equal('tip');
    });
});

describe('cache control: status rules', function () {
    it('stamps no-store on every error, whatever the class or a handler set', () => {
        for (const cls of [...Object.keys(CACHE_CLASSES), null])
            for (const status of [400, 403, 404, 413, 429, 500, 502, 503]) {
                const res = fakeRes({ 'Cache-Control': CACHE_CLASSES.immutable });
                stampCacheHeaders(res, cls, status);
                expect(res.store['Cache-Control'], cls + ' ' + status).to.equal('no-store');
            }
    });

    it('stamps no-store on a redirect inside the API and leaves one outside alone', () => {
        const inside = fakeRes();
        stampCacheHeaders(inside, 'tip', 302);
        expect(inside.store['Cache-Control']).to.equal('no-store');
        const outside = fakeRes();
        stampCacheHeaders(outside, null, 301);
        expect(outside.store).to.not.have.property('Cache-Control');
    });

    it('keeps the class on a 304 so revalidation does not evict the stored copy', () => {
        const res = fakeRes();
        stampCacheHeaders(res, 'tip', 304);
        expect(res.store['Cache-Control']).to.equal(CACHE_CLASSES.tip);
    });

    it('varies a shared-cacheable answer on Origin and Accept-Encoding', () => {
        for (const cls of ['tip', 'config', 'document', 'immutable']) {
            const res = fakeRes();
            stampCacheHeaders(res, cls, 200);
            expect(res.store['Cache-Control'], cls).to.equal(CACHE_CLASSES[cls]);
            expect(res.store.Vary, cls).to.equal('Origin, Accept-Encoding');
        }
    });

    it('stamps no-store without Vary on a no-store success', () => {
        const res = fakeRes();
        stampCacheHeaders(res, 'noStore', 200);
        expect(res.store).to.deep.equal({ 'Cache-Control': 'no-store' });
    });

    it('leaves a success outside the API exactly as its handler set it', () => {
        const res = fakeRes({ 'Cache-Control': 'public, max-age=300' });
        stampCacheHeaders(res, null, 200);
        expect(res.store).to.deep.equal({ 'Cache-Control': 'public, max-age=300' });
    });
});

describe('cache control: mount order', function () {
    it('mounts the stamp in createApp before every guard that can refuse', () => {
        const src = srcText('src/api.js');
        const body = src.slice(src.indexOf('function createApp('));
        const stamp = body.indexOf('applyCacheControl(app)');
        expect(stamp, 'createApp no longer mounts the cache stamp').to.be.greaterThan(-1);
        for (const step of ['applySecurityHeaders(app', 'applyCors(app', 'applyRateLimits(app', 'mountBridgePanelRoutes(app'])
            expect(stamp, step).to.be.lessThan(body.indexOf(step));
    });
});
