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
 * Integration test helper. Manages the test MariaDB lifecycle.
 *
 * Expects a MariaDB instance on port 3307 (see docker-compose.test.yml).
 * Provides functions to import the schema and seed data.
 */

const mariadb = require('mariadb');
const fs      = require('fs');
const path    = require('path');

const preflight = require('./fixture-preflight.js');

const DB_CONFIG = {
    ...preflight.FIXTURE_DB,
    multipleStatements: true,
    connectionLimit: 5
};

let pool = null;

// Get or create the connection pool
function getPool() {
    if (!pool) {
        pool = mariadb.createPool(DB_CONFIG);
    }
    return pool;
}

// Take a connection, translating the one failure that reads as unreadable
// otherwise. When a foreign server holds 3307 the fixture container never
// binds, and the pool's error is "Access denied for user 'root'@'127.0.0.1'",
// which names
// neither the port nor the collision and reads as a credential bug in the
// fixture. decorateFixtureError replaces it with a report that says the port is
// held, by what, and how to clear it; every other error passes through
// untouched.
async function acquire() {
    try {
        return await getPool().getConnection();
    } catch (err) {
        throw preflight.decorateFixtureError(err);
    }
}

// Remove SQL `--` line comments while respecting quoted strings, so a ';' in
// comment prose is never read as a statement terminator. Mirrors the same-named
// helper in src/hub_db_sync.js; the fixtures carry a license header whose text
// ("...v3.0 or later; see LICENSE.md...") tore every DELIMITER-bearing fixture
// into an invalid fragment until this ran first.
function stripSqlLineComments(sql) {
    let out = '';
    let quote = null;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (quote) {
            out += ch;
            if (ch === quote) {
                if (sql[i + 1] === quote) { out += sql[++i]; }
                else { quote = null; }
            }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
        if (ch === '-' && sql[i + 1] === '-') {
            while (i < sql.length && sql[i] !== '\n') { i++; }
            if (i < sql.length) { out += '\n'; }
            continue;
        }
        out += ch;
    }
    return out;
}

// Split a SQL script into statements: strip `--` comments, then honor `DELIMITER`
// directives while breaking on the active delimiter outside quoted strings. The
// node mariadb driver has no client-side DELIMITER handling (that is a CLI-only
// directive), so a fixture that defines a stored procedure with `DELIMITER //`
// cannot be sent as one multi-statement query: the procedure body's internal `;`
// would be mis-split. This walks the script line by line, tracking the active
// delimiter, and returns each statement so runSqlFile can send them one at a
// time. Comments and string literals are respected; it is not otherwise a
// general-purpose SQL parser.
function splitSqlStatements(sql) {
    const out = [];
    let delim = ';';
    let buf = '';
    // Break `text` on `d`, skipping any occurrence inside a quoted string: a
    // fixture value containing the delimiter would otherwise be cut in half and
    // sent as two invalid statements.
    const splitOutsideQuotes = (text, d) => {
        const parts = [];
        let cur = '';
        let quote = null;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (quote) {
                cur += ch;
                if (ch === quote) {
                    if (text[i + 1] === quote) { cur += text[++i]; }
                    else { quote = null; }
                }
                continue;
            }
            if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
            if (text.startsWith(d, i)) { parts.push(cur); cur = ''; i += d.length - 1; continue; }
            cur += ch;
        }
        parts.push(cur);
        return parts;
    };
    const flush = (d) => {
        for (const part of splitOutsideQuotes(buf, d)) {
            if (part.trim()) out.push(part.trim());
        }
        buf = '';
    };
    for (const line of stripSqlLineComments(sql).split('\n')) {
        const m = line.match(/^\s*DELIMITER\s+(\S+)\s*$/i);
        if (m) { flush(delim); delim = m[1]; continue; }
        buf += line + '\n';
    }
    flush(delim);
    return out;
}

// Run a SQL file against the test database. A bare name (no separator) is a
// fixture under test/integration/fixtures/; a name containing a separator is a
// path relative to test/integration/ (perf seeds live in ../performance/helpers).
async function runSqlFile(filename) {
    const filePath = filename.includes('/')
        ? path.join(__dirname, '..', filename)
        : path.join(__dirname, '..', 'fixtures', filename);
    const sql = fs.readFileSync(filePath, 'utf8');
    const conn = await acquire();
    try {
        if (/^\s*DELIMITER\s/mi.test(sql)) {
            for (const stmt of splitSqlStatements(sql)) {
                await conn.query(stmt);
            }
        } else {
            await conn.query(sql);
        }
    } finally {
        conn.release();
    }
}

// Import the schema (creates all tables)
async function importSchema() {
    await runSqlFile('schema.sql');
}

// Load seed data
async function seed(fixture) {
    const file = fixture || 'seed-baseline.sql';
    await runSqlFile(file);
}

// Truncate all data tables (preserves schema)
async function truncateAll() {
    const conn = await acquire();
    try {
        // Disable FK checks during truncate
        await conn.query('SET FOREIGN_KEY_CHECKS=0');
        const rows = await conn.query(
            `SELECT table_name FROM information_schema.tables WHERE table_schema=? AND table_type='BASE TABLE'`,
            [DB_CONFIG.database]
        );
        for (const row of rows) {
            await conn.query(`TRUNCATE TABLE \`${row.table_name}\``);
        }
        await conn.query('SET FOREIGN_KEY_CHECKS=1');
    } finally {
        conn.release();
    }
}

// Run an arbitrary query (for test assertions)
async function query(sql, args) {
    const conn = await acquire();
    try {
        return await conn.query(sql, args);
    } finally {
        conn.release();
    }
}

// Shut down the pool
async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

// Track whether setup has already run (idempotent across multiple test files)
let setupDone = false;

// Full setup: schema + seed (runs only once)
async function setupDatabase(fixture) {
    if (setupDone) return;
    await importSchema();
    await seed(fixture);
    setupDone = true;
}

// Full teardown
async function teardownDatabase() {
    await truncateAll();
    await closePool();
}

module.exports = {
    getPool,
    importSchema,
    seed,
    truncateAll,
    query,
    closePool,
    setupDatabase,
    teardownDatabase,
    DB_CONFIG,
    // Exported for the unit guard: the fixture splitter is DB-free and its
    // comment handling is what the perf suite regressed on.
    splitSqlStatements
};
