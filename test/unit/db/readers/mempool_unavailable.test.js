'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const Database = require('../../../../src/db/index.js');
const DecoderConnector = require('../../../../src/connectors/decoder.js');
const detector = require('../../../../src/ws/change_detector/mempool.js');

function makeDb(over) {
    const db = Object.create(Database.prototype);
    Object.assign(db, {
        configInfo: { env: { MEMPOOL_COUNT_CACHE_MS: '1000' } },
        decoderApiUrl: { TST: 'http://127.0.0.1:1' },
        decoderDb: { TST: 'XChain_TST_Decoder' },
        parseCoinCode: async () => null,
        doDecoderQuery: sinon.stub().resolves([]),
        util: { isNull: value => value === null || value === undefined },
        _mempoolApiCache: {}
    }, over);
    return db;
}

function reply(over) {
    return Object.assign({
        node_tx_count: 4,
        node_updated_at: Date.now(),
        stale: false,
        read_ok_at: Date.now(),
        total: 1,
        rows: [{ tx_hash: 'a', source: 's', data: 'SEND|0|TOK|1|d' }]
    }, over);
}

describe('mempool feed when the decoder is unavailable', () => {
    afterEach(() => sinon.restore());

    it('does not cache a stale decoder reply as a successful refresh', async () => {
        const clock = sinon.useFakeTimers({ now: 100000, toFake: ['Date'] });
        const read = sinon.stub(DecoderConnector.prototype, 'getmempool')
            .resolves(reply({ stale: true, read_ok_at: 99500 }));
        const db = makeDb();

        const first = await db.getDecoderMempoolSnapshot({ coin: 'TST' });
        const second = await db.getDecoderMempoolSnapshot({ coin: 'TST' });

        expect(first.read_ok_at).to.equal(99500);
        expect(second.read_ok_at).to.equal(99500);
        expect(read.callCount).to.equal(2);
        expect(db._mempoolApiCache.TST.okAt).to.equal(99500);
        expect(db._mempoolApiCache.TST.t).to.be.at.most(Date.now() - 1000);
        clock.restore();
    });

    it('rejects a stale reply with no recent successful read', async () => {
        const clock = sinon.useFakeTimers({ now: 100000, toFake: ['Date'] });
        sinon.stub(DecoderConnector.prototype, 'getmempool')
            .resolves(reply({ stale: true, read_ok_at: null }));
        const db = makeDb();

        expect(await db.getDecoderMempoolSnapshot({ coin: 'TST' })).to.equal(null);
        expect(await db.getDecoderMempoolFeed({ coin: 'TST' }, 500)).to.equal(null);
        clock.restore();
    });

    it('returns null count and rows instead of falling back when a configured decoder is unavailable', async () => {
        sinon.stub(DecoderConnector.prototype, 'getmempool').rejects(new Error('offline'));
        const db = makeDb();

        expect(await db.getDecoderMempoolCount({ coin: 'TST' })).to.equal(null);
        expect(await db.getDecoderMempoolRows({ coin: 'TST' }, 500)).to.equal(null);
        expect(db.doDecoderQuery.called).to.equal(false);
    });

    it('ages node_tx_count independently using node_updated_at', async () => {
        const clock = sinon.useFakeTimers({ now: 500000, toFake: ['Date'] });
        sinon.stub(DecoderConnector.prototype, 'getmempool').resolves(reply({
            node_tx_count: 9,
            node_updated_at: 500000 - 120001,
            read_ok_at: 500000
        }));
        const db = makeDb();

        const snapshot = await db.getDecoderMempoolSnapshot({ coin: 'TST' });
        expect(snapshot.node_tx_count).to.equal(null);
        expect(await db.getNodeMempoolCount({ coin: 'TST' })).to.equal(null);
        expect(await db.getDecoderMempoolCount({ coin: 'TST' })).to.equal(1);
        expect(await db.getDecoderMempoolRows({ coin: 'TST' }, 500)).to.have.length(1);
        clock.restore();
    });

    it('returns rows and read_ok_at for a fresh snapshot', async () => {
        sinon.stub(DecoderConnector.prototype, 'getmempool').resolves(reply({
            rows: [{ tx_hash: 'a' }, { tx_hash: 'b' }],
            total: 2
        }));
        const db = makeDb();
        const feed = await db.getDecoderMempoolFeed({ coin: 'TST' }, 1);

        expect(feed.read_ok_at).to.be.a('number');
        expect(feed.rows).to.have.length(1);
    });

    it('reads the decoder DB when no endpoint is configured', async () => {
        const row = { tx_hash: 'z' };
        const db = makeDb({ decoderApiUrl: {}, doDecoderQuery: sinon.stub().resolves([row]) });
        const feed = await db.getDecoderMempoolFeed({ coin: 'TST' }, 500);

        expect(feed.rows).to.deep.equal([row]);
        expect(feed.read_ok_at).to.be.a('number');
    });

    it('getMempool throws instead of answering an empty list', async () => {
        sinon.stub(DecoderConnector.prototype, 'getmempool').rejects(new Error('offline'));
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

    it('the change detector also keeps state when the direct row reader returns null', async () => {
        const seen = new Map([['h1', { source: 's', action: 'SEND', data: 'x' }]]);
        const ctx = Object.create(detector);
        ctx.db = { getDecoderMempoolRows: sinon.stub().resolves(null) };
        ctx.mempoolState = { TST: { seenHashes: seen, initialized: true } };
        ctx.emit = sinon.spy();

        await ctx.checkMempoolForCoin('TST');

        expect(ctx.emit.called).to.equal(false);
        expect(ctx.mempoolState.TST.seenHashes).to.equal(seen);
    });
});
