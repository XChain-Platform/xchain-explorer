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
            });
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

    describe('ChangeDetector mempool diffing', () => {
        function mkDetector(db) {
            const cd = new ChangeDetector({ db, pollInterval: 999999 });
            cd.mempoolState.RBTC = { seenHashes: new Set(), initialized: false };
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
            return { detector, sent };
        }

        it('routes MEMPOOL_ACTION to the mempool channel + source address channel', () => {
            const { detector, sent } = mkBroadcaster();
            detector.emit('mempool_action', 'RBTC', { tx_hash: 'aa11', source: 'srcAddr1', action: 'SEND', data: 'SEND|0|TOK|5|d|m' });
            expect(sent.map((s) => [s.channel, s.type, s.entity])).to.deep.equal([
                ['mempool', 'MEMPOOL_ACTION', null],
                ['address', 'MEMPOOL_ACTION', 'srcAddr1'],
            ]);
            expect(sent[0].data.data).to.equal('SEND|0|TOK|5|d|m');
        });

        it('routes MEMPOOL_REMOVED to the mempool channel only', () => {
            const { detector, sent } = mkBroadcaster();
            detector.emit('mempool_removed', 'RBTC', { tx_hash: 'aa11' });
            expect(sent).to.have.lengthOf(1);
            expect(sent[0]).to.include({ channel: 'mempool', type: 'MEMPOOL_REMOVED' });
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

        it('the decoder-canonical stored form is what the explorer reader parses', function () {
            if (!hasDecoder) this.skip();
            let canonicalizeActionPayload;
            try {
                ({ canonicalizeActionPayload } = require(decoderSrc));
            } catch (e) {
                this.skip();                       // sibling checkout without installed deps
                return;
            }
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
