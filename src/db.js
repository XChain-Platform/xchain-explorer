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
 * it now holds the constructor, the mixin that assembles the class, and the
 * exports, and nothing else. The queries live in src/db/, one module per family,
 * and arrive on Database.prototype through mixinReaders below.
 *
 * Nothing about the class a caller sees changed: `new Database(explorer)` still
 * returns one object carrying every method, reached by the same name, with the
 * same `this`. What changed is where the source of each method is read.
 *
 * Two invariants this file owes the split, both guarded by
 * test/unit/db_prototype_install.test.js:
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
    DbQueryError, DbInputError } = require('./db/shared.js');

// The families extracted out of this file so no single module holds every query.
// Each module is authored as a class body and exports that class's prototype, so
// the methods arrive with `this` still bound to the Database instance and no call
// site moved.
const connectionMethods        = require('./db/connection.js');
const queryBuilder             = require('./db/query_sql.js');
const actionListReaders        = require('./db/readers/action_lists.js');
const marketReaders            = require('./db/readers/markets.js');
const stakingGovernanceReaders = require('./db/readers/staking_governance.js');
const checkpointReaders        = require('./db/readers/checkpoints.js');
const entityReaders            = require('./db/readers/entities.js');
const actionDetailIoReaders    = require('./db/readers/action_detail_io.js');
const healthReaders            = require('./db/readers/health.js');
const projectReaders           = require('./db/readers/projects.js');
const contractReaders          = require('./db/readers/contracts.js');
const pollBetReaders           = require('./db/readers/polls_bets.js');
const xcallReaders             = require('./db/readers/xcall.js');

// Copies an extracted reader family onto Database.prototype. Object.assign cannot
// do this: a class method is non-enumerable, so assign would copy nothing. Copying
// the descriptor also keeps getters and arity intact.
//
// A collision throws rather than resolving by require order, because the loser
// would vanish silently and the page it serves would start answering with another
// family's SQL.
function mixinReaders(target, ...sources){
    for(let source of sources){
        for(let name of Object.getOwnPropertyNames(source)){
            if(name=='constructor') continue;
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('db.js reader mixin collision: ' + name + ' is defined twice');
            Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name));
        }
    }
}

// An ACTION's source is `actions.source_id`, never `transactions.source_id`. The two agree
// for every user action, and DISAGREE for a VM emission: the indexer stores the emitting
// contract's derived address on the action row (xchain-indexer db.js createActionIndex,
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

        this.actionTables = [
            'addresses',
            'airdrops',
            'anchor_actions',
            'batches',
            'broadcasts',
            'callbacks',
            'coinpays',
            'coinpay_expires',
            'coinpay_obligations',
            'destroys',
            'dispensers',
            'dispenses',
            'dividends',
            'files',
            'full_node_verifications',
            'issues',
            'links',
            'lists',
            'messages',
            'mints',
            'orders',
            'order_cancels',
            'order_edits',
            'order_matches',
            'prices',
            'sends',
            'sleeps',
            'swaps',
            'swap_cancels',
            'swap_edits',
            'swap_matches',
            'sweeps'
        ];

        // List views whose backing table name is NOT derivable from the method via
        // the get->lowercase mangle in getQueryOffsets (e.g. getAnchors -> anchor_actions,
        // getSlashEvents -> slash_events, the hub-mirrored governance/match tables). The
        // boundary-discovery query can't run for these, but it doesn't need to: each main
        // list query already orders by and filters on the correct cursor column
        // (getQueryOffsetSql picks m.id vs m.action_index per method). We only need to
        // preserve the inbound client cursor so next/prev advance instead of resetting to
        // the newest page every time.
        // The mangle is `method.toLowerCase().replace('get','')`, which never
        // reinserts an underscore, so EVERY method over a multi-word table name
        // belongs here regardless of which cursor column it uses:
        // getContractDelegations ('contractdelegations' vs contract_delegations)
        // is the standing proof, and it pages on the default action_index cursor.
        this.cursorPagedMethods = [
            'getAnchors','getXcalls','getAttestations','getAttestValidatorStats',
            'getContractStakes','getContractUnstakes','getContractDelegations','getEmissions',
            'getCrossChainSettlements','getCrossChainMatches',
            'getSlashEvents','getCapabilitySlashEvents','getFullNodeVerifications',
            'getPriceSnapshots','getOraclePrices',
            'getValidatorCapabilities','getGovernanceProposals','getGovernanceVotes','getReorgs','getSlashProposals',
            'getPeers','getConsensusState','getConfigs','getTelemetryPings',
            'getPolls','getVotes','getVoteDelegations',
            // BET market/wager lists: getBetFeeds -> bet_feeds and getBets -> bets are
            // not reachable through the get->lowercase table mangle, so they page on the
            // preserved client cursor like the poll family. Both ORDER BY m.action_index,
            // which is getQueryOffsetSql's default cursor field, so no id-keyed entry.
            'getBetFeeds','getBets',
            // The checkpoint-schema family: state_checkpoints, capability_snapshots and
            // anchor_reward_attestations are hub-mirrored and state_tree_roots is
            // indexer-local, and none of the four is reachable through the mangle. They
            // page on the preserved client cursor; getQueryOffsetSql gives getCheckpoints
            // and getCommitments their own m.block_index cursor field below (not m.id),
            // since both lists ORDER BY the committed height.
            'getCheckpoints','getCapabilitySnapshots','getAnchorRewardAttestations','getCommitments',
            // getCollectibles -> 'collectibles' is not a table (the rows are `tokens`
            // filtered by the M5.1 classification), so the get->lowercase mangle cannot
            // find a boundary; it pages on the preserved client cursor over m.id.
            // The gallery is /api-only today (it pages by ?page=, and the cursor path
            // runs for /explorer requests alone), so this entry and its sibling in
            // getQueryOffsetSql are armed rather than exercised: they exist so that
            // registering an /explorer feed later cannot silently page this method on
            // the wrong column, which is the failure the cursor list itself documents.
            'getCollectibles'
        ];

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
// caller's `require('./db.js').DbQueryError` still resolves.
module.exports = Object.assign(Database, { DbQueryError, DbInputError, ACTION_SUMMARY_FIELDS, MUTABLE_ACTION_FIELDS });