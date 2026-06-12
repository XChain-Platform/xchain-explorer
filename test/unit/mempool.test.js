/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Unit tests for the decoder-DB mempool surface: db.getDecoderMempoolRows /
 * db.decodeMempoolRow / db.getMempool, the ChangeDetector mempool diffing,
 * and Broadcaster MEMPOOL_ACTION / MEMPOOL_REMOVED routing. The decoder DB
 * is stubbed throughout — no real database.
 */

'use strict';

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

const SEND_ROW  = { tx_hash: 'aa11', source: 'srcAddr1', data_hex: hex('SEND|0|TOK|5|destAddr1|nonce123') };
const MINT_ROW  = { tx_hash: 'bb22', source: 'srcAddr2', data_hex: hex('MINT|0|OTHER|9') };
const TRASH_ROW = { tx_hash: 'cc33', source: 'srcAddr3', data_hex: 'zz-not-hex-!!' };

describe('decoder mempool surface', () => {

    describe('db.getDecoderMempoolRows', () => {
        it('returns [] when no decoder DB is mapped or the name is unsafe', async () => {
            const db = mkDb([]);
            expect(await db.getDecoderMempoolRows({ coin: 'RDOGE' }, 10)).to.deep.equal([]);
            db.decoderDb = { RBTC: 'bad-name;DROP' };
            expect(await db.getDecoderMempoolRows({ coin: 'RBTC' }, 10)).to.deep.equal([]);
            expect(db.doQuery.called).to.equal(false);
        });

        it('queries the decoder DB with joins and clamps the limit', async () => {
            const db = mkDb([SEND_ROW]);
            const rows = await db.getDecoderMempoolRows({ coin: 'RBTC' }, 9999);
            expect(rows).to.deep.equal([SEND_ROW]);
            const sql = db.doQuery.firstCall.args[1];
            expect(sql).to.include('`XChain_BTC_Decoder`.mempool_transactions');
            expect(sql).to.include('index_transactions');
            expect(sql).to.include('index_addresses');
            expect(sql).to.include('LIMIT 500');
        });

        it('returns [] on query failure (decoder DB unreachable)', async () => {
            const db = mkDb([]);
            db.doQuery = sinon.stub().rejects(new Error('no grant'));
            expect(await db.getDecoderMempoolRows({ coin: 'RBTC' }, 10)).to.deep.equal([]);
        });
    });

    describe('db.decodeMempoolRow', () => {
        it('decodes hex to the action string and extracts the action name', () => {
            const db = mkDb([]);
            const d = db.decodeMempoolRow(SEND_ROW);
            expect(d).to.deep.equal({
                tx_hash: 'aa11', source: 'srcAddr1', action: 'SEND',
                data: 'SEND|0|TOK|5|destAddr1|nonce123',
            });
        });

        it('returns null for garbage rows', () => {
            const db = mkDb([]);
            expect(db.decodeMempoolRow(TRASH_ROW)).to.equal(null);
            expect(db.decodeMempoolRow({ tx_hash: 'x' })).to.equal(null);
            expect(db.decodeMempoolRow({ tx_hash: 'x', data_hex: hex('|||') })).to.equal(null);
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
});
