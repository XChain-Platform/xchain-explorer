#!/usr/bin/env node
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
 * XChain Explorer - Hub-mirror schema migration CLI
 *
 * Runbook: brings an EXISTING hub-mirror / checkpoint schema up to the
 * current shape without a hand-written ALTER TABLE. Additive-only and
 * idempotent; safe to re-run on every deploy. Covered today: the
 * price_snapshots reorg-retraction columns (source_chain /
 * source_action_index / push_generation + idx_source_chain), the
 * capability_snapshots uq_cap_snap widen, and the item-5308 reorg fences on
 * oracle_prices / cross_chain_matches / cross_chain_calls.
 *
 * You only need this for EXTERNALLY-MAINTAINED checkpoint schemas (legacy
 * single-server deployments where database.checkpoint points at a schema
 * the explorer does not write). Self-synced mirrors
 * (database.checkpoint.self_sync = true) migrate themselves at startup via
 * HubMirrorSyncManager.
 *
 * Usage:
 *   node bin/migrate-hub-mirror.js --host 127.0.0.1 --port 3306 \
 *        --user xchain --schema XChain_Hub_Mirror [--dry-run]
 *
 * The DB password is read from the MIRROR_DB_PASS environment variable
 * (never a CLI flag: argv leaks into `ps` output). Example:
 *   MIRROR_DB_PASS=... node bin/migrate-hub-mirror.js --host 127.0.0.1 \
 *        --port 3306 --user xchain --schema XChain_Hub_Mirror
 *
 * --dry-run prints the ALTERs that WOULD run and exits without executing
 * them. Exit code 0 on success (including nothing-to-do), 1 on any error.
 *
 ********************************************************************/

'use strict';

const HubMirrorPool = require('../src/hub-mirror-pool.js');
const { ensureMirrorColumns, MIRROR_MIGRATIONS } = require('../src/hub-mirror-migrate.js');

function parseArgs(argv) {
    const args = { host: '127.0.0.1', port: 3306, user: null, schema: null, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--host')        args.host   = argv[++i];
        else if (a === '--port')   args.port   = parseInt(argv[++i], 10);
        else if (a === '--user')   args.user   = argv[++i];
        else if (a === '--schema') args.schema = argv[++i];
        else if (a === '--dry-run') args.dryRun = true;
        else if (a === '--help' || a === '-h') { args.help = true; }
        else { throw new Error('unknown argument: ' + a); }
    }
    return args;
}

function usage() {
    console.log('Usage: MIRROR_DB_PASS=... node bin/migrate-hub-mirror.js --host <h> --port <p> --user <u> --schema <db> [--dry-run]');
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { usage(); return 0; }
    if (!args.user || !args.schema) {
        usage();
        throw new Error('--user and --schema are required');
    }
    if (process.env.MIRROR_DB_PASS === undefined)
        throw new Error('MIRROR_DB_PASS is not set (the DB password is env-only, never a CLI flag)');

    const pool = new HubMirrorPool({
        host: args.host, port: args.port, user: args.user,
        pass: process.env.MIRROR_DB_PASS, name: args.schema
    });
    try {
        if (args.dryRun) {
            // Same probe path as the real run, but doQuery refuses to execute
            // anything that is not a read-only probe.
            const probeOnly = {
                doQuery: (sql, p) => {
                    if (!/^SHOW /i.test(sql)) {
                        console.log('[dry-run] would execute: ' + sql);
                        return Promise.resolve();
                    }
                    return pool.doQuery(sql, p);
                }
            };
            await ensureMirrorColumns(probeOnly, (msg) => console.log('[dry-run] ' + msg));
            return 0;
        }
        const applied = await ensureMirrorColumns(pool);
        if (applied.length === 0)
            console.log('[hub-mirror] schema ' + args.schema + ' is up to date (' +
                Object.keys(MIRROR_MIGRATIONS).join(', ') + ' checked)');
        else
            console.log('[hub-mirror] applied ' + applied.length + ' ALTER(s) to ' + args.schema);
        return 0;
    } finally {
        try { await pool.end(); } catch (_) {}
    }
}

main().then((code) => process.exit(code)).catch((err) => {
    console.error('migrate-hub-mirror: ' + (err && err.message ? err.message : err));
    process.exit(1);
});
