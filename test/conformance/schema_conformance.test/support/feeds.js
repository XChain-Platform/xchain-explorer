/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 */

'use strict';

const { expect, ChangeDetector, INDEXER_DB, DECODER_DB, MEMPOOL_ACTION_STRING } = require('../../schema_conformance.test.js');

/******************************************************************
 * 2. ChangeDetector WS-feed smoke: a fresh block must emit events
 *****************************************************************/

function registerWebSocketFeed(runtime) {
    it('emits WS block + action events for a freshly indexed block (guards the missing-column outage class)', async function () {
        const { adminPool, db } = runtime.state;
        const conn = await adminPool.getConnection();
        async function insertId(sql, args) {
            const res = await conn.query(sql, args);
            return Number(res.insertId);
        }
        try {
            await conn.query('USE `' + INDEXER_DB + '`');

            const detector = new ChangeDetector({ db, pollInterval: 3600000, fetchLimit: 100 });
            const events = { block: [], action: [] };
            detector.on('block',  (coin, b) => events.block.push(b));
            detector.on('action', (coin, a) => events.action.push(a));
            detector.state = { RBTC: { blockIndex: 0, actionIndex: 0, initialized: false } };
            // seenHashes is a Map<tx_hash, {source, data}>, not a Set: the removal
            // path needs the tx's parties after its row has left the table.
            detector.mempoolState = { RBTC: { seenHashes: new Map(), initialized: false } };

            // First poll seeds cursors from the (empty) real schema. Any bad
            // column in the tip poll throws HERE, exactly like production.
            await detector.checkCoin('RBTC');

            // Index one block with one SEND action, real-schema column names.
            const ledgerHashId = await insertId('INSERT INTO index_transactions (hash) VALUES (?)', ['conformance-ledger-1']);
            const txHashId     = await insertId('INSERT INTO index_transactions (hash) VALUES (?)', ['conformance-tx-1']);
            const addressId    = await insertId('INSERT INTO index_addresses (address) VALUES (?)', ['bcrt1qconformance']);
            const tickId       = await insertId('INSERT INTO index_tickers (tick) VALUES (?)', ['CONFTICK']);
            const statusId     = await insertId('INSERT INTO index_statuses (status) VALUES (?)', ['valid']);
            const actionId     = await insertId('INSERT INTO index_actions (action) VALUES (?)', ['SEND']);
            await conn.query('INSERT INTO blocks (block_index, block_time, ledger_hash_id) VALUES (?, ?, ?)',
                [101, 1700000000, ledgerHashId]);
            await conn.query('INSERT INTO transactions (tx_index, block_index, tx_hash_id, source_id, fee, data) VALUES (?, ?, ?, ?, ?, ?)',
                [1, 101, txHashId, addressId, 1000, 'SEND|0|CONFTICK|1|bcrt1qconformance|']);
            await conn.query('INSERT INTO actions (action_index, block_index, tx_index, tx_vout, action_id, action_format, source_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [1, 101, 1, 0, actionId, 0, addressId]);
            await conn.query('INSERT INTO sends (action_index, tick_id, destination_id, amount, status_id) VALUES (?, ?, ?, ?, ?)',
                [1, tickId, addressId, '1', statusId]);

            // Second poll must see the block and the action. This exercises
            // checkReorgAndInvalidate, getMax*, get*Since AND the lifecycle /
            // entity / attestation emit queries against the real DDL; a
            // schema error in any of them throws and fails the test.
            await detector.checkCoin('RBTC');

            expect(events.block.length, 'NEW_BLOCK feed emitted nothing for a fresh block').to.be.at.least(1);
            expect(Number(events.block[0].block_index)).to.equal(101);
            expect(events.action.length, 'NEW_ACTION feed emitted nothing for a fresh action').to.be.at.least(1);
            expect(events.action[0].action).to.equal('SEND');
            expect(events.action[0].source).to.equal('bcrt1qconformance');
        } finally {
            conn.release();
        }
    });
}

function registerDecoderMempool(runtime) {
    it('reads the decoder mempool feed against the real decoder DDL', async function () {
        const { adminPool, db } = runtime.state; const { hasDecoderDdl } = runtime;
        if (!hasDecoderDdl) this.skip();
        const conn = await adminPool.getConnection();
        try {
            await conn.query('USE `' + DECODER_DB + '`');
            // Seeded as the canonical UTF-8 ACTION string, which is what the
            // decoder's mempool path writes; this row is byte-identical
            // to the `transactions.data` value its confirmed twin would carry.
            // destination is NULL as in production: the decoder binds the column
            // on every insert but parseTransaction never sets it (see the
            // getDecoderMempoolRows contract note in src/db.js).
            await conn.query('INSERT INTO mempool_transactions (tx_hash, source, destination, amount, fee, data) VALUES (?, ?, ?, ?, ?, ?)',
                ['conf-mempool-tx-1', 'bcrt1qconformance', null, 0, 500, MEMPOOL_ACTION_STRING]);
        } finally {
            conn.release();
        }
        // getDecoderMempoolRows swallows query errors into a console.warn and
        // returns [] (WS polls must tolerate outages), which would mask schema
        // drift; asserting the seeded row actually comes back un-masks it.
        const rows = await db.getDecoderMempoolRows({ coin: 'RBTC' }, 10);
        expect(rows.length, 'decoder mempool query returned nothing for a seeded row (schema drift or pool wiring)').to.equal(1);
        expect(rows[0].tx_hash).to.equal('conf-mempool-tx-1');
        // Encoding parity against the REAL column type, not a stub: the read has
        // to hand back the same string that went in, and decodeMempoolRow has to
        // parse it. A one-sided switch back to hex on either side fails here.
        expect(String(rows[0].data), 'mempool data column round-trip changed the payload').to.equal(MEMPOOL_ACTION_STRING);
        const decodedMempool = db.decodeMempoolRow(rows[0]);
        expect(decodedMempool, 'explorer could not decode a real decoder mempool row').to.not.equal(null);
        expect(decodedMempool.action).to.equal('SEND');
        expect(decodedMempool.data).to.equal(MEMPOOL_ACTION_STRING);
    });
}

module.exports = { registerWebSocketFeed, registerDecoderMempool };
