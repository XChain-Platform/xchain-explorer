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

const fs             = require('fs');
const path           = require('path');
const sinon          = require('sinon');
const { expect }     = require('chai');
const Database       = require('../../src/db.js');
const ChangeDetector = require('../../src/ws/ChangeDetector.js');
const Broadcaster    = require('../../src/ws/Broadcaster.js');

const hex = (s) => Buffer.from(s, 'utf8').toString('hex');

// A db instance with the decoder name map + stubbed query layer.
function mkDb(rows) {
    const db = Object.create(Database.prototype);
    const Utility = require('../../src/utility.js');
    db.util = new Utility();
    db.decoderDb = { RBTC: 'XChain_BTC_Decoder' };
    db.doQuery = sinon.stub().resolves(rows);
    // getMempool TYPE=address forward-resolves the queried address to its index
    // id (byte-exactly, to match compacted `^<id>` destinations). Stub it here so
    // the shared doQuery stub is not asked to answer two different queries; the
    // compacted path has its own tests in db.mempool-address-refs.test.js.
    db.getExactAddressId = sinon.stub().resolves(null);
    return db;
}

const SEND_ROW  = { tx_hash: 'aa11', source: 'srcAddr1', data: 'SEND|0|TOK|5|destAddr1|nonce123' };
const MINT_ROW  = { tx_hash: 'bb22', source: 'srcAddr2', data: 'MINT|0|OTHER|9' };
const TRASH_ROW = { tx_hash: 'cc33', source: 'srcAddr3', data: 'zz-not-an-action-!!' };
// A row written by an older decoder that still hex-encoded the payload.
// It must NOT decode: the mempool feed drops it rather than showing mojibake.
const LEGACY_HEX_ROW = { tx_hash: 'dd44', source: 'srcAddr4', data: hex('SEND|0|TOK|5|destAddr1|nonce123') };

