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
 **********************************************************************
 * The coin home page kept rendering its summary counters at 0 and its
 * Network Information panel blank after a coin had recovered from a 503
 * COIN_DATA_STALE, until the reader loaded a later page.
 *
 * Two client-side legs produced that, both in src/content/js/xchain.js:
 *
 *   1. /api/status deletes a coin from `available` while its indexed tip is
 *      stale, and the client stores that status in localStorage for 5 minutes.
 *      getCoinNetworkInfo returned early on that verdict, dropping the page's
 *      render callback, so a page loaded after recovery made NO /api/* request
 *      at all and left the markup defaults on screen.
 *
 *   2. loadApiData only ever calls back on a 2xx. getCoinNetworkInfo arms
 *      XC.pendingNetworkInfoRequest before the call, so a 503 left that flag
 *      set for the life of the page and every later call fell into a retry
 *      branch that never issued a request.
 *
 * These run the shipped functions against a scripted API so both legs are
 * pinned at the behavior, not at the shape of the fix.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');

const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8');

// Slice a top-level function out of the source by walking braces (the same
// technique the sibling content-client tests use) so this runs shipped code
// rather than a copy that can drift.
function extractFn(name) {
    const sig = 'function ' + name + '(';
    const start = SRC.indexOf(sig);
    if (start < 0) throw new Error('function not found in xchain.js: ' + name);
    const braceStart = SRC.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < SRC.length; i++) {
        const c = SRC[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return SRC.slice(start, i);
}

const NETWORK_BODY = {
    totals:  { sends: 42, tokens: 3 },
    network: { block: 1000, time: 1, unconfirmed: 0, unconfirmed_node: null },
    fee:     { low: 1, high: 3 },
    coin:    { name: 'Dogecoin', symbol: 'DOGE', price: { btc: '1.00000000', usd: '0.00' } },
    xchain:  { name: 'XChain', symbol: 'XCHAIN', price: { btc: '0.00000000', usd: '0.00' } }
};

// Build a page whose only moving parts are the shipped functions under test.
// `routes` maps a request URL to either a body (answered 200) or
// { status } (answered as a failure, the way jQuery routes a non-2xx).
const openWindows = [];

function harness(routes, opts = {}) {
    const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
    const w   = dom.window;
    // The stale-coin recheck is a self-rescheduling poll by design; close the window
    // after each test so its timers cannot outlive the case that started them.
    openWindows.push(w);
    const requests = [];
    const store    = Object.assign({}, opts.storage || {});

    w.requests = requests;
    w.ls = {
        getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); }
    };
    w.store = store;
    w.$ = {
        getJSON: function (url, success) {
            requests.push(url);
            const route = routes[url];
            const fail  = { fail: function (fn) { if (route && route.status) fn({ status: route.status, responseJSON: route.body || null }); return this; } };
            if (route && !route.status) success(route);
            return fail;
        }
    };
    w.XC = Object.assign({
        coin: 'TDOGE',
        debug: false,
        // Keep the still-stale recheck fast enough for a test to observe it.
        networkRecheckMs: 5
    }, opts.XC || {});
    w.eval('function isNull(v){ return (v === null || v === undefined || v === ""); }');
    w.eval(extractFn('loadApiData'));
    w.eval(extractFn('getCoinNetworkInfo'));
    w.eval(extractFn('getExplorerStatusInfo'));
    return { window: w, requests, store };
}

function statusBody(available) {
    return { supported: { TDOGE: 'DOGE (testnet)' }, available: available, timestamp: Date.now() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('coin network info recovery after a COIN_DATA_STALE 503', function () {

    afterEach(function () {
        while (openWindows.length) openWindows.pop().close();
    });

    describe('loadApiData', function () {

        it('answers the errback, not the callback, on a non-2xx', function () {
            const h = harness({ '/TDOGE/api/network': { status: 503, body: { code: 'COIN_DATA_STALE' } } });
            let ok = 0, failed = null;
            h.window.loadApiData('TDOGE', 'network', null, null,
                function () { ok++; },
                function (body, xhr) { failed = { body, status: xhr && xhr.status }; });
            expect(ok, 'the success callback must not run for a 503').to.equal(0);
            expect(failed, 'the errback must run so the caller can disarm').to.not.equal(null);
            expect(failed.status).to.equal(503);
            expect(failed.body.code).to.equal('COIN_DATA_STALE');
        });

        it('answers the errback for a 200 whose body carries an error', function () {
            const h = harness({ '/TDOGE/api/network': { error: 'nope' } });
            let ok = 0, failed = 0;
            h.window.loadApiData('TDOGE', 'network', null, null,
                function () { ok++; }, function () { failed++; });
            expect(ok).to.equal(0);
            expect(failed).to.equal(1);
        });
    });

    describe('getCoinNetworkInfo', function () {

        it('re-reads the status when the cached one still calls the coin unavailable, and renders once it is back', function () {
            // The status in localStorage is FRESH (well inside its 5 minute window)
            // and was captured while the coin was stale, so it does not list the
            // coin. The coin itself is healthy again and /api/network answers.
            const h = harness({
                '/TDOGE/api/status':  statusBody({ TDOGE: 'DOGE (testnet)' }),
                '/TDOGE/api/network': NETWORK_BODY
            }, {
                storage: { 'xchain-explorer-status-info': JSON.stringify(statusBody({})) },
                XC: { status: statusBody({}) }
            });

            let rendered = null;
            h.window.getCoinNetworkInfo(function (o) { rendered = o; });

            expect(h.requests, 'the stale verdict must be re-checked, not obeyed for 5 minutes')
                .to.include('/TDOGE/api/status');
            expect(h.requests, 'and the recovered coin must be asked for its network info')
                .to.include('/TDOGE/api/network');
            expect(rendered, "the page's render callback must not be dropped").to.not.equal(null);
            expect(rendered.totals.sends).to.equal(42);
            expect(rendered.network.block).to.equal(1000);
        });

        it('keeps re-checking while the coin is still stale instead of waiting for a page load', async function () {
            const h = harness({
                '/TDOGE/api/status': statusBody({}),   // still stale
                '/TDOGE/api/network': NETWORK_BODY
            }, {
                storage: { 'xchain-explorer-status-info': JSON.stringify(statusBody({})) },
                XC: { status: statusBody({}) }
            });

            h.window.getCoinNetworkInfo(function () {});
            const first = h.requests.filter((u) => u === '/TDOGE/api/status').length;
            expect(first).to.equal(1);
            await sleep(60);
            expect(h.requests.filter((u) => u === '/TDOGE/api/status').length,
                'a still-stale coin is re-checked on the recheck interval').to.be.greaterThan(first);
            expect(h.requests.filter((u) => u === '/TDOGE/api/network').length,
                'and no network request is issued while it is still stale').to.equal(0);
        });

        it('does not leave the in-flight flag armed when the network request 503s', function () {
            const h = harness({
                '/TDOGE/api/network': { status: 503, body: { code: 'COIN_DATA_STALE' } }
            });

            h.window.getCoinNetworkInfo(function () {});
            expect(h.window.XC.pendingNetworkInfoRequest,
                'a failed request must disarm the flag it armed').to.not.equal(true);
            expect(h.requests.filter((u) => u === '/TDOGE/api/network').length).to.equal(1);

            // With the flag stuck, this second call fell into the "retry in 1000ms"
            // branch and issued nothing, for the life of the page.
            h.window.getCoinNetworkInfo(function () {});
            expect(h.requests.filter((u) => u === '/TDOGE/api/network').length,
                'a later call must be able to retry').to.equal(2);
        });

        it('caches nothing on a failed request, so the next call re-requests', function () {
            const h = harness({
                '/TDOGE/api/network': { status: 503, body: { code: 'COIN_DATA_STALE' } }
            });
            h.window.getCoinNetworkInfo(function () {});
            expect(h.store['TDOGE-network-info'],
                'a 503 body must never be stored as the coin network info').to.equal(undefined);
        });
    });

    describe('getExplorerStatusInfo', function () {

        it('does not leave its in-flight flag armed when the status request fails', function () {
            const h = harness({ '/TDOGE/api/status': { status: 503 } });
            h.window.getExplorerStatusInfo(function () {});
            expect(h.window.XC.pendingStatusInfoRequest).to.not.equal(true);
            h.window.getExplorerStatusInfo(function () {});
            expect(h.requests.filter((u) => u === '/TDOGE/api/status').length).to.equal(2);
        });

        it('answers its callback even when the request fails and nothing is cached', function () {
            const h = harness({ '/TDOGE/api/status': { status: 503 } });
            let called = 0;
            h.window.getExplorerStatusInfo(function () { called++; });
            expect(called, 'a caller waiting on the status must not wait forever').to.equal(1);
        });
    });
});
