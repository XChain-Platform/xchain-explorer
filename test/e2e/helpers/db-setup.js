/**
 * E2E test helper — extends the integration db-setup with E2E-specific seed data.
 *
 * Reuses the integration helper for schema import and baseline seeding,
 * then layers on seed-e2e.sql which adds BigInt tokens, consistency-check
 * addresses, multi-action blocks, and market history records.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const db   = require('../../integration/helpers/db-setup');

let e2eSeeded = false;

async function setupE2EDatabase() {
    await db.setupDatabase();           // schema + baseline seed (idempotent)
    if (e2eSeeded) return;
    const sql = fs.readFileSync(path.join(__dirname, '../fixtures/seed-e2e.sql'), 'utf8');
    await db.query(sql);
    e2eSeeded = true;
}

async function teardownE2EDatabase() {
    e2eSeeded = false;
    await db.teardownDatabase();
}

module.exports = {
    ...db,
    setupE2EDatabase,
    teardownE2EDatabase
};
