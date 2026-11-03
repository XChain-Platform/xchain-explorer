/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 * Every UTXO tracker read the explorer makes leaves from the explorer's one
 * IP, so every client shares the tracker's single per-IP bucket, and a
 * balances batch spends twenty reads of it. A client inside every limit of its
 * own must still get tracker figures when heavier clients drain that bucket:
 * the explorer keeps a fair-share egress budget below the tracker's ceiling
 * and sheds the clients over their share locally. A refusal that still comes
 * back pauses the tracker for its Retry-After, and the unavailable warn line
 * is aggregated per tracker per window, not one line per refused read.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon = require('sinon');
const { expect } = require('chai');

const BASE = 'http://tracker.test';
const INFO = { type: 'p2wpkh', balances: { confirmed: '1', pending: '0', received: '1' }, utxos: { confirmed: 1, pending: 0 } };
const UPSTREAM_LIMIT = 500;               // the tracker's default per-IP ceiling
const UPSTREAM_WINDOW_MS = 60 * 1000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

let warnings;
let clock;

// A fresh reader and connector per test, so no window, pause or log count leaks
// between cases, with every warn line the read path writes captured.
function makeReader() {
    const logger = { getLogger: () => ({ warn: (code, meta) => warnings.push({ code, meta }), info() {}, error() {} }) };
    const tracker = proxyquire('../../../../../src/connectors/utxo_tracker.js', { '../observability': logger });
    const proto = proxyquire('../../../../../src/db/readers/entities/addresses.js', {
        '../../../connectors/utxo_tracker.js': tracker,
        '../../../observability': logger,
    });
    const reader = Object.create(proto);
    reader.configInfo = { env: { UTXO_TRACKER_URL_RBTC: BASE } };
    return reader;
}

const refused = (retryAfter) => new Response('{"error":"Too many requests"}', {
    status: 429, headers: retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) },
});
const ok = () => new Response(JSON.stringify(INFO), { status: 200, headers: { 'Content-Type': 'application/json' } });

// The tracker's per-IP bucket: every explorer read comes from one IP, so one bucket.
function upstreamBucket() {
    const bucket = { windows: new Map(), refused: 0, calls: 0 };
    bucket.fetch = async () => {
        bucket.calls++;
        const w = Math.floor((Date.now() - T0) / UPSTREAM_WINDOW_MS);
        const n = (bucket.windows.get(w) || 0) + 1;
        bucket.windows.set(w, n);
        if (n > UPSTREAM_LIMIT) { bucket.refused++; return refused(9); }
        return ok();
    };
    return bucket;
}

const read = (reader, clientIp, address) => reader.getAddressTrackerInfo({ coin: 'RBTC', clientIp }, address);
const unavailableLines = () => warnings.filter((w) => w.code === 'UTXO_TRACKER_UNAVAILABLE');

describe('UTXO tracker egress: fair share across explorer clients', function () {
    beforeEach(() => {
        warnings = [];
        clock = sinon.useFakeTimers({ now: T0, toFake: ['Date'] });
    });
    afterEach(() => { clock.restore(); sinon.restore(); });

    it('a light client keeps its tracker figures while heavy batch clients drain the shared bucket', async function () {
        const bucket = upstreamBucket();
        sinon.stub(global, 'fetch').callsFake(bucket.fetch);
        const reader = makeReader();
        const heavy = ['198.18.7.10', '198.18.7.11', '198.18.7.12', '198.18.7.13'];
        const light = { served: 0, blank: 0 };
        // Two minutes: each heavy client spends 4 reads a second (a 20-address batch
        // every 5 s, 960 a minute between them); the light client reads every 2 s.
        for (let s = 0; s < 120; s++) {
            for (const ip of heavy)
                for (let i = 0; i < 4; i++) await read(reader, ip, 'bcrt1qheavy' + s + '_' + i);
            if (s % 2 === 0) {
                const info = await read(reader, '198.18.7.50', 'bcrt1qlight' + s);
                if (info) light.served++; else light.blank++;
            }
            clock.tick(1000);
        }
        expect(light.blank, 'light-client reads answered without tracker figures').to.equal(0);
        expect(light.served).to.equal(60);
        expect(bucket.refused, 'reads the tracker itself refused').to.equal(0);
    });

    it('a heavy client over its share is answered unavailable without a tracker call', async function () {
        const bucket = upstreamBucket();
        sinon.stub(global, 'fetch').callsFake(bucket.fetch);
        const reader = makeReader();
        reader.configInfo.env.EXPLORER_TRACKER_EGRESS_RPM = '40';
        for (let i = 0; i < 30; i++) await read(reader, '198.18.7.10', 'bcrt1qa' + i);   // under the soft line
        await read(reader, '198.18.7.50', 'bcrt1qlight');                                 // a second client
        const before = bucket.calls;
        expect(await read(reader, '198.18.7.10', 'bcrt1qover')).to.equal(null);           // 30 of 40, share 20
        expect(bucket.calls).to.equal(before);
        expect(await read(reader, '198.18.7.50', 'bcrt1qlight2')).to.deep.equal(INFO);
    });
});

