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
 * The `action:` re-stale predicate, executed by a REAL MariaDB (#5290).
 *
 * The invariant this tier exists to hold:
 *
 *     { descriptions IconDownloader._discover statement (c) CAN SELECT }
 *   ⊆ { descriptions IconResolver.resolveDescriptionToSource CAN RESOLVE }
 *
 * A row the predicate selects but the resolver cannot resolve is not a cosmetic
 * mismatch. Statement (c) selects rows in the terminal ok-with-NULL-icon_hash
 * state, and _processToken writes that exact state back for any description that
 * resolves to nothing, so such a row is re-staled on every cycle forever: a
 * permanent write loop on the indexer-owned icons table plus permanent occupancy
 * of the batch queue, mintable by anyone who can issue a token, because token
 * descriptions are attacker-controlled on-chain data.
 *
 * Why this test is in the REAL-ENGINE tier and not the unit tier. The unit tier
 * can only ever check a JS MODEL of the predicate, and this defect survived two
 * rounds of review precisely because the model and the engine disagreed. The
 * predicate emulated the resolver's /i with MariaDB's LOWER(), and those are
 * different functions: MariaDB's utf8mb4 LOWER() folds U+0130 (LATIN CAPITAL
 * LETTER I WITH DOT ABOVE) to plain 'i', while JS's non-unicode /i canonicalises
 * via toUpperCase and leaves it alone. So `ACTİON:12` MATCHED in the database and
 * resolved to null in Node. The unit test missed it twice over because it modelled
 * MariaDB's LOWER() with JavaScript's toLowerCase(), and those disagree too:
 * "İ".toLowerCase() is 'i' plus a COMBINING DOT ABOVE, two characters, which does
 * not match the grammar. Only a real engine settles this, so only a real engine
 * is allowed to answer it here.
 *
 * The fix removes case folding from the comparison on both sides rather than
 * trying to make two different folding functions agree: ACTION_REF_PATTERN spells
 * both cases of every letter out, and the SQL matches under
 * CONVERT(... USING binary) so no collation can fold anything into the grammar.
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
const { resolveDescriptionToSource, ACTION_REF_PATTERN } = require('../../src/IconResolver.js');

const DB_HOST = process.env.CONFORMANCE_DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.CONFORMANCE_DB_PORT || 3307);
const DB_USER = process.env.CONFORMANCE_DB_USER || 'root';
const DB_PASS = process.env.CONFORMANCE_DB_PASS || 'testpass';

const RESTALE_DB      = 'XChain_Conformance_Restale';
const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'sql');

// The pre-fix predicate shape, kept verbatim as the NEGATIVE CONTROL. If the
// corpus below ever stops catching this, the corpus has gone blind, not safe.
const PRE_FIX_PREDICATE = "LOWER(TRIM(t.description)) REGEXP '^action:((btc|ltc|doge):)?([0-9]+)$'";

/**
 * Split a DDL script into statements. Inline `--` comments come off FIRST,
 * because the real tokens.sql carries a semicolon inside one of them and a naive
 * split on ';' truncates the CREATE TABLE mid-column. Same shape as the helper
 * in schema-conformance.test.js.
 */
function splitStatements(sql) {
    return sql.split('\n')
        .map(line => { const i = line.indexOf('--'); return i === -1 ? line : line.slice(0, i); })
        .join('\n')
        .split(';').map(s => s.trim()).filter(s => s.length > 0);
}

// Descriptions the live resolver RESOLVES. The predicate must still reach these
// or the fix never lands on the rows it exists for.
const RESOLVABLE = [
    'action:12', 'action:BTC:5', 'ACTION:12', 'Action:BTC:5',
    'action:ltc:7', 'ACTION:DOGE:99', 'aCtIoN:DoGe:1', '  action:7  ',
];

// Descriptions the live resolver returns null for. Every one is `action:`-shaped
// enough to tempt a loose predicate; none may ever be selected. The U+0130 pair
// is the attacker-mintable case this tier was written for.
const UNRESOLVABLE = [
    'action:foo', 'action:BTC:', 'action:', 'action:12a',
    'action:XYZ:5', 'action:0x10', 'action: 12', 'Action:hello',
    'ACTİON:12', 'ACTİON:BTC:5', 'actİon:12',
    'actıon:12', 'ACTION：12', 'ＡＣＴＩＯＮ:12',
];

