/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Integration test helper — manages the test MariaDB lifecycle.
 *
 * Expects a MariaDB instance on port 3307 (see docker-compose.test.yml).
 * Provides functions to import the schema and seed data.
 */

const mariadb = require('mariadb');
const fs      = require('fs');
const path    = require('path');

const DB_CONFIG = {
    host: '127.0.0.1',
    port: 3307,
    user: 'root',
    password: 'testpass',
    database: 'XChain_BTC_Regtest_Indexer',
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

// Run a SQL file against the test database
async function runSqlFile(filename) {
    const filePath = path.join(__dirname, '..', 'fixtures', filename);
    const sql = fs.readFileSync(filePath, 'utf8');
    const conn = await getPool().getConnection();
    try {
        await conn.query(sql);
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
    const conn = await getPool().getConnection();
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
    const conn = await getPool().getConnection();
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
    DB_CONFIG
};
