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
 * Case-exactness of the mempool address matcher's id resolution, REST side
 * (spec wallet-unconfirmed-and-sounds).
 *
 * THE DEFECT, measured on regtest: index_addresses is declared
 * CHARSET=utf8 COLLATE=utf8_general_ci, so `WHERE address=?` resolves ANY case
 * variant of an address to the same id. The mempool matcher then matched that
 * id's `^<id>` destination, and
 *   /RDOGE/api/mempool/{addr}/address        -> total 1   (correct)
 *   /RDOGE/api/mempool/{Addr-case-flipped}/  -> total 1   (a stranger's tx)
 *   /RDOGE/api/mempool/{addr-lowercased}/    -> total 1   (a stranger's tx)
 * Base58 is case-SENSITIVE: those are different addresses, not sloppy typing.
 *
 * The queries run against index_addresses built from the indexer's REAL DDL,
 * mechanically translated to SQLite with the table-level ci collation carried
 * onto the address column as NOCASE. That is what makes this suite falsifiable:
 * SQLite resolves `address=?` case-INSENSITIVELY here exactly as MariaDB does,
 * so dropping the COLLATE gate from getExactAddressId turns these red.
 */

'use strict';

const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');
const Database   = require('../../src/db.js');
const Utility    = require('../../src/utility.js');

const INDEXER_SQL = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'sql', 'index_addresses.sql');

// The regtest address the defect was measured against, its id, and the two
// variants that must NOT resolve to it.
const ADDRESS    = 'moV6MFmHTNQF1cwoXiPjeEMbkSAKwBz9Li';
const ADDRESS_ID = 397;
const FLIPPED    = 'MoV6MFmHTNQF1cwoXiPjeEMbkSAKwBz9Li';
const LOWERED    = ADDRESS.toLowerCase();

// The pending row measured on the venue: its only destination is the compacted
// reference ^397, and its source is somebody else entirely.
const COMPACT_ROW = { tx_hash: 'aa11', source: 'srcAddr', data: 'SEND|0|TOK|5|^' + ADDRESS_ID + '|memo' };

// Mechanical MariaDB -> SQLite translation of the real DDL. Types and engine
// syntax only, plus the one semantic carry-over that is the whole point here:
// the table's ci collation becomes a NOCASE column collation, since SQLite has
// no table-level collation and comparisons resolve per column.
function toSqlite(ddl) {
    return ddl
        .replace(/BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
        .replace(/VARCHAR\(\d+\) NOT NULL/g, 'TEXT NOT NULL COLLATE NOCASE')
        .replace(/BIGINT NULL/g, 'BIGINT')
        .replace(/BIGINT UNSIGNED/g, 'BIGINT')
        .replace(/\) ENGINE=\w+[^;]*;/g, ');');
}

// utf8_bin is MariaDB's byte-exact collation; BINARY is SQLite's.
const toSqliteQuery = (q) => q.replace(/COLLATE utf8_bin/g, 'COLLATE BINARY');

describe('mempool address-id resolution is byte-exact (REST surface)', function () {

    let sqlite, db, ddl;

    before(function () {
        // Skip only in a standalone explorer checkout without the sibling
        // indexer; the platform monorepo and bin/ci-all.sh have it.
        if (!fs.existsSync(INDEXER_SQL)) this.skip();
        let DatabaseSync;
        try { ({ DatabaseSync } = require('node:sqlite')); }
        catch (e) { this.skip(); }
        ddl    = fs.readFileSync(INDEXER_SQL, 'utf8');
        sqlite = new DatabaseSync(':memory:');
        sqlite.exec(toSqlite(ddl));
    });

    beforeEach(function () {
        sqlite.exec('DELETE FROM index_addresses;');
        sqlite.prepare('INSERT INTO index_addresses (id, address, block_index) VALUES (?, ?, ?)')
            .run(ADDRESS_ID, ADDRESS, 100);

        db = Object.create(Database.prototype);
        db.util = new Utility();
        db._addressIdCache      = new Map();
        db._exactAddressIdCache = new Map();
        db._reorgGen            = {};
        db.doQuery = sinon.stub().callsFake(async (config, query, args) =>
            sqlite.prepare(toSqliteQuery(query)).all(...(args || [])));
        db.getDecoderMempoolRows = sinon.stub().resolves([COMPACT_ROW]);
    });

    const cfg = (search, type) => ({ coin: 'RDOGE', data: { search, type } });

    // Pins the premise. If the indexer ever declares this table byte-exact, the
    // matcher's own COLLATE gate becomes belt-and-braces rather than the fix.
    it('the indexer really declares index_addresses case-INSENSITIVELY', function () {
        expect(ddl).to.match(/COLLATE=utf8_general_ci/i);
    });

    it('the ci lookup behind search resolves a case variant to the same id', async function () {
        expect(await db.getAddressId(cfg(), ADDRESS)).to.equal(ADDRESS_ID);
        expect(await db.getAddressId(cfg(), FLIPPED)).to.equal(ADDRESS_ID);
        expect(await db.getAddressId(cfg(), LOWERED)).to.equal(ADDRESS_ID);
    });

    it('the exact lookup resolves the address and NOTHING that merely resembles it', async function () {
        expect(await db.getExactAddressId(cfg(), ADDRESS)).to.equal(ADDRESS_ID);
        expect(await db.getExactAddressId(cfg(), FLIPPED)).to.equal(null);
        expect(await db.getExactAddressId(cfg(), LOWERED)).to.equal(null);
    });

    it('matches a compacted ^<id> destination for the address itself', async function () {
        const [data, , total] = await db.getMempool(cfg(ADDRESS, 'address'));
        expect(total).to.equal(1);
        expect(data[0].tx_hash).to.equal('aa11');
    });

    it('matches NOTHING for a case-flipped spelling of that address', async function () {
        const [data, , total] = await db.getMempool(cfg(FLIPPED, 'address'));
        expect(total).to.equal(0);
        expect(data).to.deep.equal([]);
    });

    it('matches NOTHING for an all-lowercase spelling of that address', async function () {
        const [data, , total] = await db.getMempool(cfg(LOWERED, 'address'));
        expect(total).to.equal(0);
        expect(data).to.deep.equal([]);
    });

    // The window is up to 500 rows and the resolution is one real query, so it
    // must happen once per request and not once per row - for a never-indexed
    // spelling too, which is the case that resolves null every time.
    it('resolves the id ONCE per request, never once per row, for an unindexed spelling', async function () {
        const rows = [];
        for (let i = 0; i < 25; i++)
            rows.push({ tx_hash: 'h' + i, source: 'srcAddr', data: 'SEND|0|TOK|1|^' + ADDRESS_ID });
        db.getDecoderMempoolRows = sinon.stub().resolves(rows);

        const [, , total] = await db.getMempool(cfg(FLIPPED, 'address'));
        expect(total).to.equal(0);
        expect(db.doQuery.callCount).to.equal(1);
    });

    it('serves a resolved id from cache on the next request', async function () {
        expect(await db.getExactAddressId(cfg(), ADDRESS)).to.equal(ADDRESS_ID);
        expect(await db.getExactAddressId(cfg(), ADDRESS)).to.equal(ADDRESS_ID);
        expect(db.doQuery.callCount).to.equal(1);
    });

    // The two resolutions disagree for the same key by design, so they must not
    // share a cache: whichever ran first would otherwise answer for both.
    it('keeps the exact and ci resolutions in separate caches', async function () {
        expect(await db.getAddressId(cfg(), FLIPPED)).to.equal(ADDRESS_ID);
        expect(await db.getExactAddressId(cfg(), FLIPPED)).to.equal(null);
        expect(await db.getExactAddressId(cfg(), ADDRESS)).to.equal(ADDRESS_ID);
        expect(await db.getAddressId(cfg(), ADDRESS)).to.equal(ADDRESS_ID);
    });
});

// Guards the CALL SITE independently of any SQL: getMempool must ask the
// byte-exact resolver, not the ci one the search paths share.
describe('getMempool TYPE=address resolves through the exact lookup', function () {

    it('calls getExactAddressId and never getAddressId', async function () {
        const db = Object.create(Database.prototype);
        db.util = new Utility();
        db.getDecoderMempoolRows = sinon.stub().resolves([COMPACT_ROW]);
        db.getAddressId      = sinon.stub().resolves(ADDRESS_ID);
        db.getExactAddressId = sinon.stub().resolves(null);

        const [, , total] = await db.getMempool({ coin: 'RDOGE', data: { search: FLIPPED, type: 'address' } });
        expect(total).to.equal(0);
        expect(db.getExactAddressId.calledOnce).to.equal(true);
        expect(db.getAddressId.called).to.equal(false);
    });
});
