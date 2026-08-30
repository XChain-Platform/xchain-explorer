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
 * Unit tests for the shared mempool address matcher and the REST prefilter
 * that uses it: db.mempoolSegments / db.mempoolRowMatchesAddress and
 * db.getMempool TYPE=address (spec wallet-unconfirmed-and-sounds, M1.1).
 *
 * The bug being fixed: the SDK compacts destination addresses to `^<id>`
 * index references BY DEFAULT, so /api/mempool/{ADDRESS}/address matched only
 * senders and never-indexed recipients. Everything else about the endpoint,
 * including TYPE=token and the paging envelope, must not move.
 *
 * Mirrors test/unit/mempool.test.js's mkDb helper: a Database instance with
 * only the decoder-name map + a stubbed doQuery, no real database.
 */

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const Database   = require('../../src/db.js');
const Utility    = require('../../src/utility.js');

// `ids` maps address -> index id; anything absent resolves null (never indexed).
function mkDb(rows, ids) {
    const db = Object.create(Database.prototype);
    db.util      = new Utility();
    db.decoderDb = { RBTC: 'XChain_BTC_Decoder' };
    db.doQuery   = sinon.stub().resolves(rows);
    db.getExactAddressId = sinon.stub().callsFake(async (config, address) =>
        Object.prototype.hasOwnProperty.call(ids || {}, address) ? ids[address] : null);
    return db;
}

const cfg = (search, type) => ({ coin: 'RBTC', data: { search, type } });

// destAddr is indexed as id 42, so the SDK writes it to the wire as ^42.
const COMPACT_ROW = { tx_hash: 'aa11', source: 'srcAddr', data: 'SEND|0|TOK|5|^42|memo' };
const LITERAL_ROW = { tx_hash: 'bb22', source: 'srcAddr', data: 'SEND|0|TOK|5|freshAddr|memo' };
const MINT_ROW    = { tx_hash: 'cc33', source: 'otherAddr', data: 'MINT|0|OTHER|9' };

describe('db.mempoolRowMatchesAddress (shared REST/WS matcher)', () => {

    const db = mkDb([]);

    it('matches the row source', () => {
        expect(db.mempoolRowMatchesAddress({ source: 'srcAddr', data: 'MINT|0|TOK|1' }, 'srcAddr', null)).to.equal(true);
    });

    it('matches an exact literal segment but never a substring of one', () => {
        const row = { source: 'srcAddr', data: 'SEND|0|TOK|5|freshAddr|memo' };
        expect(db.mempoolRowMatchesAddress(row, 'freshAddr', null)).to.equal(true);
        expect(db.mempoolRowMatchesAddress(row, 'reshAddr',  null)).to.equal(false);
    });

    it('matches a compacted ^<id> segment only when the id is supplied', () => {
        const row = { source: 'srcAddr', data: 'SEND|0|TOK|5|^42|memo' };
        expect(db.mempoolRowMatchesAddress(row, 'destAddr', 42)).to.equal(true);
        expect(db.mempoolRowMatchesAddress(row, 'destAddr', null)).to.equal(false);
        expect(db.mempoolRowMatchesAddress(row, 'destAddr', 43)).to.equal(false);
        // The id alone is not a prefix match: ^4 must not hit ^42.
        expect(db.mempoolRowMatchesAddress(row, 'destAddr', 4)).to.equal(false);
    });

    it('returns false for a null row, a null address, or an empty address', () => {
        expect(db.mempoolRowMatchesAddress(null, 'srcAddr', 1)).to.equal(false);
        expect(db.mempoolRowMatchesAddress({ source: 's', data: 'MINT|0|T|1' }, null, 1)).to.equal(false);
        expect(db.mempoolRowMatchesAddress({ source: 's', data: 'MINT|0|T|1' }, '', 1)).to.equal(false);
    });

    // The removal path carries `data: null` for a row that never decoded, so the
    // matcher has to survive a party lookup with no action string at all.
    it('handles a row with no action string (source-only match still works)', () => {
        expect(db.mempoolSegments({ source: 's', data: null })).to.deep.equal([]);
        expect(db.mempoolRowMatchesAddress({ source: 's', data: null }, 's', 1)).to.equal(true);
        expect(db.mempoolRowMatchesAddress({ source: 's', data: null }, 'other', 1)).to.equal(false);
    });
});

