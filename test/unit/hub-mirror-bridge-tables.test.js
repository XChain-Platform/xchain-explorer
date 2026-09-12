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
 * The explorer's hub-mirror twins for bridge_transfers and policy_snapshots
 * (xchain-bridge.md row 9, policy spec row 5 / section 10).
 *
 * WHY THIS FILE EXISTS. The explorer builds into its own container with no
 * sibling repos, so it carries VENDORED copies of the hub-mirror table DDL,
 * written by xchain-indexer/bin/sync-hub-mirror-client.sh. Two silent failures
 * live in that seam and neither shows up as an error at boot:
 *
 *   - a table added to the indexer's src/sql/ but NOT to the script's SQL_FILES
 *     list simply never reaches the explorer, and HubDbSync's ensureTables()
 *     scans the vendored DIRECTORY, so the explorer creates no table, mirrors no
 *     rows, and the page renders an empty panel that looks exactly like a token
 *     with no bridged copies;
 *   - a vendored copy that DRIFTS from the indexer original creates a table with
 *     the wrong shape, and because the mirror apply is an id-parity INSERT the
 *     rows then land wrong rather than loudly failing.
 *
 * HubMirrorClientConformance.test.js enumerates whatever is vendored, so it
 * passes vacuously for a table that was never added. This file names the two
 * tables directly, which is what makes a forgotten SQL_FILES entry go red.
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');

const ROOT        = path.resolve(__dirname, '../..');          // xchain-explorer
const PLATFORM    = path.resolve(ROOT, '..');                  // XChain-Platform
const INDEXER_SQL = path.join(PLATFORM, 'xchain-indexer', 'src', 'sql');
const MIRROR_SQL  = path.join(ROOT, 'src', 'sql', 'hub-mirror');
const SYNC_SCRIPT = path.join(PLATFORM, 'xchain-indexer', 'bin', 'sync-hub-mirror-client.sh');

// The two tables this row adds to the mirror set. Named literally, not scanned:
// a scan of what is present cannot fail for something that is absent.
const BRIDGE_TABLES = ['bridge_transfers', 'policy_snapshots'];

describe('hub-mirror bridge tables: vendoring seam @regression', function () {

    it('names both tables in the sync script SQL_FILES list', function () {
        const script = fs.readFileSync(SYNC_SCRIPT, 'utf8');
        const m = /^SQL_FILES="([^"]*)"/m.exec(script);
        assert.ok(m, 'SQL_FILES is no longer declared in the expected form');
        const files = m[1].split(/\s+/).filter(Boolean);
        const missing = BRIDGE_TABLES.map(t => t + '.sql').filter(f => !files.includes(f));
        assert.deepEqual(missing, [],
            'sync-hub-mirror-client.sh would never copy these to the explorer: ' + missing.join(', '));
    });

    it('vendors a copy of each that is BYTE-identical to the indexer original', function () {
        const drift = [];
        for (const t of BRIDGE_TABLES) {
            const src  = path.join(INDEXER_SQL, t + '.sql');
            const dest = path.join(MIRROR_SQL, t + '.sql');
            if (!fs.existsSync(dest)) { drift.push(t + ': not vendored at all'); continue; }
            if (!fs.existsSync(src))  { drift.push(t + ': no indexer original to vendor from'); continue; }
            if (fs.readFileSync(src, 'utf8') !== fs.readFileSync(dest, 'utf8'))
                drift.push(t + ': vendored copy differs from xchain-indexer/src/sql/' + t + '.sql');
        }
        assert.deepEqual(drift, [], drift.join('\n'));
    });

    it('carries the columns the token page and the transfer list read', function () {
        // The panels read these by name; a renamed or dropped column renders a
        // dash rather than failing, so pin them against the DDL itself.
        const need = {
            bridge_transfers: ['transfer_id', 'snapshot_block', 'src_chain', 'src_action_index',
                               'src_address', 'dest_chain', 'dest_address', 'tick', 'decimals',
                               'amount', 'status'],
            policy_snapshots: ['snapshot_id', 'origin_chain', 'tick', 'policy_seq', 'origin_block',
                               'policy_hash', 'sleeping', 'status']
        };
        const missing = [];
        for (const t of BRIDGE_TABLES) {
            const ddl = fs.readFileSync(path.join(MIRROR_SQL, t + '.sql'), 'utf8');
            for (const col of need[t])
                if (!new RegExp('`?' + col + '`?\\s', 'i').test(ddl)) missing.push(t + '.' + col);
        }
        assert.deepEqual(missing, [], 'vendored DDL is missing: ' + missing.join(', '));
    });

    it('names both tables in the manager header, which is the explorer-side mirror set', function () {
        // HubMirrorSyncManager has no table list to register in (ensureTables scans
        // the directory), so its header comment IS the documented set a reader
        // checks against. A table mirrored but unnamed there reads as unsupported.
        const mgr = fs.readFileSync(path.join(ROOT, 'src', 'HubMirrorSyncManager.js'), 'utf8');
        const missing = BRIDGE_TABLES.filter(t => !mgr.includes(t));
        assert.deepEqual(missing, [], 'HubMirrorSyncManager does not name: ' + missing.join(', '));
    });
});

describe('hub-mirror bridge tables: ensureTables creates them @regression', function () {

    // Minimal dbConn double. ensureTables probes SHOW TABLES LIKE ? first and
    // skips a table that already exists, so the double answers "absent" for
    // everything and records the CREATE statements it is handed.
    function fakeConn() {
        const created = [];
        return {
            created,
            async doQuery(sql, args) {
                if (/^SHOW TABLES LIKE/i.test(sql.trim())) { created.push({ probe: args[0] }); return []; }
                const m = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`?([A-Za-z0-9_]+)`?/i.exec(sql);
                if (m) created.push({ create: m[1] });
                return [];
            }
        };
    }

    it('creates bridge_transfers and policy_snapshots from the vendored directory', async function () {
        const { ensureTables } = require('../../src/hub_db_sync.js');
        const conn = fakeConn();
        await ensureTables(conn, MIRROR_SQL);
        const created = conn.created.filter(e => e.create).map(e => e.create);
        const missing = BRIDGE_TABLES.filter(t => !created.includes(t));
        assert.deepEqual(missing, [],
            'ensureTables did not create: ' + missing.join(', ') + ' (created: ' + created.join(', ') + ')');
    });

    it('skips a table that already exists, so a restart does not re-run its DDL', async function () {
        const { ensureTables } = require('../../src/hub_db_sync.js');
        const conn = fakeConn();
        const inner = conn.doQuery.bind(conn);
        conn.doQuery = async function (sql, args) {
            // bridge_transfers is reported present; everything else absent.
            if (/^SHOW TABLES LIKE/i.test(sql.trim()) && args[0] === 'bridge_transfers') {
                conn.created.push({ probe: args[0] });
                return [{ t: 'bridge_transfers' }];
            }
            return inner(sql, args);
        };
        await ensureTables(conn, MIRROR_SQL);
        const created = conn.created.filter(e => e.create).map(e => e.create);
        assert.equal(created.includes('bridge_transfers'), false,
            're-running the DDL for an existing table fails with ER_TABLE_EXISTS_ERROR on every restart');
        assert.equal(created.includes('policy_snapshots'), true,
            'the absent table must still be created in the same pass');
    });
});
