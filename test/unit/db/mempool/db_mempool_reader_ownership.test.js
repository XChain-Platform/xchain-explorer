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
 * The decoder mempool readers have one home, health/decoder.js, so the reader a
 * request gets never depends on which reader family was required first; and the
 * mempool feed's decoder-DB path reports a failed read as unknown, never as a
 * freshly read empty mempool.
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('../../../../src/db/index.js');

const SRC = path.join(__dirname, '../../../../src');

// A Database with no decoder endpoint and a colocated decoder DB whose reads the test scripts.
function dbOverDecoderDb(query) {
    const db = Object.create(Database.prototype);
    return Object.assign(db, {
        configInfo: { env: { MEMPOOL_COUNT_CACHE_MS: '1000' } },
        decoderApiUrl: {},
        decoderDb: { TST: 'XChain_TST_Decoder' },
        parseCoinCode: async () => null,
        doDecoderQuery: query,
        util: { isNull: value => value === null || value === undefined },
        _mempoolApiCache: {}
    });
}

function driverError(errno) {
    return Object.assign(new Error('decoder DB read failed'), { errno });
}

describe('mempool feed over the colocated decoder DB', () => {
    afterEach(() => sinon.restore());

    it('answers null, not a fresh empty window, when the decoder DB read fails', async () => {
        const db = dbOverDecoderDb(sinon.stub().rejects(driverError(1146)));
        expect(await db.getDecoderMempoolFeed({ coin: 'TST' }, 500)).to.equal(null);
    });

    it('answers null when the first_seen retry fails too', async () => {
        const query = sinon.stub();
        query.onCall(0).rejects(driverError(1054));
        query.onCall(1).rejects(driverError(1142));
        const db = dbOverDecoderDb(query);
        expect(await db.getDecoderMempoolFeed({ coin: 'TST' }, 500)).to.equal(null);
        expect(query.callCount).to.equal(2);
    });

    it('refuses /api/mempool with DECODER_MEMPOOL_UNAVAILABLE on a failed decoder DB read', async () => {
        const db = dbOverDecoderDb(sinon.stub().rejects(driverError(1045)));
        let thrown = null;
        try { await db.getMempool({ coin: 'TST', type: 'api', data: { search: '', type: '' } }); }
        catch (e) { thrown = e; }
        expect(thrown, 'getMempool must not answer 200 empty').to.not.equal(null);
        expect(String(thrown.message)).to.match(/^DECODER_MEMPOOL_UNAVAILABLE/);
    });

    it('stamps read_ok_at on a decoder DB read that returned, even an empty one', async () => {
        const db = dbOverDecoderDb(sinon.stub().resolves([]));
        const before = Date.now();
        const feed = await db.getDecoderMempoolFeed({ coin: 'TST' }, 500);
        expect(feed.rows).to.deep.equal([]);
        expect(feed.read_ok_at).to.be.at.least(before);
    });

    it('keeps the [] answer for a direct row read that fails', async () => {
        const db = dbOverDecoderDb(sinon.stub().rejects(driverError(1146)));
        expect(await db.getDecoderMempoolRows({ coin: 'TST' }, 500)).to.deep.equal([]);
    });
});

describe('decoder mempool reader ownership', () => {
    it('defines the mempool readers in health/decoder.js and nowhere else', () => {
        const decoder = require(path.join(SRC, 'db/readers/health/decoder.js'));
        const entities = require(path.join(SRC, 'db/readers/entities.js'));
        for (const name of ['getDecoderMempoolSnapshot', 'getDecoderMempoolCount', 'getDecoderMempoolRows', 'getDecoderMempoolFeed']) {
            expect(Object.getOwnPropertyDescriptor(decoder, name), name).to.not.equal(undefined);
            expect(Object.getOwnPropertyDescriptor(entities, name), name).to.equal(undefined);
            expect(Database.prototype[name], name).to.equal(decoder[name]);
        }
    });

    // A fresh process that requires the health family BEFORE the database entry, the
    // order that froze a stale-blind reader while another family patched it at load.
    it('serves the stale-aware snapshot whichever reader family is required first', () => {
        const script = `
            require(${JSON.stringify(path.join(SRC, 'db/readers/health.js'))});
            const Database = require(${JSON.stringify(path.join(SRC, 'db/index.js'))});
            const DecoderConnector = require(${JSON.stringify(path.join(SRC, 'connectors/decoder.js'))});
            DecoderConnector.prototype.getmempool = async () => ({ stale: true, read_ok_at: null, total: 0, rows: [] });
            const db = Object.assign(Object.create(Database.prototype), {
                configInfo: { env: { MEMPOOL_COUNT_CACHE_MS: '1000' } },
                decoderApiUrl: { TST: 'http://127.0.0.1:1' }, parseCoinCode: async () => null, _mempoolApiCache: {}
            });
            db.getDecoderMempoolSnapshot({ coin: 'TST' }).then(
                (snap) => { process.stdout.write(JSON.stringify({ snap })); process.exit(0); },
                (e) => { process.stdout.write(JSON.stringify({ error: String(e) })); process.exit(0); });`;
        const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
        expect(run.status, run.stderr).to.equal(0);
        const out = JSON.parse(run.stdout.trim().split('\n').pop());
        expect(out).to.deep.equal({ snap: null });
    });
});
