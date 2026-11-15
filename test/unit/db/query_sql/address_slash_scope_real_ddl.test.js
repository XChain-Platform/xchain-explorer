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
 *
 * Address-scoped contract slashes against the indexer's REAL DDL in SQLite:
 * the address staking panel's slash leg and the slash_events list route must
 * both reach a slash recorded under a key a DELEGATE v1 rotation later
 * rewrote, and must not hand another holder of an old key this address's
 * slashes. The current-key-only predicate is run on the same fixture as the
 * negative control, so a green run here could have been red.
 *
 ********************************************************************/

'use strict';

const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const { MIRROR_CLAUSE_BUILDERS } = require('../../../../src/db/query_sql/where_mirror_clauses.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', '..', '..', 'xchain-indexer', 'src', 'sql');
const DDL_FILES = ['blocks', 'index_addresses', 'index_pubkeys', 'index_tickers', 'slash_events',
    'contract_stakes', 'contract_unstakes', 'contract_delegation_rotations'];

const CURRENT_KEY_ONLY = `AND m.signing_pubkey_id IN (
    SELECT cs.signing_pubkey_id FROM contract_stakes cs
        INNER JOIN index_addresses sa ON (sa.id=cs.source_id) WHERE sa.address=?)`;

function toSqlite(ddl) {
    return ddl
        .replace(/BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT')
        .replace(/ENUM\([^)]*\)/g, 'TEXT')
        .replace(/ UNSIGNED/g, '')
        .replace(/CHARACTER SET \w+ COLLATE \w+/g, '')
        .replace(/,([ \t]*--[^\n]*)?\s*\n\) ENGINE/g, '$1\n) ENGINE')
        .replace(/\) ENGINE=\w+[^;]*;/g, ');')
        .replace(/^CREATE\s+(UNIQUE\s+)?INDEX[^;]*;/gim, '');
}

let sqlite, db;
const K1 = 1, K2 = 2, K3 = 3;
const CONTRACT_X = 500, CONTRACT_Y = 600;
let addrA, addrB;

function loadSchema() {
    for (const t of DDL_FILES)
        if (!fs.existsSync(path.join(INDEXER_SQL_DIR, t + '.sql'))) this.skip();
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { this.skip(); }
    sqlite = new DatabaseSync(':memory:');
    for (const t of DDL_FILES)
        sqlite.exec(toSqlite(fs.readFileSync(path.join(INDEXER_SQL_DIR, t + '.sql'), 'utf8')));
}

function reset() {
    const configInfo = createConfigInfoStub();
    db = new Database({ configInfo, util: new Utility(configInfo) });
    for (const t of DDL_FILES) sqlite.exec('DELETE FROM ' + t + ';');
    sinon.stub(db, 'doQuery').callsFake(async (config, query, args) => {
        if (/FROM\s+slash_events\s+m\s+INNER JOIN blocks/.test(query) || /^\s*SELECT m\.id FROM slash_events m/.test(query))
            return sqlite.prepare(query).all(...(args || []));
        return [];
    });
    addrA = Number(sqlite.prepare('INSERT INTO index_addresses (address) VALUES (?)').run('A').lastInsertRowid);
    addrB = Number(sqlite.prepare('INSERT INTO index_addresses (address) VALUES (?)').run('B').lastInsertRowid);
    for (let b = 90; b <= 700; b += 10)
        sqlite.prepare('INSERT INTO blocks (block_index, block_time) VALUES (?, ?)').run(b, 1700000000 + b);
}

function stake(table, actionIndex, source, key, contract, block) {
    const cols = table === 'contract_stakes'
        ? 'action_index, source_id, signing_pubkey_id, target_contract_index, amount, block_index'
        : 'action_index, source_id, signing_pubkey_id, target_contract_index, cooldown_end_block, amount, block_index';
    const vals = table === 'contract_stakes'
        ? [actionIndex, source, key, contract, '10', block]
        : [actionIndex, source, key, contract, 999, '10', block];
    sqlite.prepare(`INSERT INTO ${table} (${cols}) VALUES (${vals.map(() => '?').join(',')})`).run(...vals);
}

function rewrite(table, actionIndex, from, to, block) {
    sqlite.prepare(`UPDATE ${table} SET signing_pubkey_id=? WHERE action_index=?`).run(to, actionIndex);
    sqlite.prepare(`INSERT INTO contract_delegation_rotations
        (target_table, delegation_action_index, stake_action_index, prev_signing_pubkey_id, new_signing_pubkey_id, block_index)
        VALUES (?, 1, ?, ?, ?, ?)`).run(table, actionIndex, from, to, block);
}

function slash(key, contract, block) {
    return Number(sqlite.prepare(`INSERT INTO slash_events
        (execution_index, target_contract_index, signing_pubkey_id, tick_id, amount, destination_id, block_index)
        VALUES (1, ?, ?, 1, '1', 1, ?)`).run(contract, key, block).lastInsertRowid);
}

