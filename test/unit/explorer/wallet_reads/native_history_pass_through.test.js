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
 * POST /{COIN}/api/native_history against a mocked tracker: one upstream
 * POST /history per request whatever the address count, only the tracker's
 * own fields forwarded, its answers and refusal codes passed back with their
 * status and paging headers, and a retryable refusal of our own when the
 * tracker is paused, unreachable or not configured.
 *
 *********************************************************************/

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const { ADDRESSES, buildExplorer, routeHandler, drive } = require('./support/wallet_fixture.js');

let explorer, route, fetchStub, base, baseCount = 0;

function trackerAnswer(status, json, headers = {}){
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { status, ok: status < 300, headers: { get: (name) => (name in lower ? lower[name] : null) }, json: async () => json };
}

function useMockedTracker(){
    beforeEach(() => {
        ({ explorer } = buildExplorer(null));
        // A fresh base per case: the connector's 429 pause is keyed by base URL.
        base = 'http://tracker-' + (++baseCount) + '.test';
        explorer.configInfo = Object.assign({}, explorer.configInfo, { env: { UTXO_TRACKER_URL_BTC: base } });
        route = routeHandler('post', '/:coin/api/native_history');
        fetchStub = sinon.stub(globalThis, 'fetch');
    });
    afterEach(() => sinon.restore());
}

function post(body){
    return drive(route, { path: '/BTC/api/native_history', body, ip: '203.0.113.7' });
}

const PAGE = {
    transactions: [{ txid: 'ab'.repeat(32), height: 900000, time: 1700000000, net: '-1500',
        addresses: { [ADDRESSES[0]]: { received: '0', sent: '1500', net: '-1500' } } }],
    cursor: '900000:3', history_from_height: 850000, sync: { synced: true }
};

describe('POST /{COIN}/api/native_history: pass-through', function () {
    useMockedTracker();

    it('makes one upstream call for 20 addresses and forwards only the tracker fields', async () => {
        fetchStub.resolves(trackerAnswer(200, PAGE, { 'X-Next-Cursor': '900000:3', 'X-Synced': 'true', 'X-Internal': 'no' }));
        const res = await post({ addresses: ADDRESSES, from_height: 850000, to_time: 1700000500, limit: 200,
            cursor: '900001:0', since: 5, junk: 'x' });
        expect(fetchStub.callCount).to.equal(1);
        const [url, init] = fetchStub.firstCall.args;
        expect(url).to.equal(base + '/history');
        expect(init.method).to.equal('POST');
        expect(JSON.parse(init.body)).to.deep.equal({ addresses: ADDRESSES, from_height: 850000, to_time: 1700000500,
            limit: 200, cursor: '900001:0' });
        expect(res.code).to.equal(200);
        expect(res.body).to.deep.equal(PAGE);
        expect(res.headers).to.include({ 'X-Next-Cursor': '900000:3', 'X-Synced': 'true' });
        expect(res.headers).to.not.have.property('X-Internal');
    });

    it('passes a tracker refusal back with its status and code', async () => {
        fetchStub.resolves(trackerAnswer(400, { error: 'cursor must be the cursor a previous page returned', code: 'INVALID_CURSOR' }));
        const res = await post({ addresses: [ADDRESSES[0]], cursor: 'bogus' });
        expect(res.code).to.equal(400);
        expect(res.body.code).to.equal('INVALID_CURSOR');
    });

    it('forwards a tracker 429, then sheds the next call locally until Retry-After passes', async () => {
        fetchStub.resolves(trackerAnswer(429, { error: 'Too many requests', code: 'RATE_LIMITED' }, { 'Retry-After': '30' }));
        const first = await post({ addresses: [ADDRESSES[0]] });
        expect(first.code).to.equal(429);
        expect(first.headers['Retry-After']).to.equal('30');
        const second = await post({ addresses: [ADDRESSES[0]] });
        expect(second.code).to.equal(503);
        expect(second.body).to.include({ code: 'TRACKER_UNAVAILABLE', retryable: true });
        expect(fetchStub.callCount).to.equal(1);
    });

    it('answers 502 TRACKER_UNAVAILABLE when the tracker does not answer', async () => {
        fetchStub.rejects(new Error('connect ECONNREFUSED'));
        const res = await post({ addresses: [ADDRESSES[0]] });
        expect(res.code).to.equal(502);
        expect(res.body.code).to.equal('TRACKER_UNAVAILABLE');
    });
});

