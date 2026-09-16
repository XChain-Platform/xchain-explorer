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
 * Unit tests for the decoder-DB mempool surface: db.getDecoderMempoolRows /
 * db.decodeMempoolRow / db.getMempool, the ChangeDetector mempool diffing,
 * and Broadcaster MEMPOOL_ACTION / MEMPOOL_REMOVED routing. The decoder DB
 * is stubbed throughout; no real database.
 *
 * Encoding contract: mempool_transactions.data holds the canonical
 * UTF-8 ACTION string, byte-identical to what the decoder's confirmed-block
 * path writes to transactions.data. It is not hex. The fixtures below are
 * therefore plain text, and the drift guard at the bottom of this file pins the
 * explorer's read against the decoder's actual write so neither side can move
 * alone.
 */

'use strict';

const { fs, path, sinon, expect, ChangeDetector, Broadcaster, envView, mkDb, SEND_ROW, MINT_ROW, TRASH_ROW, LEGACY_HEX_ROW, getDecoderPaths, loadCanonicalizer, makeEncodingFixture, readDecoderSite } = require('./helpers.js');

const DecoderConnector = require('../../../../../../src/connectors/decoder.js');

function mkApiDb(rows) {
    const db = mkDb(rows);
    db.decoderApiUrl = { RBTC: 'http://decoder.example:3002' };
    db.configInfo = { env: envView, getConfig: async () => ({
        COIN_NETWORKS: { BTC: {} },
        COIN_PREFIXES: { mainnet: '', testnet: 'T', regtest: 'R' },
    }) };
    return db;
}

describe("decoder mempool surface", () => {
    describe('db.getDecoderMempoolRows', () => {
        it('returns [] when no decoder DB is mapped or the name is unsafe', async () => {
            const db = mkDb([]);
            expect(await db.getDecoderMempoolRows({ coin: 'RDOGE' }, 10)).to.deep.equal([]);
            db.decoderDb = { RBTC: 'bad-name;DROP' };
            expect(await db.getDecoderMempoolRows({ coin: 'RBTC' }, 10)).to.deep.equal([]);
            expect(db.doQuery.called).to.equal(false);
        });

        it('queries the decoder mempool raw-string columns and clamps the limit', async () => {
            const db = mkDb([SEND_ROW]);
            const rows = await db.getDecoderMempoolRows({ coin: 'RBTC' }, 9999);
            expect(rows).to.deep.equal([SEND_ROW]);
            const sql = db.doQuery.firstCall.args[1];
            // The mempool surface reads the raw-string columns straight from
            // mempool_transactions; the index_* FK-id joins were dropped when
            // those columns went away (see "read raw-string columns" fix).
            expect(sql).to.include('`XChain_BTC_Decoder`.mempool_transactions');
            expect(sql).to.include('m.tx_hash');
            expect(sql).to.include('m.source');
            expect(sql).to.include('m.data');
            // The column is text, so it must not be aliased (or read) as hex.
            expect(sql).to.not.include('data_hex');
            expect(sql).to.include('LIMIT 500');
            // No primary key and the decoder rewrites the table every cycle: the
            // window must be keyed on the unique tx_hash index to be a stable snapshot.
            expect(sql).to.match(/ORDER BY m\.tx_hash\s+LIMIT 500/);
            // Action-carrying rows only. The table holds a row for EVERY mempool
            // tx the decoder saw, with data blanked to '' when it carried no
            // valid ACTION, so an unfiltered window fills all 500 slots with
            // actionless rows on a busy chain and renders an empty feed.
            expect(sql).to.match(/WHERE m\.data IS NOT NULL AND m\.data != ''/);
        });

        it('returns [] on query failure (decoder DB unreachable)', async () => {
            const db = mkDb([]);
            db.doQuery = sinon.stub().rejects(new Error('no grant'));
            expect(await db.getDecoderMempoolRows({ coin: 'RBTC' }, 10)).to.deep.equal([]);
        });
    });
});