describe('IconDownloader re-stale predicate vs a real MariaDB (#5290)', function () {
    this.timeout(180000);

    let adminPool = null;      // no default database: creates/drops the schema
    let pool      = null;      // BOUND to RESTALE_DB, so every pooled connection
                               // has the right default database. A per-query
                               // `USE` would not: the pool hands back a different
                               // connection each time, and the shipped statement
                               // names `icons` and `tokens` unqualified.
    let restaleSql   = null;   // the SHIPPED statement (c), verbatim
    let predicateSql = null;   // its description conjunct, verbatim

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
     * Capture the three statements _discover actually emits. Binding to the
     * shipped text rather than to a copy of it is the point: a test that
     * rebuilds the predicate from ACTION_REF_PATTERN itself would pass just as
     * happily against the LOWER() version that shipped the bug.
     */
    function shippedDiscoverStatements() {
        const sqls = [];
        const downloader = new IconDownloader({ util: {} });
        const conn = { query: async (sql) => { sqls.push(sql); return []; }, release: async () => {} };
        return downloader._discover(conn).then(() => sqls);
    }

    before(async function () {
        // Only skip for a standalone explorer checkout with no sibling indexer
        // DDL. CI supplies it, and so does the platform monorepo.
        if (!fs.existsSync(INDEXER_SQL_DIR)) this.skip();

        adminPool = mariadb.createPool({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
            connectionLimit: 2, connectTimeout: 8000,
        });
        try {
            await adminQuery('SELECT 1');
        } catch (e) {
            throw new Error('The re-stale predicate tier needs the test MariaDB on ' + DB_HOST + ':' +
                DB_PORT + ' (start it with `npm run test:integration:up`): ' + e.message);
        }

        await adminQuery('DROP DATABASE IF EXISTS `' + RESTALE_DB + '`');
        await adminQuery('CREATE DATABASE `' + RESTALE_DB + '`');

        pool = mariadb.createPool({
            host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
            database: RESTALE_DB, connectionLimit: 4, connectTimeout: 8000,
        });

        // The indexer's REAL tokens/icons DDL, verbatim. tokens.description is
        // utf8mb4 there while the tables around it are utf8mb3, which is exactly
        // why the shipped predicate converts to binary instead of naming a
        // collation: a literal `COLLATE utf8_bin` is a charset error on the real
        // column, and a literal `COLLATE utf8mb4_bin` is one on the fixture's.
        for (const f of ['tokens.sql', 'icons.sql']) {
            const src = fs.readFileSync(path.join(INDEXER_SQL_DIR, f), 'utf8');
            for (const stmt of splitStatements(src)) await q(stmt);
        }

        const statements = await shippedDiscoverStatements();
        expect(statements, 'expected _discover to emit three statements').to.have.length(3);
        restaleSql = statements[2];

        // The description conjunct of the shipped statement, pulled out so the
        // exhaustive sweep below runs the SAME expression the worker runs.
        predicateSql = restaleSql.split('\n').map(s => s.trim())
            .filter(s => s.includes('t.description')).pop();
        expect(predicateSql, 'statement (c) must test t.description').to.be.a('string');
        predicateSql = predicateSql.replace(/^AND\s+/i, '');
    });

    after(async function () {
        if (pool) await pool.end();
        if (!adminPool) return;
        try { await adminQuery('DROP DATABASE IF EXISTS `' + RESTALE_DB + '`'); }
        catch (e) { /* teardown */ }
        await adminPool.end();
    });

    /**
     * Seed one token + one icons row per description, with the icons row parked
     * in the terminal state statement (c) selects on (status ok, icon_hash NULL)
     * and its description_hash already current so statement (b) stays inert and
     * only (c) can move anything.
     */
    async function seed(descriptions) {
        await q('DELETE FROM icons');
        await q('DELETE FROM tokens');
        for (let i = 0; i < descriptions.length; i++) {
            await q('INSERT INTO tokens (id, description) VALUES (?, ?)', [i + 1, descriptions[i]]);
            await q(`INSERT INTO icons (token_id, description_hash, status, icon_hash)
                     SELECT id, MD5(description), 'ok', NULL FROM tokens WHERE id = ?`, [i + 1]);
        }
    }

    /** Run the SHIPPED statement (c) and return the descriptions it re-staled. */
    async function runShippedRestale() {
        await q(restaleSql);
        const rows = await q(`SELECT t.description AS d FROM icons i
                              JOIN tokens t ON t.id = i.token_id WHERE i.status = 'stale'`);
        return rows.map(r => r.d);
    }

    it('premise check: the real tokens.description really is utf8mb4', async function () {
        const rows = await adminQuery(
            `SELECT CHARACTER_SET_NAME cs, COLLATION_NAME co FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tokens' AND COLUMN_NAME = 'description'`,
            [RESTALE_DB]);
        expect(rows, 'tokens.description must exist in the real DDL').to.have.length(1);
        expect(rows[0].cs).to.equal('utf8mb4');
    });

    // The negative control. Everything below is only meaningful if this corpus
    // and this rig can actually catch the defect, so prove they do by running
    // the pre-fix predicate against them and watching it select the poison.
    it('NEGATIVE CONTROL: the pre-fix LOWER() predicate DOES select the U+0130 poison', async function () {
        await seed(UNRESOLVABLE);
        const rows = await q(
            'SELECT t.description AS d FROM tokens t WHERE ' + PRE_FIX_PREDICATE);
        const selected = rows.map(r => r.d);

        expect(selected, 'the pre-fix predicate must select ACTİON:12, or this corpus proves nothing')
            .to.include('ACTİON:12');
        expect(selected).to.include('ACTİON:BTC:5');
        for (const d of selected) {
            expect(resolveDescriptionToSource(d),
                'and every one it selects is unresolvable, i.e. an infinite re-stale').to.equal(null);
        }

        // And the engine-level reason, stated as a fact about MariaDB rather than
        // an argument about it.
        const [{ folds }] = await q("SELECT LOWER(_utf8mb4 0xC4B0) = _utf8mb4'i' AS folds");
        expect(Number(folds), 'MariaDB LOWER() folds U+0130 to ASCII i').to.equal(1);
        expect(/^action:/i.test('ACTİON:12'),
            'JavaScript /i does NOT, which is the whole divergence').to.equal(false);
    });

    it('SUBSET INVARIANT: every description the shipped predicate selects, the resolver resolves',
        async function () {
            await seed(RESOLVABLE.concat(UNRESOLVABLE));
            const selected = await runShippedRestale();

            const violations = selected.filter(d => resolveDescriptionToSource(d) === null);
            expect(violations, 'selected but unresolvable => re-staled forever:\n' +
                violations.map(v => JSON.stringify(v)).join('\n')).to.deep.equal([]);
            expect(selected.length, 'a vacuous pass: the predicate selected nothing at all')
                .to.be.greaterThan(0);
        });

    it('never selects an unresolvable description, U+0130 spellings included', async function () {
        await seed(RESOLVABLE.concat(UNRESOLVABLE));
        const selected = await runShippedRestale();
        for (const d of UNRESOLVABLE) {
            expect(resolveDescriptionToSource(d), JSON.stringify(d) + ' must resolve to no source')
                .to.equal(null);
            expect(selected, JSON.stringify(d) + ' resolves to nothing, so re-staling it loops forever')
                .to.not.include(d);
        }
    });

    it('still selects every description the resolver does resolve', async function () {
        await seed(RESOLVABLE.concat(UNRESOLVABLE));
        const selected = await runShippedRestale();
        for (const d of RESOLVABLE) {
            expect(resolveDescriptionToSource(d).scheme, JSON.stringify(d) + ' must resolve')
                .to.equal('action');
            expect(selected, JSON.stringify(d) + ' resolves, so the fix must reach its row')
                .to.include(d);
        }
    });

    it('is one-shot: a second cycle over the same unresolvable rows re-stales nothing',
        async function () {
            await seed(UNRESOLVABLE);
            expect(await runShippedRestale(), 'cycle 1').to.deep.equal([]);
            // _processToken writes these rows straight back to ok/NULL, so the
            // state the statement selects on is unchanged going into cycle 2.
            expect(await runShippedRestale(), 'cycle 2').to.deep.equal([]);
        });

    // The exhaustive half. The cases above are the ones a human thought of; this
    // is the one that does not depend on having thought of anything, and it is
    // what turns "we fixed U+0130" into "no codepoint can do this".
    it('EXHAUSTIVE: no Unicode scalar value can enter the grammar, at any slot',
        async function () {
            await q('DROP TABLE IF EXISTS sweep_cps');
            await q(`CREATE TABLE sweep_cps (
                        cp INT PRIMARY KEY,
                        ch VARCHAR(4) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci
                     ) ENGINE=InnoDB`);

            // The recursion cap is a SESSION variable, so it has to be set on the
            // same connection that runs the recursive CTE.
            const conn = await pool.getConnection();
            try {
                await conn.query('SET SESSION max_recursive_iterations = 2000000');
                await conn.query(`INSERT INTO sweep_cps (cp, ch)
                    WITH RECURSIVE n(cp) AS (
                        SELECT 1 UNION ALL SELECT cp+1 FROM n WHERE cp < 1114111)
                    SELECT cp, CONVERT(CHAR(cp USING utf32) USING utf8mb4)
                    FROM n WHERE cp NOT BETWEEN 55296 AND 57343`);
            } finally { conn.release(); }

            const [{ n }] = await q('SELECT COUNT(*) AS n FROM sweep_cps');
            expect(Number(n), 'every Unicode scalar value must be present')
                .to.equal(1112063);

            // Every codepoint substituted into each structural slot of the
            // grammar: before it, after it, in a letter position, in a digit
            // position, and in the coin-ticker position.
            const slots = {
                leading: "CONCAT(ch,'action:12')",
                trailing: "CONCAT('action:12',ch)",
                letter: "CONCAT('act',ch,'on:12')",
                digit: "CONCAT('action:',ch,'2')",
                ticker: "CONCAT('action:',ch,'tc:5')",
            };
            const probes = Object.values(slots)
                .map(expr => `SELECT cp, ${expr} AS description FROM sweep_cps`).join(' UNION ALL ');

            // The shipped predicate, verbatim, over all 5,560,315 probe strings.
            const nonAscii = await q(
                `SELECT COUNT(*) AS n FROM (${probes}) t WHERE t.cp > 127 AND ${predicateSql}`);
            expect(Number(nonAscii[0].n),
                'a non-ASCII codepoint reached the grammar; ' + predicateSql).to.equal(0);

            // Not merely "no non-ASCII": everything it DOES select must resolve.
            const selected = await q(
                `SELECT DISTINCT t.description AS d FROM (${probes}) t WHERE ${predicateSql}`);
            expect(selected.length, 'a vacuous sweep selects nothing').to.be.greaterThan(0);
            const violations = selected.map(r => r.d)
                .filter(d => resolveDescriptionToSource(d) === null);
            expect(violations, 'engine selected what Node cannot resolve:\n' +
                violations.map(v => JSON.stringify(v)).join('\n')).to.deep.equal([]);

            // And the same sweep against the PRE-FIX predicate still finds the
            // poison, so a green result above means the fix works rather than
            // meaning the sweep stopped looking.
            const preFix = await q(
                `SELECT t.cp AS cp FROM (${probes}) t
                  WHERE t.cp > 127 AND ${PRE_FIX_PREDICATE}`);
            expect(preFix.map(r => Number(r.cp)),
                'the sweep must still catch the pre-fix defect').to.deep.equal([304]);

            await q('DROP TABLE IF EXISTS sweep_cps');
        });

    // Guards the two ways this could silently regress in source.
    it('the shipped statement does no case folding and matches under a binary collation',
        function () {
            expect(restaleSql).to.include("REGEXP '" + ACTION_REF_PATTERN + "'");
            expect(restaleSql, 'CONVERT-to-binary is what makes the SQL side ASCII-exact')
                .to.include('CONVERT(TRIM(t.description) USING binary)');
            expect(restaleSql, 'LOWER() is not /i; emulating one with the other is the defect')
                .to.not.match(/LOWER\s*\(/i);
            expect(restaleSql).to.not.include("LIKE 'action:%'");

            // Every letter in the grammar is spelt as a two-case class. Strip the
            // classes and no bare letter may be left: one would be case-SENSITIVE
            // on both sides now that neither side folds, silently dropping
            // `ACTION:12` out of the language.
            const bare = ACTION_REF_PATTERN.replace(/\[[A-Za-z]{2}\]|\[0-9\]/g, '');
            expect(bare, 'a bare letter in the pattern is now case-sensitive on both sides')
                .to.not.match(/[A-Za-z]/);
            for (const [, upper, lower] of ACTION_REF_PATTERN.matchAll(/\[([A-Za-z])([A-Za-z])\]/g)) {
                expect(lower, 'class [' + upper + lower + '] must be one letter in both cases')
                    .to.equal(upper.toLowerCase());
            }
        });
});
