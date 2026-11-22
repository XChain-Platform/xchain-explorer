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
 **********************************************************************/

'use strict';

const fs         = require('fs');
const path       = require('path');
const sinon      = require('sinon');
const { expect } = require('chai');
const Database   = require('../../../../../src/db/index.js');
const Utility    = require('../../../../../src/lib/utility.js');
const { siblingCheckout, skipOrFail } = require('../../../../helpers/sibling_checkout.js');

const INDEXER_SQL = path.join(__dirname, '..', '..', '..', '..', '..', '..',
    'xchain-indexer', 'src', 'sql', 'index_addresses.sql');
const LOWER_BECH32 = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const MIXED_BECH32 = 'tb1qW508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const BASE58 = 'moV6MFmHTNQF1cwoXiPjeEMbkSAKwBz9Li';
const BASE58_VARIANT = 'MoV6MFmHTNQF1cwoXiPjeEMbkSAKwBz9Li';

function toSqlite(ddl) {
    return ddl
        .replace(/BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
        .replace(/VARCHAR\(\d+\) NOT NULL/g, 'TEXT NOT NULL COLLATE NOCASE')
        .replace(/BIGINT NULL/g, 'BIGINT')
        .replace(/BIGINT UNSIGNED/g, 'BIGINT')
        .replace(/\) ENGINE=\w+[^;]*;/g, ');');
}

const toSqliteQuery = query => query.replace(/COLLATE utf8_bin/g, 'COLLATE BINARY');

let sqlite;
let db;

function loadSchema() {
    const verdict = siblingCheckout(__dirname, INDEXER_SQL);
    if(!verdict.usable)
        return skipOrFail(this, verdict, 'the real indexer address DDL');
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch(_){ return this.skip(); }
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(toSqlite(fs.readFileSync(INDEXER_SQL, 'utf8')));
}

function resetFixture() {
    sqlite.exec('DELETE FROM index_addresses;');
    sqlite.prepare('INSERT INTO index_addresses (id, address, block_index) VALUES (?, ?, ?)')
        .run(11, MIXED_BECH32, 100);
    sqlite.prepare('INSERT INTO index_addresses (id, address, block_index) VALUES (?, ?, ?)')
        .run(12, BASE58, 100);
    sqlite.prepare('INSERT INTO index_addresses (id, address, block_index) VALUES (?, ?, ?)')
        .run(13, 'tb1qnullblock', null);

    db = Object.create(Database.prototype);
    db.util = new Utility();
    db._addressIdCache = new Map();
    db._reorgGen = {};
    db.doQuery = sinon.stub().callsFake(async (config, query, args) =>
        sqlite.prepare(toSqliteQuery(query)).all(...(args || [])));
}

describe('compactable address ids preserve the requested spelling @regression @tier1', function () {
    before(loadSchema);
    beforeEach(resetFixture);

    it('the case-insensitive lookup premise resolves a variant to the stored row', async function () {
        expect(await db.getAddressId({ coin: 'TBTC' }, LOWER_BECH32)).to.equal(11);
    });

    it('does not compact a lowercase address through a mixed-case stored row', async function () {
        expect(await db.getCompactableAddressId({ coin: 'TBTC' }, LOWER_BECH32)).to.equal(null);
    });

    it('compacts the exact stored bech32 spelling', async function () {
        expect(await db.getCompactableAddressId({ coin: 'TBTC' }, MIXED_BECH32)).to.equal(11);
    });

    it('does not compact a case-variant base58 spelling', async function () {
        expect(await db.getCompactableAddressId({ coin: 'TBTC' }, BASE58_VARIANT)).to.equal(null);
        expect(await db.getCompactableAddressId({ coin: 'TBTC' }, BASE58)).to.equal(12);
    });

    it('keeps the deterministic block-index requirement', async function () {
        expect(await db.getCompactableAddressId({ coin: 'TBTC' }, 'tb1qnullblock')).to.equal(null);
    });
});