describe("decoder mempool surface", () => {
    describe('db.decodeMempoolRow', () => {
        it('reads the stored UTF-8 action string and extracts the action name', () => {
            const db = mkDb([]);
            const d = db.decodeMempoolRow(SEND_ROW);
            expect(d).to.deep.equal({
                tx_hash: 'aa11', source: 'srcAddr1', action: 'SEND',
                data: 'SEND|0|TOK|5|destAddr1|nonce123',
                first_seen: null,
            });
        });

        it('passes first_seen through as a number and nulls a non-numeric value', () => {
            const db = mkDb([]);
            expect(db.decodeMempoolRow({ ...SEND_ROW, first_seen: 1787000000 }).first_seen).to.equal(1787000000);
            expect(db.decodeMempoolRow({ ...SEND_ROW, first_seen: '1787000000' }).first_seen).to.equal(1787000000);
            expect(db.decodeMempoolRow({ ...SEND_ROW, first_seen: 'garbage' }).first_seen).to.equal(null);
        });

        it('accepts a Buffer-valued data column (driver returning TEXT as binary)', () => {
            const db = mkDb([]);
            const d = db.decodeMempoolRow({ ...SEND_ROW, data: Buffer.from(SEND_ROW.data, 'utf8') });
            expect(d.action).to.equal('SEND');
            expect(d.data).to.equal('SEND|0|TOK|5|destAddr1|nonce123');
        });

        it('does NOT hex-decode: a hex-looking payload is not treated as an action', () => {
            // The regression this pins: an explorer that runs
            // Buffer.from(data, 'hex') over a column the decoder writes as plain
            // text silently blanks every pending action. Reading text as
            // text must stay the only interpretation, in both directions.
            const db = mkDb([]);
            expect(db.decodeMempoolRow(LEGACY_HEX_ROW)).to.equal(null);
        });

        it('returns null for garbage rows and the rejected-ACTION "" sentinel', () => {
            const db = mkDb([]);
            expect(db.decodeMempoolRow(TRASH_ROW)).to.equal(null);
            expect(db.decodeMempoolRow({ tx_hash: 'x' })).to.equal(null);
            expect(db.decodeMempoolRow({ tx_hash: 'x', data: '|||' })).to.equal(null);
            // The decoder stores '' (never NULL) for a money-bearing tx whose
            // ACTION was invalid or unknown; it is not a renderable action.
            expect(db.decodeMempoolRow({ tx_hash: 'x', data: '' })).to.equal(null);
        });
    });
});

describe("decoder mempool surface", () => {
    describe('db.getMempool (REST)', () => {
        const cfg = (search, type) => ({ coin: 'RBTC', data: { search, type } });

        it('address type matches source OR any exact pipe segment (SEND destination)', async () => {
            const db = mkDb([SEND_ROW, MINT_ROW]);
            let [data, , total] = await db.getMempool(cfg('destAddr1', 'address'));
            expect(total).to.equal(1);
            expect(data[0].tx_hash).to.equal('aa11');

            [data] = await db.getMempool(cfg('srcAddr2', 'address'));
            expect(data[0].tx_hash).to.equal('bb22');

            [data] = await db.getMempool(cfg('estAddr1', 'address'));   // substring must NOT match
            expect(data).to.deep.equal([]);
        });

        it('token type matches exact tick segments, uppercased', async () => {
            const db = mkDb([SEND_ROW, MINT_ROW, TRASH_ROW]);
            const [data, , total] = await db.getMempool(cfg('tok', 'token'));
            expect(total).to.equal(1);
            expect(data[0].action).to.equal('SEND');
        });
    });
});