describe('UTXO tracker egress: refusals and the log', function () {
    beforeEach(() => {
        warnings = [];
        clock = sinon.useFakeTimers({ now: T0, toFake: ['Date'] });
    });
    afterEach(() => { clock.restore(); sinon.restore(); });

    it('1000 refused sub-reads make one tracker call and one warn line, then a counted line', async function () {
        const fetchStub = sinon.stub(global, 'fetch').callsFake(async () => refused(30));
        const reader = makeReader();
        for (let i = 0; i < 1000; i++)
            expect(await read(reader, '198.18.20.' + (i % 250), 'bcrt1q' + i)).to.equal(null);
        expect(fetchStub.callCount).to.equal(1);
        expect(unavailableLines()).to.have.length(1);
        expect(unavailableLines()[0].meta).to.include({ err: 'HTTP 429', failed: 1, shed: 0 });
        clock.tick(UPSTREAM_WINDOW_MS);
        await read(reader, '198.18.20.1', 'bcrt1qlast');
        expect(unavailableLines()).to.have.length(2);
        expect(unavailableLines()[1].meta).to.include({ failed: 1, shed: 999 });
    });

    it('pauses the tracker for its Retry-After, then asks again', async function () {
        const fetchStub = sinon.stub(global, 'fetch');
        fetchStub.onFirstCall().callsFake(async () => refused(2));
        fetchStub.callsFake(async () => ok());
        const reader = makeReader();
        expect(await read(reader, '198.18.7.10', 'bcrt1qa')).to.equal(null);
        clock.tick(1999);
        expect(await read(reader, '198.18.7.11', 'bcrt1qa')).to.equal(null);
        expect(fetchStub.callCount).to.equal(1);
        clock.tick(2);
        expect(await read(reader, '198.18.7.11', 'bcrt1qa')).to.deep.equal(INFO);
        expect(fetchStub.callCount).to.equal(2);
    });

    it('a transport outage still answers null and logs at once', async function () {
        sinon.stub(global, 'fetch').rejects(new Error('connect ECONNREFUSED'));
        const reader = makeReader();
        expect(await read(reader, '198.18.7.10', 'bcrt1qa')).to.equal(null);
        expect(unavailableLines()).to.have.length(1);
        expect(unavailableLines()[0].meta.err).to.equal('connect ECONNREFUSED');
    });
});

// The read is charged to the end client only if the client's address reaches the
// reader's config from both entry paths: a direct GET and a balances batch.
describe('UTXO tracker egress: the end client reaches the reader', function () {
    it('request state carries req.ip as config.clientIp', function () {
        const { newRequestState } = require('../../../../../src/explorer/request/state.js');
        const explorer = { response: {}, util: { startTimer: () => null } };
        const st = newRequestState(explorer, { ip: '203.0.113.7', path: '/RBTC/api/address/x', query: {} }, {});
        expect(st.cfg.clientIp).to.equal('203.0.113.7');
    });

    it('a batch inner read carries the batch caller\'s ip', async function () {
        const { methods } = require('../../../../../src/explorer/batch.js');
        const seen = [];
        const host = Object.create(methods);
        host.processRequest = async (req, res) => { seen.push(req.ip); res.status(200).send('{}'); };
        await host.readApi('RBTC', '/address/x', {}, '198.51.100.9');
        expect(seen).to.deep.equal(['198.51.100.9']);
    });
});
