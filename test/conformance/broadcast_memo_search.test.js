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
 * The broadcast search panel's memo match and the token search page sort,
 * executed by a REAL MariaDB against the indexer's own DDL.
 *
 * index_memos.memo is utf8mb4_nopad_bin upstream, so a bare LIKE on it is
 * case-sensitive while broadcasts.message folds case. The statements run here
 * are the ones getSearch emits, captured from the module and not retyped, and
 * the pre-fix predicate runs on the same rows as the negative control. A
 * replica that never ran the memo migrations still holds memo as utf8mb3, so
 * the same statements run again after the column is altered back, and the bare
 * COLLATE form is shown to be a charset error there.
 *
 * Requires the integration MariaDB fixture (127.0.0.1:3307):
 *   npm run test:integration:up
 *
 ********************************************************************/

'use strict';

const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');
const sinon   = require('sinon');
const { expect } = require('chai');

const pre = require('../integration/helpers/fixture-preflight.js');
const { makeConfig, makeDb } = require('../unit/db/readers/db_contract_meta.test/support/helpers.js');

const connection  = pre.conformanceConnection();
const SEARCH_DB   = pre.conformanceDatabase('XChain_Conformance_Broadcast_Memo');
const INDEXER_SQL = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'sql');

let adminPool = null;
let pool      = null;
let shipped   = null;

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

// The broadcast and token statements getSearch builds, off the module itself.
async function captureShipped() {
    const out = {};
    for (const [type, indexes] of [['broadcast', false], ['token', true]]) {
        const db = makeDb();
        const calls = [];
        sinon.stub(db, 'doQuery').callsFake(async (config, query, args) => {
            if (/information_schema\.STATISTICS/.test(query)) return indexes && args[0] === 'tokens'
                ? [{ INDEX_NAME: 'description', INDEX_TYPE: 'BTREE', COLUMN_NAME: 'description', SEQ_IN_INDEX: 1 }] : [];
            calls.push({ query, args });
            return /COUNT\(\*\)/.test(query) ? [{ count: 1 }] : [];
        });
        await db.getSearch(makeConfig({ coin: 'RTEST', data: { method: 'getSearch', search: 'hello', type, sql: { limit: 10 } } }));
        out[type] = {
            count: calls.find(c => /COUNT\(\*\)/.test(c.query) && (type === 'broadcast' ? /broadcasts b/ : /tokens t1/).test(c.query)),
            page:  calls.find(c => !/COUNT\(\*\)/.test(c.query) && (type === 'broadcast' ? /broadcasts b/ : /tokens t1|index_tickers/).test(c.query))
        };
        sinon.restore();
    }
    return out;
}

async function loadSchema() {
    for (const f of ['index_memos.sql', 'index_statuses.sql', 'broadcasts.sql', 'index_tickers.sql', 'tokens.sql'])
        for (const stmt of splitStatements(fs.readFileSync(path.join(INDEXER_SQL, f), 'utf8'))) await run(pool, stmt);
}

async function setUp() {
    if (!fs.existsSync(INDEXER_SQL)) this.skip();
    adminPool = mariadb.createPool({ ...connection, connectionLimit: 2, connectTimeout: 8000 });
    try { await run(adminPool, 'SELECT 1'); }
    catch (e) {
        throw new Error('The broadcast memo tier needs the test MariaDB on ' + connection.host + ':' + connection.port +
            ' (start it with `npm run test:integration:up`): ' + e.message);
    }
    await run(adminPool, 'DROP DATABASE IF EXISTS `' + SEARCH_DB + '`');
    await run(adminPool, 'CREATE DATABASE `' + SEARCH_DB + '`');
    pool = mariadb.createPool({ ...connection, database: SEARCH_DB, connectionLimit: 4, connectTimeout: 8000 });
    await loadSchema();
    shipped = await captureShipped();
}

