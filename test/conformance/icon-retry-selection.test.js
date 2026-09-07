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
 * The icon batch-queue selection predicate, executed by a REAL MariaDB.
 *
 * The invariant this tier exists to hold:
 *
 *   every icons row _markFailure parks in BACKOFF (status 'failed' with a
 *   next_retry_at) re-enters _processFlavor's batch once that timer elapses,
 *   and every row it RETIRES (status 'failed', next_retry_at NULL) never does.
 *
 * Why a real engine and not a SQL-text assertion. The unit tier can only check
 * the SHAPE of the emitted statement; the defect this file was written for was
 * a shape that read as correct (a next_retry_at timer predicate sitting right
 * there in the WHERE clause) and selected nothing, because the status list
 * beside it excluded every row that ever carries such a timer. Only rows in a
 * real table settle which rows come back, so only rows answer it here.
 *
 * The pre-fix predicate is kept verbatim below as the NEGATIVE CONTROL: it runs
 * against the same seeded rows and must MISS the elapsed-backoff row. A rig that
 * cannot reproduce the original failure certifies nothing about the fix.
 *
 * Requires the integration MariaDB fixture (127.0.0.1:3307):
 *   npm run test:integration:up
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const mariadb = require('mariadb');
const { expect } = require('chai');

const IconDownloader = require('../../src/IconDownloader.js');

const DB_HOST = process.env.CONFORMANCE_DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.CONFORMANCE_DB_PORT || 3307);
const DB_USER = process.env.CONFORMANCE_DB_USER || 'root';
const DB_PASS = process.env.CONFORMANCE_DB_PASS || 'testpass';

const RETRY_DB        = 'XChain_Conformance_IconRetry';
const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'sql');

// The WHERE clause as it shipped before the fix, verbatim. Same role as
// PRE_FIX_PREDICATE in icon-restale-predicate.test.js.
const PRE_FIX_WHERE =
    "i.status IN ('pending','stale') " +
    'AND (i.next_retry_at IS NULL OR i.next_retry_at <= NOW())';

/**
 * Split a DDL script into statements, stripping inline `--` comments first
 * (tokens.sql carries a semicolon inside one). Same helper shape as
 * icon-restale-predicate.test.js and schema-conformance.test.js.
 */
function splitStatements(sql) {
    return sql.split('\n')
        .map(line => { const i = line.indexOf('--'); return i === -1 ? line : line.slice(0, i); })
        .join('\n')
        .split(';').map(s => s.trim()).filter(s => s.length > 0);
}

// One row per state the writers can leave an icons row in, plus the two that
// only a bug could produce. `retry` is minutes relative to NOW(): negative is an
// elapsed timer, positive a live one, null a cleared one.
const SEED = [
    { tick: 'PEND',     status: 'pending', retry: null, attempts: 0, expect: true,
      why: 'never checked' },
    { tick: 'STALE',    status: 'stale',   retry: null, attempts: 0, expect: true,
      why: 'description drifted' },
    { tick: 'BACKOFF',  status: 'failed',  retry: -60,  attempts: 1, expect: true,
      why: 'transient failure whose backoff has elapsed - the row this fix exists for' },
    { tick: 'WAITING',  status: 'failed',  retry: 60,   attempts: 2, expect: false,
      why: 'transient failure still inside its backoff window' },
    { tick: 'TERMINAL', status: 'failed',  retry: null, attempts: 4, expect: false,
      why: 'retired at maxAttempts - next_retry_at NULL is the terminal flag' },
    { tick: 'OK',       status: 'ok',      retry: null, attempts: 0, expect: false,
      why: 'already has its icon' },
    { tick: 'STALEWAIT', status: 'stale',  retry: 60,   attempts: 1, expect: false,
      why: 'stale but still timer-held' },
];