async function panelIds(address) {
    const [data] = await db.getAddressStaking(makeConfig({ coin: 'BTC', data: { method: 'getAddressStaking', search: address, sql: { limit: 50 } } }));
    return data.slash_events.map(r => r.id).sort((a, b) => a - b);
}

function listIds(address) {
    const where = MIRROR_CLAUSE_BUILDERS.getSlashEvents(db, { data: { type: 'address', search: address } }, 'WHERE 1=1');
    return sqlite.prepare('SELECT m.id FROM slash_events m ' + where + ' ORDER BY m.id').all(address).map(r => Number(r.id));
}

function rotatedOnce() {
    stake('contract_stakes', 10, addrA, K1, CONTRACT_X, 90);
    const early = slash(K1, CONTRACT_X, 100);
    rewrite('contract_stakes', 10, K1, K2, 200);
    const late = slash(K2, CONTRACT_X, 250);
    return { early, late };
}

const SUITE_TITLE = 'address-scoped contract slashes against the REAL indexer DDL';

function useRealDdlFixture() {
    before(loadSchema);
    beforeEach(reset);
    afterEach(() => sinon.restore());
}

describe(SUITE_TITLE, function () {
    useRealDdlFixture();

    it('negative control: the current-key-only predicate misses the pre-rotation slash', function () {
        const { late } = rotatedOnce();
        const ids = sqlite.prepare('SELECT m.id FROM slash_events m WHERE 1=1 ' + CURRENT_KEY_ONLY + ' ORDER BY m.id').all('A').map(r => Number(r.id));
        expect(ids).to.deep.equal([late]);
    });

    it('the panel and the list route both return the slash recorded under the replaced key', async function () {
        const { early, late } = rotatedOnce();
        expect(await panelIds('A')).to.deep.equal([early, late]);
        expect(listIds('A')).to.deep.equal([early, late]);
    });

    it('does not hand another holder of the old key this address\'s slashes', async function () {
        const { early, late } = rotatedOnce();
        stake('contract_stakes', 11, addrB, K1, CONTRACT_X, 280);
        const bSlash = slash(K1, CONTRACT_X, 300);
        expect(await panelIds('A')).to.deep.equal([early, late]);
        expect(listIds('A')).to.deep.equal([early, late]);
        expect(listIds('B')).to.include(bSlash);
    });

    it('keeps a slash on the old key out of the address when it hit another contract', function () {
        rotatedOnce();
        const other = slash(K1, CONTRACT_Y, 150);
        expect(listIds('A')).to.not.include(other);
    });

    it('excludes a slash in the rotation\'s own block, which already used the new key', function () {
        rotatedOnce();
        const sameBlock = slash(K1, CONTRACT_X, 200);
        expect(listIds('A')).to.not.include(sameBlock);
    });

});

describe(SUITE_TITLE, function () {
    useRealDdlFixture();

    it('keeps a slash made under the intermediate key across a revert to the first key', function () {
        stake('contract_stakes', 10, addrA, K1, CONTRACT_X, 90);
        rewrite('contract_stakes', 10, K1, K2, 200);
        const mid = slash(K2, CONTRACT_X, 300);
        rewrite('contract_stakes', 10, K2, K1, 400);
        expect(listIds('A')).to.deep.equal([mid]);
    });

    it('does not claim a slash on the intermediate key from before the row held it', function () {
        stake('contract_stakes', 10, addrA, K1, CONTRACT_X, 90);
        rewrite('contract_stakes', 10, K1, K2, 200);
        rewrite('contract_stakes', 10, K2, K1, 400);
        const before = slash(K2, CONTRACT_X, 150);
        expect(listIds('A')).to.not.include(before);
    });

});

describe(SUITE_TITLE, function () {
    useRealDdlFixture();

    it('follows a chain of rotations through every key the row held', function () {
        stake('contract_stakes', 10, addrA, K1, CONTRACT_X, 90);
        const s1 = slash(K1, CONTRACT_X, 100);
        rewrite('contract_stakes', 10, K1, K2, 200);
        const s2 = slash(K2, CONTRACT_X, 300);
        rewrite('contract_stakes', 10, K2, K3, 400);
        const s3 = slash(K3, CONTRACT_X, 500);
        expect(listIds('A')).to.deep.equal([s1, s2, s3]);
    });

    it('reaches a slash through a rotated contract_unstakes row once the stake row is gone', function () {
        stake('contract_unstakes', 20, addrA, K1, CONTRACT_X, 90);
        const early = slash(K1, CONTRACT_X, 100);
        rewrite('contract_unstakes', 20, K1, K2, 200);
        expect(listIds('A')).to.deep.equal([early]);
    });

    it('binds exactly one placeholder on the list route', function () {
        const where = MIRROR_CLAUSE_BUILDERS.getSlashEvents(db, { data: { type: 'address', search: 'A' } }, 'WHERE 1=1');
        expect(where.match(/\?/g)).to.have.lengthOf(1);
    });
});
