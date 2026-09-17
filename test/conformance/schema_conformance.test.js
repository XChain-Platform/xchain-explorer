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
 * Real-schema conformance canary.
 *
 * Why this tier exists: a SELECT of a non-existent blocks.block_hash column
 * once silently killed the live WebSocket feed for 9 days because every unit
 * test stubbed doQuery and the integration tier runs against a fixture
 * SNAPSHOT of the schema, so no automated test ever executed the explorer's
 * real SQL against the REAL indexer DDL. This suite closes that class of gap
 * systemically, not just for the one bug:
 *
 *   1. Loads the indexer's REAL DDL (xchain-indexer/src/sql/*.sql, plus its
 *      dated migrations) verbatim into a real MariaDB, and the co-located
 *      hub-mirror schema the serving invariant requires (this repo's vendored
 *      src/sql/hub-mirror twins plus the hub's own operational-table DDL).
 *   2. Executes every db.js read path reachable from the API route table
 *      (pulled live from XChainExplorer.urls, so new endpoints are covered
 *      automatically) and fails on any schema error (unknown column /
 *      missing table / SQL syntax).
 *   3. Drives the ChangeDetector poll loop end-to-end and asserts the WS
 *      feed emits a block + action event for a freshly inserted block
 *      (the exact surface that outage killed).
 *   4. Guards the integration fixture snapshot against drift from the real
 *      DDL (per-table column-name parity), so the existing integration tier
 *      keeps testing the schema production actually has.
 *
 * Deployment shape: NO_HUB, i.e. no hub JSON-RPC endpoint. That is deliberate.
 * With a hub endpoint configured, validator_capabilities / governance_proposals
 * / governance_votes are served over JSON-RPC and carry no local SQL at all, so
 * an unreachable hub turned 13 routed read paths into tolerated no-ops that the
 * canary still printed as green. Running the no-hub shape routes those tables
 * to the co-located hub schema, where they execute real SQL against the real
 * DDL, which is the only shape in which this tier can see them.
 *
 * Requires the integration MariaDB fixture (127.0.0.1:3307):
 *   npm run test:integration:up
 * In CI this runs in a dedicated job with a mariadb service container plus
 * sibling checkouts of xchain-indexer and xchain-hub (same pattern as the
 * drift-guards job). The decoder-DB checks run only when a sibling
 * xchain-decoder checkout is present (always true in the platform monorepo).
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const express = require('express');
const mariadb = require('mariadb');
const { expect } = require('chai');

const XChainExplorer = require('../../src/XChainExplorer.js');
const ChangeDetector = require('../../src/ws/change_detector.js');
const { makeConfig } = require('../fixtures/mock-query-args.js');
const { envView }    = require('../fixtures/mock-config.js');
const pre = require('../integration/helpers/fixture-preflight.js');

const connection = pre.conformanceConnection();
const DB_HOST = connection.host;
const DB_PORT = connection.port;
const DB_USER = connection.user;
const DB_PASS = connection.password;

const INDEXER_DB = pre.conformanceDatabase('XChain_Conformance_Indexer');
const DECODER_DB = pre.conformanceDatabase('XChain_Conformance_Decoder');
const FIXTURE_DB = pre.conformanceDatabase('XChain_Conformance_Fixture');
const HUB_DB     = pre.conformanceDatabase('XChain_Conformance_Hub');

const INDEXER_SQL_DIR = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'sql');
const DECODER_SQL_DIR = path.join(__dirname, '..', '..', '..', 'xchain-decoder', 'src', 'sql');
const HUB_SQL_DIR     = path.join(__dirname, '..', '..', '..', 'xchain-hub', 'src', 'sql');
const MIRROR_SQL_DIR  = path.join(__dirname, '..', '..', 'src', 'sql', 'hub-mirror');
const FIXTURE_SCHEMA  = path.join(__dirname, '..', 'integration', 'fixtures', 'schema.sql');

// Hub-LOCAL operational tables the explorer reads out of the co-located hub
// schema in the no-hub shape (db.js hubSource). These are the hub's own
// tables, never vendored here, so their DDL comes from the sibling checkout.
// The mirror twins (state_checkpoints, capability_snapshots, price_snapshots,
// oracle_prices, cross_chain_matches, cross_chain_calls,
// anchor_reward_attestations) are loaded from THIS repo's vendored copies
// instead, because those are the files the explorer's own ensureTables()
// creates in production; drift between them and the hub is the drift-guards
// job's business, not this one's.
const HUB_LOCAL_TABLES = [
    'validators.sql',
    'validator_capabilities.sql',
    'governance_proposals.sql',
    'governance_votes.sql',
    'p2p_peers.sql',
    'consensus_state.sql',
    'configs.sql',
    'telemetry_pings.sql',
    // getReorgs' no-hub leg reads reorg_attestations out of the same co-located
    // hub schema. Its primary transport is the getreorghistory RPC, but this tier
    // deliberately runs the NO_HUB shape, which is the only shape in which the
    // co-located SQL meets the real DDL.
    'reorg_attestations.sql',
    // getSlashProposals' no-hub leg reads slash_proposals out of the same
    // co-located hub schema. Its primary transport is the getslashproposals RPC,
    // but this tier deliberately runs the NO_HUB shape, which is the only shape
    // in which the co-located SQL meets the real DDL. It is also the only tier
    // that proves SHA2(COALESCE(m.evidence,''), 256) is legal against it.
    'slash_proposals.sql'
];