describe('IconDownloader batch selection vs a real MariaDB', function () {
    this.timeout(180000);

    let adminPool = null;   // no default database: creates/drops the schema
    let pool      = null;   // bound to RETRY_DB
    let selectSql = null;   // the SHIPPED batch SELECT, verbatim
    let whereSql  = null;   // its WHERE clause, verbatim

    async function adminQuery(sql, args) {
        const conn = await adminPool.getConnection();
        try { return await conn.query(sql, args); }
        finally { conn.release(); }
    }

    async function q(sql, args) {
        const conn = await pool.getConnection();
        try { return await conn.query(sql, args); }
        finally { conn.release(); }
    }

    /**
     * Capture the statement _processFlavor actually emits. Binding to the shipped
     * text rather than to a copy of it is the point: a test that rebuilt the
     * predicate here would pass just as happily against the version that shipped
     * the bug.
     */
    async function shippedSelect() {
        const sqls = [];
        const conn = {
            query:   async (sql) => { sqls.push(sql); return []; },
            release: async () => {},
        };
        const downloader = new IconDownloader({ util: {} });
        downloader._log = () => {};
        // Point the icon root at an empty directory so the orphan sweep short-circuits
        // and cannot touch this checkout's real src/content/icons tree while we are
        // only here to read a statement back out.
        downloader.iconRoot = await require('fs/promises')
            .mkdtemp(path.join(require('os').tmpdir(), 'iconcapture_'));
        await downloader._processFlavor({
            coin: 'BTC', network: 'mainnet', poolKey: 'BTC',
            pool: { getConnection: async () => conn },
        });
        // `AS icon_id` is what distinguishes the batch drain from the sweep's query,
        // which also selects FROM icons.
        return sqls.find(s => /^\s*SELECT/.test(s) && s.includes('AS icon_id'));
    }

    before(async function () {
        if (!fs.existsSync(INDEXER_SQL_DIR)) this.skip();

        adminPool = mariadb.createPool({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
            connectionLimit: 2, connectTimeout: 8000,
        });
        try {
            await adminQuery('SELECT 1');
        } catch (e) {
            throw new Error('The icon batch-selection tier needs the test MariaDB on ' + DB_HOST +
                ':' + DB_PORT + ' (start it with `npm run test:integration:up`): ' + e.message);
        }

        await adminQuery('DROP DATABASE IF EXISTS `' + RETRY_DB + '`');
        await adminQuery('CREATE DATABASE `' + RETRY_DB + '`');

        pool = mariadb.createPool({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
            database: RETRY_DB, connectionLimit: 4, connectTimeout: 8000,
        });

        // The indexer's REAL DDL for every table the batch SELECT joins.
        for (const f of ['tokens.sql', 'icons.sql', 'index_tickers.sql']) {
            const src = fs.readFileSync(path.join(INDEXER_SQL_DIR, f), 'utf8');
            for (const stmt of splitStatements(src)) await q(stmt);
        }

        selectSql = await shippedSelect();
        expect(selectSql, 'expected _processFlavor to emit a batch SELECT').to.be.a('string');
        whereSql = selectSql.slice(selectSql.indexOf('WHERE ') + 'WHERE '.length,
                                   selectSql.indexOf('ORDER BY')).trim();
        expect(whereSql, 'expected a WHERE clause between FROM and ORDER BY').to.have.length.above(10);

        // Seed once: nothing below mutates rows.
        for (let i = 0; i < SEED.length; i++) {
            const s = SEED[i];
            await q('INSERT INTO index_tickers (id, tick) VALUES (?, ?)', [i + 1, s.tick]);
            await q('INSERT INTO tokens (id, tick_id, description) VALUES (?, ?, ?)',
                    [i + 1, i + 1, 'action:' + (i + 1)]);
            await q(
                `INSERT INTO icons (token_id, description_hash, status, attempts,
                                    next_retry_at, last_checked_at)
                 VALUES (?, MD5('x'), ?, ?, ` +
                (s.retry === null ? 'NULL' : 'DATE_ADD(NOW(), INTERVAL ? MINUTE)') +
                `, NOW())`,
                s.retry === null
                    ? [i + 1, s.status, s.attempts]
                    : [i + 1, s.status, s.attempts, s.retry]);
        }
    });

    after(async function () {
        if (pool) await pool.end();
        if (!adminPool) return;
        try { await adminQuery('DROP DATABASE IF EXISTS `' + RETRY_DB + '`'); }
        catch (e) { /* teardown */ }
        await adminPool.end();
    });

    /** Run a WHERE clause against the seeded rows and return the ticks it selects. */
    async function selectedBy(where) {
        const rows = await q(
            `SELECT idx.tick AS tick
             FROM icons i
             JOIN tokens        t   ON t.id   = i.token_id
             JOIN index_tickers idx ON idx.id = t.tick_id
             WHERE ` + where);
        return rows.map(r => r.tick).sort();
    }

    // The negative control. Everything below is only meaningful if this rig can
    // reproduce the original defect, so prove it does: the pre-fix WHERE clause
    // must MISS the elapsed-backoff row against these very same rows.
    it('NEGATIVE CONTROL: the pre-fix WHERE clause never re-admits an elapsed backoff row',
       async function () {
        const selected = await selectedBy(PRE_FIX_WHERE);
        expect(selected, 'the pre-fix clause must miss BACKOFF, or this rig proves nothing')
            .to.not.include('BACKOFF');
        expect(selected).to.deep.equal(['PEND', 'STALE']);
    });

    it('the shipped clause selects exactly the rows that are due', async function () {
        const expected = SEED.filter(s => s.expect).map(s => s.tick).sort();
        const selected = await selectedBy(whereSql);
        expect(selected).to.deep.equal(expected);
    });

    it('an elapsed backoff row comes back and a retired one does not', async function () {
        const selected = await selectedBy(whereSql);
        expect(selected, 'transient failure past its timer must retry').to.include('BACKOFF');
        expect(selected, 'a row retired at maxAttempts is terminal').to.not.include('TERMINAL');
        expect(selected, 'a failure still inside its window must wait').to.not.include('WAITING');
    });

    it('the full shipped SELECT (joins, ORDER BY, LIMIT) runs on the real schema',
       async function () {
        const rows = await q(selectSql, [50]);
        expect(rows.map(r => r.tick).sort())
            .to.deep.equal(SEED.filter(s => s.expect).map(s => s.tick).sort());
        // Every column _processToken reads must actually arrive.
        for (const r of rows) {
            expect(r).to.have.property('icon_id');
            expect(r).to.have.property('token_id');
            expect(r).to.have.property('attempts');
            expect(r).to.have.property('description');
        }
    });

    /**
     * The orphan sweep's own query, run by the real engine over a real
     * icons/tokens/index_tickers join and a real directory.
     *
     * A mock cannot answer the two things that can actually go wrong here: whether
     * the three-way join resolves a tick at all, and whether IN (...) matches the
     * filename bytes without case folding (index_tickers is utf8mb4_bin, and the
     * LOWER()-vs-/i divergence in icon-restale-predicate.test.js is what that
     * collation exists to prevent). So run the shipped method against both.
     */
    describe('_sweepOrphanIcons against the real join', function () {
        const os   = require('os');
        const fsp  = require('fs/promises');

        let tmpRoot = null;
        let dir     = null;

        beforeEach(async function () {
            tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'iconsweep_'));
            dir = path.join(tmpRoot, 'BTC', 'mainnet');
            await fsp.mkdir(dir, { recursive: true });
        });

        afterEach(async function () {
            if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
        });

        async function sweepWith(files) {
            for (const f of files) await fsp.writeFile(path.join(dir, f), 'x');
            const d = new IconDownloader({ util: {} });
            d.iconRoot = tmpRoot;
            d._log = () => {};
            const conn = await pool.getConnection();
            try { await d._sweepOrphanIcons(conn, { coin: 'BTC', network: 'mainnet' }); }
            finally { conn.release(); }
            return (await fsp.readdir(dir)).sort();
        }

        // OK is seeded at status='ok' with icon_hash NULL, so it is the orphan. Every
        // other seeded row is in some other status and must survive: a 'stale' or
        // 'failed' row can still be holding a perfectly good icon.
        it('removes the ok-with-no-icon PNG and leaves every other state alone',
           async function () {
            const left = await sweepWith(['OK.png', 'PEND.png', 'STALE.png', 'BACKOFF.png',
                                          'TERMINAL.png', 'notes.txt']);
            expect(left).to.deep.equal(
                ['BACKOFF.png', 'PEND.png', 'STALE.png', 'TERMINAL.png', 'notes.txt'].sort());
        });

        // The negative control for the sweep's safety rule: it deletes on a POSITIVE
        // answer only. Files whose tick the database does not know at all - a
        // reindexing or truncated DB - are exactly the case an inverted sweep would
        // wipe, so prove this one leaves them.
        it('NEGATIVE CONTROL: an unknown tick is never deleted', async function () {
            const left = await sweepWith(['NOSUCHTICK.png', 'OK.png']);
            expect(left, 'a tick with no row must survive').to.include('NOSUCHTICK.png');
            expect(left, 'and the one the DB does report is still removed')
                .to.not.include('OK.png');
        });

        // index_tickers is utf8mb4_bin. A case-folding comparison would match 'ok'
        // against the seeded 'OK' row and delete a file no row claims.
        it('matches tick bytes exactly, with no case folding', async function () {
            const left = await sweepWith(['ok.png']);
            expect(left).to.deep.equal(['ok.png']);
        });
    });
});
