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
 * One table of decoder getmempool reply outcomes (malformed, empty, unknown,
 * unreachable) and what the snapshot, count, rows and feed readers in
 * health/decoder.js answer for each.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const Database = require('../../../../src/db/index.js');
const DecoderConnector = require('../../../../src/connectors/decoder.js');

const CONFIG = { coin: 'TST' };

// A Database with a decoder endpoint for TST and no colocated decoder DB.
function dbWithEndpoint() {
    const db = Object.create(Database.prototype);
    return Object.assign(db, {
        configInfo: { env: { MEMPOOL_COUNT_CACHE_MS: '1000' } },
        decoderApiUrl: { TST: 'http://decoder.invalid' },
        decoderDb: {},
        parseCoinCode: async () => null,
        doDecoderQuery: sinon.stub().resolves([]),
        util: { isNull: value => value === null || value === undefined, isNumeric: value => Number.isFinite(Number(value)) },
        _mempoolApiCache: {}
    });
}

const ROW = { tx_hash: 'aa', source: 'addr', data: 'SEND|0|TICK|1', first_seen: 1 };

const OUTCOMES = [
    {
        name: 'malformed reply (null)',
        reply: () => null,
        snapshot: null,
        count: 0,
        rows: [],
        feed: { rows: [] },
        malformed: true
    },
    {
        name: 'malformed reply (rows is not an array)',
        reply: () => ({ rows: 'nope', total: 3 }),
        snapshot: null,
        count: 0,
        rows: [],
        feed: { rows: [] },
        malformed: true
    },
    {
        name: 'empty reply (rows [] with a good read)',
        reply: () => ({ rows: [], total: 0, read_ok_at: Date.now() }),
        snapshot: { total: 0, rows: [] },
        count: 0,
        rows: [],
        feed: { rows: [] },
        malformed: false
    },
    {
        name: 'populated reply',
        reply: () => ({ rows: [ROW], total: 1, read_ok_at: Date.now() }),
        snapshot: { total: 1, rows: [ROW] },
        count: 1,
        rows: [ROW],
        feed: { rows: [ROW] },
        malformed: false
    },
    {
        name: 'unknown reply (stale with no read_ok_at)',
        reply: () => ({ rows: [ROW], total: 1, stale: true }),
        snapshot: null,
        count: null,
        rows: null,
        feed: null,
        malformed: false
    },
    {
        name: 'unknown reply (stale with a read older than two TTLs)',
        reply: () => ({ rows: [ROW], total: 1, stale: true, read_ok_at: Date.now() - 60000 }),
        snapshot: null,
        count: null,
        rows: null,
        feed: null,
        malformed: false
    },
    {
        name: 'unreachable decoder (transport throws)',
        reply: () => { throw new Error('ECONNREFUSED'); },
        snapshot: null,
        count: null,
        rows: null,
        feed: null,
        malformed: false
    }
];

describe('decoder mempool reply contract', () => {
    afterEach(() => sinon.restore());

    OUTCOMES.forEach(outcome => {
        describe(outcome.name, () => {
            let db;
            beforeEach(() => {
                db = dbWithEndpoint();
                sinon.stub(DecoderConnector.prototype, 'getmempool').callsFake(async () => outcome.reply());
            });

            it('getDecoderMempoolSnapshot', async () => {
                const snap = await db.getDecoderMempoolSnapshot(CONFIG);
                if (outcome.snapshot === null) return expect(snap).to.equal(null);
                expect(snap.total).to.equal(outcome.snapshot.total);
                expect(snap.rows).to.deep.equal(outcome.snapshot.rows);
            });

            it('flags the cache entry malformed only for a malformed reply', async () => {
                await db.getDecoderMempoolSnapshot(CONFIG);
                expect(Boolean(db._mempoolApiCache.TST.malformed)).to.equal(outcome.malformed);
            });

            it('getDecoderMempoolCount', async () => {
                expect(await db.getDecoderMempoolCount(CONFIG)).to.equal(outcome.count);
            });

            it('getDecoderMempoolRows', async () => {
                expect(await db.getDecoderMempoolRows(CONFIG, 500)).to.deep.equal(outcome.rows);
            });

            it('getDecoderMempoolFeed', async () => {
                const feed = await db.getDecoderMempoolFeed(CONFIG, 500);
                if (outcome.feed === null) return expect(feed).to.equal(null);
                expect(feed.rows).to.deep.equal(outcome.feed.rows);
                expect(feed.read_ok_at).to.be.a('number');
            });
        });
    });

    it('serves the last good window when the decoder becomes unreachable within two TTLs', async () => {
        const db = dbWithEndpoint();
        const stub = sinon.stub(DecoderConnector.prototype, 'getmempool');
        stub.onCall(0).resolves({ rows: [ROW], total: 1, read_ok_at: Date.now() });
        stub.onCall(1).rejects(new Error('ECONNRESET'));
        await db.getDecoderMempoolSnapshot(CONFIG);
        db._mempoolApiCache.TST.t -= 5000;
        const snap = await db.getDecoderMempoolSnapshot(CONFIG);
        expect(stub.callCount).to.equal(2);
        expect(snap.rows).to.deep.equal([ROW]);
    });
});
