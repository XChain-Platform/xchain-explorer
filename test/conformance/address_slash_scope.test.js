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
 * The address slash predicate executed by a REAL MariaDB on the indexer's own
 * DDL: the WITH-in-derived-table shape is engine syntax SQLite cannot vouch for,
 * so the rotation, other-holder and span cases run here too.
 *
 * Requires the integration MariaDB fixture (127.0.0.1:3307):
 *   npm run test:integration:up
 *
 ********************************************************************/

'use strict';

const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');
const { expect } = require('chai');

const pre = require('../integration/helpers/fixture-preflight.js');
const { addressSlashScope } = require('../../src/db/query_sql/slash_scope/address_slash_scope.js');

const connection  = pre.conformanceConnection();
const SCOPE_DB    = pre.conformanceDatabase('xchain_conformance_slash_scope');
const INDEXER_SQL = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'sql');
const TABLES      = ['index_addresses', 'slash_events', 'contract_stakes', 'contract_unstakes', 'contract_delegation_rotations'];

let adminPool = null;
let pool      = null;

function splitStatements(sql) {
    return sql.split('\n')
        .map(line => { const i = line.indexOf('--'); return i === -1 ? line : line.slice(0, i); })
        .join('\n')
        .split(';').map(s => s.trim()).filter(s => s.length > 0);
}

async function run(p, sql, args) {
    const conn = await p.getConnection();
    try { return await conn.query(sql, args); }
    finally { conn.release(); }
}

async function setUp() {
    if (!fs.existsSync(INDEXER_SQL)) this.skip();
    adminPool = mariadb.createPool({ ...connection, connectionLimit: 2, connectTimeout: 8000 });
    try { await run(adminPool, 'SELECT 1'); }
    catch (e) {
        throw new Error('The slash scope tier needs the test MariaDB on ' + connection.host + ':' + connection.port +
            ' (start it with `npm run test:integration:up`): ' + e.message);
    }
    await run(adminPool, 'DROP DATABASE IF EXISTS `' + SCOPE_DB + '`');
    await run(adminPool, 'CREATE DATABASE `' + SCOPE_DB + '`');
    pool = mariadb.createPool({ ...connection, database: SCOPE_DB, connectionLimit: 4, connectTimeout: 8000 });
    for (const t of TABLES)
        for (const stmt of splitStatements(fs.readFileSync(path.join(INDEXER_SQL, t + '.sql'), 'utf8'))) await run(pool, stmt);
}

async function tearDown() {
    if (pool) await pool.end();
    if (!adminPool) return;
    try { await run(adminPool, 'DROP DATABASE IF EXISTS `' + SCOPE_DB + '`'); } catch (e) { /* teardown */ }
    await adminPool.end();
}

async function slash(key, contract, block) {
    const r = await run(pool, `INSERT INTO slash_events
        (execution_index, target_contract_index, signing_pubkey_id, tick_id, amount, destination_id, block_index)
        VALUES (1, ?, ?, 1, '1', 1, ?)`, [contract, key, block]);
    return Number(r.insertId);
}

async function stake(table, actionIndex, source, key, block) {
    const extra = table === 'contract_unstakes' ? ', cooldown_end_block' : '';
    const mark  = table === 'contract_unstakes' ? ', 999' : '';
    await run(pool, `INSERT INTO ${table} (action_index, source_id, signing_pubkey_id, target_contract_index, amount, block_index${extra})
        VALUES (?, ?, ?, 500, '10', ?${mark})`, [actionIndex, source, key, block]);
}

async function rotate(table, actionIndex, from, to, block) {
    await run(pool, `UPDATE ${table} SET signing_pubkey_id=? WHERE action_index=?`, [to, actionIndex]);
    await run(pool, `INSERT INTO contract_delegation_rotations
        (target_table, delegation_action_index, stake_action_index, prev_signing_pubkey_id, new_signing_pubkey_id, block_index)
        VALUES (?, 1, ?, ?, ?, ?)`, [table, actionIndex, from, to, block]);
}

const idsFor = async (address) =>
    (await run(pool, 'SELECT m.id FROM slash_events m WHERE ' + addressSlashScope() + ' ORDER BY m.id', [address]))
        .map(r => Number(r.id));

describe('address slash predicate against a real MariaDB', function () {
    this.timeout(30000);
    before(setUp);
    after(tearDown);
    beforeEach(async () => {
        for (const t of TABLES) await run(pool, 'DELETE FROM ' + t);
        await run(pool, 'INSERT INTO index_addresses (id, address) VALUES (1, "A"), (2, "B")');
    });

    it('returns the slash recorded under a replaced key and the one under the new key', async function () {
        await stake('contract_stakes', 10, 1, 1, 90);
        const early = await slash(1, 500, 100);
        await rotate('contract_stakes', 10, 1, 2, 200);
        const late = await slash(2, 500, 250);
        expect(await idsFor('A')).to.deep.equal([early, late]);
    });

    it('does not hand a later holder of the old key the address\'s slashes, nor take the same-block slash', async function () {
        await stake('contract_stakes', 10, 1, 1, 90);
        await rotate('contract_stakes', 10, 1, 2, 200);
        const sameBlock = await slash(1, 500, 200);
        await stake('contract_stakes', 11, 2, 1, 280);
        const laterHolder = await slash(1, 500, 300);
        const ids = await idsFor('A');
        expect(ids).to.not.include(sameBlock);
        expect(ids).to.not.include(laterHolder);
        expect(await idsFor('B')).to.include(laterHolder);
    });

    it('does not claim an intermediate-key slash from before the row held that key', async function () {
        await stake('contract_stakes', 10, 1, 1, 90);
        await rotate('contract_stakes', 10, 1, 2, 200);
        await rotate('contract_stakes', 10, 2, 1, 400);
        const before = await slash(2, 500, 150);
        const during = await slash(2, 500, 300);
        expect(await idsFor('A')).to.deep.equal([during]);
        expect(await idsFor('A')).to.not.include(before);
    });

    it('reaches a slash through a rotated contract_unstakes row', async function () {
        await stake('contract_unstakes', 20, 1, 1, 90);
        const early = await slash(1, 500, 100);
        await rotate('contract_unstakes', 20, 1, 2, 200);
        expect(await idsFor('A')).to.deep.equal([early]);
    });
});