async function tearDown() {
    if (pool) await pool.end();
    if (!adminPool) return;
    try { await run(adminPool, 'DROP DATABASE IF EXISTS `' + SEARCH_DB + '`'); } catch (e) { /* teardown */ }
    await adminPool.end();
}

async function seedBroadcasts() {
    await run(pool, 'DELETE FROM broadcasts');
    await run(pool, 'DELETE FROM index_memos');
    await run(pool, 'INSERT INTO index_memos (id, memo) VALUES (1, ?), (2, ?)', ['Hello World', 'unrelated memo']);
    await run(pool, 'INSERT INTO broadcasts (action_index, message, memo_id) VALUES (1, ?, 1), (2, ?, 2), (3, ?, NULL)',
        ['plain text', 'Hello message', 'no memo']);
}

const counted = async (call) => Number((await run(pool, call.query, call.args))[0].count);
const pageRows = (call) => run(pool, call.query, call.args);
const OLD_MEMO_ONLY = `SELECT COUNT(*) AS count FROM (SELECT 1 FROM broadcasts b LEFT JOIN index_memos m ON (m.id=b.memo_id)
    WHERE m.memo LIKE ? LIMIT 100) bounded_matches`;

describe('broadcast search memo match against a real MariaDB', function () {
    this.timeout(30000);
    before(setUp);
    after(tearDown);
    beforeEach(seedBroadcasts);

    it('negative control: a bare LIKE on the byte-exact memo misses a different-case memo', async function () {
        const rows = await run(pool, OLD_MEMO_ONLY, ['hello%']);
        expect(Number(rows[0].count)).to.equal(0);
    });

    it('the shipped count and page statements match the memo in another case and the message too', async function () {
        expect(await counted(shipped.broadcast.count)).to.equal(2);
        const page = await pageRows(shipped.broadcast.page);
        expect(page.map(r => Number(r.action_index))).to.deep.equal([2, 1]);
    });

    it('still runs, and still matches, when the replica holds memo as utf8mb3', async function () {
        await run(pool, 'ALTER TABLE index_memos MODIFY memo VARCHAR(250) CHARACTER SET utf8 COLLATE utf8_general_ci NOT NULL');
        try {
            expect(await counted(shipped.broadcast.count)).to.equal(2);
            expect((await pageRows(shipped.broadcast.page)).length).to.equal(2);
            let failure = null;
            try { await run(pool, 'SELECT 1 FROM index_memos m WHERE m.memo COLLATE utf8mb4_general_ci LIKE ?', ['hello%']); }
            catch (e) { failure = e; }
            expect(failure, 'a bare COLLATE on a utf8mb3 column must be rejected').to.not.equal(null);
        } finally {
            await run(pool, 'ALTER TABLE index_memos MODIFY memo VARCHAR(250) CHARACTER SET utf8mb4 COLLATE utf8mb4_nopad_bin NOT NULL');
        }
    });
});

describe('token search page sort against a real MariaDB', function () {
    this.timeout(30000);
    before(setUp);
    after(tearDown);

    it('orders ticks that share their first 200 characters by the full tick, and ticker-less tokens first by id', async function () {
        const stem = 'T'.repeat(200);
        await run(pool, 'DELETE FROM tokens');
        await run(pool, 'DELETE FROM index_tickers');
        await run(pool, 'INSERT INTO index_tickers (id, tick) VALUES (1, ?), (2, ?)', [stem + 'B', stem + 'A']);
        await run(pool, 'INSERT INTO tokens (id, tick_id, description) VALUES (10, 1, ?), (11, 2, ?), (12, NULL, ?), (13, NULL, ?)',
            ['d1', 'd2', stem + ' one', stem + ' two']);
        const search = 'T'.repeat(200) + '%';
        const rows = await run(pool, shipped.token.page.query, [search, search]);
        expect(rows.map(r => r.description)).to.deep.equal([stem + ' one', stem + ' two', 'd2', 'd1']);
    });
});
