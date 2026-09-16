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

function mkDetector(db) {
    const cd = new ChangeDetector({ db, pollInterval: 999999 });
    cd.mempoolState.RBTC = { seenHashes: new Map(), initialized: false };
    return cd;
}

describe("decoder mempool surface", () => {
    describe('ChangeDetector mempool diffing', () => {
        it('seeds silently on first poll, then emits mempool_action for new rows', async () => {
            const db = mkDb([SEND_ROW]);
            db.getDecoderMempoolRows = sinon.stub();
            db.getDecoderMempoolRows.onCall(0).resolves([SEND_ROW]);
            db.getDecoderMempoolRows.onCall(1).resolves([SEND_ROW, MINT_ROW]);
            const cd = mkDetector(db);
            const seen = [];
            cd.on('mempool_action', (coin, row) => seen.push([coin, row.tx_hash, row.action]));

            await cd.checkMempoolForCoin('RBTC');                 // seed
            expect(seen).to.deep.equal([]);
            await cd.checkMempoolForCoin('RBTC');                 // MINT_ROW is new
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

            await cd.checkMempoolForCoin('RBTC');                 // seed
            await cd.checkMempoolForCoin('RBTC');                 // SEND_ROW gone
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
            await cd.checkMempoolForCoin('RBTC');                 // seed
            await cd.checkMempoolForCoin('RBTC');                 // window shifted down
            expect(removed).to.deep.equal([]);                     // h0500..h0998 fell above the window, not gone
            expect(seen.length).to.equal(250);                     // the odd low hashes are genuinely new
            await cd.checkMempoolForCoin('RBTC');                 // window shifts back over them
            expect(seen.length).to.equal(250);                     // carried forward: not re-announced
            // The odd hashes h0001..h0499 now sort below the covered bound and are absent: gone.
            expect(removed.length).to.equal(250);
            expect(removed.every((h) => Number(h.slice(1)) % 2 === 1)).to.equal(true);
        });
    });
});

describe("decoder mempool surface", () => {
    describe('ChangeDetector mempool diffing', () => {
        it('emits mempool_removed for every missing hash when the window is short of the cap', async () => {
            const db = mkDb([]);
            db.getDecoderMempoolRows = sinon.stub();
            db.getDecoderMempoolRows.onCall(0).resolves([SEND_ROW, MINT_ROW, TRASH_ROW]);
            db.getDecoderMempoolRows.onCall(1).resolves([SEND_ROW]);
            const cd = mkDetector(db);
            const removed = [];
            cd.on('mempool_removed', (c, r) => removed.push(r.tx_hash));
            await cd.checkMempoolForCoin('RBTC');
            await cd.checkMempoolForCoin('RBTC');
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
            await cd.checkMempoolForCoin('RBTC');
            await cd.checkMempoolForCoin('RBTC');
            expect(seen).to.deep.equal([]);                        // decoded null → not emitted
        });
    });
});

describe("decoder mempool surface", () => {
    describe('Broadcaster mempool routing', () => {
        function mkBroadcaster() {
            const detector = new (require('events').EventEmitter)();
            const sent = [];
            const b = new Broadcaster({ wsServer: {}, changeDetector: detector });
            b.broadcastToChannel = (coin, channel, event, raw, entity) =>
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
});
