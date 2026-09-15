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
 * XChain Explorer - Database Class, the composition root
 *
 * Proposal B stage 5. This file used to hold every query the explorer issues;
 * it now holds the constructor, the composition call that assembles the class,
 * and the exports, and nothing else. The queries live in src/db/, one module per
 * family, and arrive on Database.prototype through mixinReaders, which lives in
 * src/db/reader_parts.js beside composeReaderParts, the helper a family split
 * across several part files uses to export one prototype-shaped object.
 *
 * Nothing about the class a caller sees changed: `new Database(explorer)` still
 * returns one object carrying every method, reached by the same name, with the
 * same `this`. What changed is where the source of each method is read.
 *
 * Two invariants this file owes the split, both guarded by
 * test/unit/db/core/db_prototype_install.test.js:
 *
 *   - The surface is complete. Every method the class had is still on the
 *     prototype; a module that is written but never required here would
 *     otherwise throw at 2am on the one page that calls it.
 *   - The methods stay NON-ENUMERABLE. A class-body method is non-enumerable,
 *     and mixinReaders copies the descriptor rather than the value to keep it
 *     that way. A plain assignment would install enumerable properties, and
 *     every `for (const k in db)` and JSON/spread of a Database instance would
 *     quietly start walking 285 methods.
 *
 ********************************************************************/

// Module-level bindings the extracted modules share with this one. They cannot
// ride on a module's own export, which is a prototype mixinReaders copies whole:
// an extra key there would arrive on Database.prototype as a method. The two
// field lists and the two error classes are re-exported below under their
// original names, which is how every caller already reaches them.
const { ACTION_SUMMARY_FIELDS, MUTABLE_ACTION_FIELDS,
    DbQueryError, DbInputError } = require('./shared.js');

// The families extracted out of this file so no single module holds every query.
// Each module is authored as a class body and exports that class's prototype, so
// the methods arrive with `this` still bound to the Database instance and no call
// site moved.
const connectionMethods        = require('./connection.js');
const queryBuilder             = require('./query_sql.js');
const actionListReaders        = require('./readers/action_lists.js');
const marketReaders            = require('./readers/markets.js');
const stakingGovernanceReaders = require('./readers/staking_governance.js');
const checkpointReaders        = require('./readers/checkpoints.js');
const entityReaders            = require('./readers/entities.js');
const actionDetailIoReaders    = require('./readers/action_detail_io.js');
const healthReaders            = require('./readers/health.js');
const projectReaders           = require('./readers/projects.js');
const contractReaders          = require('./readers/contracts.js');
const pollBetReaders           = require('./readers/polls_bets.js');
const xcallReaders             = require('./readers/xcall.js');

// connection.js is itself split: it composes ./connection/cache.js and
// ./connection/pools.js onto its own methods through composeReaderParts and
// exports the one object, so the require above brings all three. The parts are
// named here so a reader of this composition root can find every file whose
// methods land on Database.prototype.

// The descriptor copy and collision check every family goes through, and the two
// name lists each instance is handed a copy of.
const { mixinReaders } = require('./reader_parts.js');
const { ACTION_TABLES, CURSOR_PAGED_METHODS } = require('./method_tables.js');

// An ACTION's source is `actions.source_id`, never `transactions.source_id`. The two agree
// for every user action, and DISAGREE for a VM emission: the indexer stores the emitting
// contract's derived address on the action row (xchain-indexer src/db/actions.js createActionIndex,
// execute/index.js processEmission) while the transaction still belongs to the human who sent the
// EXECUTE. Reading the transaction there renders a real address that is the WRONG one, which
// no reader can catch by eye. Every query below therefore resolves source through
// COALESCE(<actions alias>.source_id, t1.source_id); the fallback covers system/synthetic
// actions (expiries, completion UNSTAKEs), which are created with no SOURCE at all.
class Database {

    constructor(explorer){
        this.explorer   = explorer;
        this.configInfo = explorer.configInfo
        this.util   = explorer.util;

        this.configInfo.onConfigChanged(()=>{
            this.setupConnectionPools();
        })

        this.transactionConnection = null;

        // LRU caches for frequently-queried immutable lookups
        this._addressIdCache  = new Map();
        // Byte-exact address -> id resolutions (getExactAddressId). Kept apart from
        // _addressIdCache because the two lookups legitimately disagree for the same
        // key: the ci lookup resolves a case variant to the id of the address it
        // resembles, the byte-exact one resolves it to null. One shared cache would
        // let whichever ran first answer for both.
        this._exactAddressIdCache = new Map();
        this._tickIdCache     = new Map();
        this._actionDataCache = new Map();
        // Per-coin reorg generation counter mixed into the id/action cache keys
        // (M-3). The indexer reassigns ^id / action_index values on a reorg, so
        // a pre-reorg cache entry keyed by an index can resolve to a DIFFERENT
        // entity afterward. bumpReorgGeneration() increments the counter on a
        // detected reorg, which changes every future key for that coin and lets
        // the stale entries age out via normal LRU eviction (no full flush, no
        // per-request DB check). _lastTip tracks the last-seen tip per coin so
        // checkReorgAndInvalidate can spot a rewind on the tip-poll loop.
        this._reorgGen = {};
        this._lastTip  = {};
        // Per-coin tip memo backing the getData result-cache generation token.
        // The cached list methods read tables the indexer only rewrites when a
        // block is applied, so the tip height is exactly the generation those
        // results belong to; see resultCacheGeneration.
        this._tipMemo  = {};
        // AST introspection ({methods, abi} pair) is a pure function of the
        // contract source, and code is immutable once deployed, so cache by
        // the sha256 we compute from the code itself (two deploys of identical
        // source share one entry; the stored code_hash column is unverified).
        this._methodsCache    = new Map();

        // Fresh copies of the two method tables (src/db/method_tables.js), so each
        // instance owns its own arrays and a push onto one never reaches another.
        this.actionTables       = ACTION_TABLES.slice();
        this.cursorPagedMethods = CURSOR_PAGED_METHODS.slice();

    }

}

// The families that have moved out under proposal B are attached here, after the
// class exists. Order is irrelevant: mixinReaders refuses a collision rather than
// letting require order decide a winner.
mixinReaders(Database.prototype, connectionMethods, queryBuilder,
    actionListReaders, marketReaders, stakingGovernanceReaders, checkpointReaders,
    entityReaders, actionDetailIoReaders, healthReaders, projectReaders,
    contractReaders, pollBetReaders, xcallReaders);

// One export, the class, carrying the shared names as static properties so every
// caller's `require('./db/index.js').DbQueryError` still resolves.
module.exports = Object.assign(Database, { DbQueryError, DbInputError, ACTION_SUMMARY_FIELDS, MUTABLE_ACTION_FIELDS });