describe('db.getMempool TYPE=address forward-resolves ^<id> (M1.1)', () => {

    it('matches a destination that arrived COMPACTED as ^<id>', async () => {
        const db = mkDb([COMPACT_ROW, MINT_ROW], { destAddr: 42 });
        const [data, , total] = await db.getMempool(cfg('destAddr', 'address'));
        expect(total).to.equal(1);
        expect(data[0].tx_hash).to.equal('aa11');
    });

    it('still matches a LITERAL destination for a never-indexed address', async () => {
        const db = mkDb([COMPACT_ROW, LITERAL_ROW], {});            // no ids at all
        const [data, , total] = await db.getMempool(cfg('freshAddr', 'address'));
        expect(total).to.equal(1);
        expect(data[0].tx_hash).to.equal('bb22');
    });

    it('still matches the source', async () => {
        const db = mkDb([COMPACT_ROW, MINT_ROW], { srcAddr: 7 });
        const [data, , total] = await db.getMempool(cfg('srcAddr', 'address'));
        expect(total).to.equal(1);
        expect(data[0].tx_hash).to.equal('aa11');
    });

    it('does not match a DIFFERENT address whose id is not on the wire', async () => {
        const db = mkDb([COMPACT_ROW], { otherAddr: 99 });
        const [data, , total] = await db.getMempool(cfg('otherAddr', 'address'));
        expect(total).to.equal(0);
        expect(data).to.deep.equal([]);
    });

    it('resolves the queried address to its id ONCE per request, not once per row', async () => {
        const rows = [];
        for (let i = 0; i < 25; i++)
            rows.push({ tx_hash: 'h' + i, source: 'srcAddr', data: 'SEND|0|TOK|1|^42' });
        const db = mkDb(rows, { destAddr: 42 });
        const [, , total] = await db.getMempool(cfg('destAddr', 'address'));
        expect(total).to.equal(25);
        expect(db.getExactAddressId.callCount).to.equal(1);
    });

    it('degrades to literal-only matching when the id lookup throws', async () => {
        const db = mkDb([COMPACT_ROW, LITERAL_ROW], {});
        db.getExactAddressId = sinon.stub().rejects(new Error('db down'));
        const [literal] = await db.getMempool(cfg('freshAddr', 'address'));
        expect(literal.map((r) => r.tx_hash)).to.deep.equal(['bb22']);
        const [compact] = await db.getMempool(cfg('destAddr', 'address'));
        expect(compact).to.deep.equal([]);
    });

    it('never resolves an id for TYPE=token, and token matching is unchanged', async () => {
        const db = mkDb([COMPACT_ROW, MINT_ROW], { destAddr: 42 });
        const [data, , total] = await db.getMempool(cfg('other', 'token'));
        expect(total).to.equal(1);
        expect(data[0].tx_hash).to.equal('cc33');                   // uppercased tick match
        expect(db.getExactAddressId.called).to.equal(false);
    });

    it('never resolves an id in list-all mode, and lists every decoded row', async () => {
        const db = mkDb([COMPACT_ROW, MINT_ROW], { destAddr: 42 });
        const [data, args, total] = await db.getMempool(cfg(null, null));
        expect(args).to.equal(null);
        expect(total).to.equal(2);
        expect(data).to.have.lengthOf(2);
        expect(db.getExactAddressId.called).to.equal(false);
    });

    it('keeps the paging envelope: total is the pre-slice match count', async () => {
        const rows = [];
        for (let i = 0; i < 10; i++)
            rows.push({ tx_hash: 'h' + i, source: 'srcAddr', data: 'SEND|0|TOK|1|^42' });
        const db = mkDb(rows, { destAddr: 42 });
        const [data, , total] = await db.getMempool({
            coin: 'RBTC',
            type: 'api',
            data: { search: 'destAddr', type: 'address', sql: { limit: 4, apiOffset: 4 } }
        });
        expect(total).to.equal(10);
        expect(data.map((r) => r.tx_hash)).to.deep.equal(['h4', 'h5', 'h6', 'h7']);
    });
});