describe('POST /{COIN}/api/native_history: client address and tracker states', function () {
    useMockedTracker();

    function sentHeaders(){
        return fetchStub.firstCall.args[1].headers;
    }

    it('forwards the trusted req.ip as X-Forwarded-For, never the header the client sent', async () => {
        fetchStub.resolves(trackerAnswer(200, PAGE));
        await drive(route, { path: '/BTC/api/native_history', ip: '203.0.113.7',
            headers: { 'x-forwarded-for': '6.6.6.6' }, body: { addresses: [ADDRESSES[0]] } });
        expect(sentHeaders()['X-Forwarded-For']).to.equal('203.0.113.7');
    });

    it('writes an IPv4-mapped address as plain IPv4 and sends no header for an unusable one', async () => {
        fetchStub.resolves(trackerAnswer(200, PAGE));
        await drive(route, { path: '/BTC/api/native_history', ip: '::ffff:198.51.100.9', body: { addresses: [ADDRESSES[0]] } });
        expect(sentHeaders()['X-Forwarded-For']).to.equal('198.51.100.9');
        await drive(route, { path: '/BTC/api/native_history', ip: 'not-an-ip', body: { addresses: [ADDRESSES[0]] } });
        expect(fetchStub.secondCall.args[1].headers).to.not.have.property('X-Forwarded-For');
    });

    it('passes the per-address watch fields through unchanged', async () => {
        const page = Object.assign({}, PAGE, { transactions: [], addresses: {
            [ADDRESSES[0]]: { history_status: 'backfilling', history_from_height: 850000 },
            [ADDRESSES[1]]: { history_status: 'not_watched', history_refused: 'IP_BUDGET' }
        } });
        fetchStub.resolves(trackerAnswer(200, page));
        const res = await post({ addresses: [ADDRESSES[0], ADDRESSES[1]] });
        expect(res.body.addresses).to.deep.equal(page.addresses);
    });

    it('passes the tracker 503 NOT_READY back with its code and Retry-After, and keeps calling it', async () => {
        fetchStub.resolves(trackerAnswer(503, { error: 'tracker has not indexed a block yet', code: 'NOT_READY' }, { 'Retry-After': '5' }));
        const first = await post({ addresses: [ADDRESSES[0]] });
        expect(first.code).to.equal(503);
        expect(first.body.code).to.equal('NOT_READY');
        expect(first.headers['Retry-After']).to.equal('5');
        await post({ addresses: [ADDRESSES[0]] });
        expect(fetchStub.callCount).to.equal(2);
    });
});

describe('POST /{COIN}/api/native_history: refused before any upstream call', function () {
    useMockedTracker();

    for(const [label, body, code] of [
        ['21 addresses', () => ({ addresses: [...ADDRESSES, ADDRESSES[0].slice(0, -1) + 'z'] }), 'TOO_MANY_ADDRESSES'],
        ['no addresses', () => ({ addresses: [] }), 'INVALID_ADDRESSES'],
        ['a malformed address', () => ({ addresses: ['1' + 'A'.repeat(33)] }), 'INVALID_ADDRESS']
    ]){
        it('refuses ' + label + ' with 400 ' + code, async () => {
            const res = await post(body());
            expect(res.code).to.equal(400);
            expect(res.body.code).to.equal(code);
            expect(fetchStub.callCount).to.equal(0);
        });
    }

    it('answers 503 TRACKER_NOT_CONFIGURED for a coin with no tracker URL', async () => {
        explorer.configInfo = Object.assign({}, explorer.configInfo, { env: {} });
        const res = await post({ addresses: [ADDRESSES[0]] });
        expect(res.code).to.equal(503);
        expect(res.body.code).to.equal('TRACKER_NOT_CONFIGURED');
        expect(fetchStub.callCount).to.equal(0);
    });
});