// Per-method probe arguments for read paths whose WHERE clause binds a
// parameter unconditionally. Without a value the driver refuses the query with
// "Parameter at position 1 is not set" BEFORE it reaches the server, so the SQL
// never meets the schema and the method contributes nothing to this tier. The
// values are deliberately arbitrary: the canary asserts the query is legal
// against the real DDL, not that it matches a row.
const PROBE_ARGS = {
    // contract_state / contract balance reads key off the contract's index and
    // its derived custody address respectively.
    getContractState:   { search: '1' },
    getContractBalance: { search: 'C:BTC:1' },
    // poll_results is keyed by the poll's creating action_index.
    getPollResults:     { search: '1' },
    // A single state checkpoint is keyed by block height.
    getCheckpoint:      { search: '1' },
    // The M4 detail compositions. Each resolves a subject first and returns null
    // when it finds none, so on an empty schema this tier proves only that the
    // IDENTITY query is legal; the composed legs behind it are not reached. That
    // is a real limit of probing a composition rather than a builder, and it is
    // why these methods also carry query-shape unit coverage: the two tiers
    // answer different questions and neither substitutes for the other.
    getValidator:       { search: '1' },
    getAttestation:     { search: '1' },
    getAnchor:          { search: '1' },
    getAddressStaking:  { search: '1' },
    // M5.2's rich list resolves the TICK first and returns null when the tick was never
    // interned OR when the interned tick has no `tokens` row. The probe test seeds both
    // for RICHTICK (see seedRichListSubject), because with only the tick interned the
    // method stopped at its second guard and the tokens query never ran: that is how
    // a `tokens.block_index` reference reached the RDOGE venue as a 500 while this
    // canary printed green.
    getRichList:        { search: 'RICHTICK' }
};

// The canonical UTF-8 ACTION string the decoder writes to
// mempool_transactions.data. Kept as plain text on purpose: it is the
// same representation the confirmed-block path writes to transactions.data.
const MEMPOOL_ACTION_STRING = 'SEND|0|CONFTICK|1|bcrt1qconformance|';

// A MariaDB error that means the SQL disagrees with the schema. This is the
// drift class the canary exists for; anything matching it is a hard failure.
// (doQuery wraps the driver error, so match on the propagated message text.)
const SCHEMA_ERROR = /Unknown column|doesn't exist|Unknown table|in 'field list'|in 'where clause'|in 'on clause'|in 'order clause'|your SQL syntax/i;

function isSchemaError(err) {
    for (let e = err; e; e = e.cause) {
        if (e.message && SCHEMA_ERROR.test(e.message)) return true;
    }
    return false;
}

// Strip `-- ...` end-of-line comments and split a DDL script into statements.
// The indexer/decoder DDL uses no DELIMITER blocks and no string literals
// containing `;` or `--`, so plain splitting is sufficient (asserted by the
// suite passing; a future procedure would fail loudly here, not silently).
function splitStatements(sql) {
    const stripped = sql.split('\n')
        .map(line => {
            const i = line.indexOf('--');
            return i === -1 ? line : line.slice(0, i);
        })
        .join('\n');
    return stripped.split(';').map(s => s.trim()).filter(s => s.length > 0);
}

function ddlFiles(dir) {
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.sql'))
        .sort()
        .map(f => path.join(dir, f));
}

function migrationFiles(dir) {
    const mig = path.join(dir, 'migrations');
    if (!fs.existsSync(mig)) return [];
    return fs.readdirSync(mig)
        .filter(f => f.endsWith('.sql'))
        .sort()                            // dated filenames: lexical = chronological
        .map(f => path.join(mig, f));
}

module.exports = { fs, path, express, mariadb, expect, XChainExplorer, ChangeDetector, makeConfig, envView, DB_HOST, DB_PORT, DB_USER, DB_PASS, INDEXER_DB, DECODER_DB, FIXTURE_DB, HUB_DB, INDEXER_SQL_DIR, DECODER_SQL_DIR, HUB_SQL_DIR, MIRROR_SQL_DIR, FIXTURE_SCHEMA, HUB_LOCAL_TABLES, PROBE_ARGS, MEMPOOL_ACTION_STRING, isSchemaError, splitStatements, ddlFiles, migrationFiles };

require('./schema_conformance.test/support/suite.js');
