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
 * Boundary integration test helper — reuses base DB setup with boundary fixtures.
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

function getPool() {
    if (!pool) {
        pool = mariadb.createPool(DB_CONFIG);
    }
    return pool;
}

async function runSqlFile(filename, fixtureDir) {
    const dir = fixtureDir || path.join(__dirname, '..', 'fixtures');
    const filePath = path.join(dir, filename);
    const sql = fs.readFileSync(filePath, 'utf8');
    const conn = await getPool().getConnection();
    try {
        await conn.query(sql);
    } finally {
        conn.release();
    }
}

async function importSchema() {
    // Reuse the base integration schema
    const schemaPath = path.join(__dirname, '..', '..', '..', 'integration', 'fixtures');
    await runSqlFile('schema.sql', schemaPath);
}

async function seed() {
    await runSqlFile('seed-boundary.sql');
}

async function truncateAll() {
    const conn = await getPool().getConnection();
    try {
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

async function query(sql, args) {
    const conn = await getPool().getConnection();
    try {
        return await conn.query(sql, args);
    } finally {
        conn.release();
    }
}

async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

let setupDone = false;

async function setupDatabase() {
    if (setupDone) return;
    await importSchema();
    await seed();
    setupDone = true;
}

async function teardownDatabase() {
    await truncateAll();
    await closePool();
}

module.exports = {
    getPool, importSchema, seed, truncateAll, query,
    closePool, setupDatabase, teardownDatabase, DB_CONFIG
};
