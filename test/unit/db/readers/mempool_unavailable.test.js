'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');
const network    = require('../../../../src/db/readers/entities/network.js');
const detector   = require('../../../../src/ws/change_detector/mempool.js');

function makeDb(over) {
    const db = Object.create(network);
    Object.assign(db, {
        configInfo: { env: { MEMPOOL_COUNT_CACHE_MS: '1000' } },
        decoderApiUrl: { TST: 'http://127.0.0.1:1' },
        parseCoinCode: async () => null,
        getDecoderMempoolRows: async () => [],
        getDecoderMempoolSnapshot: async () => null,
        decodeMempoolRow: r => r,
        _mempoolApiCache: {}
    }, over);
    return db;
}

describe('mempool feed when the decoder is unavailable', () => {
    afterEach(() => sinon.restore());

    it('returns null when configured but the snapshot is null', async () => {
        const db = makeDb();
        expect(await db.getDecoderMempoolFeed({ coin: 'TST' }, 500)).to.equal(null);
    });

    it('returns null when the snapshot is older than two TTLs', async () => {
        const db = makeDb({
            getDecoderMempoolSnapshot: async () => ({ rows: [{ tx_hash: 'a' }] }),
            _mempoolApiCache: { TST: { okAt: Date.now() - 5000 } }
        });
        expect(await db.getDecoderMempoolFeed({ coin: 'TST' }, 500)).to.equal(null);
    });

    it('returns rows and read_ok_at for a fresh snapshot', async () => {
        const okAt = Date.now();
        const db = makeDb({
            getDecoderMempoolSnapshot: async () => ({ rows: [{ tx_hash: 'a' }, { tx_hash: 'b' }] }),
            _mempoolApiCache: { TST: { okAt } }
        });
        const feed = await db.getDecoderMempoolFeed({ coin: 'TST' }, 1);
        expect(feed.read_ok_at).to.equal(okAt);
        expect(feed.rows).to.have.length(1);
    });

    it('reads the decoder DB when no endpoint is configured', async () => {
        const db = makeDb({ decoderApiUrl: {}, getDecoderMempoolRows: async () => [{ tx_hash: 'z' }] });
        const feed = await db.getDecoderMempoolFeed({ coin: 'TST' }, 500);
        expect(feed.rows).to.have.length(1);
        expect(feed.read_ok_at).to.be.a('number');
    });

    it('getMempool throws instead of answering an empty list', async () => {
        const db = makeDb();
        let err = null;
        try { await db.getMempool({ coin: 'TST', data: {} }); } catch (e) { err = e; }
        expect(err).to.not.equal(null);
        expect(err.message).to.contain('DECODER_MEMPOOL_UNAVAILABLE');
    });

    it('the change detector skips the poll and keeps state on null', async () => {
        const seen = new Map([['h1', { source: 's', action: 'SEND', data: 'x' }]]);
        const ctx = Object.create(detector);
        ctx.db = { getDecoderMempoolFeed: async () => null, getDecoderMempoolRows: sinon.stub() };
        ctx.mempoolState = { TST: { seenHashes: seen, initialized: true } };
        ctx.emit = sinon.spy();
        await ctx.checkMempoolForCoin('TST');
        expect(ctx.emit.called).to.equal(false);
        expect(ctx.mempoolState.TST.seenHashes).to.equal(seen);
        expect(ctx.db.getDecoderMempoolRows.called).to.equal(false);
    });
});