describe('decoder mempool surface', () => {

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
            // The regression this pins: the explorer used to run
            // Buffer.from(data, 'hex') over a column the decoder writes as plain
            // text, which silently blanked every pending action. Reading text as
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

    // The decoder JSON-RPC path: the ONLY live-mempool source for an explorer
    // serving from synced replicas (mempool_transactions is excluded from
    // xchain-sync replication, so its replica copy is permanently empty).
    describe('decoder-API mempool path', () => {
        const DecoderConnector = require('../../src/XChainDecoderConnector.js');
        const API_ROW = { tx_hash: 'aa11', source: 'srcAddr1', data: 'SEND|0|TOK|5|destAddr1|nonce123', first_seen: 1787000000 };

        function mkApiDb(rows) {
            const db = mkDb(rows);
            db.decoderApiUrl = { RBTC: 'http://decoder.example:3002' };
            db.configInfo = { getConfig: async () => ({
                COIN_NETWORKS: { BTC: {} },
                COIN_PREFIXES: { mainnet: '', testnet: 'T', regtest: 'R' },
            }) };
            return db;
        }

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

    describe('ChangeDetector mempool diffing', () => {
        function mkDetector(db) {
            const cd = new ChangeDetector({ db, pollInterval: 999999 });
            cd.mempoolState.RBTC = { seenHashes: new Map(), initialized: false };
            return cd;
        }

        it('seeds silently on first poll, then emits mempool_action for new rows', async () => {
            const db = mkDb([SEND_ROW]);
            db.getDecoderMempoolRows = sinon.stub();
            db.getDecoderMempoolRows.onCall(0).resolves([SEND_ROW]);
            db.getDecoderMempoolRows.onCall(1).resolves([SEND_ROW, MINT_ROW]);
            const cd = mkDetector(db);
            const seen = [];
            cd.on('mempool_action', (coin, row) => seen.push([coin, row.tx_hash, row.action]));

            await cd._checkMempoolForCoin('RBTC');                 // seed
            expect(seen).to.deep.equal([]);
            await cd._checkMempoolForCoin('RBTC');                 // MINT_ROW is new
            expect(seen).to.deep.equal([['RBTC', 'bb22', 'MINT']]);
        });

        it('emits mempool_removed when a tx leaves the mempool', async () => {
            const db = mkDb([]);
            db.getDecoderMempoolRows = sinon.stub();
            db.getDecoderMempoolRows.onCall(0).resolves([SEND_ROW, MINT_ROW]);
            db.getDecoderMempoolRows.onCall(1).resolves([MINT_ROW]);
            const cd = mkDetector(db);
            const removed = [];
            cd.on('mempool_removed', (coin, row) => removed.push(row.tx_hash));

            await cd._checkMempoolForCoin('RBTC');                 // seed
            await cd._checkMempoolForCoin('RBTC');                 // SEND_ROW gone
            expect(removed).to.deep.equal(['aa11']);
        });

        // The read is ORDER BY tx_hash LIMIT 500. A full window does not cover the
        // table, so an already-seen hash above the largest hash read is unknown,
        // not gone: no false mempool_removed, and no re-announce when it returns.
        it('does not emit mempool_removed for a hash above a saturated window, and carries it forward', async () => {
            const mk = (i) => ({ tx_hash: 'h' + String(i).padStart(4, '0'), source: 's', data: 'MINT|0|TOK|1' });
            const first  = Array.from({ length: 500 }, (_, i) => mk(i * 2));        // h0000..h0998
            const shifted = Array.from({ length: 500 }, (_, i) => mk(i));           // h0000..h0499 (new low hashes arrived)
            const db = mkDb([]);
            db.getDecoderMempoolRows = sinon.stub();
            db.getDecoderMempoolRows.onCall(0).resolves(first);
            db.getDecoderMempoolRows.onCall(1).resolves(shifted);
            db.getDecoderMempoolRows.onCall(2).resolves(first);
            const cd = mkDetector(db);
            const removed = [], seen = [];
            cd.on('mempool_removed', (c, r) => removed.push(r.tx_hash));
            cd.on('mempool_action',  (c, r) => seen.push(r.tx_hash));
            await cd._checkMempoolForCoin('RBTC');                 // seed
            await cd._checkMempoolForCoin('RBTC');                 // window shifted down
            expect(removed).to.deep.equal([]);                     // h0500..h0998 fell above the window, not gone
            expect(seen.length).to.equal(250);                     // the odd low hashes are genuinely new
            await cd._checkMempoolForCoin('RBTC');                 // window shifts back over them
            expect(seen.length).to.equal(250);                     // carried forward: not re-announced
            // The odd hashes h0001..h0499 now sort below the covered bound and are absent: gone.
            expect(removed.length).to.equal(250);
            expect(removed.every((h) => Number(h.slice(1)) % 2 === 1)).to.equal(true);
        });

        it('emits mempool_removed for every missing hash when the window is short of the cap', async () => {
            const db = mkDb([]);
            db.getDecoderMempoolRows = sinon.stub();
            db.getDecoderMempoolRows.onCall(0).resolves([SEND_ROW, MINT_ROW, TRASH_ROW]);
            db.getDecoderMempoolRows.onCall(1).resolves([SEND_ROW]);
            const cd = mkDetector(db);
            const removed = [];
            cd.on('mempool_removed', (c, r) => removed.push(r.tx_hash));
            await cd._checkMempoolForCoin('RBTC');
            await cd._checkMempoolForCoin('RBTC');
            expect(removed.sort()).to.deep.equal(['bb22', 'cc33']);
        });

        it('skips garbage rows without breaking the diff', async () => {
            const db = mkDb([]);
            db.getDecoderMempoolRows = sinon.stub();
            db.getDecoderMempoolRows.onCall(0).resolves([]);
            db.getDecoderMempoolRows.onCall(1).resolves([TRASH_ROW]);
            const cd = mkDetector(db);
            const seen = [];
            cd.on('mempool_action', (c, r) => seen.push(r));
            await cd._checkMempoolForCoin('RBTC');
            await cd._checkMempoolForCoin('RBTC');
            expect(seen).to.deep.equal([]);                        // decoded null → not emitted
        });
    });

    describe('Broadcaster mempool routing', () => {
        function mkBroadcaster() {
            const detector = new (require('events').EventEmitter)();
            const sent = [];
            const b = new Broadcaster({ wsServer: {}, changeDetector: detector });
            b._broadcastToChannel = (coin, channel, event, raw, entity) =>
                sent.push({ coin, channel, type: event.type, entity: entity || null, data: event.data });
            return { detector, sent, b };
        }

        // Mempool frames are queued on the per-coin promise tail (_mempoolTails)
        // because the fan-out awaits address-id resolution, so a test has to let
        // the tail settle before asserting.
        const settle = (b, coin) => b._mempoolTails.get(coin) || Promise.resolve();

        it('routes MEMPOOL_ACTION to the source address channel + the mempool channel', async () => {
            const { detector, sent, b } = mkBroadcaster();
            detector.emit('mempool_action', 'RBTC', { tx_hash: 'aa11', source: 'srcAddr1', action: 'SEND', data: 'SEND|0|TOK|5|d|m' });
            await settle(b, 'RBTC');
            expect(sent.map((s) => [s.channel, s.type, s.entity])).to.deep.equal([
                ['address', 'MEMPOOL_ACTION', 'srcAddr1'],
                ['mempool', 'MEMPOOL_ACTION', null],
            ]);
            expect(sent[1].data.data).to.equal('SEND|0|TOK|5|d|m');
        });

        it('routes MEMPOOL_REMOVED to the mempool channel and the source address channel', async () => {
            const { detector, sent, b } = mkBroadcaster();
            detector.emit('mempool_removed', 'RBTC', { tx_hash: 'aa11' });
            await settle(b, 'RBTC');
            expect(sent).to.have.lengthOf(1);                       // no source: nowhere to route it
            expect(sent[0]).to.include({ channel: 'mempool', type: 'MEMPOOL_REMOVED' });

            detector.emit('mempool_removed', 'RBTC', { tx_hash: 'bb22', source: 'srcAddr1', data: 'SEND|0|TOK|5|d|m' });
            await settle(b, 'RBTC');
            expect(sent.slice(1).map((s) => [s.channel, s.entity])).to.deep.equal([
                ['address', 'srcAddr1'],
                ['mempool', null],
            ]);
        });
    });

    /******************************************************************
     * Cross-repo encoding pin
     *
     * The explorer's read and the decoder's write have to agree on how
     * mempool_transactions.data is encoded, and they live in two repos, so a
     * test inside either one alone cannot catch a one-sided change: that is
     * exactly how the explorer ended up hex-decoding a column the decoder had
     * started writing as text. These two tests drive the decoder's own
     * canonicalization into the explorer's own reader, and read the decoder's
     * write site directly, so moving either side turns this red.
     *
     * Skips when no sibling xchain-decoder checkout is present (always true in
     * the platform monorepo; the standalone-explorer CI job has no decoder).
     *****************************************************************/
    describe('decoder/explorer mempool encoding pin', () => {
        const decoderRoot = process.env.XCHAIN_DECODER_ROOT ||
                            path.resolve(__dirname, '../../../xchain-decoder');
        const decoderSrc  = path.join(decoderRoot, 'src', 'XChainDecoder.js');
        const hasDecoder  = fs.existsSync(decoderSrc);

        // The decoder's module tree is loaded here rather than inside the first case.
        // A synchronous require of it costs seconds on a cold venue, and mocha charges
        // that to whichever case runs first, so the file reddened on the clock with a
        // "Timeout exceeded" against a cross-repo parity assertion that had not moved.
        // A hook with its own budget absorbs the load; raising a per-test timeout would
        // only move the same cost somewhere else.
        let canonicalizeActionPayload = null;
        let decoderLoadFailed = false;
        before(function () {
            if (!hasDecoder) return;
            this.timeout(60000);
            try {
                ({ canonicalizeActionPayload } = require(decoderSrc));
            } catch (e) {
                decoderLoadFailed = true;          // sibling checkout without installed deps
            }
        });

        it('the decoder-canonical stored form is what the explorer reader parses', function () {
            if (!hasDecoder || decoderLoadFailed) this.skip();
            const strict = new TextDecoder('utf-8', { fatal: true });
            const db = mkDb([]);
            const SAMPLES = [
                'SEND|0|TOK|5|destAddr1|nonce123',
                'ATTEST|0|hello world',
            ];
            for (const wire of SAMPLES) {
                // Exactly what the decoder's mempool path writes to the column.
                const canonical = canonicalizeActionPayload(Buffer.from(wire, 'utf8'));
                const stored    = strict.decode(canonical.buffer);
                expect(stored, 'decoder stored form drifted from the UTF-8 ACTION string').to.equal(wire);

                const decoded = db.decodeMempoolRow({ tx_hash: 'aa11', source: 'srcAddr1', data: stored });
                expect(decoded, 'explorer could not read the decoder stored form for ' + wire).to.not.equal(null);
                expect(decoded.data).to.equal(wire);
                expect(decoded.action).to.equal(wire.split('|')[0]);
            }
        });

        it('the decoder mempool INSERT still passes the decoded string, not hex', function () {
            if (!hasDecoder) this.skip();
            const src = fs.readFileSync(decoderSrc, 'utf8');
            const at  = src.indexOf('insertMempoolTransaction({');
            expect(at, 'decoder mempool INSERT call site not found').to.be.greaterThan(-1);
            // The assignment of the value bound to `data:` lives just above the call.
            const site = src.slice(Math.max(0, at - 2500), at + 600);
            // The decoder folded the mempool and confirmed-block writes into one
            // storage gate, so the UTF-8 decode moved out of this call site and into
            // buildStoredActionRecord. What this pin protects is unchanged: the column
            // still receives the decoded string. Assert the binding here and the decode
            // in the helper that now owns it, rather than the old inline variable.
            expect(site, 'decoder mempool INSERT no longer stores the shared storage-gate record')
                .to.match(/data:\s*stored\.data/);
            expect(site, 'decoder mempool payload no longer comes from the shared storage gate')
                .to.include('buildStoredActionRecord(');
            const gateAt = src.indexOf('buildStoredActionRecord(parseResult, txHash, mempool)');
            expect(gateAt, 'decoder storage gate buildStoredActionRecord not found').to.be.greaterThan(-1);
            const gate = src.slice(gateAt, gateAt + 4000);
            expect(gate, 'decoder storage gate no longer produces the payload by a UTF-8 decode')
                .to.match(/decode\(\s*canonical\.buffer\s*\)/);
            expect(site, 'decoder mempool write reintroduced hex encoding; the explorer read must move with it')
                .to.not.match(/toString\(\s*['"]hex['"]\s*\)/);
        });
    });
});