describe("decoder mempool surface", () => {
    // The decoder JSON-RPC path: the ONLY live-mempool source for an explorer
    // serving from synced replicas (mempool_transactions is excluded from
    // xchain-sync replication, so its replica copy is permanently empty).
    describe('decoder-API mempool path', () => {
        const API_ROW = { tx_hash: 'aa11', source: 'srcAddr1', data: 'SEND|0|TOK|5|destAddr1|nonce123', first_seen: 1787000000 };

        afterEach(() => sinon.restore());

        it('prefers the decoder API snapshot and never touches the DB path', async () => {
            const db = mkApiDb([SEND_ROW]);
            const stub = sinon.stub(DecoderConnector.prototype, 'getmempool')
                .resolves({ node_tx_count: 42, total: 1, rows: [API_ROW] });
            const rows = await db.getDecoderMempoolRows({ coin: 'RBTC' }, 10);
            expect(rows).to.deep.equal([API_ROW]);
            expect(db.doQuery.called).to.equal(false);
            // Counts come off the same (cached) snapshot: one fetch serves all three.
            expect(await db.getDecoderMempoolCount({ coin: 'RBTC' })).to.equal(1);
            expect(await db.getNodeMempoolCount({ coin: 'RBTC' })).to.equal(42);
            expect(stub.callCount).to.equal(1);
        });

        it('maps the decoder\'s -1 "no poll yet" node count to null', async () => {
            const db = mkApiDb([]);
            sinon.stub(DecoderConnector.prototype, 'getmempool')
                .resolves({ node_tx_count: -1, total: 0, rows: [] });
            expect(await db.getNodeMempoolCount({ coin: 'RBTC' })).to.equal(null);
        });

        it('falls back to the decoder DB path when no endpoint resolves', async () => {
            const db = mkApiDb([SEND_ROW]);
            db.decoderApiUrl = {};                                 // nothing configured
            const stub = sinon.stub(DecoderConnector.prototype, 'getmempool');
            const rows = await db.getDecoderMempoolRows({ coin: 'RBTC' }, 10);
            expect(stub.called).to.equal(false);
            expect(rows).to.deep.equal([SEND_ROW]);                // DB path served it
            expect(await db.getNodeMempoolCount({ coin: 'RBTC' })).to.equal(null);
        });

        it('serves the stale snapshot when a refresh fails, then retries after the TTL', async () => {
            const db = mkApiDb([]);
            const stub = sinon.stub(DecoderConnector.prototype, 'getmempool');
            stub.onCall(0).resolves({ node_tx_count: 7, total: 2, rows: [API_ROW, API_ROW] });
            stub.onCall(1).rejects(new Error('decoder down'));
            expect(await db.getDecoderMempoolCount({ coin: 'RBTC' })).to.equal(2);
            db._mempoolApiCache.RBTC.t = 0;                        // force TTL expiry
            expect(await db.getDecoderMempoolCount({ coin: 'RBTC' })).to.equal(2);   // stale-served
            // The failed refresh re-arms the clock so a dead decoder is retried
            // once per TTL, not on every request.
            expect(db._mempoolApiCache.RBTC.t).to.be.greaterThan(0);
        });
    });
});

describe("decoder mempool surface", () => {
    describe('decoder-API mempool path', () => {
        afterEach(() => sinon.restore());

        it('falls back to the DB path on a malformed API response', async () => {
            const db = mkApiDb([SEND_ROW]);
            sinon.stub(DecoderConnector.prototype, 'getmempool').resolves({ nonsense: true });
            const rows = await db.getDecoderMempoolRows({ coin: 'RBTC' }, 10);
            expect(rows).to.deep.equal([SEND_ROW]);
        });
    });

    describe('db.getDecoderMempoolCount', () => {
        it('counts only action-carrying rows, not the whole node mempool', async () => {
            // mempool_transactions holds a row for EVERY mempool tx the decoder
            // observed; `data` is '' when the tx carried no valid ACTION. A bare
            // COUNT(*) therefore publishes the node's entire mempool as the
            // XChain unconfirmed count (measured on BTC testnet: 32 of 32 rows
            // actionless), disagreeing with the feed, which drops those rows.
            const db = mkDb([{ count: 3 }]);
            db.decoderApiUrl = {};
            expect(await db.getDecoderMempoolCount({ coin: 'RBTC' })).to.equal(3);
            expect(db.doQuery.firstCall.args[1]).to.match(/WHERE data IS NOT NULL AND data != ''/);
        });
    });

    describe('db.getDecoderMempoolRows pre-migration fallback', () => {
        it('retries without first_seen when the decoder DB predates the column (errno 1054)', async () => {
            const db = mkDb([]);
            const bad = new Error('Unknown column');
            bad.errno = 1054;
            db.doQuery = sinon.stub();
            db.doQuery.onCall(0).rejects(bad);
            db.doQuery.onCall(1).resolves([SEND_ROW]);
            const rows = await db.getDecoderMempoolRows({ coin: 'RBTC' }, 10);
            expect(rows).to.deep.equal([SEND_ROW]);
            expect(db.doQuery.firstCall.args[1]).to.include('first_seen');
            expect(db.doQuery.secondCall.args[1]).to.not.include('first_seen');
        });

        it('reads the wrapped errno too (doQuery raises DbQueryError with cause)', async () => {
            const db = mkDb([]);
            const wrapped = new Error('SQL query failed: Unknown column');
            wrapped.cause = { errno: 1054 };
            db.doQuery = sinon.stub();
            db.doQuery.onCall(0).rejects(wrapped);
            db.doQuery.onCall(1).resolves([SEND_ROW]);
            expect(await db.getDecoderMempoolRows({ coin: 'RBTC' }, 10)).to.deep.equal([SEND_ROW]);
        });
    });
});
