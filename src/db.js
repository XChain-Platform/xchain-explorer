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
 * XChain Explorer - Database Class
 * 
 * This file handles connecting to databases and running SQL queries
 *
 ********************************************************************/

const crypto  = require('crypto');
const DecoderConnector = require('./XChainDecoderConnector.js');
const { extractMethods } = require('./contract-introspect.js');
const listEditResolution = require('./list_edit_resolution_activation');
const actionDetail = require('./action-detail');

// Module-level bindings the extracted modules share with this one. They cannot
// ride on a module's own export, which is a prototype mixinReaders copies whole:
// an extra key there would arrive on Database.prototype as a method.
const { DbQueryError, DbInputError, MUTABLE_ACTION_FIELDS, staleFailClosed } = require('./db/shared.js');

// The families extracted out of this file so no single module holds every query.
// Each module is authored as a class body and exports that class's prototype, so
// the methods arrive with `this` still bound to the Database instance and no call
// site moved.
const connectionMethods        = require('./db/connection.js');
const queryBuilder             = require('./db/query_sql.js');
const actionListReaders        = require('./db/readers/action-lists.js');
const marketReaders            = require('./db/readers/markets.js');
const stakingGovernanceReaders = require('./db/readers/staking-governance.js');
const checkpointReaders        = require('./db/readers/checkpoints.js');
const entityReaders            = require('./db/readers/entities.js');

// The one field list every compact action summary projects (transaction and
// history rows via getActionSummaryData, BATCH members via projectActionSummary).
// Every field the client's getActionDetails reads must be here, or the summary
// renders blank on one path while the full detail page works; the drift guard
// (test/unit/db.action-summary-field-contract.test.js) pins the two against
// each other, so a new summary branch adds its field here in the same change.
const ACTION_SUMMARY_FIELDS = Object.freeze([
    'coin', 'tick',  'amount', 'source', 'destination', 'type', 'edit', 'expiration', 'allow_list', 'block_list',  // Common fields
    'action_format', 'action_index',                                                                               // Action details
    'fee_preference', 'require_memo', 'dispenser_preference',                                                      // Addresses
    'action_class', 'controller', 'unbind',                                                                        // Addresses (controller bind, v1)
    'message', 'value', 'broadcast_action_index', 'broadcast_fee',                                                 // Broadcasts
    'callback_tick', 'callback_amount',                                                                            // Callbacks
    'dividend_tick',                                                                                               // Dividends
    'name', 'title',                                                                                               // Files
    'coin1', 'coin2', 'coin1_action_index', 'coin2_action_index',                                                  // Links
    'list_action_index',                                                                                           // Lists
    'encryption_method', 'plaintext_message',                                                                      // Messages
    'give_coin', 'get_coin', 'give_tick', 'get_tick', 'give_amount', 'get_amount', 'give_escrow',                  // Orders, Swaps, Dispensers
    'order_action_index',                                                                                          // Order (cancels, edits, expires)
    'swap_action_index',                                                                                           // Swap  (cancels, edits, expires)
    'dispenser_action_index',                                                                                      // Dispesnser (cancels, edits, expires)
    'resume_block',                                                                                                // Sleep
    'balances', 'ownerships', 'orders', 'swaps', 'dispensers',                                                     // Sweeps
    'target_contract_index', 'cooldown_end_block', 'capability',                                                   // Staking (stake, unstake, delegate, slash)
    'contract_index', 'method_name', 'cooldown_blocks', 'chunk_index', 'total_chunks',                             // Contracts (deploy, execute, deposit, withdraw)
    'deployed_contract_index', 'contract_meta_name', 'contract_meta_version',                                      // Contracts: the identity the chain recorded, so history rows can print "Name vX (C:COIN:n)"
    'vote_kind',                                                                                                   // Governance
    'chain', 'network', 'checkpoint_seq', 'anchored_block_index',                                                  // Anchors
    'round_number', 'pair_count', 'fiat', 'batch_first_round', 'batch_last_round', 'round_count'                   // Prices
]);

// Wall-clock age, in seconds, past which the newest INDEXED block means this
// instance is no longer serving current data for a coin. Deliberately far above
// every chain's normal inter-block gap (BTC ~10min): a fail-closed gate that
// delists a quiet-but-healthy chain is worse than one that trails an outage by
// hours, and the freezes this catches ran 55 hours and 33 days in practice.
const TIP_MAX_AGE_DEFAULT_S = 21600;

// How far AHEAD of this host's clock a newest-indexed block may be dated before
// its timestamp stops counting as evidence of freshness. A future-dated tip
// makes (now - block_time) negative, which reads as "younger than any
// threshold", so a frozen chain can hide behind one for as long as the skew
// lasts: with no bound, a tip dated a year ahead would never age out. 7200s is
// the BTC-family consensus limit on how far ahead of network-adjusted time a
// block may be dated, so a tip beyond it is host clock drift or a chain the
// timestamp rules do not bind (testnet), neither of which this instance can
// vouch for. Overridable per coin, 0 disables the check.
const TIP_MAX_FUTURE_SKEW_DEFAULT_S = 7200;

// TTL of the cached per-coin freshness snapshot (tip block, tip age, stale
// verdict, replica halt). Short enough that a freeze surfaces within one status
// poll, long enough that annotating every response costs no extra query on a
// busy explorer.
const TIP_STALE_CACHE_TTL_MS = 15000;

// The action families that carry a real RECIPIENT, and the column on each that
// points back at the action (decision I-46, measured against xchain-indexer/src/sql).
// Backs getActionsSince's `destinations` (spec wallet-unconfirmed-and-sounds M1.4).
//
// Two things here are load-bearing and easy to get wrong:
//
//   - `contracts` is DELIBERATELY ABSENT. It carries `slash_destination_id`, not
//     `destination_id`, and that column is DEPLOY-time slash ROUTING CONFIG, not a
//     recipient of anything. Including it would fan "you received something" out to
//     every address a contract merely names in its deploy, which is the opposite of
//     what the wallet's incoming-receipt notification means. It is also the only
//     destination-ish column not named `destination_id`, which is how a naive grep
//     sweeps it back in; do not add it.
//   - Three of the join keys are NOT `action_index`. `slash_events` keys on
//     `execution_index` (FK to contract_executions.action_index) and
//     `capability_slash_events` on `slash_action_index` (FK to actions.action_index).
//     Joining either on `action_index` silently matches nothing, since neither table
//     has that column at all.
//
// `sends.action_index` is a NON-unique index on purpose: a multi-output SEND is
// several rows sharing one action_index, and every one of their destinations must
// reach the wire. That is why the lookup below collects a LIST per action rather
// than a single value.
//
// These table/column names are compile-time literals interpolated as SQL
// IDENTIFIERS (a placeholder cannot bind an identifier). No caller can reach them:
// nothing outside this constant is ever spliced into the query, and every VALUE is
// still bound with `?`.
const ACTION_DESTINATION_FAMILIES = [
    { table: 'sends',                   key: 'action_index'       },
    { table: 'sweeps',                  key: 'action_index'       },
    { table: 'dispenses',               key: 'action_index'       },
    { table: 'mints',                   key: 'action_index'       },
    { table: 'messages',                key: 'action_index'       },
    { table: 'fees',                    key: 'action_index'       },
    { table: 'slash_events',            key: 'execution_index'    },
    { table: 'capability_slash_events', key: 'slash_action_index' }
];

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
// execute.js processEmission) while the transaction still belongs to the human who sent the
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
        // results belong to; see _resultCacheGeneration.
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

    /******************************************************************
     * Commonly used functions 
     *****************************************************************/

    // Extract the revoke target of a DELEGATE v2/v3 from the transaction's decoded
    // action string. Returns { pubkey } for v2 (capability revoke) and
    // { pubkey, target, tick } for v3 (contract-targeted revoke), or null when the
    // wire is absent/unparseable. Locates the `DELEGATE|<fmt>|...` segment so it works
    // for a standalone DELEGATE and one nested in a BATCH (`VERSION|CMD;CMD`); the
    // 64-hex signing pubkey is a fixed-width token, so the match is unambiguous.
    _parseDelegateRevokeWire(wire, fmt){
        if(this.util.isNull(wire)) return null;
        let str = String(wire);
        if(Number(fmt)===3){
            let m = str.match(/DELEGATE\|3\|([0-9a-fA-F]{64})\|([0-9]+)\|([^;|]+)/);
            return m ? { pubkey: m[1], target: m[2], tick: m[3] } : null;
        }
        let m = str.match(/DELEGATE\|2\|([0-9a-fA-F]{64})/);
        return m ? { pubkey: m[1] } : null;
    }

    // Split a route code ('BTC' / 'TBTC' / 'RDOGE') into its base coin and
    // network. Prefixed networks are tested first so 'TBTC' is not read as a
    // mainnet coin literally named 'TBTC'. Returns null when the code names no
    // configured coin, which callers must treat as "cannot mirror consensus
    // here" rather than as mainnet.
    // @param {config}  object  request config carrying the route code in .coin
    async _resolveCoinNetwork(config){
        let code = String((config && config.coin) || '').toUpperCase();
        if(!code) return null;
        let full     = await this.configInfo.getConfig();
        let networks = full['COIN_NETWORKS'] || {};
        let prefixes = full['COIN_PREFIXES'] || { mainnet: '', testnet: 'T', regtest: 'R' };
        for(let network in prefixes){
            let p = prefixes[network];
            if(p && code.startsWith(p)){
                let base = code.slice(p.length);
                if(networks[base]) return { coin: base, network };
            }
        }
        return networks[code] ? { coin: code, network: 'mainnet' } : null;
    }

    // Walk a SET of LIST references up to the CREATE actions that root their edit
    // chains, one query per hop for the whole set instead of one per list.
    // Mirrors the indexer's db.getListRootIndex: an edit row carries the index of
    // the list it edits in lists.list_action_index and a create carries NULL, and
    // the hop count is bounded so a malformed chain cannot spin. The frontier is
    // deduped every hop, and a chain that revisits an index it has already stood on
    // stops there, so a cycle costs one wasted hop rather than looping.
    // @param {action_indexes}  array  ACTION_INDEXes of LIST creates or edits
    // @return {object}  map of String(input index) -> root action_index (number)
    async getListRootIndexes(config, action_indexes){
        let roots   = {};   // input index -> the index the walk currently stands on
        let seen    = {};   // input index -> set of indexes already visited
        let pending = {};   // input indexes whose walk has not terminated
        for(let action_index of (action_indexes || [])){
            let n = Number(action_index);
            if(!Number.isFinite(n)) continue;
            let key = String(n);
            if(key in roots) continue;
            roots[key] = n;
            seen[key]  = {};
            pending[key] = true;
        }
        for(let hop = 0; hop < 16; hop++){
            let keys = Object.keys(pending);
            if(keys.length == 0) break;
            let frontier = [...new Set(keys.map(key => roots[key]))];
            let rows = await this.doQuery(config, 'SELECT action_index, list_action_index FROM lists WHERE action_index IN (' +
                                                  frontier.map(() => '?').join(',') + ')', frontier);
            let parents = {};
            for(let row of (rows || [])) parents[String(Number(row['action_index']))] = row['list_action_index'];
            for(let key of keys){
                let at = String(roots[key]);
                // Already stood here on an earlier hop: the chain is cyclic, stop.
                if(seen[key][at]){ delete pending[key]; continue; }
                seen[key][at] = true;
                // No row (dangling reference) or a NULL parent (a create): this is the root.
                if(!(at in parents) || this.util.isNull(parents[at])){ delete pending[key]; continue; }
                roots[key] = Number(parents[at]);
            }
        }
        return roots;
    }

    // Walk a LIST reference up to the CREATE action that roots its edit chain.
    // @param {action_index}  integer  ACTION_INDEX of any LIST create or edit
    async getListRootIndex(config, action_index){
        let roots = await this.getListRootIndexes(config, [action_index]);
        let key   = String(Number(action_index));
        return (key in roots) ? roots[key] : action_index;
    }

    // Resolve a SET of LIST references to the actions whose list_items rows ARE
    // those lists' CURRENT membership, in a bounded number of queries regardless
    // of set size. Mirrors the indexer's db.getListHeadIndex per list, including
    // the ordering (the newest valid action in the chain; action_index is unique
    // and monotonic, so MAX is the same total order as ORDER BY DESC LIMIT 1) and
    // the valid-only filter, so the explorer displays the membership the chain
    // actually enforces. A chain with no valid edits resolves to its own root.
    // @param {action_indexes}  array  ACTION_INDEXes of LIST creates or edits
    // @return {object}  map of String(input index) -> head action_index (number)
    async getListHeadIndexes(config, action_indexes){
        let roots    = await this.getListRootIndexes(config, action_indexes);
        let distinct = [...new Set(Object.values(roots))];
        if(distinct.length == 0) return roots;
        let query = `SELECT
                        l.list_action_index AS root,
                        MAX(l.action_index) AS head
                    FROM
                        lists l
                        INNER JOIN index_statuses s ON (s.id=l.status_id)
                    WHERE
                        l.list_action_index IN (` + distinct.map(() => '?').join(',') + `)
                        AND s.status='valid'
                    GROUP BY l.list_action_index`;
        let rows  = await this.doQuery(config, query, distinct);
        let heads = {};
        for(let row of (rows || [])) heads[String(Number(row['root']))] = Number(row['head']);
        let out = {};
        for(let key in roots){
            let root = String(roots[key]);
            out[key] = (root in heads) ? heads[root] : roots[key];
        }
        return out;
    }

    // Resolve a LIST reference to the action whose list_items rows ARE the list's
    // CURRENT membership: the newest VALID action in its edit chain, or the create
    // itself when it has no valid edits.
    // @param {action_index}  integer  ACTION_INDEX of any LIST create or edit
    async getListHeadIndex(config, action_index){
        let heads = await this.getListHeadIndexes(config, [action_index]);
        let key   = String(Number(action_index));
        return (key in heads) ? heads[key] : action_index;
    }

    // Is list-edit read resolution active for this coin at the CURRENT TIP?
    // Every display that resolves an edit chain asks this first, because
    // below the flag day consensus still reads the pinned create's rows and the
    // explorer must not advertise a rule the chain is not applying yet. An
    // unresolvable coin/network is treated as inactive (the safe side).
    async _isListEditResolutionActiveAtTip(config){
        let resolved = null;
        try {
            resolved = await this._resolveCoinNetwork(config);
        } catch(e){ /* config momentarily unavailable: fall through to inactive */ }
        if(!resolved) return false;
        let tip = await this.getMaxBlockIndex(config);
        return listEditResolution.isListEditResolutionActive(tip, resolved.network, resolved.coin);
    }

    // Current membership of the list a LIST action belongs to (the display leg).
    //
    // A LIST edit writes the resulting membership under the EDIT's own
    // action_index and never touches the parent's rows, so the create's
    // list_items are its create-time snapshot forever. Consumers pin a list by
    // its CREATE index - a bet feed's ALLOW_LIST is exactly that - so the page a
    // "who may bet on this market" link lands on was showing membership the chain
    // had already stopped enforcing.
    //
    // Gated on the same per-chain flag day as the indexer's read path, evaluated
    // against the TIP, because below the height consensus still reads the create's
    // rows and the explorer must not advertise a rule the chain is not applying
    // yet. An unresolvable coin/network is treated as inactive (the safe side).
    // @param {action_index}  integer  ACTION_INDEX of the LIST action being viewed
    // @param {type}          integer  list type (1 = tick, 2 = address)
    async getListCurrentMembership(config, action_index, type){
        let active = await this._isListEditResolutionActiveAtTip(config);
        let state  = { edit_resolution_active: active, membership_action_index: Number(action_index), current_list: null };
        if(!active) return state;
        let head = await this.getListHeadIndex(config, action_index);
        state.membership_action_index = Number(head);
        let rows = await this.doQuery(config, `SELECT
                        a1.address,
                        t1.tick
                    FROM
                        list_items l1
                        LEFT JOIN index_addresses a1 ON (a1.id=l1.item_id)
                        LEFT JOIN index_tickers   t1 ON (t1.id=l1.item_id)
                    WHERE
                        l1.action_index=?`, [head]);
        let items = [];
        for(let row of (rows || [])){
            if(Number(type) == 1) items.push(row.tick);
            if(Number(type) == 2) items.push(row.address);
        }
        state.current_list = items.sort();
        return state;
    }

    // @param {object} preload  optional page-level prefetch from _buildActionPreload.
    //                          Every leg it carries is OPTIONAL: an
    //                          index or tx_hash it does not cover falls through to
    //                          the single-index query, so the payload is the same
    //                          whether the preload is present, partial, or absent.
    async getActionData(config, action_index, preload){
        // Check LRU cache first. Action data is immutable once confirmed, but a
        // reorg can reassign action_index, so the key carries coin + reorg
        // generation (action_index is per-coin, and a reorg bumps the generation
        // to invalidate; see _cacheKey / bumpReorgGeneration).
        //
        // "Immutable once confirmed" does NOT hold for the responses that carry a
        // live `state` block (DISPENSER, ORDER, SWAP): give_remaining, status,
        // expiration and the allow/block lists are all recomputed from LATER
        // dispenses, matches, edits and closes. Those are not written back here -
        // see the _cacheSet guard at the end of this method - so this lookup only
        // ever returns a genuinely immutable action.
        let cached = this._cacheGet(this._actionDataCache, this._cacheKey(config.coin, action_index));
        if(cached !== undefined) return structuredClone(cached);
        let coinConfigs = await this.configInfo.getConfig()
        let data = {
            credits: null,
            debits:  null,
            escrows: null,
            fee:    null
        };
        // Use the page preload only for the indexes it actually prefetched; anything
        // else runs the per-index queries exactly as before.
        let pre  = (preload && preload.indexes && preload.indexes.has(Number(action_index))) ? preload : null;
        let type = (pre && pre.types.has(Number(action_index)))
            ? pre.types.get(Number(action_index))
            : await this.getActionType(config, action_index);
        if(type){
            // Per-action detail is a registry (src/action-detail/), not an
            // if-chain: one handler per action type owns its SQL and its result
            // shaping, so a new action adds a handler file entry instead of
            // editing the middle of this method. Everything below is
            // the part every action shares - run the detail query, de-blank a
            // row-less variant, run the follow-ups, attach ledger effects - with
            // the handler's hooks called at the points where actions differ.
            let handler = actionDetail.getHandler(type);
            let ctx     = { db: this, config, coinConfigs, action_index, type, util: this.util };
            let built   = (handler.queries) ? await handler.queries(ctx) : {};
            let query   = built.query  || null;
            let query2  = built.query2 || null;
            let query3  = built.query3 || null;
            let results = null;
            if(query){
                results = await this.doQuery(config, query, [action_index]);
                if(results && results.length)
                    data = Object.assign({}, data, results[0]);
            }
            if(!results || !results.length)
                data = await actionDetail.deblankBaseline(this, config, action_index, data);
            if(handler.afterMain)
                await handler.afterMain(ctx, data);
            if(query2){
                // Set correct arguments for the query
                let args2 = (handler.query2Args) ? handler.query2Args(ctx, data) : [action_index];
                results = await this.doQuery(config, query2, args2);
                if(results && results.length && handler.afterQuery2)
                    await handler.afterQuery2(ctx, data, results);
            }
            if(query3){
                let args3 = (handler.query3Args) ? handler.query3Args(ctx, data) : [action_index];
                results = await this.doQuery(config, query3, args3);
                if(results && results.length && handler.afterQuery3)
                    await handler.afterQuery3(ctx, data, results);
            }
            if(handler.afterQueries)
                await handler.afterQueries(ctx, data);
            await this.attachActionDetailSupplements(config, type, action_index, data, pre);
            await actionDetail.attachLedgerEffects(this, config, action_index, data, handler.effects, (pre) ? pre.effects : null);
            if(handler.afterEffects)
                await handler.afterEffects(ctx, data);
            let fee = (pre && pre.fees.has(Number(action_index)))
                ? pre.fees.get(Number(action_index))
                : await this.getActionFeeData(config, action_index);
            if(fee)
                data.fee = fee;
            // The preload is keyed by tx_hash, and data.tx_hash comes from the handler
            // row, which may name a transaction the page-level prefetch never saw (a
            // BATCH child, a handler that aliases another action's tx). A hash the map
            // does not carry falls back to the single-hash query rather than to null.
            let txKey  = this.util.isNull(data.tx_hash) ? null : String(data.tx_hash);
            let txData = (pre && txKey !== null && pre.txs.has(txKey))
                ? pre.txs.get(txKey)
                : await this.getTransactionData(config, data.tx_hash);
            data.tx_data = (!this.util.isNull(txData)) ? txData.data : null;
        }
        // Store in LRU cache for future lookups (coin + reorg-generation key, see getActionData entry).
        // Skip anything carrying a live `state` block: DISPENSER, ORDER and SWAP responses
        // derive give_remaining / status / expiration / allow_list / block_list from rows
        // written AFTER the action confirmed, and the cache has no TTL, so a cached entry
        // would freeze that state for the process lifetime (measured on regtest:
        // a fully-drained, closed dispenser kept serving `give_remaining: 200, status: open`
        // until the explorer restarted, letting the wallet's detail page show a buyer an
        // open dispenser they could pay for nothing).
        if(this._isCacheableAction(data))
            this._cacheSet(this._actionDataCache, this._cacheKey(config.coin, action_index), structuredClone(data));
        return data;
    }

    // Wire-carried fields the per-type detail handlers cannot select because they
    // live in a SIBLING event table, not the handler's primary table. The action
    // detail is the page that exists to render what the wire format carried, so a
    // field the indexer stores must appear here, populated on the variant that
    // carries it and present-as-null on the others (the shape every other ISSUE
    // variant field already follows). All three source tables are append-only and
    // reorg rollback deletes their rows, so the values are as cache-safe as the
    // rest of the action payload.
    async attachActionDetailSupplements(config, type, action_index, data, pre){
        let fmt = this.util.isNull(data.action_format) ? null : Number(data.action_format);
        if(type=='ISSUE'){
            // ISSUE v6 = controller bind/unbind (ISSUE|6|TICK|CONTROLLER|ACTION_CLASS|
            // COOLDOWN_BLOCKS|UNBIND). The event row is written to token_controllers,
            // never to `issues`, so without this the four wire fields vanished from
            // the API row while /api/controllers showed them.
            data.controller      = null;
            data.action_class    = null;
            data.cooldown_blocks = null;
            data.unbind          = null;
            if(fmt === 6){
                let rows = await this.doQuery(config,
                    `SELECT
                        c.contract_index as controller,
                        c.action_class,
                        c.cooldown_blocks,
                        c.is_unbind as unbind
                    FROM
                        token_controllers c
                    WHERE
                        c.action_index=?
                    LIMIT 1`, [action_index]);
                // No row = the bind/unbind never applied (invalid action, or rolled
                // back); the keys stay null rather than being reparsed from tx_data.
                if(rows && rows.length)
                    Object.assign(data, rows[0]);
            }
        }
        if(type=='DEPLOY' && fmt === 4){
            // v4 chunk carrier: CODE_PART is a first-class wire field and this page
            // is the only surface that can show the payload. The full slice rides
            // the single-action row only; list rows carry code_part_length instead
            // (getDeployChunks), because a MEDIUMTEXT slice per row is too heavy for
            // a paged list.
            data.code_part        = null;
            data.code_part_length = null;
            let rows = await this.doQuery(config,
                `SELECT
                    m.code_part,
                    CHAR_LENGTH(m.code_part) as code_part_length
                FROM
                    deploy_chunks m
                WHERE
                    m.action_index=?
                LIMIT 1`, [action_index]);
            if(rows && rows.length){
                data.code_part        = rows[0].code_part;
                data.code_part_length = this.util.isNull(rows[0].code_part_length) ? null : Number(rows[0].code_part_length);
            }
        }
        // A v4 carrier is normally a code slice and nothing else, but the piece that
        // COMPLETES a chunked group runs the deployment at its own action_index, so
        // the constructor was billed here and its execution row sits at this index
        // too. The detail handler's own probe has already answered whether a
        // contracts row exists here (deployed_contract_index, set in afterMain,
        // which runs before this method), so this reuses that answer rather than
        // asking again: an ordinary carrier that completed nothing still issues no
        // contract_executions query at all.
        let carrierDeployed = (fmt === 4 && !this.util.isNull(data.deployed_contract_index));
        if(type=='DEPLOY' && fmt !== null && (fmt !== 4 || carrierDeployed)){
            // v0-v3 deploy, and the completing v4 carrier: the constructor run is
            // billed like any EXECUTE and the indexer records it in
            // contract_executions, but the detail row showed no gas at all, hiding
            // the deployer's cost. Surface the recorded gas plus the execution
            // linkage (contract_index / method_name); this reads existing execution
            // rows only and invents no fee artifacts.
            data.contract_index = null;
            data.method_name    = null;
            data.gas_used       = null;
            data.gas_limit      = null;
            let rows = await this.doQuery(config,
                `SELECT
                    m.contract_index,
                    m.method_name,
                    m.gas_used,
                    m.gas_limit
                FROM
                    contract_executions m
                WHERE
                    m.action_index=?
                LIMIT 1`, [action_index]);
            if(rows && rows.length)
                Object.assign(data, rows[0]);
        }
        // Emission provenance, for EVERY action type. A VM-emitted action has no wire string
        // of its own - it was never on the wire - so `tx_data` on its detail row is the PARENT
        // EXECUTE's string. Read alone on a per-action page that says "Transaction Data", it
        // reads as this action's own data, and it is the field this campaign cross-checks
        // rendered values against. No synthetic string is composed here: inventing a wire form
        // that was never broadcast would be worse than the ambiguity. Instead the page is told
        // where the action came from, so it can label the parent's string as the parent's.
        // A page-level prefetch resolves this leg for the whole index set at once; asking
        // per-action here put the page back above the per-index query ceiling that
        // action-preload-parity guards. The single-index path falls through to the batch
        // helper with a set of one, so both paths return the identical shape.
        data.emitted_by = null;
        let key = Number(action_index);
        if(pre && pre.emitted && pre.indexes && pre.indexes.has(key)){
            data.emitted_by = pre.emitted.has(key) ? pre.emitted.get(key) : null;
        } else {
            let one = await this.getEmissionProvenanceBatch(config, [key]);
            data.emitted_by = one.has(key) ? one.get(key) : null;
        }
    }

    // Get fee information for a given action_index
    async getActionFeeData(config, action_index){
        let fee   = null;
        let args  = [action_index];
        let query = `SELECT
                        a2.address as source,
                        a3.address as destination,
                        t2.tick,
                        f1.amount,
                        f1.method,
                        f1.gas_cost,
                        f1.gas_price,
                        f1.xchain_amount,
                        f1.payment_mode,
                        f1.native_coin_amount,
                        f1.native_coin,
                        f1.oracle_round,
                        f1.fee_preference,
                        f1.fee_version
                    FROM
                        fees f1
                        INNER JOIN actions         a1 ON (a1.action_index=f1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_tickers   t2 ON (t2.id=f1.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses a3 ON (a3.id=f1.destination_id)
                    WHERE 
                        f1.action_index=?`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            fee = results[0];
        return fee;
    }
    async getActionType(config, action_index){
        let type = null;
        let args = [action_index];
        let sql  = `SELECT 
                        a2.action
                    FROM
                        actions a1
                        LEFT  JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?`;
        let results = await this.doQuery(config, sql, args);
        if(results && results.length)
            type = results[0].action;
        return type;
    }

    // Supports search types: 'block', 'address', 'token', 'recent'.
    async getHistoryData(config){
        let sql       = config.data.sql;
        let type      = config.data.type;
        let q         = config.data.query;
        let offset    = (config.data.offset) ? config.data.offset : false;
        let action    = (offset && !this.util.isNull(offset.action)) ? offset.action : false;
        let start     = (offset && !this.util.isNull(offset.start) && this.util.isNumeric(offset.start)) ? offset.start : false;
        let limit     = sql.limit;
        let total     = 0;
        let id        = 0;
        let history   = [];
        let args      = [];
        let results   = null;
        let count     = null;
        let query     = null;
        let where     = sql.where.data;
        // WHICH TABLE THE FEED IS DRIVEN BY, and why it is not always mappings_actions.
        //
        // mappings_actions is an address/tick LOOKUP INDEX, not an action list: the
        // indexer writes it from the addresses/tickers an action touched
        // (xchain-indexer src/chain/mapper.js, fed by util.getAddressesList(), which is only
        // populated by credit/debit bookkeeping). An action that moves no ledger entry
        // - ANCHOR, PRICE, ATTEST, NODEPROOF, ROLLCALL and every future consensus
        // action - therefore has NO row there and is structurally unreachable through
        // it. Driving the unfiltered feed off that table did not merely under-report:
        // on a network whose actions are all consensus actions (a fresh testnet
        // publishing PRICE rounds and ANCHOR checkpoints) it answered an empty
        // "All Activity" list and an empty per-block action list while the actions
        // existed and their own /anchors and /prices pages listed them.
        //
        // So the mapping table is used ONLY where its lookup is what the query needs
        // (type=address / type=token, which filter on m.type_id + m.id); the
        // all-activity and per-block feeds read `actions` directly. `cursor` is the
        // paging column for whichever shape is in play, and getQueryWhereSql anchors
        // its WHERE on the matching alias.
        let mapped    = ['address','token'].includes(type);
        let cursor    = (mapped) ? 'm.action_index' : 'a1.action_index';
        let source    = (mapped)
            ? `mappings_actions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)`
            : `actions a1`;
        if(type=='address')
            id = await this.getAddressId(config, config.data.search);
        if(type=='token')
            id = await this.getTickId(config, config.data.search);
        // For full-history (search='null'): pre-set total to the highest action_index to avoid a COUNT(*) scan.
        if(config.data.search=='null'){
            let query = `SELECT
                            action_index
                        FROM
                            actions
                        ORDER BY action_index DESC
                        LIMIT 1`;
            results = await this.doQuery(config, query);
            if(results && results.length)
                q.total = Number(results[0].action_index);
        }
        // Seed bind args to match the WHERE built by getQueryWhereSql: address/token add
        // 'm.id=?' (the resolved id), block adds 'b1.block_index=?'. type=recent (the
        // homepage default) and null add no placeholder, so any seed here is a phantom that
        // shifts the offset 'action_index < ?' bind (binding 0 -> 'action_index < 0' -> no rows).
        args = (type=='block') ? [config.data.search]
             : (['address','token'].includes(type) ? [id] : []);
        // Skip COUNT query when total is passed on the querystring (speeds up explorer pagination).
        // Number() because a querystring value arrives as a string and `total` is the
        // shared list-envelope field, which every other list route emits as a JSON
        // integer (see the count branch of the generic list path); history was the one
        // route handing consumers a string for it.
        if(q && q.total){
            total = Number(q.total);
        } else {
            // Get total number of matching records for this type of action and add to grand total
            count = `SELECT
                        count(DISTINCT(` + cursor + `)) as count
                    FROM
                        ` + source + `
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where;
            results = await this.doQuery(config, count, args);
            if(results && results.length)
                // bcadd returns a decimal STRING (mathjs bignumber formatting), which is
                // what put a quoted total on the history envelope; a row count is a plain
                // integer far below 2^53, so narrow it here.
                total = Number(this.util.bcadd(total, results[0].count, 0));
        }
        if(action && start){
            if(action=='prev'){
                where += ' AND ' + cursor + ' > ?';
                args.push(start);
            } else {
                where += ' AND ' + cursor + ' < ?';
                args.push(start);
            }
        }
        // parent_batch_action_index (spec explorer-coverage-completion M1.6):
        // the indexer stores no parent column (batches is (action_index, status_id);
        // every sub-command is its own root action), so parenthood is DERIVED here.
        // A parent and its children share (tx_index, tx_vout) on `actions`; the parent
        // is whichever of those rows also has an `actions.action_index` present in
        // `batches`. This MUST stay a correlated scalar subquery in the select list,
        // never a FROM-clause join: the outer query is SELECT DISTINCT over the whole
        // row, and a join that multi-matches (one BATCH parent joined against N
        // children sharing its tx_vout) would re-materialize duplicate action_index
        // rows past the DISTINCT. A subquery returns exactly one scalar per outer row
        // and does not change row cardinality, so DISTINCT still collapses correctly.
        // `apx.action_index!=a1.action_index` is what makes the parent BATCH row's own
        // value NULL (it would otherwise find itself); every non-batch row also comes
        // back NULL because no sibling row in `batches` exists at all. EXPLAIN shape:
        // apx is looked up via actions' own PK/unique index on action_index bounded by
        // the outer row's tx_index/tx_vout (actions carries a plain index on tx_index,
        // narrowing the scan to the handful of rows sharing one tx output), then
        // filtered through batches' UNIQUE KEY on action_index (an eq_ref, not a scan);
        // the whole subquery runs once per returned row, so cost scales with page size
        // (sql.limit), not table size.
        if(total){
            query = `SELECT
                        DISTINCT(` + cursor + `) as action_index,
                        a2.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        (
                            SELECT bpx.action_index
                            FROM actions apx
                            INNER JOIN batches bpx ON (bpx.action_index=apx.action_index)
                            WHERE apx.tx_index=a1.tx_index
                                AND apx.tx_vout=a1.tx_vout
                                AND apx.action_index!=a1.action_index
                            LIMIT 1
                        ) as parent_batch_action_index
                    FROM
                        ` + source + `
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY ` + cursor + ` ` + sql.order + `
                    LIMIT ` + sql.limit;
            results = await this.doQuery(config, query, args);
            if(results && results.length){
                for(let row of results)
                    history.push(row);
            }
        }
        // Get summary data for actions
        let data = await this.getActionSummaryData(config, history);
        return [data, total];
    }

    // Action type + owning transaction hash for a SET of action_indexes.
    // Mirrors getActionType's join and adds the transactions / index_transactions hop
    // getTransactionData keys on, so one query gives a page both the type it dispatches
    // the handler on and the tx_hash it prefetches transactions by.
    // Returns a Map of action_index -> { type, tx_hash }; an index with no row is absent,
    // which the caller reads the same way getActionType reads a row-less result (null).
    async getActionMetaBatch(config, action_indexes){
        let map = new Map();
        if(!action_indexes || !action_indexes.length) return map;
        let ph  = action_indexes.map(() => '?').join(',');
        let sql = `SELECT
                        a1.action_index,
                        a2.action,
                        t2.hash as tx_hash
                    FROM
                        actions a1
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE
                        a1.action_index IN (${ph})`;
        let results = await this.doQuery(config, sql, [...action_indexes]);
        for(let row of (results || [])){
            let key = Number(row.action_index);
            // First row wins, matching getActionType's unqualified results[0].
            if(map.has(key)) continue;
            map.set(key, {
                type:    (row.action === undefined)  ? null : row.action,
                tx_hash: (row.tx_hash === undefined) ? null : row.tx_hash
            });
        }
        return map;
    }

    // Batched getActionFeeData. Same SELECT list, same order, same joins;
    // action_index rides along last and is deleted, so a surviving row is key-for-key
    // what the single-index query returns. Returns a Map of action_index -> fee row.
    async getActionFeeDataBatch(config, action_indexes){
        let map = new Map();
        if(!action_indexes || !action_indexes.length) return map;
        let ph    = action_indexes.map(() => '?').join(',');
        let query = `SELECT
                        a2.address as source,
                        a3.address as destination,
                        t2.tick,
                        f1.amount,
                        f1.method,
                        f1.gas_cost,
                        f1.gas_price,
                        f1.xchain_amount,
                        f1.payment_mode,
                        f1.native_coin_amount,
                        f1.native_coin,
                        f1.oracle_round,
                        f1.fee_preference,
                        f1.fee_version,
                        f1.action_index as _group_index
                    FROM
                        fees f1
                        INNER JOIN actions         a1 ON (a1.action_index=f1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_tickers   t2 ON (t2.id=f1.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses a3 ON (a3.id=f1.destination_id)
                    WHERE
                        f1.action_index IN (${ph})`;
        let results = await this.doQuery(config, query, [...action_indexes]);
        for(let row of (results || [])){
            let key = Number(row._group_index);
            delete row._group_index;
            // First row wins, matching getActionFeeData's unqualified results[0].
            if(!map.has(key)) map.set(key, row);
        }
        return map;
    }

    // Batched getTransactionData, keyed by tx_hash rather than action_index
    // because that is what the single-hash query takes. Every REQUESTED hash gets an
    // entry (null when the row is absent), so a caller can treat map.has() as authority
    // and only fall back for a hash the page never prefetched.
    async getTransactionDataBatch(config, hashes){
        let map = new Map();
        if(!hashes || !hashes.length) return map;
        let distinct = [...new Set(hashes.map((h) => String(h)))];
        let ph       = distinct.map(() => '?').join(',');
        let query = `SELECT
                        t1.tx_index,
                        t1.block_index,
                        t2.hash,
                        t1.fee,
                        t1.data
                    FROM
                        transactions t1
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE
                        t2.hash IN (${ph})`;
        let results = await this.doQuery(config, query, distinct);
        for(let row of (results || [])){
            let key = String(row.hash);
            if(!map.has(key)) map.set(key, row);
        }
        for(let h of distinct)
            if(!map.has(h)) map.set(h, null);
        return map;
    }

    // Build the page-level preload getActionData reads its shared legs from.
    // Six queries for the whole page in place of six per action: one meta query for type
    // and tx_hash, up to three ledger-effect queries, one fee query, one transaction
    // query. The effect prefetch is narrowed by each index's handler `effects` flags,
    // the SAME flags attachLedgerEffects gates on, so the prefetched set and the consumed
    // set are equal by construction and a page of non-ledger actions queries none of them.
    // Per-handler detail queries are deliberately untouched: they differ per action type
    // and batching them is the high-risk half of this change.
    async _buildActionPreload(config, action_indexes){
        let idxs = (action_indexes || []).map((i) => Number(i));
        if(!idxs.length) return null;
        let preload = {
            indexes:  new Set(idxs),
            types:    new Map(),
            fees:     new Map(),
            txs:      new Map(),
            emitted:  new Map(),
            effects:  null
        };
        let meta          = await this.getActionMetaBatch(config, idxs);
        let effectIndexes = { credits: [], debits: [], escrows: [] };
        let typed         = [];
        let hashes        = [];
        for(let idx of idxs){
            let row = meta.get(idx) || { type: null, tx_hash: null };
            preload.types.set(idx, row.type);
            // An untyped index short-circuits in getActionData before any shared leg
            // runs, so it contributes nothing to the effect / fee / tx prefetch sets.
            if(this.util.isNull(row.type)) continue;
            typed.push(idx);
            let flags = actionDetail.getHandler(row.type).effects || {};
            for(let key of ['credits', 'debits', 'escrows'])
                if(flags[key] !== false) effectIndexes[key].push(idx);
            if(!this.util.isNull(row.tx_hash)) hashes.push(String(row.tx_hash));
        }
        preload.effects = await actionDetail.prefetchLedgerEffects(this, config, effectIndexes);
        let fees = await this.getActionFeeDataBatch(config, typed);
        // Absence in the fee query means "no fee row", which is the null the single-index
        // path returns; record it explicitly so has() is authoritative for typed indexes.
        for(let idx of typed)
            preload.fees.set(idx, fees.has(idx) ? fees.get(idx) : null);
        preload.txs = await this.getTransactionDataBatch(config, hashes);
        // Emission provenance is a shared leg like the fee and tx legs: identical in shape
        // for every action, so it runs ONCE over the page instead of once per action.
        // Asking per-action put the page's per-index query count back above the ceiling
        // action-preload-parity guards.
        preload.emitted = await this.getEmissionProvenanceBatch(config, typed);
        return preload;
    }

    // Emission provenance for a SET of action indexes, in two queries rather than two per
    // action. Almost no action is an emission, so the second query runs only for the few
    // that are - and on a page with none it does not run at all. Returns a Map of
    // action_index -> { execution_index, position, contract_index, caller }, containing only
    // the indexes that ARE emissions; absence means "broadcast normally".
    async getEmissionProvenanceBatch(config, action_indexes){
        let out  = new Map();
        let idxs = (action_indexes || []).map((i) => Number(i)).filter((i) => !isNaN(i));
        if(!idxs.length) return out;
        let holes = idxs.map(() => '?').join(',');
        let rows  = await this.doQuery(config,
            `SELECT
                e.action_index,
                e.execution_index,
                e.position
            FROM
                contract_emissions e
            WHERE
                e.action_index IN (${holes})`, idxs);
        if(!rows || !rows.length) return out;
        for(let r of rows)
            out.set(Number(r.action_index), {
                execution_index: r.execution_index,
                position:        r.position,
                contract_index:  null,
                caller:          null
            });
        let parents = [...new Set([...out.values()].map((v) => Number(v.execution_index)))];
        let pHoles  = parents.map(() => '?').join(',');
        let pRows   = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.contract_index,
                a1.address as caller
            FROM
                contract_executions m
                LEFT  JOIN index_addresses a1 ON (a1.id=m.caller_id)
            WHERE
                m.action_index IN (${pHoles})`, parents);
        let byExec = new Map((pRows || []).map((r) => [Number(r.action_index), r]));
        for(let v of out.values()){
            let p = byExec.get(Number(v.execution_index));
            if(p){ v.contract_index = p.contract_index; v.caller = p.caller; }
        }
        return out;
    }

    // Batch-load getActionData for a set of action indexes (Fix B / #3841). Resolves the
    // DISTINCT action_index set concurrently through the existing getActionData path (bounded
    // by BATCH_CONCURRENCY so the connection pool is not exhausted), returning a Map keyed by
    // the numeric action_index. Because each entry is produced by the unmodified getActionData,
    // every payload is byte-for-byte identical to the per-row path it replaces; the only change
    // is that the page's lookups now overlap instead of running strictly serially, and the LRU
    // _actionDataCache is warmed exactly as before. Callers must read results by action_index
    // (never rely on ordering). Failures propagate unchanged (same as the old per-row await).
    async getActionDataBatch(config, actionIndexes){
        const BATCH_CONCURRENCY = Number(this.config && this.config.BATCH_CONCURRENCY) || 8;
        // Distinct, insertion-order-preserving set of indexes to fetch.
        let distinct = [];
        let seen = new Set();
        for(let idx of actionIndexes){
            let key = Number(idx);
            if(!seen.has(key)){ seen.add(key); distinct.push(idx); }
        }
        // Shared-leg prefetch. Overlapping the fan-out hid the latency but
        // left the page's DB work at O(actions x queries): every index still ran its
        // own type, three ledger-effect, fee and transaction queries. Those legs are
        // identical in shape for every action, so the page runs each of them ONCE over
        // the whole index set and threads the result in as a preload; only the
        // per-handler detail queries still fan out. Indexes already in the LRU are
        // excluded, so a warm page prefetches nothing, and at a single cold index the
        // query count is unchanged (the type and tx legs merge into one meta query).
        let cold = distinct.filter((idx) => this._cacheGet(this._actionDataCache, this._cacheKey(config.coin, idx)) === undefined);
        let preload = (cold.length) ? await this._buildActionPreload(config, cold) : null;
        let out = new Map();
        let cursor = 0;
        const worker = async () => {
            while(cursor < distinct.length){
                let i = cursor++;
                let idx = distinct[i];
                out.set(Number(idx), await this.getActionData(config, idx, preload));
            }
        };
        let workers = [];
        let poolSize = Math.min(BATCH_CONCURRENCY, distinct.length);
        for(let w = 0; w < poolSize; w++) workers.push(worker());
        await Promise.all(workers);
        return out;
    }

    // Project one full getActionData payload onto the compact summary shape the
    // client's getActionDetails renders: ACTION_SUMMARY_FIELDS copied onto a
    // `details` object (false when none is present) plus the row status. SEND
    // keeps its fields per destination under sends[], so the summary reads
    // sends[0] for every field and takes its status when the payload has none.
    // The transaction/history rows and the BATCH member table both go through
    // here, so a field lands on every summary surface at once.
    projectActionSummary(info){
        let details = false;
        let status  = info.status;
        let send    = (info.action=='SEND' && Array.isArray(info.sends) && info.sends.length>0) ? info.sends[0] : null;
        if(send && this.util.isNull(status))
            status = send.status;
        for(let name of ACTION_SUMMARY_FIELDS){
            let found  = false;
            let detail = false;
            if(typeof info[name] !== 'undefined'){
                found  = true;
                detail = info[name];
            }
            if(send){
                found  = true;
                detail = send[name];
            }
            if(found){
                if(!details)
                    details = {};
                details[name] = detail;
            }
        }
        return { details, status };
    }

    async getActionSummaryData(config, actions){
        // --- Performance note (Fix B / #3841) ---
        // The page's action rows are enriched via getActionDataBatch(), which resolves the
        // distinct action_index set through getActionData with bounded concurrency instead of
        // one strictly-serial await per row. Payloads are byte-identical to the old per-row
        // path (same getActionData); only the round-trips now overlap, so first-load latency
        // no longer scales linearly with the serial round-trip count. Tracked as #3841.
        const t0 = Date.now();
        // --- End Fix B ---
        // Pre-resolve every row's action data once, keyed by action_index.
        let actionData = await this.getActionDataBatch(config, actions.map((a) => a.action_index));
        for(let data of actions){
            let info = actionData.get(Number(data.action_index));
            let { details, status } = this.projectActionSummary(info);
            data.status  = status;
            data.details = details;
        }
        // Slow-page observability (Fix B): warn when first-load latency is still high after
        // the batched concurrent fetch (#3841), so any residual slow path stays visible.
        const elapsed = Date.now() - t0;
        if(elapsed > 500)
            console.warn('getActionSummaryData: slow page (' + elapsed + 'ms, ' + actions.length + ' actions) -- batched getActionData fetch still slow; see #3841');
        return actions;
    }

    async getSearch(config){
        // --- Performance guard (Fix A) ---
        // Every search term is wrapped in leading+trailing % which defeats all B-tree indexes,
        // causing full-table scans across every search column. Short terms (e.g. 1-2 chars)
        // are especially costly because they can match a huge fraction of every table.
        // The proper long-term fix is a FULLTEXT index on the searched columns, or a
        // normalized lowercase prefix column with a covering index -- tracked post-launch.
        // Until then: reject terms below the minimum length to cap scan cost.
        const SEARCH_MIN_LENGTH = 3;
        const searchRaw = (config.data.search || '').trim();
        if(searchRaw.length < SEARCH_MIN_LENGTH){
            return [{ data: [], totals: { addresses: 0, broadcasts: 0, contracts: 0, tokens: 0, transactions: 0 } }, null, 0];
        }
        // Cap the result LIMIT to a safe ceiling regardless of what the pager computed,
        // as a defense-in-depth measure against runaway scans on popular terms.
        const SEARCH_MAX_ROWS = 100;
        // --- End Fix A ---
        let searchTypes = ['address', 'broadcast', 'contract', 'token', 'transaction'];
        let dataType    = config.data.type;
        let search      = '%' + this.util.escapeLike(searchRaw) + '%';
        let total       = 0;
        let sql  = config.data.sql;
        const searchLimit = Math.min(Number(sql.limit) || SEARCH_MAX_ROWS, SEARCH_MAX_ROWS);
        // The contract panel is the ONE panel that is not a LIKE (spec 2.6): contracts
        // carry a FULLTEXT index over (meta_name, meta_description), so a name or
        // description word is matched through it rather than by a leading-% scan. Its
        // term is sanitized for BOOLEAN MODE and can come back empty (a term of nothing
        // but operator characters), which leaves the contract panel at zero while the
        // other four still answer their own counts.
        let ftTerm = this.fulltextTerm(searchRaw);
        let data = {
            data: [],
            totals: {
                addresses:    0,
                broadcasts:   0,
                contracts:    0,
                tokens:       0,
                transactions: 0
            },
        };
        let countQueries = [
            { type: 'address',     query: `SELECT COUNT(*) AS count FROM index_addresses WHERE LOWER(address) LIKE LOWER( ? )`, args: [search] },
            { type: 'transaction', query: `SELECT COUNT(*) AS count FROM transactions t1 LEFT JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id) WHERE LOWER(t2.hash) LIKE LOWER( ? )`, args: [search] },
            { type: 'broadcast',   query: `SELECT COUNT(*) AS count FROM broadcasts b LEFT JOIN index_memos m ON (m.id=b.memo_id) WHERE LOWER(b.message) LIKE LOWER( ? ) OR LOWER(m.memo) LIKE LOWER( ? )`, args: [search, search] },
            { type: 'token',       query: `SELECT COUNT(*) AS count FROM tokens t1 LEFT JOIN index_tickers t2 ON (t2.id=t1.tick_id) WHERE LOWER(t2.tick) LIKE LOWER( ? ) OR LOWER(t1.description) LIKE LOWER( ? )`, args: [search, search] }
        ];
        if(ftTerm !== '')
            countQueries.push({ type: 'contract', query: `SELECT COUNT(*) AS count FROM contracts m WHERE MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)`, args: [ftTerm] });
        let countResults = await Promise.all(countQueries.map(q => this.doQuery(config, q.query, q.args)));
        for(let i = 0; i < countQueries.length; i++){
            let results = countResults[i];
            let type    = countQueries[i].type;
            if(results && results.length){
                let cnt = Number(results[0].count);
                if(type=='address')     data.totals.addresses    = cnt;
                if(type=='broadcast')   data.totals.broadcasts   = cnt;
                if(type=='contract')    data.totals.contracts    = cnt;
                if(type=='token')       data.totals.tokens       = cnt;
                if(type=='transaction') data.totals.transactions = cnt;
                if(type==dataType)      total = cnt;
            }
        }
        if(total){
            let query = false;
            let args  = [search];
            if(['broadcast','token'].includes(dataType))
                args.push(search);
            // The contract panel binds the FULLTEXT term, not the LIKE pattern.
            if(dataType=='contract')
                args = [ftTerm];
            if(dataType=='address')
                query = `SELECT
                            address
                        FROM
                            index_addresses
                        WHERE
                            LOWER(address) LIKE LOWER( ? )
                        ORDER BY address ASC
                        LIMIT ` + searchLimit;
            if(dataType=='transaction')
                query = `SELECT
                            t2.hash
                        FROM
                            transactions t1
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE
                            LOWER(t2.hash) LIKE LOWER( ? )
                        ORDER BY t2.hash ASC
                        LIMIT ` + searchLimit;
            if(dataType=='broadcast')
                query = `SELECT
                            b.message,
                            m.memo,
                            b.action_index,
                            s.status
                        FROM
                            broadcasts b
                            LEFT  JOIN index_memos    m ON (m.id=b.memo_id)
                            LEFT  JOIN index_statuses s ON (s.id=b.status_id)
                        WHERE
                            LOWER(b.message) LIKE LOWER( ? ) OR
                            LOWER(m.memo)    LIKE LOWER( ? )
                        ORDER BY b.action_index DESC
                        LIMIT ` + searchLimit;
            if(dataType=='token'){
                query = `SELECT
                            t2.tick,
                            t1.description
                        FROM
                            tokens t1
                            LEFT  JOIN index_tickers t2 ON (t2.id=t1.tick_id)
                        WHERE
                            LOWER(t2.tick)        LIKE LOWER( ? ) OR
                            LOWER(t1.description) LIKE LOWER( ? )
                        ORDER BY t2.tick ASC
                        LIMIT ` + searchLimit;
            }
            // Contracts, matched through meta_search rather than by LIKE. Newest
            // first: contract indexes are monotonic, so ORDER BY action_index DESC
            // is "most recently deployed", which is what a name search is looking
            // for when several contracts share a name (they are not unique).
            if(dataType=='contract'){
                query = `SELECT
                            m.action_index,
                            m.meta_name,
                            m.meta_version,
                            m.meta_description
                        FROM
                            contracts m
                        WHERE
                            MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)
                        ORDER BY m.action_index DESC
                        LIMIT ` + searchLimit;
            }
            if(query){
                let results = await this.doQuery(config, query, args);
                if(results && results.length)
                    data.data = results;
                // A contract hit carries the derived address the reader actually
                // navigates by (C:<CHAIN>:<action_index>, the same derivation
                // getContractBalance uses) and a bounded description snippet: the
                // column holds up to 512 bytes, which is a paragraph in a results row.
                if(dataType=='contract' && Array.isArray(data.data)){
                    let chain = this.baseCoin ? (this.baseCoin[config.coin] || config.coin) : config.coin;
                    data.data = data.data.map((row) => ({
                        action_index:     row.action_index,
                        contract_address: 'C:' + chain + ':' + row.action_index,
                        meta_name:        this.util.isNull(row.meta_name)    ? null : row.meta_name,
                        meta_version:     this.util.isNull(row.meta_version) ? null : row.meta_version,
                        snippet:          this._metaSnippet(row.meta_description)
                    }));
                }
            }
        }
        // Get count of total number of addresses
        return [data, null, total]
    }

    // Return order info for given action_index
    async getOrderInfo(config, action_index){
        let order = false;
        let query = `SELECT 
                        o1.action_index,
                        t2.tick as give_tick,
                        o1.give_amount,
                        c2.coin as give_coin,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        o1.get_amount,
                        a2.address as source,
                        a3.address as get_address,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        m1.memo,
                        s2.status,
                        s3.status as order_status,
                        b1.block_index,
                        b1.block_time
                    FROM 
                        orders o1
                        INNER JOIN actions         a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        INNER JOIN index_addresses a3 ON (a3.id=o1.get_address_id)
                        -- LEFT, not INNER: an order against the native coin carries a NULL
                        -- tick id on that side, and inner-joining the ticker dropped the order
                        -- outright, which emptied the orderbook of every token/native market.
                        -- The side is named by give_coin / get_coin instead.
                        LEFT  JOIN index_tickers   t2 ON (t2.id=o1.give_tick_id)
                        LEFT  JOIN index_tickers   t3 ON (t3.id=o1.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=o1.get_coin_id)
                        INNER JOIN index_coins     c2 ON (c2.id=o1.give_coin_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=o1.memo_id)
                        INNER JOIN order_statuses  s1 ON (s1.order_action_index=o1.action_index)
                        INNER JOIN index_statuses  s2 ON (s2.id=o1.status_id)
                        INNER JOIN index_statuses  s3 ON (s3.id=s1.status_id)
                    WHERE 
                        s1.action_index = (
                            SELECT
                                MAX(s4.action_index)
                            FROM
                                order_statuses s4
                            WHERE
                                s4.order_action_index=o1.action_index
                        ) AND
                        o1.action_index=? 
                    LIMIT 1`;
        let args  = [action_index];
        let results = await this.doQuery(config, query, args);
        if(results.length > 0){
            order = results[0];
            // Convert BIGINT values to Numbers
            order.action_index = Number(order.action_index);
            order.block_index  = Number(order.block_index);
            order.block_time   = Number(order.block_time);
            order.allow_list   = Number(order.allow_list);
            order.block_list   = Number(order.block_list);
        }
        // Get additional information on this order 
        if(order){
            // Get updated order properties from the order_edits table
            let edit = await this.getOrderEditInfo(config, action_index);
            if(edit.expiration) order.expiration = edit.expiration;
            if(edit.allow_list) order.allow_list = edit.allow_list;
            if(edit.block_list) order.block_list = edit.block_list;
            // Determine order get/give prices
            order.give_price = this.util.getPrice(order.get_amount, order.give_amount);
            order.get_price  = this.util.getPrice(order.give_amount, order.get_amount);
            // Determine order amounts remaining
            let [give_remaining, get_remaining] = await this.getOrderAmountsRemaining(config, action_index);
            order.give_remaining = give_remaining;
            order.get_remaining  = get_remaining;
        }
        order = this.util.ksort(order);
        return order;
    }

    // Return order edit information for given action_index
    async getOrderEditInfo(config, action_index){
        let edit  = {
            expiration: false,
            allow_list: false,
            block_list: false
        };
        let query  = `SELECT 
                        o.expiration,
                        o.allow_list,
                        o.block_list
                    FROM 
                        order_edits o
                        INNER JOIN index_statuses s ON (s.id=o.status_id)
                    WHERE 
                        o.order_action_index=? AND
                        s.status=?
                    ORDER BY
                        o.action_index ASC`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(config, query, args);
        if(results.length > 0){
            for(let row of results){
                if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration)) edit.expiration = Number(row.expiration);
                if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list)) edit.allow_list = Number(row.allow_list);
                if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list)) edit.block_list = Number(row.block_list);
            }
        }
        return edit;
    }    

    async getOrderAmountsRemaining(config, action_index){
        let give_coin_id   = 0,
            give_tick_id   = 0,
            give_remaining = 0,
            get_coin_id    = 0,
            get_tick_id    = 0,
            get_remaining  = 0;
        let query  = `SELECT
                        o.give_coin_id,
                        o.give_tick_id,
                        o.give_amount,
                        o.get_coin_id,
                        o.get_tick_id,
                        o.get_amount
                    FROM 
                        orders o
                        INNER JOIN index_statuses s ON (s.id=o.status_id)
                    WHERE 
                        o.action_index=? AND
                        s.status=?`;
        let args  = [action_index, 'valid'];
        let results = await this.doQuery(config, query, args);
        if(results.length > 0){
            let info = results[0];
            give_coin_id   = info.give_coin_id;
            give_tick_id   = info.give_tick_id;  
            give_remaining = info.give_amount;
            get_coin_id    = info.get_coin_id;
            get_tick_id    = info.get_tick_id;  
            get_remaining  = info.get_amount;
        }
        query = `SELECT
                    m.give_action_index,
                    m.get_action_index,
                    m.give_amount,
                    m.get_amount
                FROM
                    order_matches m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    (m.give_action_index=? OR m.get_action_index=?) AND
                    s.status=?
                ORDER BY action_index ASC`;
        args = [action_index, action_index, 'valid'];
        results = await this.doQuery(config, query, args);
        if(results.length > 0){
            for(let row of results){
                let give_amount = (row.get_action_index==action_index) ? row.give_amount : row.get_amount;
                let get_amount  = (row.get_action_index==action_index) ? row.get_amount  : row.give_amount;
                give_remaining  = this.util.bcsub(give_remaining, give_amount);
                get_remaining   = this.util.bcsub(get_remaining,  get_amount);
            }
        }
        return [give_remaining, get_remaining];
    }

    // Render a derived amount as a plain decimal string. mathjs bignumbers
    // stringify to exponential notation below 1e-7 ('3e-8'), which no client
    // parses as an amount, so 18-decimal dust would render unusable.
    _amountString(value){
        if(this.util.isNull(value)) return null;
        return (value && typeof value.toFixed === 'function') ? value.toFixed() : String(value);
    }

    /**
     * Live escrow for one or more dispensers.
     *
     * The ONLY dispenser-escrow derivation in this service. A dispenser holds no
     * escrow column: what is left is the valid create row's GIVE_ESCROW, plus the
     * top-up every valid DISPENSER_EDIT added, minus what every valid DISPENSE
     * paid out. That is consensus-sensitive arithmetic (the indexer's
     * getDispenserAmountRemaining is its mirror, down to the 64-digit precision
     * and the valid-status filters), so both explorer read lanes - the per-action
     * detail path and the getDispensers list path - call this instead of each
     * rolling its own SQL, and the two can never disagree about how full a
     * dispenser is.
     *
     * @param   {Object} config          request config (carries the coin/pool)
     * @param   {Array}  action_indexes  dispenser action_index values
     * @returns {Object} map keyed by String(action_index) ->
     *                   { give_escrow, escrow_remaining } (both decimal strings,
     *                   give_escrow null for an ownership dispenser, which escrows
     *                   no amount at all)
     */
    async getDispenserEscrowBatch(config, action_indexes){
        let map = {};
        if(!Array.isArray(action_indexes) || !action_indexes.length)
            return map;
        // action_index is a BIGINT that reaches callers as either a Number or a
        // String depending on the driver path, so key on String and de-dupe: a
        // list page can repeat an index and must not bind it twice.
        let idxs = [...new Set(action_indexes.filter((x) => !this.util.isNull(x)).map((x) => String(x)))];
        if(!idxs.length)
            return map;
        let ph = idxs.map(() => '?').join(',');
        // Opening balance: the create row's escrow. Filtered to valid rows the
        // same way the indexer filters it - an invalid DISPENSER escrows nothing.
        let query = `SELECT
                        d.action_index,
                        d.give_escrow
                    FROM
                        dispensers d
                        INNER JOIN index_statuses s ON (s.id=d.status_id)
                    WHERE
                        d.action_index IN (` + ph + `) AND
                        s.status=?`;
        let rows = await this.doQuery(config, query, [...idxs, 'valid']);
        for(let row of (rows || [])){
            let escrow = this.util.isNull(row.give_escrow) ? null : row.give_escrow;
            map[String(row.action_index)] = { give_escrow: escrow, escrow_remaining: escrow };
        }
        // Refills: every valid DISPENSER_EDIT that topped GIVE_ESCROW up.
        query = `SELECT
                    m.dispenser_action_index,
                    m.give_escrow
                FROM
                    dispenser_edits m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    m.dispenser_action_index IN (` + ph + `) AND
                    s.status=?
                ORDER BY m.action_index ASC`;
        rows = await this.doQuery(config, query, [...idxs, 'valid']);
        for(let row of (rows || [])){
            let entry = map[String(row.dispenser_action_index)];
            if(entry && !this.util.isNull(row.give_escrow))
                entry.escrow_remaining = this.util.bcadd(entry.escrow_remaining, row.give_escrow, 64);
        }
        // Payouts: every valid DISPENSE this dispenser served.
        query = `SELECT
                    m.dispenser_action_index,
                    m.give_amount
                FROM
                    dispenses m
                    INNER JOIN index_statuses s ON (s.id=m.status_id)
                WHERE
                    m.dispenser_action_index IN (` + ph + `) AND
                    s.status=?
                ORDER BY m.action_index ASC`;
        rows = await this.doQuery(config, query, [...idxs, 'valid']);
        for(let row of (rows || [])){
            let entry = map[String(row.dispenser_action_index)];
            if(entry && !this.util.isNull(row.give_amount))
                entry.escrow_remaining = this.util.bcsub(entry.escrow_remaining, row.give_amount, 64);
        }
        for(let key of Object.keys(map)){
            map[key].give_escrow      = this._amountString(map[key].give_escrow);
            map[key].escrow_remaining = this._amountString(map[key].escrow_remaining);
        }
        return map;
    }

    /**
     * Latest lifecycle status for one or more dispensers.
     *
     * The dispensers table's own status column is the CREATE action's validity
     * and never moves; the lifecycle (open / cancelling / cancelled / complete /
     * expired) lives in dispenser_statuses, one row per transition, newest row
     * current. The per-action detail path already resolves it via a
     * MAX(action_index) subquery; this is the batched mirror for the
     * getDispensers list lane, so a listing can tell an open dispenser from a
     * cancelled one without a detail fetch per row.
     *
     * @param   {Object} config          request config (carries the coin/pool)
     * @param   {Array}  action_indexes  dispenser action_index values
     * @returns {Object} map keyed by String(action_index) -> status string;
     *                   a dispenser with no status row (an invalid create
     *                   writes none) is simply absent from the map
     */
    async getDispenserCurrentStatusBatch(config, action_indexes){
        let map = {};
        if(!Array.isArray(action_indexes) || !action_indexes.length)
            return map;
        let idxs = [...new Set(action_indexes.filter((x) => !this.util.isNull(x)).map((x) => String(x)))];
        if(!idxs.length)
            return map;
        let ph = idxs.map(() => '?').join(',');
        // Ordered oldest->newest so the plain overwrite below leaves the newest
        // transition per dispenser in the map - the same "latest row wins" rule
        // as the detail path's MAX(action_index) subquery, without a correlated
        // subquery per listed row.
        let query = `SELECT
                        m.dispenser_action_index,
                        m.action_index,
                        s.status
                    FROM
                        dispenser_statuses m
                        INNER JOIN index_statuses s ON (s.id=m.status_id)
                    WHERE
                        m.dispenser_action_index IN (` + ph + `)
                    ORDER BY m.action_index ASC`;
        let rows = await this.doQuery(config, query, idxs);
        for(let row of (rows || []))
            map[String(row.dispenser_action_index)] = row.status;
        return map;
    }

    /******************************************************************
     * Batch query methods (eliminate N+1 patterns)
     *****************************************************************/

    async getOrderInfoBatch(config, action_indexes){
        if(!action_indexes || action_indexes.length === 0) return {};
        let orderMap = {};
        let placeholders = action_indexes.map(() => '?').join(',');

        let query = `SELECT
                        o1.action_index,
                        t2.tick as give_tick,
                        o1.give_amount,
                        c2.coin as give_coin,
                        c1.coin as get_coin,
                        t3.tick as get_tick,
                        o1.get_amount,
                        a2.address as source,
                        a3.address as get_address,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        m1.memo,
                        s2.status,
                        s3.status as order_status,
                        b1.block_index,
                        b1.block_time
                    FROM
                        orders o1
                        INNER JOIN actions         a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        INNER JOIN index_addresses a3 ON (a3.id=o1.get_address_id)
                        -- LEFT, not INNER: an order against the native coin carries a NULL
                        -- tick id on that side, and inner-joining the ticker dropped the order
                        -- outright, which emptied the orderbook of every token/native market.
                        -- The side is named by give_coin / get_coin instead.
                        LEFT  JOIN index_tickers   t2 ON (t2.id=o1.give_tick_id)
                        LEFT  JOIN index_tickers   t3 ON (t3.id=o1.get_tick_id)
                        INNER JOIN index_coins     c1 ON (c1.id=o1.get_coin_id)
                        INNER JOIN index_coins     c2 ON (c2.id=o1.give_coin_id)
                        LEFT  JOIN index_memos     m1 ON (m1.id=o1.memo_id)
                        INNER JOIN order_statuses  s1 ON (s1.order_action_index=o1.action_index)
                        INNER JOIN index_statuses  s2 ON (s2.id=o1.status_id)
                        INNER JOIN index_statuses  s3 ON (s3.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT MAX(s4.action_index)
                            FROM order_statuses s4
                            WHERE s4.order_action_index=o1.action_index
                        ) AND
                        o1.action_index IN (` + placeholders + `)`;
        let results = await this.doQuery(config, query, [...action_indexes]);
        if(results && results.length > 0){
            for(let row of results){
                row.action_index = Number(row.action_index);
                row.block_index  = Number(row.block_index);
                row.block_time   = Number(row.block_time);
                row.allow_list   = Number(row.allow_list);
                row.block_list   = Number(row.block_list);
                orderMap[row.action_index] = row;
            }
        }

        let editQuery = `SELECT
                            o.order_action_index,
                            o.expiration,
                            o.allow_list,
                            o.block_list
                        FROM
                            order_edits o
                            INNER JOIN index_statuses s ON (s.id=o.status_id)
                        WHERE
                            o.order_action_index IN (` + placeholders + `) AND
                            s.status=?
                        ORDER BY o.action_index ASC`;
        let editResults = await this.doQuery(config, editQuery, [...action_indexes, 'valid']);
        if(editResults && editResults.length > 0){
            for(let row of editResults){
                let idx = Number(row.order_action_index);
                if(orderMap[idx]){
                    if(!this.util.isNull(row.expiration) && this.util.isNumeric(row.expiration)) orderMap[idx].expiration = Number(row.expiration);
                    if(!this.util.isNull(row.allow_list) && this.util.isNumeric(row.allow_list)) orderMap[idx].allow_list = Number(row.allow_list);
                    if(!this.util.isNull(row.block_list) && this.util.isNumeric(row.block_list)) orderMap[idx].block_list = Number(row.block_list);
                }
            }
        }

        let amtQuery = `SELECT
                            o.action_index,
                            o.give_amount,
                            o.get_amount
                        FROM
                            orders o
                            INNER JOIN index_statuses s ON (s.id=o.status_id)
                        WHERE
                            o.action_index IN (` + placeholders + `) AND
                            s.status=?`;
        let amtResults = await this.doQuery(config, amtQuery, [...action_indexes, 'valid']);
        let remainingMap = {};
        if(amtResults && amtResults.length > 0){
            for(let row of amtResults){
                let idx = Number(row.action_index);
                remainingMap[idx] = { give_remaining: row.give_amount, get_remaining: row.get_amount };
            }
        }

        let matchPlaceholders = action_indexes.map(() => '?').join(',');
        let matchQuery = `SELECT
                            m.give_action_index,
                            m.get_action_index,
                            m.give_amount,
                            m.get_amount
                        FROM
                            order_matches m
                            INNER JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            (m.give_action_index IN (` + matchPlaceholders + `) OR m.get_action_index IN (` + matchPlaceholders + `)) AND
                            s.status=?
                        ORDER BY m.action_index ASC`;
        let matchResults = await this.doQuery(config, matchQuery, [...action_indexes, ...action_indexes, 'valid']);
        if(matchResults && matchResults.length > 0){
            for(let row of matchResults){
                for(let idx of action_indexes){
                    if(row.give_action_index == idx || row.get_action_index == idx){
                        if(remainingMap[idx]){
                            let give_amount = (row.get_action_index == idx) ? row.give_amount : row.get_amount;
                            let get_amount  = (row.get_action_index == idx) ? row.get_amount  : row.give_amount;
                            remainingMap[idx].give_remaining = this.util.bcsub(remainingMap[idx].give_remaining, give_amount);
                            remainingMap[idx].get_remaining  = this.util.bcsub(remainingMap[idx].get_remaining,  get_amount);
                        }
                    }
                }
            }
        }

        for(let idx of action_indexes){
            let order = orderMap[idx];
            if(order){
                order.give_price = this.util.getPrice(order.get_amount, order.give_amount);
                order.get_price  = this.util.getPrice(order.give_amount, order.get_amount);
                if(remainingMap[idx]){
                    order.give_remaining = remainingMap[idx].give_remaining;
                    order.get_remaining  = remainingMap[idx].get_remaining;
                }
                orderMap[idx] = this.util.ksort(order);
            }
        }
        return orderMap;
    }

    /******************************************************************
     * WebSocket Change Detection Queries
     *
     * Lightweight queries used by the ChangeDetector to poll for new
     * blocks and actions. These are designed to be fast (index-only
     * where possible) and are called every poll cycle.
     *****************************************************************/

    async getMaxBlockIndex(config) {
        let query   = `SELECT MAX(block_index) as max_index FROM blocks`;
        let results = await this.doQuery(config, query, []);
        if (results && results.length && results[0].max_index !== null)
            return Number(results[0].max_index);
        return 0;
    }

    // Get the block_time of the highest (tip) block in the blocks table.
    // Used as the deterministic "now" for display-side activation checks so the
    // result matches the indexer's consensus logic (which uses block_time) and is
    // identical across explorer hosts irrespective of local wall-clock.
    async getMaxBlockTime(config) {
        let query   = `SELECT block_time FROM blocks ORDER BY block_index DESC LIMIT 1`;
        let results = await this.doQuery(config, query, []);
        if (results && results.length && results[0].block_time !== null)
            return Number(results[0].block_time);
        return 0;
    }

    // Max tip age for a coin, in seconds: EXPLORER_TIP_MAX_AGE_S_<COIN> if set,
    // else EXPLORER_TIP_MAX_AGE_S, else the default. An explicit 0 disables the
    // gate for that coin, the same operator escape hatch MIRROR_MAX_LAG_S has; a
    // regtest instance, where blocks are mined on demand, wants that.
    /**
     * @param {string} coin coin code, e.g. 'BTC' or 'TLTC'
     * @returns {number} max age in seconds, 0 when the gate is disabled
     */
    tipMaxAgeSeconds(coin) {
        let perCoin = parseInt(process.env['EXPLORER_TIP_MAX_AGE_S_' + String(coin).toUpperCase()], 10);
        if (Number.isFinite(perCoin) && perCoin >= 0) return perCoin;
        let global = parseInt(process.env.EXPLORER_TIP_MAX_AGE_S, 10);
        if (Number.isFinite(global) && global >= 0) return global;
        return TIP_MAX_AGE_DEFAULT_S;
    }

    // Max future skew for a coin, in seconds: EXPLORER_TIP_MAX_FUTURE_SKEW_S_<COIN>
    // if set, else EXPLORER_TIP_MAX_FUTURE_SKEW_S, else the default. An explicit 0
    // disables the future-tip check for that coin, the same escape hatch
    // EXPLORER_TIP_MAX_AGE_S has for the age check.
    /**
     * @param {string} coin coin code, e.g. 'BTC' or 'TBTC'
     * @returns {number} max future skew in seconds, 0 when the check is disabled
     */
    tipMaxFutureSkewSeconds(coin) {
        let perCoin = parseInt(process.env['EXPLORER_TIP_MAX_FUTURE_SKEW_S_' + String(coin).toUpperCase()], 10);
        if (Number.isFinite(perCoin) && perCoin >= 0) return perCoin;
        let global = parseInt(process.env.EXPLORER_TIP_MAX_FUTURE_SKEW_S, 10);
        if (Number.isFinite(global) && global >= 0) return global;
        return TIP_MAX_FUTURE_SKEW_DEFAULT_S;
    }

    // Is the newest indexed block old enough that this coin's data is not current?
    // Fails closed on a missing, zero, or unparseable block_time, which is what a
    // never-bootstrapped or unreadable replica looks like. decoder_lag_blocks
    // cannot see this: it is an intra-replica difference that reads 0 whenever the
    // indexer and decoder freeze together.
    //
    // A tip dated far AHEAD of this host also fails closed. Its age is negative,
    // which clears the age gate by a margin that grows with the skew, so an
    // unbounded future timestamp is a permanent freshness alibi for a coin that
    // has stopped advancing. Skew within tipMaxFutureSkewSeconds is tolerated
    // so ordinary clock drift and lax testnet timestamp rules do not delist a
    // healthy chain.
    /**
     * @param {string} coin coin code
     * @param {number|null} blockTimeSec unix seconds of the newest indexed block
     * @param {number} [nowSec] unix seconds to measure against, defaults to now
     * @returns {boolean}
     */
    isTipStale(coin, blockTimeSec, nowSec) {
        let maxAge = this.tipMaxAgeSeconds(coin);
        if (maxAge === 0) return false;
        let tip = Number(blockTimeSec);
        if (!Number.isFinite(tip) || tip <= 0) return true;
        let now = Number.isFinite(Number(nowSec)) ? Number(nowSec) : Math.floor(Date.now() / 1000);
        let delta = now - tip;
        if (delta < 0) {
            let maxSkew = this.tipMaxFutureSkewSeconds(coin);
            return (maxSkew !== 0) && (-delta > maxSkew);
        }
        return delta > maxAge;
    }

    // Whether a stale coin is refused (503 COIN_DATA_STALE, delisted from
    // /status `available`, WS replay/snapshot errors) rather than served with a
    // freshness marker. Off by default; see staleFailClosed for why.
    /**
     * @returns {boolean}
     */
    staleFailClosed() {
        return staleFailClosed();
    }

    // Cached per-coin freshness snapshot: the newest indexed block, how old it is
    // against this host's clock, whether that age passes the coin's stale
    // threshold, and whether the replica carries an active sync halt. This is
    // what every data response is annotated with (XChainExplorer.processRequest)
    // and what the WS serving boundaries read, so it is one cache fill per coin
    // per TIP_STALE_CACHE_TTL_MS rather than a query per request. An unreadable
    // indexer reads as stale with null tip fields: the marker exists to say this
    // instance cannot vouch for the tip, and an unreadable one is the clearest
    // case of that.
    /**
     * @param {string} coin coin code
     * @returns {Promise<{stale: boolean, tip_block: number|null, tip_time: number|null,
     *   tip_age_seconds: number|null, replica_halted: boolean|null, max_age_seconds: number}>}
     */
    async getCoinFreshness(coin) {
        if (!this._tipStaleCache) this._tipStaleCache = {};
        const cached = this._tipStaleCache[coin];
        if (cached && (Date.now() - cached.at) < TIP_STALE_CACHE_TTL_MS) return cached.snapshot;
        let snapshot = {
            stale:           this.tipMaxAgeSeconds(coin) !== 0,
            tip_block:       null,
            tip_time:        null,
            tip_age_seconds: null,
            replica_halted:  null,
            max_age_seconds: this.tipMaxAgeSeconds(coin)
        };
        try {
            let tipSec = await this.getMaxBlockTime({ coin, data: {} });
            let nowSec = Math.floor(Date.now() / 1000);
            snapshot.stale = this.isTipStale(coin, tipSec, nowSec);
            if (Number.isFinite(Number(tipSec)) && Number(tipSec) > 0) {
                snapshot.tip_time        = Number(tipSec);
                snapshot.tip_age_seconds = Math.max(0, nowSec - Number(tipSec));
            }
            snapshot.tip_block = await this.getMaxBlockIndex({ coin, data: {} });
        } catch (e) {
            // Leave the fail-closed defaults: stale unless the gate is disabled,
            // and no tip to report.
        }
        // The halt signal is only worth a query while the tip is already stale:
        // a fresh tip means the replica is applying blocks, so it cannot be
        // halted, and the banner only needs the reason once there is one.
        if (snapshot.stale) {
            try { snapshot.replica_halted = await this.getReplicaHaltStatus(coin); }
            catch (e) { snapshot.replica_halted = null; }
        } else {
            snapshot.replica_halted = false;
        }
        this._tipStaleCache[coin] = { at: Date.now(), snapshot };
        return snapshot;
    }

    // Cached tip-staleness verdict, the boolean view of getCoinFreshness. An
    // unreadable indexer counts as stale: the marker exists to say this instance
    // cannot vouch for the tip as current.
    /**
     * @param {string} coin coin code
     * @returns {Promise<boolean>}
     */
    async isCoinTipStale(coin) {
        return (await this.getCoinFreshness(coin)).stale;
    }

    // Reads whether this coin's indexer replica carries an active
    // consensus-divergence halt (xchain-sync's sync_halt table, cleared_at IS
    // NULL). Checks table existence first via information_schema, a query that
    // always succeeds (0 rows, not an error) on a deployment whose DB predates
    // the sync client, so that ordinary case never hits the failure log below.
    // Returns true (active halt), false (table read, no active halt), or null
    // (no pool, table absent, or the read failed); null is never coerced to
    // false, since /status consumers read false as healthy.
    /**
     * @param {string} coin coin code
     * @returns {Promise<boolean|null>}
     */
    async getReplicaHaltStatus(coin) {
        let config = { coin, data: {} };
        let existing;
        try {
            existing = await this.doQuery(config,
                `SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sync_halt' LIMIT 1`,
                []);
        } catch (e) {
            return null;
        }
        if (!existing || !existing.length) return null;
        try {
            let rows = await this.doQuery(config,
                `SELECT id FROM sync_halt WHERE db_type=? AND cleared_at IS NULL LIMIT 1`,
                ['indexer']);
            return !!(rows && rows.length);
        } catch (e) {
            return null;
        }
    }

    // Get the decoder-tip reference for a coin: the highest block the decoder has
    // *processed* for it. The explorer reads the indexer DB, whose MAX(block_index)
    // is the indexer's own position; the decoder DB's MAX(block_index) is the
    // decoder's position. Comparing the two yields the indexer->decoder lag, which
    // is what lets /api/status distinguish a stalled indexer from a healthy one.
    // NOTE: this is NOT the coin node's chain tip; the explorer never talks to a
    // coin node, so a decoder lagging the chain node is invisible here; that gap is
    // surfaced by the decoder's own health() JSON-RPC. Reuses the indexer connection
    // pool via a database-qualified query (the decoder DB is on the same server) and
    // returns null when the decoder DB name is unknown or the query fails, so status
    // degrades to "no tip" rather than erroring.
    async getDecoderTip(config) {
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return null;
        // dbName originates from hub/explorer config, not client input, but it is
        // interpolated into the query (database identifiers can't be bound), so
        // restrict it to a safe identifier charset before use.
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return null;
        try {
            let query   = 'SELECT MAX(block_index) as max_index FROM `' + dbName + '`.blocks';
            let results = await this.doDecoderQuery(config, query, []);
            if (results && results.length && results[0].max_index !== null)
                return Number(results[0].max_index);
        } catch(e){
            // Decoder DB unreachable, missing, or no cross-DB grant: omit the tip.
            console.warn('getDecoderTip: decoder tip unavailable for ' + config.coin + ': ' + (e && e.message ? e.message : e));
        }
        return null;
    }

    // Read the decoder's recorded block_time for ONE height. Exists to answer a
    // question tip_future_seconds structurally cannot: that field is derived from
    // the newest block the indexer has already COMMITTED, which is by definition
    // past-dated, so it reads 0 during the exact condition it looks like it would
    // reveal. The block that decides whether the indexer is waiting or wedged is
    // the NEXT one (last_block + 1), which only the decoder DB has, because the
    // indexer has not committed it yet. Same degradation contract as
    // getDecoderTip: null when the DB name is unknown, unsafe, or the read fails.
    async getDecoderBlockTime(config, height) {
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return null;
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return null;
        if(!Number.isFinite(Number(height))) return null;
        try {
            let query   = 'SELECT block_time FROM `' + dbName + '`.blocks WHERE block_index = ? LIMIT 1';
            let results = await this.doDecoderQuery(config, query, [Number(height)]);
            if (results && results.length && results[0].block_time !== null)
                return Number(results[0].block_time);
        } catch(e){
            console.warn('getDecoderBlockTime: decoder block_time unavailable for ' + config.coin + ' at ' + height + ': ' + (e && e.message ? e.message : e));
        }
        return null;
    }

    // Split a route code (TBTC / RDOGE / BTC) into { coin, network } using the
    // loaded config's COIN_PREFIXES/COIN_NETWORKS. Returns null when the code
    // doesn't parse (config momentarily unavailable, or an unknown base coin).
    async _parseCoinCode(code){
        try {
            let full     = await this.configInfo.getConfig();
            let networks = full['COIN_NETWORKS'] || {};
            let prefixes = full['COIN_PREFIXES'] || { mainnet: '', testnet: 'T', regtest: 'R' };
            let upper    = String(code || '').toUpperCase();
            // Non-empty prefixes (T/R) first so 'TBTC' isn't read as a mainnet
            // coin named 'TBTC' (same rule as getStatus's parseCode).
            for(let network in prefixes){
                let p = prefixes[network];
                if(p && upper.startsWith(p)){
                    let base = upper.slice(p.length);
                    if(networks[base]) return { coin: base, network };
                }
            }
            if(networks[upper]) return { coin: upper, network: 'mainnet' };
        } catch(e){ /* fall through to null */ }
        return null;
    }

    // Live mempool snapshot over the decoder's JSON-RPC API (getmempool), the
    // ONLY live-mempool path for an explorer serving from synced replicas:
    // mempool_transactions is deliberately excluded from xchain-sync replication
    // (node-local, non-deterministic), so on a replica deployment the colocated
    // decoder-DB reads below see a permanently empty table. When a decoder API
    // endpoint resolves for the coin (DECODER_API_URL_<COIN>_<NETWORK> >
    // config-derived decoderApiUrl > DECODER_API_URL, same chain as /status's
    // decoder_health), this snapshot is preferred by the mempool readers; a
    // deployment with no endpoint (e.g. a single-box regtest stack whose decoder
    // DB is truly colocated) falls back to the direct DB path unchanged.
    // Cached per coin for MEMPOOL_COUNT_CACHE_MS (default 15s), stale-served on
    // fetch failure for one extra TTL so one decoder hiccup doesn't blank the
    // homepage counter. Returns { node_tx_count, total, rows } or null when
    // unconfigured/unreachable with nothing cached.
    async _getDecoderMempoolSnapshot(config){
        const code = config.coin;
        const ttl  = parseInt(process.env.MEMPOOL_COUNT_CACHE_MS, 10) || 15000;
        const now  = Date.now();
        this._mempoolApiCache = this._mempoolApiCache || {};
        const hit = this._mempoolApiCache[code];
        if(hit && (now - hit.t) < ttl) return hit.v;
        let parsed = await this._parseCoinCode(code);
        let url    = DecoderConnector.resolveDecoderUrl(
                        parsed ? parsed.coin    : null,
                        parsed ? parsed.network : null,
                        (this.decoderApiUrl || {})[code] || null);
        if(!url) return null;
        try {
            let r = await new DecoderConnector(url).getmempool(500);
            let v = (r && Array.isArray(r.rows)) ? {
                node_tx_count: (typeof r.node_tx_count === 'number' && r.node_tx_count >= 0) ? r.node_tx_count : null,
                total:         Number(r.total) || 0,
                rows:          r.rows
            } : null;
            this._mempoolApiCache[code] = { t: now, v };
            return v;
        } catch(e){
            console.warn('_getDecoderMempoolSnapshot: decoder mempool unavailable for ' + code + ': ' + (e && e.message ? e.message : e));
            // Serve the stale snapshot once more; refresh the clock so a dead
            // decoder is retried once per TTL, not on every request.
            this._mempoolApiCache[code] = { t: now, v: (hit && hit.v) || null };
            return (hit && hit.v) || null;
        }
    }

    // The coin node's TOTAL mempool tx count (XChain-carrying or not), from the
    // decoder API snapshot. null when no decoder API is configured/reachable or
    // the decoder hasn't completed a mempool poll yet: the DB paths below cannot
    // know this number (the decoder DB only holds the XChain-carrying subset),
    // so there is deliberately no fallback and callers render null as absent.
    async getNodeMempoolCount(config){
        let snap = await this._getDecoderMempoolSnapshot(config);
        return (snap && typeof snap.node_tx_count === 'number') ? snap.node_tx_count : null;
    }

    // Count of unconfirmed (mempool) transactions for this coin: the decoder
    // API snapshot when one resolves (see _getDecoderMempoolSnapshot), else the
    // decoder DB's mempool_transactions table. Same access pattern + safety as
    // getDecoderTip (DB-qualified query on the indexer pool; only works when the
    // decoder DB shares the indexer's server/credentials). Returns 0 when the
    // decoder DB isn't reachable so callers always get a usable number.
    // Cached per coin for MEMPOOL_COUNT_CACHE_MS (default 15s, same pattern as
    // getFeeEstimate's _feeCache): the count backs the unauthenticated coin
    // homepage / network stats, and an uncached COUNT(*) on a busy mempool table
    // is a full-scan the public read path can be made to repeat on every hit.
    // A stale prior value is served when the query fails mid-flight.
    async getDecoderMempoolCount(config) {
        let snap = await this._getDecoderMempoolSnapshot(config);
        if(snap) return snap.total;
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return 0;
        // dbName is config-derived, not client input, but database identifiers
        // can't be bound; restrict to a safe identifier charset before use.
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return 0;
        const ttl = parseInt(process.env.MEMPOOL_COUNT_CACHE_MS, 10) || 15000;
        const now = Date.now();
        this._mempoolCountCache = this._mempoolCountCache || {};
        const hit = this._mempoolCountCache[config.coin];
        if(hit && (now - hit.t) < ttl) return hit.v;
        try {
            // Action-carrying rows only. mempool_transactions holds a row for
            // EVERY mempool tx the decoder saw, with `data` blanked to '' when
            // the tx carried no valid ACTION (nearly all of them on a public
            // chain), so a bare COUNT(*) publishes the node's whole mempool as
            // the XChain unconfirmed count. Matches what the feed renders,
            // since decodeMempoolRow drops the same rows.
            let query   = 'SELECT COUNT(*) as count FROM `' + dbName + '`.mempool_transactions' +
                          " WHERE data IS NOT NULL AND data != ''";
            let results = await this.doDecoderQuery(config, query, []);
            if (results && results.length && results[0].count !== null){
                const v = Number(results[0].count);
                this._mempoolCountCache[config.coin] = { t: now, v };
                return v;
            }
        } catch(e){
            // Decoder DB unreachable, missing table, or no cross-DB grant: serve the
            // last good count if we have one, else report 0.
            console.warn('getDecoderMempoolCount: mempool count unavailable for ' + config.coin + ': ' + (e && e.message ? e.message : e));
        }
        return (hit && hit.v) || 0;
    }

    // Raw unconfirmed (mempool) action rows from the decoder DB. As of the
    // 2026-06-15 mempool-raw-strings migration, mempool_transactions stores the
    // tx hash and source address as raw string columns (tx_hash, source) rather
    // than FK ids into the decoder's index tables, so the row reads directly with
    // no joins. Rows are PRE-VALIDATION: the decoder writes whatever parses out of
    // a mempool tx; the indexer may still reject it at confirmation time.
    // mempool_transactions DOES declare a `destination` column (indexed as
    // mempool_destination) and the decoder binds it on every insert, but the
    // bound value is always NULL: XChainDecoder.parseTransaction's only success
    // return hardcodes destination:null. Destinations live inside the decoded
    // action string (`data`), which callers parse. Do NOT move getMempool's
    // type=address filter onto that index: it would match zero rows. Same
    // access pattern + safety rules as getDecoderMempoolCount. Returns [] when
    // the decoder DB isn't reachable.
    //
    // ENCODING: mempool_transactions.data is a MEDIUMTEXT utf8mb4 column holding
    // the canonical UTF-8 ACTION string ("SEND|0|TICK|..."), the exact same
    // representation the decoder's confirmed-block path writes to
    // transactions.data. It is NOT hex. The decoder pins that contract in
    // test/unit/mempoolPayloadRepresentation.test.js (uuid:26220713); this read
    // and decodeMempoolRow below are the other half of it.
    async getDecoderMempoolRows(config, limit) {
        let max = Math.max(1, Math.min(Number(limit) || 200, 500));
        // Live path first: the decoder API snapshot (see _getDecoderMempoolSnapshot).
        // Its rows carry the same tx_hash/source/data shape this method's DB path
        // returns, plus first_seen (unix seconds, from the decoder's own table).
        let snap = await this._getDecoderMempoolSnapshot(config);
        if(snap) return snap.rows.slice(0, max);
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return [];
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return [];
        try {
            // ORDER BY the unique-indexed tx_hash: the table has no primary key
            // and the decoder rewrites it every cycle, so a bare LIMIT returns a
            // scan-order subset that churns between polls. The ws mempool diff
            // and /api/mempool paging both read this window as a stable snapshot.
            // first_seen: UNIX_TIMESTAMP so both paths hand callers the same
            // integer-seconds representation the decoder API serves.
            // Action-carrying rows only (same filter + rationale as
            // getDecoderMempoolCount): an unfiltered window fills all 500 slots
            // with actionless rows on a busy chain and renders an empty feed
            // while real pending actions sit deeper in the table.
            let query = 'SELECT m.tx_hash AS tx_hash, m.source AS source, m.data AS data, ' +
                        'UNIX_TIMESTAMP(m.first_seen) AS first_seen ' +
                        'FROM `' + dbName + '`.mempool_transactions m ' +
                        "WHERE m.data IS NOT NULL AND m.data != '' " +
                        'ORDER BY m.tx_hash ' +
                        'LIMIT ' + max;
            let results = await this.doDecoderQuery(config, query, []);
            return results || [];
        } catch(e){
            // errno 1054: a decoder DB from before the 2026-08-22-mempool-first-seen
            // migration has no first_seen column. Retry without it (Time renders
            // as absent) instead of blanking the whole feed until the decoder
            // restarts and auto-applies its migration. doQuery wraps the driver
            // error in DbQueryError with the original on `cause`, so check both.
            let errno = (e && e.errno) || (e && e.cause && e.cause.errno);
            if(errno == 1054){
                try {
                    let query = 'SELECT m.tx_hash AS tx_hash, m.source AS source, m.data AS data ' +
                                'FROM `' + dbName + '`.mempool_transactions m ' +
                                "WHERE m.data IS NOT NULL AND m.data != '' " +
                                'ORDER BY m.tx_hash ' +
                                'LIMIT ' + max;
                    let results = await this.doDecoderQuery(config, query, []);
                    return results || [];
                } catch(e2){
                    console.warn('getDecoderMempoolRows: mempool rows unavailable for ' + config.coin + ': ' + (e2 && e2.message ? e2.message : e2));
                    return [];
                }
            }
            console.warn('getDecoderMempoolRows: mempool rows unavailable for ' + config.coin + ': ' + (e && e.message ? e.message : e));
        }
        return [];
    }

    // Split one decoder mempool row's action string into its parts. The column
    // already holds the canonical UTF-8 ACTION string (see the encoding note on
    // getDecoderMempoolRows), so there is nothing to decode: the wire layout is
    // pipe-joined with the action name first (e.g.
    // SEND|0|TICK|AMOUNT|DESTINATION|MEMO). Returns null on garbage, which also
    // covers the decoder's rejected-ACTION sentinel (an empty string written for
    // a money-bearing tx whose ACTION was invalid or unknown) and any legacy
    // hex-encoded row left behind by an older decoder: neither yields a
    // valid leading action name, so both drop out of the feed rather than
    // rendering as mojibake.
    decodeMempoolRow(row) {
        try {
            if(!row || this.util.isNull(row.data)) return null;
            // Buffer only if a driver hands back the TEXT column as binary.
            let text = Buffer.isBuffer(row.data) ? row.data.toString('utf8') : String(row.data);
            if(!text.length) return null;
            let segments = text.split('|');
            let action = String(segments[0] || '').trim().toUpperCase();
            if(!/^[A-Z_]{2,32}$/.test(action)) return null;
            return {
                tx_hash: row.tx_hash || null,
                source:  row.source || null,
                action:  action,
                data:    text,
                // Unix seconds when the decoder first observed the tx in its
                // node's mempool; null against a pre-first_seen decoder DB.
                first_seen: this.util.isNumeric(row.first_seen) ? Number(row.first_seen) : null
            };
        } catch(e){
            return null;
        }
    }

    // Split a decoded mempool row's action string into its pipe-joined segments.
    // Deliberately layout-free: the field map differs per action family and only
    // SEND has a documented one, so every consumer scans segments instead of
    // reading positions. Returns [] for a row with no action string (the
    // ChangeDetector's removal path carries `data: null` for a row that never
    // decoded), so callers never have to null-check first.
    mempoolSegments(decoded) {
        if(!decoded || this.util.isNull(decoded.data)) return [];
        let text = Buffer.isBuffer(decoded.data) ? decoded.data.toString('utf8') : String(decoded.data);
        return text.split('|');
    }

    // Does this decoded mempool row involve `address`? THE one matcher for
    // "who does this unconfirmed tx affect", shared by the REST prefilter
    // (getMempool TYPE=address) and the WS fan-out (Broadcaster mempool
    // frames). Sharing it is the point: the poll and the live event must never
    // disagree about the parties to a tx, or a wallet sees a pending row that
    // no event ever removes (or the reverse).
    //
    // `addressId` is the address's index id from the cached BYTE-EXACT resolver
    // (getExactAddressId), or null when it has none. Byte-exact is a correctness
    // requirement of this matcher and not a style choice: the ci resolver would
    // hand a case variant the id of the address it resembles, and the `^<id>`
    // branch below would then name it a party to a transaction it has no part in.
    // It is what makes a compacted destination match:
    // the SDK writes destinations as `^<id>` references by default
    // (addressResolver), so without this branch an incoming pending payment to
    // an address that already holds an index id is invisible on both surfaces. Resolution
    // is FORWARD (address -> id) on purpose; no id -> address lookup exists in
    // the explorer and none is needed, since both call sites hold the address.
    //
    // Known false-positive class, accepted: a non-destination segment (a memo)
    // whose text equals the address matches. See the accepted-limitations note
    // in the /api/mempool endpoint header.
    mempoolRowMatchesAddress(decoded, address, addressId) {
        if(!decoded || this.util.isNull(address)) return false;
        let search = String(address);
        if(!search.length) return false;
        if(decoded.source === search) return true;
        let segments = this.mempoolSegments(decoded);
        if(segments.includes(search)) return true;
        if(this.util.isNull(addressId)) return false;
        return segments.includes('^' + String(addressId));
    }

    // Suggested fee tiers (sat/vByte) for this coin, fetched from its encoder's
    // `estimatefee` JSON-RPC method (which reads the node's estimatesmartfee).
    // The explorer is DB-only and can't reach a node, so it asks the encoder.
    // Endpoint comes from ENCODER_URL (e.g. https://encoder.xchain.io); the coin
    // path is appended (.../{COIN}/). Result is cached per coin for FEE_CACHE_MS
    // (default 60s) so the coin homepage doesn't trigger a node RPC on every hit.
    // Returns a conservative {low:1,medium:2,high:3} fallback when no encoder is
    // configured or it's unreachable.
    async getFeeEstimate(config) {
        const fallback = { low: 1, medium: 2, high: 3 };
        const base = process.env.ENCODER_URL;
        if(!base) return fallback;
        const code = config.coin;
        const ttl  = parseInt(process.env.FEE_CACHE_MS, 10) || 60000;
        const now  = Date.now();
        this._feeCache = this._feeCache || {};
        const hit = this._feeCache[code];
        if(hit && (now - hit.t) < ttl) return hit.v;
        try {
            const url = base.replace(/\/+$/, '') + '/' + encodeURIComponent(code) + '/';
            const res = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ jsonrpc: '2.0', method: 'estimate_fee', id: 1 }),
                signal:  AbortSignal.timeout(6000)
            });
            if(!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json();
            const f = j && j.result;
            if(f && f.low != null && f.medium != null && f.high != null){
                const v = { low: Number(f.low), medium: Number(f.medium), high: Number(f.high) };
                this._feeCache[code] = { t: now, v };
                return v;
            }
            throw new Error('malformed estimatefee response');
        } catch(e){
            console.warn('getFeeEstimate: fee estimate unavailable for ' + code + ': ' + (e && e.message ? e.message : e));
            // Reuse a prior good value if we have one; otherwise the safe fallback.
            return (hit && hit.v) || fallback;
        }
    }

    // Live USD price for this coin, fetched from the xchain-hub price oracle
    // (its finalized price_snapshots, via the public `getprice` JSON-RPC). The
    // explorer has no market feed of its own. Endpoint comes from HUB_URL
    // (e.g. http://127.0.0.1:10000). Cached per base coin for PRICE_CACHE_MS
    // (default 60s) so the coin homepage doesn't hit the hub on every request.
    // Mirrors getFeeEstimate(). Only mainnet BTC/LTC/DOGE have an oracle market;
    // testnet/regtest route codes (TBTC, RDOGE, …) have no market, so this returns
    // null and getNetwork keeps the $0.00 placeholder. Returns a price string
    // (8-decimal, as published) or null.
    async getCoinPriceUsd(config) {
        const hubUrl = process.env.HUB_URL;
        if(!hubUrl) return null;
        // Resolve the base mainnet symbol. The oracle only prices the real asset,
        // so a request is eligible only when its route code IS the base symbol
        // (mainnet): 'BTC' === 'BTC'. Testnet/regtest codes ('TBTC','RDOGE') differ.
        let code = String(config.coin);
        let sym = null;
        try {
            const full  = await this.configInfo.getConfig();
            const bases = Object.keys(full['COIN_NETWORKS'] || {});   // ['BTC','LTC','DOGE']
            const b     = bases.find(c => code.endsWith(c));
            if(b && code === b) sym = b;
        } catch(e){ return null; }
        if(!sym) return null;

        const ttl = parseInt(process.env.PRICE_CACHE_MS, 10) || 60000;
        const now = Date.now();
        this._priceCache = this._priceCache || {};
        const hit = this._priceCache[sym];
        if(hit && (now - hit.t) < ttl) return hit.v;
        try {
            const url = hubUrl.replace(/\/+$/, '') + '/';
            const res = await fetch(url, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ jsonrpc: '2.0', method: 'getprice', params: { coin_pair: sym + '/USD' }, id: 1 }),
                signal:  AbortSignal.timeout(6000)
            });
            if(!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json();
            const r = j && j.result;
            if(r && !r.error && r.price != null){
                const p = Number(r.price);
                if(Number.isFinite(p) && p > 0){
                    const v = String(r.price);
                    this._priceCache[sym] = { t: now, v };
                    this._priceStaleSince = this._priceStaleSince || {};
                    delete this._priceStaleSince[sym];
                    return v;
                }
            }
            // The hub answers a well-formed verdict when it refuses to quote: a
            // stale snapshot (its reference block aged past the oracle bound, which
            // a long Bitcoin block gap does routinely) or no finalized round at all.
            // Surface that verdict as the hub wrote it; "malformed" is reserved for
            // a body the parser genuinely cannot read.
            if(r && typeof r.error === 'string' && r.error){
                if(/\bstale\b/i.test(r.error)){
                    // Expected between rounds during a long block gap, and the last
                    // good value keeps serving, so log the transition once rather
                    // than every cache expiry until the next round finalizes.
                    this._priceStaleSince = this._priceStaleSince || {};
                    if(!this._priceStaleSince[sym]){
                        this._priceStaleSince[sym] = now;
                        console.log('getCoinPriceUsd: hub declines to quote ' + sym + ' (' + r.error + '); serving the last finalized value until the next round');
                    }
                    return (hit && hit.v) || null;
                }
                throw new Error('hub: ' + r.error);
            }
            throw new Error('malformed getprice response');
        } catch(e){
            console.warn('getCoinPriceUsd: price unavailable for ' + sym + ': ' + (e && e.message ? e.message : e));
            // Reuse a prior good value if we have one; otherwise null (placeholder).
            return (hit && hit.v) || null;
        }
    }

    // Returns the action-index high-water mark as an exact BigInt, never a Number.
    // This value is the WebSocket live/catch-up cursor, and Number() collapses two
    // consecutive action indices above 2^53 onto one value, which stalls or skips a
    // NEW_ACTION frame even though the wire serializer emits exact decimal strings.
    // Callers that put it on the wire still String() it; the WS frames
    // are decimal strings under schema v2 (ws/serialize.js).
    async getMaxActionIndex(config) {
        let query   = `SELECT MAX(action_index) as max_index FROM actions`;
        let results = await this.doQuery(config, query, []);
        if (results && results.length && results[0].max_index !== null)
            return BigInt(results[0].max_index);
        return 0n;
    }

    /******************************************************************
     * Project Registry queries (protocol/Project_Registry.md)
     *
     * A project's current roster is the TICK-type LIST referenced by
     * the most recent valid LINK targeting one of the project tick's
     * valid ISSUE actions, with BOTH sides on the local chain (LINK
     * skips owner validation when COIN2 is remote, so cross-chain
     * roster links carry no authority). Authority comes from LINK's
     * owner validation at processing time; display only needs
     * status='valid' rows.
     ******************************************************************/

    // Resolve a project tick's current roster. Returns
    // { roster_action_index, membership_action_index, link_action_index, total }
    // or null when the tick has never had an owner-valid roster link.
    //
    // roster_action_index is what the LINK pinned (the list's identity, and the
    // index the UI links to); membership_action_index is the action whose
    // list_items rows are the roster's CURRENT membership. Those differ once the
    // list has been edited, because a LIST edit writes the resulting membership
    // under the EDIT's own action_index and never touches the parent's rows.
    // Every roster consumer below reads members through the membership
    // index, so a project that dropped or added a token shows the roster the
    // chain is enforcing rather than the one it shipped with. Flag-day gated at
    // the tip by _isListEditResolutionActiveAtTip, so below the height the two
    // indexes are equal and the legacy create-index read runs unchanged.
    async getProjectRosterInfo(config, tick){
        let chain = this.baseCoin ? this.baseCoin[config.coin] : null;
        if(this.util.isNull(chain) || this.util.isNull(tick)) return null;
        let query = `SELECT
                        l.action_index       AS link_action_index,
                        l.coin1_action_index AS roster_action_index
                    FROM
                        links l
                        INNER JOIN index_statuses s1 ON (s1.id=l.status_id AND s1.status='valid')
                        INNER JOIN index_coins    c1 ON (c1.id=l.coin1_id AND c1.coin=?)
                        INNER JOIN index_coins    c2 ON (c2.id=l.coin2_id AND c2.coin=?)
                        INNER JOIN issues         i1 ON (i1.action_index=l.coin2_action_index)
                        INNER JOIN index_statuses s2 ON (s2.id=i1.status_id AND s2.status='valid')
                        INNER JOIN index_tickers  t1 ON (t1.id=i1.tick_id AND t1.tick=?)
                        INNER JOIN lists          ls ON (ls.action_index=l.coin1_action_index AND ls.type='1')
                        INNER JOIN index_statuses s3 ON (s3.id=ls.status_id AND s3.status='valid')
                    ORDER BY l.action_index DESC
                    LIMIT 1`;
        let rows = await this.doQuery(config, query, [chain, chain, tick]);
        if(!rows || !rows.length) return null;
        let info = {
            roster_action_index:     Number(rows[0].roster_action_index),
            membership_action_index: Number(rows[0].roster_action_index),
            link_action_index:       Number(rows[0].link_action_index),
            total: 0
        };
        if(await this._isListEditResolutionActiveAtTip(config))
            info.membership_action_index = Number(await this.getListHeadIndex(config, info.roster_action_index));
        let count = await this.doQuery(config, `SELECT count(*) AS total FROM list_items WHERE action_index=?`, [info.membership_action_index]);
        if(count && count.length)
            info.total = Number(count[0].total);
        return info;
    }

    // Projects whose CURRENT roster includes the given tick (the reverse
    // lookup behind the token-page "Official: part of X" banner). A project
    // whose latest roster dropped the tick does not match - which, once
    // edit resolution is live, includes a roster that dropped it by LIST
    // EDIT and not only one replaced by a newer LINK. The edit's membership
    // lives under the EDIT's action_index, so the membership join has to run
    // against each project's resolved chain head, not the index the LINK pinned.
    //
    // That head is per-project, so the membership filter moves out of SQL: the
    // candidate query returns one row per project (exactly the row count the old
    // inner GROUP BY already produced), heads resolve for the whole set in a
    // bounded number of queries, and one final query asks which of those heads
    // list the tick. Below the flag day the original single-query form runs
    // unchanged, because consensus is still reading the pinned create's rows.
    async getTokenProjects(config, tick){
        let chain = this.baseCoin ? this.baseCoin[config.coin] : null;
        if(this.util.isNull(chain) || this.util.isNull(tick)) return [];
        // Latest owner-valid roster LINK per project, newest link first.
        let latestRosterLinks = `FROM (
                        SELECT
                            i1.tick_id,
                            MAX(l.action_index) AS link_action_index
                        FROM
                            links l
                            INNER JOIN index_statuses s1 ON (s1.id=l.status_id AND s1.status='valid')
                            INNER JOIN index_coins    c1 ON (c1.id=l.coin1_id AND c1.coin=?)
                            INNER JOIN index_coins    c2 ON (c2.id=l.coin2_id AND c2.coin=?)
                            INNER JOIN issues         i1 ON (i1.action_index=l.coin2_action_index)
                            INNER JOIN index_statuses s2 ON (s2.id=i1.status_id AND s2.status='valid')
                            INNER JOIN lists          ls ON (ls.action_index=l.coin1_action_index AND ls.type='1')
                            INNER JOIN index_statuses s3 ON (s3.id=ls.status_id AND s3.status='valid')
                        GROUP BY i1.tick_id
                    ) latest
                        INNER JOIN links          lk ON (lk.action_index=latest.link_action_index)`;
        let select = `SELECT
                        t1.tick                AS project,
                        latest.link_action_index,
                        lk.coin1_action_index  AS roster_action_index
                    `;
        if(!(await this._isListEditResolutionActiveAtTip(config))){
            let query = select + latestRosterLinks + `
                        INNER JOIN list_items     li ON (li.action_index=lk.coin1_action_index)
                        INNER JOIN index_tickers  t2 ON (t2.id=li.item_id AND t2.tick=?)
                        INNER JOIN index_tickers  t1 ON (t1.id=latest.tick_id)
                    ORDER BY latest.link_action_index DESC`;
            let rows = await this.doQuery(config, query, [chain, chain, tick]);
            if(!rows || !rows.length) return [];
            return rows.map(r => ({
                project:                 r.project,
                link_action_index:       Number(r.link_action_index),
                roster_action_index:     Number(r.roster_action_index),
                membership_action_index: Number(r.roster_action_index)
            }));
        }
        let candidates = await this.doQuery(config, select + latestRosterLinks + `
                        INNER JOIN index_tickers  t1 ON (t1.id=latest.tick_id)
                    ORDER BY latest.link_action_index DESC`, [chain, chain]);
        if(!candidates || !candidates.length) return [];
        let heads   = await this.getListHeadIndexes(config, candidates.map(r => Number(r.roster_action_index)));
        let rosters = candidates.map(r => ({
            project:                 r.project,
            link_action_index:       Number(r.link_action_index),
            roster_action_index:     Number(r.roster_action_index),
            membership_action_index: Number(heads[String(Number(r.roster_action_index))])
        }));
        let indexes = [...new Set(rosters.map(r => r.membership_action_index))];
        let members = await this.doQuery(config, `SELECT
                        li.action_index
                    FROM
                        list_items    li
                        INNER JOIN index_tickers t2 ON (t2.id=li.item_id AND t2.tick=?)
                    WHERE
                        li.action_index IN (` + indexes.map(() => '?').join(',') + `)
                    GROUP BY li.action_index`, [tick, ...indexes]);
        let listing = {};
        for(let row of (members || [])) listing[String(Number(row['action_index']))] = true;
        return rosters.filter(r => listing[String(r.membership_action_index)] === true);
    }

    /******************************************************************
     * Controller bindings (protocol/Controller_Bound_Tokens.md)
     *
     * token_controllers / address_controllers are append-only bind/unbind
     * event logs. The effective (still-gating) controller for a
     * (subject, action_class) is the latest event by action_index, with a
     * read-time cooldown: a `bind` always gates; an `unbind` gates only while
     * the chain tip is below its cooldown_end_block. This mirrors the indexer's
     * readEffectiveControllerMap / controllerEventIfGating (xchain-indexer
     * src/db.js) so the explorer surfaces exactly what consensus enforces.
     ******************************************************************/

    // Reduce an append-only controller event log (token_controllers /
    // address_controllers) to the array of bindings that are still gating at the
    // chain tip. keyColumn is tick_id / address_id. Returns the shared shape:
    // [{ action_class, contract_index, cooldown_blocks, is_unbind, bind_block, bound_by }].
    async _resolveControllerBindings(config, table, keyColumn, keyValue){
        if(this.util.isNull(keyValue)) return [];
        // token_controllers carries bound_by_id (the token owner who signed the event);
        // address_controllers has no such column so bound_by is NULL for address-scoped bindings.
        let boundBySelect = (table === 'token_controllers')
            ? `,\n                        signer.address AS bound_by`
            : `,\n                        NULL AS bound_by`;
        let boundByJoin = (table === 'token_controllers')
            ? `\n                    LEFT JOIN index_addresses signer ON (signer.id=c.bound_by_id)`
            : '';
        let query = `SELECT
                        c.action_class,
                        c.action_index,
                        c.contract_index,
                        c.is_unbind,
                        c.cooldown_blocks,
                        c.cooldown_end_block,
                        c.block_index` + boundBySelect + `
                    FROM ${table} c` + boundByJoin + `
                    WHERE c.${keyColumn}=?
                    ORDER BY c.action_index ASC`;
        let rows = await this.doQuery(config, query, [keyValue]);
        if(!rows || !rows.length) return [];
        // Latest event per action_class wins (rows are action_index ASC, so the
        // last seen for each class is the highest action_index).
        let latest = new Map();
        for(let row of rows)
            latest.set(row.action_class, row);
        // Read-time cooldown: resolve the chain tip once and gate each unbind.
        let tip = await this.getMaxBlockIndex(config);
        let bindings = [];
        for(let [, row] of latest){
            // controllerEventIfGating: a bind always gates; an unbind gates only
            // while tip < cooldown_end_block (and never when it's NULL).
            if(Number(row.is_unbind) === 1){
                if(this.util.isNull(row.cooldown_end_block)) continue;
                if(Number(tip) >= Number(row.cooldown_end_block)) continue;
            }
            bindings.push({
                action_class:   row.action_class,
                contract_index: Number(row.contract_index),
                cooldown_blocks: Number(row.cooldown_blocks),
                is_unbind:      Number(row.is_unbind),
                bind_block:     Number(row.block_index),
                bound_by:       row.bound_by || null
            });
        }
        return bindings;
    }

    // Controller bindings still gating a token (token-page display surface).
    async getTokenControllerBindings(config, tick){
        let tick_id = await this.getTickId(config, tick);
        return this._resolveControllerBindings(config, 'token_controllers', 'tick_id', tick_id);
    }

    // Controller bindings still gating an address (address-page display surface).
    async getAddressControllerBindings(config, address){
        let address_id = await this.getAddressId(config, address);
        return this._resolveControllerBindings(config, 'address_controllers', 'address_id', address_id);
    }

    // Project detail (API endpoint): project tick + roster metadata + member
    // tokens. Members are capped at 1000 per response; `total` always carries
    // the full roster size.
    async getProject(config){
        let tick = config.data.search;
        let info = await this.getProjectRosterInfo(config, tick);
        if(!info) return [null];
        let query = `SELECT
                        t3.tick,
                        m.supply,
                        m.max_supply,
                        m.decimals,
                        m.lock_max_supply
                    FROM
                        list_items li
                        INNER JOIN tokens        m  ON (m.tick_id=li.item_id)
                        INNER JOIN index_tickers t3 ON (t3.id=m.tick_id)
                    WHERE
                        li.action_index=?
                    ORDER BY t3.tick ASC
                    LIMIT 1000`;
        let rows = await this.doQuery(config, query, [info.membership_action_index]);
        let data = {
            // Echo the tick exactly as it was looked up. Uppercasing it here while the
            // lookup stays case-sensitive means the value handed back does not resolve:
            // feed it into /api/project/{TICK} for any tick that is not already all
            // upper case and the round trip 404s. The roster and /explorer routes were
            // never affected, because neither echoes the tick.
            tick:                    String(tick),
            roster_action_index:     info.roster_action_index,
            membership_action_index: info.membership_action_index,
            link_action_index:       info.link_action_index,
            total:                   info.total,
            members:                 []
        };
        if(rows && rows.length){
            data.members = rows.map(r => ({
                tick:            r.tick,
                supply:          r.supply,
                max_supply:      r.max_supply,
                decimals:        Number(r.decimals),
                lock_max_supply: Number(r.lock_max_supply)
            }));
        }
        return [data];
    }

    // SQL-builder for the explorer roster datatable (token-page "Official
    // Tokens" tab): member tokens of the project's current roster, shaped
    // exactly like getTokens rows.
    async getProjectTokens(config){
        let sql  = config.data.sql;
        let info = await this.getProjectRosterInfo(config, config.data.search);
        // No roster → empty datatable (object query short-circuits getData)
        if(!info) return [[], [], 0];
        let args  = [info.membership_action_index];
        let count = `SELECT
                        count(*) as total
                    FROM
                        tokens m
                        INNER JOIN list_items         li ON (li.item_id=m.tick_id AND li.action_index=?)
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        t3.tick,
                        m.supply,
                        m.max_supply,
                        m.max_mint,
                        m.decimals,
                        m.lock_max_supply,
                        m.lock_mint,
                        m.lock_mint_supply,
                        m.lock_max_mint,
                        m.lock_description,
                        m.lock_sleep,
                        m.lock_callback,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index
                    FROM
                        tokens m
                        INNER JOIN list_items         li ON (li.item_id=m.tick_id AND li.action_index=?)
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY t3.tick ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Fill `destinations: string[]` on every row of a getActionsSince batch, in
    // place. Backs NEW_ACTION's additive destinations field (spec M1.4): the feed
    // has never selected a destination column, so the Broadcaster's destination
    // routing branch has been permanently inert and the wallet's incoming-receipt
    // notification has never fired for anyone.
    //
    // SHAPE: ONE round trip for the whole batch, a UNION ALL over the eight
    // destination-bearing families (ACTION_DESTINATION_FAMILIES) filtered by the
    // action_index values ACTUALLY FETCHED. This feed drives the 5s ChangeDetector
    // poll, so a per-row lookup would cost up to `limit` (100) round trips every
    // five seconds per coin; a per-family lookup would cost eight. The IN list is
    // built from the fetched rows rather than from the cursor range, so a catch-up
    // burst binds exactly as many parameters as it has actions (<= limit * 8), and
    // an EMPTY batch issues no query at all.
    //
    // FAILURE MODE, deliberately soft: a failed lookup degrades every row to
    // `destinations: []` and the actions still ship. There is scar tissue here. A
    // prior `s1.id=a1.status_id` join against a column that does not exist threw
    // ER_BAD_FIELD_ERROR and SILENTLY killed the entire WebSocket action feed,
    // because getActionsSince returned [] every poll while the detector's cursor
    // kept advancing past the actions nobody ever saw (see the note on the query
    // above). An enrichment must never be able to do that again: destinations are a
    // nice-to-have on a frame whose delivery is not.
    //
    // Every row is given the key unconditionally and up front, so a subscriber
    // never has to tell "no destinations" from "the lookup failed" from "the field
    // is missing": all three are `[]`.
    async _attachActionDestinations(config, rows){
        let indexes = [];
        for(let row of rows){
            row.destinations = [];
            if(!this.util.isNull(row.action_index)) indexes.push(row.action_index);
        }
        if(!indexes.length) return rows;

        let map = await this._getActionDestinationMap(config, indexes);
        for(let row of rows){
            let list = map.get(String(row.action_index));
            if(list) row.destinations = list;
        }
        return rows;
    }

    // action_index (as a decimal string) -> ordered, DEDUPED list of destination
    // addresses, for the given batch of action indexes. Returns an EMPTY map, never
    // throws: every caller treats "no destinations" and "lookup broke" identically.
    async _getActionDestinationMap(config, indexes){
        // Lazily initialized (not in the constructor) because the unit harness
        // builds a Database with Object.create(Database.prototype) and never runs it.
        if(!this._actionDestinationSkip) this._actionDestinationSkip = new Map();
        let skip     = this._actionDestinationSkip.get(config.coin) || new Set();
        let families = ACTION_DESTINATION_FAMILIES.filter(f => !skip.has(f.table));
        let map      = new Map();
        if(!families.length) return map;

        try {
            let [query, args] = this._actionDestinationSql(families, indexes);
            this._collectActionDestinations(map, await this.doQuery(config, query, args));
            return map;
        } catch(e){
            // The union is all-or-nothing: one absent table (an older deployment
            // without capability_slash_events, say) loses the destinations of all
            // eight families. Retry family by family so the rest still resolve, and
            // QUARANTINE only the ones that fail for a schema reason, so the steady
            // state on such a deployment is back to one query per poll rather than
            // nine. A transient failure (connection lost) is deliberately NOT
            // quarantined: it would silence destinations permanently for a fault
            // that clears on its own.
            map.clear();
            for(let family of families){
                try {
                    let [q, a] = this._actionDestinationSql([family], indexes);
                    this._collectActionDestinations(map, await this.doQuery(config, q, a));
                } catch(err){
                    if(this._isSchemaShapeError(err)){
                        skip.add(family.table);
                        this._actionDestinationSkip.set(config.coin, skip);
                        console.error('Action destinations: disabling ' + family.table +
                                      ' for ' + config.coin + ' (' + (err && err.message) + ')');
                    }
                }
            }
            return map;
        }
    }

    // Build the UNION ALL (or the single-family retry). INNER JOIN on
    // index_addresses is what drops a NULL destination_id and an id that resolves to
    // nothing, so the result set holds only real, literal addresses.
    _actionDestinationSql(families, indexes){
        let holes = indexes.map(() => '?').join(',');
        let parts = [];
        let args  = [];
        for(let family of families){
            parts.push(`SELECT
                            m.${family.key} as action_index,
                            a1.address as destination
                        FROM
                            ${family.table} m
                            INNER JOIN index_addresses a1 ON (a1.id=m.destination_id)
                        WHERE
                            m.${family.key} IN (${holes})`);
            // Bound as VALUES, and passed through as the driver gave them to us
            // (BIGINT reads back as a BigInt on this pool): re-stringifying them
            // would make MariaDB compare a quoted literal against a BIGINT column as
            // a DOUBLE, the same >2^53 collapse the cursor comment above warns about.
            args.push(...indexes);
        }
        return [parts.join(' UNION ALL '), args];
    }

    // Fold one result set into the map. Deduped per action because the same address
    // can legitimately appear twice (a multi-output SEND paying one address twice,
    // or a fee and a send landing on the same treasury): a subscriber must not be
    // told about it twice, and the Broadcaster must not broadcast to that channel
    // twice. Insertion order is kept so the wire order is stable across polls.
    _collectActionDestinations(map, rows){
        if(!rows || !rows.length) return map;
        for(let row of rows){
            if(!row || this.util.isNull(row.action_index) || this.util.isNull(row.destination)) continue;
            let key  = String(row.action_index);
            let list = map.get(key);
            if(!list){
                list = [];
                map.set(key, list);
            }
            if(!list.includes(row.destination)) list.push(row.destination);
        }
        return map;
    }

    // "That table or column does not exist here", seen through doQuery's wrapper.
    // doQuery rethrows as DbQueryError with its OWN code ('DB_ERROR') and the
    // driver's SqlError on .cause, so testing the top-level error alone never
    // matches a real one; walk the (short, bounded) cause chain. Mirrors
    // ChangeDetector._isMissingTableError, widened to the bad-column case because
    // that is the exact error class that killed this feed once already.
    _isSchemaShapeError(err){
        for(let e = err, depth = 0; e && depth < 5; e = e.cause, depth++){
            if(e.code === 'ER_NO_SUCH_TABLE'   || Number(e.errno) === 1146) return true;
            if(e.code === 'ER_BAD_FIELD_ERROR' || Number(e.errno) === 1054) return true;
        }
        return false;
    }

    // Resolve the PARENT market for any BET-family action, so a ws lifecycle event can
    // be routed to the `bet_feed:<feed_index>` entity channel. BET is one action name
    // over four formats, so the parent is wherever the action landed:
    //   format 0 (create) -> the feed row itself, whose id IS this action_index
    //   format 2 (place)  -> bets.feed_action_index
    //   formats 1/3 + BET_EXPIRE -> bet_feed_statuses.feed_action_index (the status row
    //   the cancel/resolve/expire wrote). Checked in that order; the first hit wins.
    // Returns null when nothing matches (a rejected BET writes no child row), which the
    // caller treats as non-fatal and emits without a parent index.
    async getBetActionFeedIndex(config, actionIndex) {
        let feed = await this.doQuery(config,
            `SELECT action_index FROM bet_feeds WHERE action_index=? LIMIT 1`, [actionIndex]);
        if (feed && feed.length) return feed[0].action_index;
        let bet = await this.doQuery(config,
            `SELECT feed_action_index FROM bets WHERE action_index=? LIMIT 1`, [actionIndex]);
        if (bet && bet.length && bet[0].feed_action_index != null) return bet[0].feed_action_index;
        let st = await this.doQuery(config,
            `SELECT feed_action_index FROM bet_feed_statuses WHERE action_index=? ORDER BY feed_action_index ASC LIMIT 1`, [actionIndex]);
        if (st && st.length && st[0].feed_action_index != null) return st[0].feed_action_index;
        return null;
    }

    // Feeds whose `closed` deadline latch was stamped above `sinceBlock`, oldest
    // first. This is the ws layer's SECOND cursor and it exists because the latch is
    // the one BET transition with no action row: the end-of-block pass writes
    // bet_feeds.closed_block directly (spec §6), so the ChangeDetector's actions
    // cursor has nothing to see and a subscribed market page never learns that
    // betting closed. closed_block IS the durable record of that write, and
    // it is also what the reorg reset clears, so a rolled-back-then-re-latched feed
    // re-emits naturally.
    // Ordered by closed_block ASC (then action_index) because the caller advances a
    // block-height high-water mark and must be able to stop on a whole-block boundary.
    async getBetFeedsClosedSince(config, sinceBlock, limit) {
        let query = `SELECT
                        m.action_index,
                        m.closed_block,
                        m.deadline,
                        m.expire_at,
                        a2.address as source,
                        pt.tick,
                        fs.status as feed_status
                    FROM
                        bet_feeds m
                        INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers   pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses  fs ON (fs.id=m.feed_status_id)
                    WHERE
                        m.closed_block > ?
                    ORDER BY m.closed_block ASC, m.action_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlock, limit]);
        return results || [];
    }

    // Deployed contracts. Every contract query is an explicit column list, so the
    // four meta_* columns (spec contract-meta-manifest 2.5) are named here as well
    // as on getContract; meta_json is parsed into the nested `meta` object by
    // getData's post-pass, the same shape the single-contract route serves.
    //
    // The `name` lane binds the FULLTEXT term the WHERE clause built (see
    // getQueryWhereSql), which is the one filter on this method whose bind value is
    // not the raw path segment: BOOLEAN MODE reads +, -, *, ", ( ), ~, < > and @ as
    // operators, so an unsanitized term is a query-syntax injection into the search
    // itself. A term left with nothing to match after sanitizing returns the empty
    // page rather than a MATCH that would match everything.
    async getContracts(config){
        let sql   = config.data.sql;
        let args  = null;
        if(config.data.type=='name'){
            let term = this.fulltextTerm(config.data.search);
            if(term === '') return [[], null, 0];
            args = [term];
        }
        let count = `SELECT
                        count(*) as total
                    FROM
                        contracts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.code_hash,
                        m.api_version,
                        m.cooldown_blocks,
                        sd.address as slash_destination,
                        m.meta_name,
                        m.meta_description,
                        m.meta_version,
                        m.meta_json,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contracts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    sd ON (sd.id=m.slash_destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Get single CONTRACT by action_index. Data method (returns [data]): the
    // /api/contract/{idx} route serves a single record, not a datatable (the
    // explorer contract listing uses getContracts). The LEFT JOIN surfaces the
    // contract's permissions manifest (contract_permissions; null when none).
    async getContract(config){
        let data  = null;
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.code,
                        m.code_hash,
                        m.api_version,
                        m.cooldown_blocks,
                        sd.address as slash_destination,
                        m.meta_name,
                        m.meta_description,
                        m.meta_version,
                        m.meta_json,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status,
                        cp.permissions,
                        cp.max_take_bps
                    FROM
                        contracts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    sd ON (sd.id=m.slash_destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                        LEFT  JOIN contract_permissions cp ON (cp.contract_index=m.action_index)
                    WHERE ` + sql.where.data + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            // Permissions manifest (protocol/Controller_Bound_Tokens.md): the
            // declared emission allowlist + per-contract fee cap. permissions is
            // stored as a JSON array (NULL = unrestricted / no manifest); parse
            // it, falling back to null on absence or malformed JSON. max_take_bps
            // is NULL when the global cap applies.
            let permissions = null;
            if(!this.util.isNull(row.permissions)){
                try { permissions = JSON.parse(row.permissions); }
                catch(e){ permissions = null; }
            }
            row.permissions  = permissions;
            row.max_take_bps = this.util.isNull(row.max_take_bps) ? null : Number(row.max_take_bps);
            // Contract identity manifest (spec contract-meta-manifest 2.1): the three
            // extracted columns ride flat beside permissions, and the whole declared
            // object rides nested as `meta`, the way `abi` already does. meta_json
            // holds the isolate's own JSON.stringify bytes; parse it here so no
            // consumer has to (and so a malformed one is null rather than a string).
            this.attachContractMeta(row);
            // action_index stays the driver's BIGINT so utility.jsonStringify emits the
            // exact decimal string openapi's info.description promises; a Number() here
            // collapsed values above 2^53 and made it the one index in this row typed
            // unlike its own block_index (contract standardized in 38cc1d9).
            // The constructor lookup below binds it as a BigInt, never a quoted string,
            // which MariaDB would compare against a BIGINT column as a DOUBLE.
            if(this.util.isNull(row.action_index)) row.action_index = null;

            // Source integrity: the chain carries the source itself, so
            // "verified contract" reduces to hashing what we serve. A mismatch
            // can only mean a corrupted indexer row; surface it, never hide it.
            let computedHash = this.util.isNull(row.code) ? null
                : crypto.createHash('sha256').update(row.code).digest('hex');
            row.code_hash_ok = computedHash !== null && computedHash === row.code_hash;

            // Callable method surface + optional self-declared abi metadata
            // via AST extraction (presentation-only; methods null = shape
            // unrecognized and the UI shows "unknown"; abi null = none
            // declared or malformed, UI falls back to name-only forms).
            // Cache key is the digest WE computed, never the stored code_hash:
            // introspection is a pure function of the code, and a row whose
            // stored hash mismatches its code must not poison (or read) the
            // entry of the code that hash really belongs to.
            let introspected = computedHash === null ? { methods: null, abi: null }
                : this._cacheGet(this._methodsCache, computedHash);
            if(introspected === undefined){
                try {
                    let ex = extractMethods(row.code);
                    introspected = { methods: ex.methods, abi: ex.abi };
                } catch(e){
                    introspected = { methods: null, abi: null };
                }
                this._cacheSet(this._methodsCache, computedHash, introspected);
            }
            row.methods = introspected.methods;
            row.abi     = introspected.abi;

            // Deploy-time constructor arguments: the indexer records the
            // constructor run in contract_executions under the literal method
            // name 'constructor', keyed by the DEPLOY's own action_index.
            try {
                let ctor = await this.doQuery(config,
                    `SELECT input_params FROM contract_executions WHERE action_index=? AND method_name='constructor' LIMIT 1`,
                    [row.action_index]);
                row.constructor_params = (ctor && ctor.length && !this.util.isNull(ctor[0].input_params)) ? String(ctor[0].input_params) : null;
            } catch(e){
                row.constructor_params = null;
            }

            // Feature discovery for the contract page's Read Contract card:
            // mirrors the env gate on POST /{COIN}/api/contract/{idx}/call.
            row.vm_query_enabled = process.env.EXPLORER_VM_QUERY_ENABLED === 'true';

            // Wallet handoff target for the Write Contract card. An explicitly
            // EMPTY EXPLORER_WALLET_URL disables the card, so only default over
            // an unset variable, never over ''.
            row.wallet_url = process.env.EXPLORER_WALLET_URL !== undefined
                ? process.env.EXPLORER_WALLET_URL : 'https://wallet.xchain.io';

            data = row;
        }
        return [data];
    }

    // Turn a contracts row's stored meta_json into the nested `meta` object every
    // contract-bearing response carries, and drop the raw column: a consumer that
    // had to JSON.parse a string field would eventually forget to, and the two
    // forms of the same value on one row is the drift that produces. A row whose
    // meta_json is absent, unparseable, or not a plain object gets meta null; the
    // three flat columns are served exactly as stored (the author's own bytes,
    // hardened at render, never here).
    attachContractMeta(row){
        if(!row || typeof row !== 'object') return row;
        let meta = null;
        if(!this.util.isNull(row.meta_json)){
            try {
                let parsed = JSON.parse(row.meta_json);
                if(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
                    meta = parsed;
            } catch(e){ meta = null; }
        }
        row.meta = meta;
        delete row.meta_json;
        return row;
    }

    // One search row's share of a contract description: enough to tell two hits
    // apart, short enough that a 512-byte description cannot take over the results
    // list. Truncated on characters, not bytes, because the consumer is a table
    // cell. The bytes are otherwise the author's own and are hardened at render,
    // never here.
    _metaSnippet(description){
        const SNIPPET_MAX = 160;
        if(this.util.isNull(description)) return null;
        let s = String(description);
        return (s.length > SNIPPET_MAX) ? s.slice(0, SNIPPET_MAX - 1) + '…' : s;
    }

    // Get a contract's permissions manifest (protocol/Controller_Bound_Tokens.md):
    // the declared emission allowlist + per-contract fee cap, or null when the
    // contract declared no manifest. permissions is a JSON array on the wire
    // (NULL = unrestricted); parse it, falling back to null on malformed JSON.
    async getContractManifest(config, contractIndex){
        if(this.util.isNull(contractIndex)) return null;
        let query = `SELECT permissions, max_take_bps
                     FROM contract_permissions
                     WHERE contract_index=?
                     LIMIT 1`;
        let rows = await this.doQuery(config, query, [contractIndex]);
        if(!rows || !rows.length) return null;
        let row = rows[0];
        let permissions = null;
        if(!this.util.isNull(row.permissions)){
            try { permissions = JSON.parse(row.permissions); }
            catch(e){ permissions = null; }
        }
        return {
            permissions:  permissions,
            max_take_bps: this.util.isNull(row.max_take_bps) ? null : Number(row.max_take_bps)
        };
    }

    async getContractState(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_state cs
                        INNER JOIN (
                            SELECT state_key, MAX(id) as max_id
                            FROM contract_state
                            WHERE contract_index=?
                            GROUP BY state_key
                        ) latest ON (latest.max_id=cs.id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        cs.id,
                        cs.contract_index,
                        cs.state_key,
                        cs.state_value,
                        cs.block_index
                    FROM
                        contract_state cs
                        INNER JOIN (
                            SELECT state_key, MAX(id) as max_id
                            FROM contract_state
                            WHERE contract_index=?
                            GROUP BY state_key
                        ) latest ON (latest.max_id=cs.id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY cs.state_key ASC
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Load a contract's FULL current state in the shape the VM consumes,
    // mirroring the indexer's own loader (xchain-indexer/src/db.js
    // getContractState): latest non-null row per key, values JSON-parsed with
    // raw-string fallback. Null-prototype object so adversarial keys like
    // '__proto__' round-trip instead of hitting the setter. Used only by the
    // read-only simulation endpoint (vm-query.js), not the datatable route.
    //
    // The endpoint is public and the VM's maxStateKeys only bounds NEW writes,
    // not the initial load, so the caller passes hard row/byte caps and a
    // cheap aggregate pre-check refuses oversized state BEFORE the multi-MB
    // row fetch. Throws code 'STATE_TOO_LARGE' past either cap.
    async getContractFullState(config, contractIndex, limits){
        let maxRows  = limits && limits.maxRows  > 0 ? Math.floor(limits.maxRows)  : 10000;
        let maxBytes = limits && limits.maxBytes > 0 ? Math.floor(limits.maxBytes) : 4 * 1024 * 1024;
        let gateQuery = `SELECT COUNT(*) as total_rows, COALESCE(SUM(LENGTH(cs.state_value)), 0) as total_bytes
                     FROM contract_state cs
                     INNER JOIN (
                         SELECT MAX(id) as max_id
                         FROM contract_state
                         WHERE contract_index = ?
                         GROUP BY state_key
                     ) latest ON (cs.id = latest.max_id)
                     WHERE cs.state_value IS NOT NULL`;
        let gate = await this.doQuery(config, gateQuery, [contractIndex]);
        let totalRows  = gate && gate.length ? Number(gate[0].total_rows)  : 0;
        let totalBytes = gate && gate.length ? Number(gate[0].total_bytes) : 0;
        if(totalRows > maxRows || totalBytes > maxBytes){
            let err  = new Error('contract state too large to load for simulation (' + totalRows + ' keys, ' + totalBytes + ' bytes)');
            err.code = 'STATE_TOO_LARGE';
            throw err;
        }
        // LIMIT is belt-and-braces for rows written between the two queries.
        let query = `SELECT cs.state_key, cs.state_value
                     FROM contract_state cs
                     INNER JOIN (
                         SELECT MAX(id) as max_id
                         FROM contract_state
                         WHERE contract_index = ?
                         GROUP BY state_key
                     ) latest ON (cs.id = latest.max_id)
                     WHERE cs.state_value IS NOT NULL
                     LIMIT ` + maxRows;
        let results = await this.doQuery(config, query, [contractIndex]);
        let state = Object.create(null);
        let loadedBytes = 0;
        for(let row of (results || [])){
            // Re-verify the byte budget against the rows actually fetched: the
            // aggregate gate above and this SELECT are two separate queries, so
            // state written between them can push the real payload past the cap
            // the gate approved (TOCTOU). LIMIT bounds row count; this bounds bytes.
            loadedBytes += row.state_value == null ? 0 : Buffer.byteLength(String(row.state_value));
            if(loadedBytes > maxBytes){
                let err  = new Error('contract state exceeded simulation byte budget while loading (>' + maxBytes + ' bytes)');
                err.code = 'STATE_TOO_LARGE';
                throw err;
            }
            try { state[row.state_key] = JSON.parse(row.state_value); }
            catch(e){ state[row.state_key] = row.state_value; }
        }
        return state;
    }

    // Get contract custody balances; custody lives in the standard `balances`
    // table under the contract's derived address C:<CHAIN>:<action_index>.
    async getContractBalance(config){
        let sql     = config.data.sql;
        let chain   = this.baseCoin ? this.baseCoin[config.coin] : null;
        let address = 'C:' + chain + ':' + config.data.search;
        let args    = [address];
        let count = `SELECT
                        count(*) as total
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        t3.tick,
                        m.amount
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY t3.tick ASC
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getExecutions(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_executions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.caller_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.contract_index,
                        a2.address as caller,
                        m.method_name,
                        m.gas_used,
                        m.gas_limit,
                        m.emitted_count,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contract_executions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.caller_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getExecution(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_executions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.caller_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.contract_index,
                        a2.address as caller,
                        m.method_name,
                        m.input_params,
                        m.gas_used,
                        m.gas_limit,
                        m.emitted_count,
                        m.error_message,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contract_executions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.caller_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Get list of contract emissions (the per-CONTRACT rollup across every EXECUTE call
    // against it). contract_emissions is keyed to the EXECUTION (execution_index = the
    // EXECUTE action's action_index), not to the contract, so reaching contract_index
    // requires joining through contract_executions; block_index lives on
    // contract_executions directly, so the block filter and the timestamp join need no
    // actions/blocks hop. Cursor is m.id: this table's own action_index is nullable for
    // internal emissions (e.g. SLASH), so it cannot page reliably. type in
    // {contract, execution, block}.
    async getEmissions(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_emissions m
                        INNER JOIN contract_executions ce ON (ce.action_index=m.execution_index)
                        INNER JOIN blocks               b1 ON (b1.block_index=ce.block_index)
                        LEFT  JOIN index_statuses        s1 ON (s1.id=ce.status_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.execution_index,
                        ce.contract_index,
                        m.position,
                        m.emitted_action,
                        m.action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        contract_emissions m
                        INNER JOIN contract_executions ce ON (ce.action_index=m.execution_index)
                        INNER JOIN blocks               b1 ON (b1.block_index=ce.block_index)
                        LEFT  JOIN index_statuses        s1 ON (s1.id=ce.status_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDeposits(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        deposits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.contract_index,
                        a2.address as source,
                        t3.tick,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        deposits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getWithdrawals(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        withdrawals m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.contract_index,
                        a2.address as source,
                        t3.tick,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        withdrawals m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }


    // Cross-chain reorg attestations (hub-owned, id-keyed). Primary transport: hub
    // JSON-RPC via HubOperationalCache over the hub's EXISTING unauthenticated
    // getreorghistory RPC, so this row needs no new hub-side surface. Unlike the three
    // tables above (platform-global, no per-chain column), reorg_attestations carries
    // source_chain and getreorghistory returns EVERY chain's history with no server-side
    // chain filter at all, so a per-coin page would otherwise leak another chain's
    // reorgs. Both transports therefore scope to THIS coin's own chain: client-side
    // inside HubOperationalCache.getReorgHistory (the established pattern for a param the
    // hub RPC does not support server-side, see getGovernanceProposals' proposal_id), and
    // via an explicit m.source_chain=? on the co-located leg, matching
    // getCrossChainMatches' mandatory network filter.
    //
    // this.baseCoin[config.coin] (RBTC -> BTC) is the chain source rather than
    // _checkpointSource().chain because it is populated for every configured coin whether
    // or not a co-located checkpoint DB exists, so the RPC-only deployment shape still
    // scopes correctly. A configured-but-unreachable hub still fails loud past the stale
    // ceiling; the co-located read below serves only the no-hub shape.
    // type in {status, block}; 'block' reuses the platform-wide type name (reorg_height IS
    // a block height) rather than inventing 'height'.
    async getReorgs(config){
        let ops   = this.explorer.hubOperational;
        let chain = this.baseCoin ? (this.baseCoin[config.coin] || config.coin) : config.coin;
        if(ops && ops.enabled()){
            let rows = await ops.getReorgHistory({
                chain,
                status:       config.data.type=='status' ? config.data.search : undefined,
                reorg_height: config.data.type=='block'  ? config.data.search : undefined
            });
            if(rows) return this._pageHubOperationalRows(config, rows);
            this._hubOperationalOutage('reorg_attestations');
        }
        let sql = config.data.sql;
        let src = this._hubSource(config, 'reorg_attestations');
        // Mandatory per-coin chain scope, appended AFTER the optional type filter (the
        // same placement getCrossChainMatches uses for its network filter), so the args
        // stay [<type filter?>, chain] in strict left-to-right text order.
        let chainFilter = ' AND m.source_chain=?';
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data + chainFilter;
        let query = `SELECT
                        m.id,
                        m.reorg_id,
                        m.source_chain,
                        m.reorg_height,
                        m.reorg_timestamp,
                        m.affected_chains,
                        m.validator_count,
                        m.status,
                        m.created_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + chainFilter + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        let typeArgs = ['status','block'].includes(config.data.type) ? [config.data.search] : [];
        let args = [...typeArgs, chain];
        return [query, args, count];
    }

    // Federation slash proposals (hub-owned, id-keyed). Primary transport: hub
    // JSON-RPC via HubOperationalCache over the hub's NEW unauthenticated
    // getslashproposals RPC (added for this row alongside the hub-side evidence
    // hashing). Unlike reorg_attestations there is NO chain column and none is
    // missing: the offenses are federation-wide (oracle and attestation rounds are
    // not per-chain, and a signing pubkey is one identity across every chain), so
    // this table is platform-global like validator_capabilities/governance_* and
    // binds no chain filter on either transport. Adding one later would empty this
    // page permanently, since no row can ever carry a chain value to match.
    //
    // Rows with status 'pending' are UNADJUDICATED ACCUSATIONS: SlashDetector
    // records evidence, and only a passed SLASH_PENALTY governance vote moves a row
    // off 'pending' (SlashGovernance.applyFinalized). status is therefore carried on
    // every row and rendered as its own labelled column, never as a row colour.
    //
    // The verbatim `evidence` blob is NEVER served on either leg. The RPC leg gets
    // evidence_hash from the hub (SlashDetector.hashEvidence, sha256 of the stored
    // text, the same digest SlashGovernance's voted evidence hash is built from);
    // the co-located leg computes the identical digest in SQL. Hashing hub-side is
    // the ruling's point: the hub's own POST surface serves this RPC to anyone, so
    // explorer-side redaction alone would leak.
    //
    // A configured-but-unreachable hub fails loud past the stale ceiling
    // (_hubOperationalOutage); the co-located read below serves only the no-hub
    // deployment shape. type in {status, pubkey}, matching the hub RPC's two
    // server-side filters exactly, so neither transport post-filters. No 'block'
    // type: round_number is an oracle round (or an attestation pseudo-round), not a
    // block height.
    async getSlashProposals(config){
        let ops = this.explorer.hubOperational;
        if(ops && ops.enabled()){
            let rows = await ops.getSlashProposals({
                status:           config.data.type=='status' ? config.data.search : undefined,
                validator_pubkey: config.data.type=='pubkey' ? config.data.search : undefined
            });
            if(rows) return this._pageHubOperationalRows(config, rows);
            this._hubOperationalOutage('slash_proposals');
        }
        let sql = config.data.sql;
        let src = this._hubSource(config, 'slash_proposals');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.validator_pubkey,
                        m.offense_type,
                        m.round_number,
                        SHA2(COALESCE(m.evidence,''), 256) AS evidence_hash,
                        m.status,
                        m.created_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // ── Hub operational-state pages (p2p_peers / consensus_state / configs /
    // telemetry_pings). These are hub-LOCAL operational tables with no on-chain
    // action and, unlike validator_capabilities/governance_*, no hub JSON-RPC read
    // surface at all, so they are served ONLY from the co-located hub DB via
    // _hubSource (same host+creds as the indexer pool; #4138), which is therefore
    // mandatory for these four on any install that serves them. That is the reverse
    // of the three RPC-first tables above, where the co-located schema serves only
    // the no-hub shape and a configured-but-down hub fails loud. Each is
    // id-keyed (no action_index), so the paging cursor compares m.id (see
    // getQueryOffsetSql).

    // P2P peer roster the hub gossips with. type in {validator}. id-keyed.
    async getPeers(config){
        let sql = config.data.sql;
        let src = this._hubSource(config, 'p2p_peers');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.addr,
                        m.validator_id,
                        m.last_seen_at,
                        m.is_seed,
                        m.updated_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Hub consensus key/value state. type in {key}. id-keyed.
    async getConsensusState(config){
        let sql = config.data.sql;
        let src = this._hubSource(config, 'consensus_state');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.key_name,
                        m.value,
                        m.updated_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Hub config-oracle parameter store (per coin/network/module). type in {coin, module}.
    // id-keyed.
    async getConfigs(config){
        let sql = config.data.sql;
        let src = this._hubSource(config, 'configs');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.coin,
                        m.network,
                        m.module,
                        m.param_name,
                        m.param_value,
                        m.updated_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Anonymous xchain-node telemetry pings. type in {event, install, country}. id-keyed.
    // Privacy: ip_hash (a keyed HMAC of the source IP) is deliberately NOT selected;
    // only the anonymous install UUID + coarse country/region + software fingerprint
    // are surfaced.
    async getTelemetryPings(config){
        let sql = config.data.sql;
        let src = this._hubSource(config, 'telemetry_pings');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.install_id,
                        m.country,
                        m.region,
                        m.node_version,
                        m.os_platform,
                        m.os_release,
                        m.arch,
                        m.docker_version,
                        m.event,
                        m.created_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of ATTEST actions from the consolidated `attests` table. Lists both
    // v0 (request) and v1 (response) rows; `version` + request/response status let
    // the UI tell them apart. type in {address, block, contract}.
    //
    // The block is resolved off the ACTION's own block_index and `transactions` is a
    // LEFT join, the tx-less-safe shape getHistory already uses. A mirror-applied
    // ATTEST v1 response is a system-synthesized action with a real action_index and
    // block_index but a NULL tx_index and no transactions row (attest-response-mirror
    // spec §4.4), so the older INNER chain through t1 made every such response
    // VANISH from this list rather than render incompletely. tx_hash and tx_index
    // come back NULL for those rows, which is what they are.
    async getAttestations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        attests m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        // The block is resolved off the ACTION's own block_index and `transactions` is a
        // LEFT join, the tx-less-safe shape getHistory already uses. A mirror-applied
        // ATTEST v1 response is a system-synthesized action with a real action_index and
        // block_index but a NULL tx_index and no transactions row (attest-response-mirror
        // spec §4.4), so the older INNER chain through t1 made every such response
        // VANISH from this list rather than render incompletely. tx_hash and tx_index
        // come back NULL for those rows, which is what they are.
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.version,
                        m.request_id,
                        m.provider_id,
                        m.contract_index,
                        a2.address as source,
                        fp.address as fee_payer,
                        m.gas_escrow,
                        m.fee_amount,
                        ft.tick as fee_tick,
                        m.request_status,
                        m.response_status,
                        m.payload,
                        m.response_payload,
                        m.callback_params_json,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        attests m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    fp ON (fp.id=m.fee_payer_id)
                        LEFT  JOIN index_tickers      ft ON (ft.id=m.fee_tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // List VOTE governance polls (polls table, one row per VOTE v0 create-poll action).
    // Joins the actions/transactions/blocks chain like getAttestations; filter by
    // block / tick (electorate token) / poll_status / source creator (see the
    // getQueryWhereSql getPolls branch). tick + source resolve through index tables.
    async getPolls(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        polls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        pt.tick,
                        m.end_block,
                        m.options,
                        m.max_selections,
                        m.tally_mode,
                        m.weight_mode,
                        m.quorum,
                        m.min_voters,
                        m.question,
                        m.poll_status,
                        m.winning_option,
                        m.total_weight,
                        m.total_voters,
                        m.quorum_met,
                        m.min_voters_met,
                        m.deposit_amount,
                        m.callback_contract_index,
                        m.callback_method,
                        m.finalized_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        polls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Open (not yet finalized) polls governed by one token, soonest close first.
    // Backs getToken's open_polls (the token page's Active Governance card).
    // Capped small because it rides the token point-read; full poll history
    // stays on getPolls (the tick/status-filterable list).
    async getTokenOpenPolls(config, tick){
        let query = `SELECT
                        m.action_index,
                        m.question,
                        m.end_block,
                        m.quorum,
                        m.min_voters,
                        m.weight_mode,
                        m.callback_contract_index,
                        m.callback_method
                    FROM
                        polls m
                        INNER JOIN index_tickers pt ON (pt.id=m.tick_id)
                    WHERE
                        pt.tick=?
                        AND m.poll_status='open'
                    ORDER BY m.end_block ASC
                    LIMIT 25`;
        let rows = await this.doQuery(config, query, [tick]);
        return rows || [];
    }

    // Single VOTE poll by its creating action_index (the poll id). Returns the full
    // poll definition + finalization summary (null fields until VOTE v2 finalizes) as a
    // single object (getXcall pattern), with options/callback_params JSON-parsed. The
    // per-option breakdown lives in poll_results (getPollResults); ballots in votes.
    async getPoll(config){
        let data  = null;
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        pt.tick,
                        m.tick_id,
                        m.end_block,
                        m.options,
                        m.max_selections,
                        m.tally_mode,
                        m.weight_mode,
                        m.quorum,
                        m.min_voters,
                        m.min_vote_balance,
                        m.decide_threshold,
                        m.question,
                        m.poll_status,
                        m.winning_option,
                        m.total_weight,
                        m.total_voters,
                        m.quorum_met,
                        m.min_voters_met,
                        m.fail_reason,
                        m.decided_early,
                        m.effective_close_block,
                        m.finalized_action_index,
                        m.resolved_block,
                        m.deposit_amount,
                        dep.address as deposit_address,
                        m.deposit_resolved,
                        m.callback_contract_index,
                        m.callback_method,
                        m.callback_params,
                        m.callback_on,
                        m.gas_escrow,
                        m.callback_delay_blocks,
                        m.callback_execute_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        polls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    dep ON (dep.id=m.deposit_address_id)
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            // options is a JSON array of option labels; callback_params a JSON array of
            // developer params. Parse both, falling back to the raw string on malformed
            // JSON (mirrors getXcall's params_json / getContract's permissions parse).
            try { row.options = this.util.isNull(row.options) ? [] : JSON.parse(row.options); }
            catch(e){ row.options = row.options; }
            try { row.callback_params = this.util.isNull(row.callback_params) ? null : JSON.parse(row.callback_params); }
            catch(e){ row.callback_params = row.callback_params; }
            data = row;
        }
        return [data];
    }

    // Frozen per-option tally for one poll (poll_results, written by VOTE v2 finalize).
    // Empty until the poll is finalized; ordered by option_index so the caller renders
    // the poll's options in order. No actions chain (keyed by poll_index directly).
    async getPollResults(config){
        let sql   = config.data.sql;
        let count = `SELECT count(*) as total FROM poll_results m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.poll_index,
                        m.option_index,
                        m.total_weight,
                        m.voter_count,
                        m.action_index as finalize_action_index,
                        m.block_index,
                        s1.status
                    FROM
                        poll_results m
                        LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
                    WHERE ` + sql.where.data + `
                    ORDER BY m.option_index ASC`;
        return [query, null, count];
    }

    // List VOTE ballots (votes table, one row per poll+voter+chosen option). Joins the
    // actions/transactions/blocks chain like getAttestations; the voter IS the source
    // (a2). Filter by voter address / poll / block (see getQueryWhereSql getVotes branch).
    async getVotes(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        votes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.poll_index,
                        m.choice,
                        m.share,
                        m.memo,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        votes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // List BET markets (bet_feeds, one row per BET format 0 create-feed action).
    // Joins the actions/transactions/blocks chain like getPolls; the feed id IS the
    // creating action_index. tick joins index_tickers (pt) on m.tick_id (the wager
    // token); source is the oracle that created the feed (a2 via the action source);
    // status filters the stored feed lifecycle enum through index_statuses (fs).
    // feed_status is STORED rather than derived, so the list never recomputes a
    // close from the wall clock (the §5 backdating property E11 pins).
    async getBetFeeds(config){
        let sql   = config.data.sql;
        let from  = `
                        bet_feeds m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_statuses     fs ON (fs.id=m.feed_status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)`;
        let count = `SELECT count(*) as total FROM ` + from + ` WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        pt.tick,
                        m.label,
                        m.outcomes,
                        m.fee,
                        m.deadline,
                        m.refund_window,
                        m.expire_at,
                        m.min_amount,
                        m.allow_list,
                        m.block_list,
                        fs.status as feed_status,
                        m.closed_block,
                        m.terminal_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM ` + from + `
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // HTTP entry point for one BET market (getPoll pattern: a one-element array
    // whose element is null when there is no such feed). The router's where-builder
    // resolves to `m.action_index IS NOT NULL AND m.action_index=?` for this method
    // (getQueryWhereSql), which is the equality getBetFeedInfo binds directly, so
    // both entry points read the same row through one query body.
    async getBetFeed(config){
        return [await this.getBetFeedInfo(config, config.data.search)];
    }

    // Single BET market by its creating action_index (the feed id), returned as one
    // object with the per-outcome pools, bet counts and the full status timeline
    // attached, or null. DETAILS is returned as the RAW base64 exactly as it landed
    // on the wire plus a decoded `details_json` when it parses; it is never rendered
    // as markup and no URL inside it is ever fetched (§11.1 rendering safety,
    // SSRF-guard stance). Takes the index as an argument rather than off the config
    // so callers holding no router-built config can read it too: the WebSocket
    // bet_feed SNAPSHOT builds `{ coin }` alone. Same shape as getDispenserInfo.
    async getBetFeedInfo(config, actionIndex){
        let data  = null;
        let args  = [actionIndex];
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        pt.tick,
                        m.tick_id,
                        m.label,
                        m.outcomes,
                        m.fee,
                        m.deadline,
                        m.refund_window,
                        m.expire_at,
                        m.min_amount,
                        m.allow_list,
                        m.block_list,
                        m.details,
                        fs.status as feed_status,
                        m.closed_block,
                        m.terminal_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        bet_feeds m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_statuses     fs ON (fs.id=m.feed_status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE m.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            // OUTCOMES is stored as the canonical comma-joined label list. Split it
            // back into an array so the caller renders options in wire order without
            // re-implementing the join rule. Byte-exact uniqueness was enforced at
            // parse, so positions are stable and index-addressable.
            row.outcome_labels = this.util.isNull(row.outcomes) ? [] : String(row.outcomes).split(',');
            // DETAILS rides the wire as base64 and is ATTACKER-CONTROLLED. Decode it
            // for convenience but keep the raw alongside, and fall back to null (never
            // to the raw string) when it is not valid base64 JSON, so a consumer can
            // never mistake un-parsed hostile bytes for a parsed object.
            row.details_json = null;
            if(!this.util.isNull(row.details)){
                try { row.details_json = JSON.parse(Buffer.from(String(row.details), 'base64').toString('utf8')); }
                catch(e){ row.details_json = null; }
            }
            row.pools    = await this.getBetFeedPools(config, row.action_index);
            row.timeline = await this.getBetFeedTimeline(config, row.action_index, row.closed_block);
            // The outcome a finished market resolved to; the feed row itself has none.
            row.winning_outcome = await this.getBetFeedWinningOutcome(config, row.action_index);
            data = row;
        }
        return data;
    }

    // Return the outcome an honoured resolve settled to, else null. Only a valid
    // resolve counts: an invalid row stores the outcome the oracle CLAIMED and settles
    // nothing. Resolve is terminal, so at most one row can apply.
    async getBetFeedWinningOutcome(config, feedIndex){
        let query = `SELECT
                        br.outcome
                    FROM
                        bet_resolves br
                        LEFT JOIN index_statuses bs ON (bs.id=br.status_id)
                    WHERE
                        br.feed_action_index=?
                        AND bs.status='valid'
                    ORDER BY br.action_index DESC
                    LIMIT 1`;
        let rows = await this.doQuery(config, query, [feedIndex]);
        if(!rows || !rows.length || this.util.isNull(rows[0].outcome)) return null;
        return Number(rows[0].outcome);
    }

    // Sum every bet that escrowed; invalid rows escrowed nothing and are the only
    // exclusion. This is a display aggregation, NOT the settlement predicate (which
    // counts open rows alone); no consensus path reads it.
    async getBetFeedPools(config, feedIndex){
        let query = `SELECT
                        m.outcome,
                        count(*) as bet_count,
                        SUM(CAST(m.amount AS DECIMAL(65,18))) as pool
                    FROM
                        bets m
                        LEFT JOIN index_statuses bs ON (bs.id=m.bet_status_id)
                    WHERE
                        m.feed_action_index=?
                        AND bs.status <> 'invalid'
                    GROUP BY m.outcome
                    ORDER BY m.outcome ASC`;
        let rows = await this.doQuery(config, query, [feedIndex]) || [];
        // Trim the 18-place tail a DECIMAL sum leaves on a token with fewer decimals.
        // Display only; no consensus path reads this.
        return rows.map(r => ({ outcome: Number(r.outcome),
                                bet_count: Number(r.bet_count),
                                pool: this.trimAmountTail(r.pool) }));
    }

    // Status timeline for one feed. bet_feed_statuses is action-scoped, so it carries
    // create / resolve / resolved_void / cancel / expire but deliberately NOT the
    // 'closed' latch, which has no causing action (see bet_feed_statuses.sql). The
    // explorer SYNTHESIZES that entry from the bet_feeds.closed_block stamp, which is
    // the latch's durable record, and marks it synthetic so a consumer can tell it
    // apart from an action-backed row.
    //
    // The block comes from `actions.block_index`, NOT from the action's transaction:
    // BET_EXPIRE is emitted by the end-of-block pass and has no transaction at all
    // (tx_index NULL), so routing the block join through `transactions` used to return
    // NULL for that one status, and because the synthetic-latch insertion below compares
    // block numbers, that NULL also mis-ordered the closed/expired history. The
    // transaction join stays, but only for the tx hash a system action does not have.
    async getBetFeedTimeline(config, feedIndex, closedBlock){
        let query = `SELECT
                        m.action_index,
                        s1.status,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash
                    FROM
                        bet_feed_statuses m
                        LEFT JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT JOIN actions            a1 ON (a1.action_index=m.action_index)
                        LEFT JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE m.feed_action_index=?
                    ORDER BY m.action_index ASC`;
        let rows = await this.doQuery(config, query, [feedIndex]) || [];
        rows = rows.map(r => Object.assign({}, r, { synthetic: false }));
        if(!this.util.isNull(closedBlock)){
            let closed = { action_index: null, status: 'closed', block_index: closedBlock,
                           timestamp: null, tx_hash: null, synthetic: true };
            let times  = await this.doQuery(config, `SELECT block_time FROM blocks WHERE block_index=? LIMIT 1`, [closedBlock]);
            if(times && times.length) closed.timestamp = times[0].block_time;
            // Order by block, and place the synthetic latch AFTER any action-backed row
            // in the same block: within a block, user txs process before the latch pass.
            let at = rows.findIndex(r => r.block_index > closedBlock);
            if(at === -1) rows.push(closed); else rows.splice(at, 0, closed);
        }
        return rows;
    }

    // List BET wagers (bets table, one row per BET format 2 place-bet action). Joins
    // the actions/transactions/blocks chain; the bettor IS the source (a2). Filter by
    // bettor address / feed / tick / block / bet status (see getQueryWhereSql getBets).
    async getBets(config){
        let sql   = config.data.sql;
        let from  = `
                        bets m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_statuses     bs ON (bs.id=m.bet_status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)`;
        let count = `SELECT count(*) as total FROM ` + from + ` WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.feed_action_index,
                        m.outcome,
                        pt.tick,
                        m.amount,
                        bs.status as bet_status,
                        m.settled_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM ` + from + `
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Oracle track record for one address (§11.1). This IS the v0 reputation system:
    // there is no bonding or staking behind it, and the record is PER-ADDRESS, so an
    // oracle can start fresh at any time. Callers MUST surface that caveat; an empty
    // history means unknown, not safe. "Resolved on time" is deliberately absent: a
    // resolve past expire_at is rejected by format 3, so every resolve is in-window
    // by construction and the distinction would be vacuous.
    async getOracleStats(config){
        let args  = [config.data.search];
        let query = `SELECT
                        fs.status as feed_status,
                        count(*)  as feeds
                    FROM
                        bet_feeds m
                        INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses  fs ON (fs.id=m.feed_status_id)
                    WHERE a2.address=?
                    GROUP BY fs.status`;
        let rows  = await this.doQuery(config, query, args) || [];
        let counts = { open: 0, closed: 0, resolved: 0, resolved_void: 0, cancelled: 0, expired: 0 };
        let total  = 0;
        for(const r of rows){
            if(r.feed_status in counts) counts[r.feed_status] = Number(r.feeds);
            total += Number(r.feeds);
        }
        // Active = still able to take or settle bets. Kept explicit rather than
        // derived by the caller so the market list and the oracle page agree.
        let active = counts.open + counts.closed;
        let fees   = await this.getOracleFeesEarned(config, config.data.search);
        let price  = await this.getOraclePriceRecord(config, config.data.search);
        return [{ address: config.data.search, total_feeds: total, active_feeds: active,
                  counts, fees_earned: fees, price,
                  reputation_caveat: 'Per-address record with no bonding; addresses are free to create, so an empty history means unknown, not safe.' }];
    }

    // PRICE v1 half of the per-address oracle track record. A price publisher is an
    // oracle too, but its rounds land in the hub-mirrored oracle_prices table, not
    // bet_feeds, so the stats above are blind to it and the page reported an active
    // publisher as all zeros. Aggregated per published pair (COIN/TICK/FIAT) with
    // the round counts and publish window; the individual rounds are served by
    // getOraclePrices. Returns null (a "cannot know", distinct from the zero-pair
    // record {total_publishes:0, pairs:[]}) when this node has no co-located hub DB:
    // oracle_prices is mirror-only and the betting record must still answer.
    async getOraclePriceRecord(config, address){
        let src = null;
        try {
            src = this._oracleMirrorSource(config, 'oracle_prices');
        } catch(e) {
            return null;
        }
        let rows = await this.doQuery(config,
            `SELECT
                m.coin,
                m.tick,
                m.fiat,
                count(*) as publishes,
                MIN(m.block_time) as first_publish,
                MAX(m.block_time) as last_publish
            FROM
                ${src.table} m
            WHERE
                m.source_address=?
            GROUP BY m.coin, m.tick, m.fiat
            ORDER BY last_publish DESC`, [address]) || [];
        let record = { total_publishes: 0, pairs: [] };
        for(const r of rows){
            // Counts and epoch times can arrive as BigInt; normalize so the JSON is
            // plain numbers (values are far below 2^53).
            let publishes = Number(r.publishes);
            record.total_publishes += publishes;
            record.pairs.push({
                coin: r.coin, tick: r.tick, fiat: r.fiat, publishes,
                first_publish: this.util.isNull(r.first_publish) ? null : Number(r.first_publish),
                last_publish:  this.util.isNull(r.last_publish)  ? null : Number(r.last_publish)
            });
        }
        return record;
    }

    // What an oracle has actually EARNED, per wager token (§11.1's "fees earned").
    //
    // The earning event is one ledger row and only one: settlement credits the feed
    // source a single amount carrying the FEE percent of the pot PLUS the rounding
    // dust (bet.js, §7), and only on the resolve path - a void, a cancel and an
    // expiry all pay the oracle nothing. So the sum is over `credits` rows attached
    // to a BET resolve action.
    //
    // The identity test is what makes it exact, and it is not decoration: a WINNING
    // BETTOR's payout is also a credit inside that same resolve action, so filtering
    // on the credited address alone would report other people's winnings as this
    // address's fee income the moment it ever bet on someone else's market. Requiring
    // the credited address to BE the address that submitted the resolve excludes them,
    // because format 3 is owner-only and format 2 rejects a bet from the feed source,
    // so within one resolve the oracle is credited exactly once and never as a bettor.
    async getOracleFeesEarned(config, address){
        let query = `SELECT
                        tk.tick,
                        count(*) as resolves,
                        SUM(CAST(c.amount AS DECIMAL(65,18))) as amount
                    FROM
                        credits c
                        INNER JOIN bet_resolves    br ON (br.action_index=c.action_index)
                        INNER JOIN actions         a1 ON (a1.action_index=br.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses ra ON (ra.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses ca ON (ca.id=c.address_id)
                        LEFT  JOIN index_tickers   tk ON (tk.id=c.tick_id)
                    WHERE ca.address=? AND ra.address=?
                    GROUP BY tk.tick
                    ORDER BY tk.tick ASC`;
        let rows = await this.doQuery(config, query, [address, address]) || [];
        // DECIMAL(65,18) sums arrive with an 18-place tail whatever the token's own
        // DECIMALS, so trim it here rather than in each renderer. Display only: no
        // consensus path reads this method.
        return rows.map(r => ({ tick: r.tick, resolves: Number(r.resolves),
                                amount: this.trimAmountTail(r.amount) }));
    }

    // Strip the zero tail a DECIMAL sum leaves behind ('0.175000000000000000' ->
    // '0.175'), leaving a whole number bare ('12.000...' -> '12'). Never touches a
    // significant digit, and returns non-numeric input unchanged.
    trimAmountTail(value){
        if(this.util.isNull(value)) return '0';
        let s = String(value);
        if(!/^-?\d+\.\d+$/.test(s)) return s;
        return s.replace(/0+$/, '').replace(/\.$/, '');
    }

    // List XCALL cross-chain call requests (xcalls table, VM-emitted, read-only).
    // Joins the actions/transactions/blocks chain like getAttestations; filter by
    // block / source contract / request_status (see getQueryWhereSql getXcalls branch).
    async getXcalls(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        xcalls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.version,
                        m.call_id,
                        m.contract_index,
                        a2.address as source,
                        m.target_chain,
                        m.target_contract_index,
                        m.method,
                        m.gas_limit,
                        m.cross_hops,
                        m.callback_method,
                        m.deadline_block,
                        m.request_status,
                        m.result_status,
                        m.resolved_block,
                        m.callback_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        xcalls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // List ANCHOR checkpoint records from anchor_actions. Joins the
    // actions/transactions/blocks chain like getAttestations/getXcalls.
    // type in {block, chain, network, status}.
    //
    // A v0 BUNDLE is N sibling rows sharing one action_index, one per checkpointed
    // chain, each carrying its own chain/block_index/checkpoint_seq/roots. That is
    // exactly why the bundle was stored one row per section: every per-chain reader,
    // this list and its `chain` filter included, keeps working unchanged and simply
    // lists the section rows. section_index is projected so a reader can tell two
    // sections of one bundle apart, and it breaks the ORDER BY tie the shared
    // action_index would otherwise leave to the server.
    async getAnchors(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        anchor_actions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        m.section_index,
                        a1.action_format,
                        m.version,
                        m.chain,
                        m.network,
                        m.block_index,
                        m.block_hash,
                        m.ledger_hash,
                        m.actions_hash,
                        m.contract_hash,
                        m.checkpoint_seq,
                        m.snapshot_block,
                        m.match_batch_seq,
                        m.match_count,
                        m.batch_crc32,
                        m.total_chunks,
                        m.chunk_index,
                        m.state_root,
                        m.state_root_version,
                        m.block_merkle_root,
                        m.block_merkle_version,
                        m.validator_signatures,
                        m.block_index_doge,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        anchor_actions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `, m.section_index ASC
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Per-block SPV commitments (state_tree_roots), decorated with the covering
    // hub-mirrored state_checkpoints row (if any) and the local ANCHOR action that carried
    // it (if any). The three legs live in three places and are not casually joinable:
    // state_tree_roots is this coin's own indexer DB (no action chain, one row per block,
    // unique on (chain, network, block_index)); state_checkpoints is the co-located
    // hub-mirror schema reached via _checkpointSource, DB-qualified but on the SAME
    // connection pool as the indexer DB (checkpointDb is registered ONLY when it shares
    // host/port/user/pass with that pool), which is exactly what the co-location guarantee
    // is FOR; anchor_actions is this same coin's own local indexer DB, parsed from the
    // DOGE-only ANCHOR action, so on a non-DOGE deployment that leg is structurally always
    // empty - the same limitation getAnchors already carries reading the same table.
    //
    // Both decoration legs are LEFT JOINs correlated on this row's own block_index, so a
    // block with no covering checkpoint yet (normal near the tip: checkpoints cut on a
    // cadence) or no carrying ANCHOR yet (anchoring batches several heights) comes back
    // with those columns NULL rather than the row vanishing. _checkpointSource still
    // throws when this coin has no co-located hub DB configured at ALL, which is a
    // deployment misconfiguration and a different case entirely.
    //
    // Reuses the exact latest-per-height predicate getCheckpoints established rather than
    // a third, differently-bounded checkpoint query, and applies the identical shape to
    // the anchor leg's own latest-checkpoint_seq-per-height lookup.
    async getCommitments(config){
        let sql      = config.data.sql;
        let src      = this._checkpointSource(config);
        let scFilter = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let latest   = this._latestCheckpointPredicate(src, 'sc');
        // anchor_actions.chain/network name the CHECKPOINTED chain (the same convention
        // state_checkpoints uses), not the chain the ANCHOR transaction landed on, so this
        // coin's own (chain, network) identity is the correct filter here too: block_index
        // alone is not unique across chains on the DOGE deployment, where one local table
        // holds commitments for all three.
        let anFilter = ' AND an.chain = ? AND an.network = ?';
        let anLatest = ` AND an.checkpoint_seq = (SELECT MAX(a2.checkpoint_seq) FROM anchor_actions a2
                           WHERE a2.block_index = an.block_index AND a2.chain = ? AND a2.network = ?)`;
        let count = `SELECT
                        count(*) as total
                    FROM
                        state_tree_roots m
                        LEFT JOIN ${src.table} sc ON sc.block_index = m.block_index${scFilter}${latest.sql}
                        LEFT JOIN anchor_actions an ON an.block_index = m.block_index${anFilter}${anLatest}
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.block_index,
                        m.balances_root,
                        m.stakes_root,
                        m.state_root,
                        m.block_merkle_root,
                        m.contract_state_root,
                        m.computed_at,
                        sc.checkpoint_seq        AS checkpoint_seq,
                        sc.snapshot_block        AS checkpoint_snapshot_block,
                        sc.created_at            AS checkpoint_created_at,
                        JSON_LENGTH(sc.validator_signatures) AS checkpoint_signer_count,
                        an.action_index          AS anchor_action_index,
                        an.version               AS anchor_version
                    FROM
                        state_tree_roots m
                        LEFT JOIN ${src.table} sc ON sc.block_index = m.block_index${scFilter}${latest.sql}
                        LEFT JOIN anchor_actions an ON an.block_index = m.block_index${anFilter}${anLatest}
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.block_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        // Left-to-right text order: both JOIN ON clauses (checkpoint filter + latest, then
        // anchor filter + latest), then the WHERE type-bound value, which is present only
        // when type='block' (getData's list-all null filter drops the trailing undefined on
        // a bare request, so the placeholder count still lines up). count and list share
        // IDENTICAL FROM+JOIN text, so this one array binds correctly against both.
        let args = [...src.filterParams, ...latest.params, ...src.filterParams, ...src.filterParams, config.data.search];
        return [query, args, count];
    }

    // Full XCALL lifecycle by call_id: the source request (xcalls) + the target-chain
    // execution outcome (cross_chain_call_executions) + the source-chain callback
    // delivery (cross_chain_call_callbacks). The latter two are null until the call is
    // relayed/executed/delivered. Mirrors getContract's single-item return ([data]);
    // data is null when the call_id is unknown. A call_id can carry more than one
    // xcalls row (rejected attempts index alongside the accepted request), so the
    // read is pinned to the valid row, matching the indexer's authoritative
    // by-call_id lookup; without the status bound the ORDER BY can surface an
    // invalid row as the lifecycle.
    async getXcall(config){
        let data  = null;
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.version,
                        m.call_id,
                        m.contract_index,
                        a2.address as source,
                        m.target_chain,
                        m.target_contract_index,
                        m.method,
                        m.params_json,
                        m.gas_limit,
                        m.cross_hops,
                        m.callback_method,
                        m.callback_params_json,
                        m.deadline_block,
                        m.request_status,
                        m.result_status,
                        m.result_payload,
                        m.resolved_block,
                        m.callback_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        xcalls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + ` AND s1.status='valid'
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            // params/callback_params are JSON arrays on the wire; parse, falling back to
            // the raw string on malformed JSON (mirrors getContract's permissions parse).
            try { row.params = this.util.isNull(row.params_json) ? null : JSON.parse(row.params_json); }
            catch(e){ row.params = row.params_json; }
            try { row.callback_params = this.util.isNull(row.callback_params_json) ? null : JSON.parse(row.callback_params_json); }
            catch(e){ row.callback_params = row.callback_params_json; }
            // Target-chain execution outcome (1:1 by call_id; null until executed).
            let exec = await this.doQuery(config,
                `SELECT execute_action_index, result_status, return_payload_b64, gas_used, block_index as execution_block_index
                 FROM cross_chain_call_executions WHERE call_id=? LIMIT 1`, [row.call_id]);
            row.execution = (exec && exec.length) ? exec[0] : null;
            // Source-chain callback delivery (1:1 by call_id; null until delivered).
            let cb = await this.doQuery(config,
                `SELECT result_status as callback_result_status, block_index as callback_block_index
                 FROM cross_chain_call_callbacks WHERE call_id=? LIMIT 1`, [row.call_id]);
            row.callback_delivery = (cb && cb.length) ? cb[0] : null;
            data = row;
        }
        return [data];
    }

    // Composed VALIDATOR detail (M4.1). QUERY is EITHER the Ed25519 signing pubkey or the
    // staking address: both name the same validator in circulation (/validators renders both
    // columns, a hub registry entry is keyed by pubkey, a reward accrual and its COLLECT are
    // keyed by address), so the page answers to either without the caller having to say
    // which it holds.
    //
    // The QUERY is resolved to IDs FIRST, in two unique point reads, and only then does the
    // spine touch `stakes`. The obvious one-query form (`WHERE a3.pubkey=? OR a2.address=?`
    // over the joined aliases) reads correctly and scans the whole stakes table: an OR
    // spanning two different joined tables leaves the optimizer no driving table but `stakes`
    // itself. Resolving first puts the OR on two INDEXED columns of `stakes`
    // (signing_pubkey_id, source_id), which index-merges. The single-predicate list legs
    // below keep the joined-alias form: one null-rejecting equality lets the optimizer
    // convert the LEFT JOIN and drive from the unique index, which an OR does not.
    //
    // Reward accounting is per-ADDRESS, not per-pubkey: validator_rewards accrues to
    // (source_id, signing_pubkey_id) but reward_claims (the COLLECT trail) carries only
    // source_id, so a claimable figure can only be stated for the staking address. Both
    // totals are returned alongside the difference rather than the difference alone, because
    // a negative remainder means ledger drift and has to stay visible instead of clamping.
    //
    // The capability leg follows the established hub DUAL PATH (getValidatorCapabilities):
    // hub JSON-RPC first, the co-located hub schema only on a deployment with no hub
    // endpoint at all, and a CONFIGURED hub unreachable past the stale ceiling throws
    // through _hubOperationalOutage. That throw is not caught here: an outage rendered as
    // "this validator qualified for nothing" is a false claim about consensus state.
    async getValidator(config){
        let limit  = this._detailLimit(config);
        let search = config.data.search;
        let pubkeyRow  = await this.doQuery(config,
            'SELECT id FROM index_pubkeys WHERE pubkey=? LIMIT 1', [search]);
        let addressRow = await this.doQuery(config,
            'SELECT id FROM index_addresses WHERE address=? LIMIT 1', [search]);
        let pubkeyId  = (pubkeyRow  && pubkeyRow.length)  ? Number(pubkeyRow[0].id)  : null;
        let addressId = (addressRow && addressRow.length) ? Number(addressRow[0].id) : null;
        // Neither name exists anywhere on this chain: answer without touching `stakes`.
        if(pubkeyId === null && addressId === null)
            return [null];
        // Only the resolved side is bound, so a QUERY that is unambiguously one form
        // never carries a dead placeholder against the other column's index.
        let idClauses = [];
        let idArgs    = [];
        if(pubkeyId !== null){  idClauses.push('m.signing_pubkey_id=?'); idArgs.push(pubkeyId);  }
        if(addressId !== null){ idClauses.push('m.source_id=?');         idArgs.push(addressId); }
        // Identity spine. status='valid' matches getValidators' own active-set rule, so the
        // page cannot resolve an identity off a rejected STAKE.
        let identity = await this.doQuery(config,
            `SELECT
                a3.pubkey  as signing_pubkey,
                a2.address as source,
                m.action_index as stake_action_index,
                m.version,
                m.activation_block,
                m.deactivation_block,
                m.block_index
            FROM
                stakes m
                LEFT JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE s1.status='valid' AND (` + idClauses.join(' OR ') + `)
            ORDER BY m.action_index DESC
            LIMIT 1`, idArgs);
        if(!identity || !identity.length)
            return [null];
        let row    = identity[0];
        let pubkey = row.signing_pubkey;
        let source = row.source;

        // Active stake: an aggregate over ONE pubkey's rows (signing_pubkey_id is indexed),
        // never a GROUP BY across validators. deactivation_block IS NULL is what "still
        // active" means on this ledger; a superseded row carries the height it stopped at.
        let totals = await this.doQuery(config,
            `SELECT
                count(*) as position_count,
                COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as active_stake
            FROM
                stakes m
                LEFT JOIN index_pubkeys  a3 ON (a3.id=m.signing_pubkey_id)
                LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
            WHERE s1.status='valid' AND a3.pubkey=? AND m.deactivation_block IS NULL`, [pubkey]);

        let stakes = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.version,
                m.amount,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                stakes m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

        let unstakes = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.amount,
                m.cooldown_end_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                unstakes m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

        let delegations = await this.doQuery(config,
            `SELECT
                m.action_index,
                a2.address as source,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                delegations m
                INNER JOIN blocks           b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_addresses  a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys    a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses   s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

        // Key revocations belong with the delegation history rather than in a section of
        // their own: a DELEGATE v2/v3 revocation is the event that ENDS a delegated key's
        // validity, and reading it apart from the delegation it ends inverts the meaning.
        let revocations = await this.doQuery(config,
            `SELECT
                m.action_index,
                a2.address as source,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                stake_key_revocations m
                INNER JOIN blocks           b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_addresses  a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys    a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses   s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

        // Rotations name BOTH the key they replaced and the key they installed, so this key
        // is on either side of the pair and both are matched. See the frontier note: neither
        // pubkey column is indexed on contract_delegation_rotations today.
        let rotations = await this.doQuery(config,
            `SELECT
                m.id,
                m.target_table,
                m.delegation_action_index,
                m.stake_action_index,
                pp.pubkey as prev_signing_pubkey,
                np.pubkey as new_signing_pubkey,
                m.block_index,
                b1.block_time as timestamp
            FROM
                contract_delegation_rotations m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys pp ON (pp.id=m.prev_signing_pubkey_id)
                LEFT  JOIN index_pubkeys np ON (np.id=m.new_signing_pubkey_id)
            WHERE (pp.pubkey=? OR np.pubkey=?)
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey, pubkey]);

        let rewards = await this.doQuery(config,
            `SELECT
                m.id,
                m.reward_type,
                m.round_reference,
                m.amount,
                m.block_index,
                m.derive_block_index,
                b1.block_time as timestamp
            FROM
                validator_rewards m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys a3 ON (a3.id=m.signing_pubkey_id)
            WHERE a3.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        let claimable = await this._collectTrail(config, source, limit);

        // Both slash families. capability_slash_events is the equivocation bond-burn against
        // a CONSENSUS validator (keyed by the signing pubkey directly); slash_events is the
        // contract-stake burn emitted by an EXECUTE (also keyed by the staker's pubkey). One
        // family alone understates exposure, which is why the page carries both. The row
        // shape matches getCapabilitySlashEvents and the address staking panel (slashed
        // key + submitter + destination), so the same slash reads identically wherever
        // it surfaces.
        let capabilitySlashes = await this.doQuery(config,
            `SELECT
                m.id,
                m.slash_action_index,
                a3.pubkey as slashed_pubkey,
                m.capability,
                m.equiv_key,
                m.amount,
                m.bounty_amount,
                m.treasury_amount,
                sub.address as submitter,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                capability_slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   a3  ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_addresses sub ON (sub.id=m.submitter_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE a3.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        let contractSlashes = await this.doQuery(config,
            `SELECT
                m.id,
                m.execution_index,
                m.target_contract_index,
                t3.tick,
                m.amount,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   a3  ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3  ON (t3.id=m.tick_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE a3.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        let nodeproofs = await this.doQuery(config,
            `SELECT
                m.id,
                m.action_index,
                m.challenge_id,
                m.epoch_height,
                m.target_height,
                a3.address as staking_source,
                m.passed,
                m.block_index,
                b1.block_time as timestamp
            FROM
                full_node_verifications m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   pk ON (pk.id=m.signing_pubkey_id)
                LEFT  JOIN index_addresses a3 ON (a3.id=m.source_id)
            WHERE pk.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        // Attestation quality is keyed by the RAW pubkey string (attest_validator_stats has
        // no index_pubkeys id), one row per provider the validator serves.
        let attestationQuality = await this.doQuery(config,
            `SELECT
                m.id,
                m.validator_pubkey,
                m.provider_id,
                m.fulfilled_count,
                m.missed_count,
                m.slashed_count,
                m.quality_score,
                m.last_updated_block
            FROM
                attest_validator_stats m
            WHERE m.validator_pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        let capabilities = await this._validatorCapabilityRows(config, pubkey, limit);

        // The hub registry decorates, never gates: getFederationRegistry returns null when
        // no registry is reachable at all, and null means UNKNOWN, not "unregistered".
        let registry = await this.getFederationRegistry(config);
        let entry    = (registry && pubkey) ? registry[String(pubkey).toLowerCase()] : null;

        return [{
            query:              search,
            signing_pubkey:     pubkey,
            source:             source,
            stake_action_index: row.stake_action_index,
            version:            row.version,
            activation_block:   row.activation_block,
            deactivation_block: row.deactivation_block,
            block_index:        row.block_index,
            registry:           (entry) ? entry : null,
            registry_known:     (registry !== null),
            active_stake:       this.util.bcformat((totals && totals.length) ? totals[0].active_stake : 0, 8),
            position_count:     (totals && totals.length) ? Number(totals[0].position_count) : 0,
            capabilities:       capabilities,
            stakes:             stakes      || [],
            unstakes:           unstakes    || [],
            delegations:        delegations || [],
            revocations:        revocations || [],
            rotations:          rotations   || [],
            rewards:            rewards     || [],
            rewards_total:      claimable.rewards_total,
            collected_total:    claimable.collected_total,
            claimable:          claimable.claimable,
            collects:           claimable.collects,
            capability_slash_events: capabilitySlashes || [],
            slash_events:            contractSlashes   || [],
            nodeproofs:              nodeproofs        || [],
            attestation_quality:     attestationQuality || []
        }];
    }

    // The COLLECT trail for ONE staking address, shared by the validator page and the
    // address staking panel so the two can never disagree about what "claimable" means.
    // Accrual (validator_rewards) minus claims (reward_claims), both summed in SQL over an
    // indexed source_id lookup rather than over a fetched page, because a page-local sum
    // would silently under-report the moment a validator has more rows than one page.
    async _collectTrail(config, source, limit){
        let accrued = await this.doQuery(config,
            `SELECT COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as total
             FROM validator_rewards m
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
             WHERE a2.address=?`, [source]);
        let claimed = await this.doQuery(config,
            `SELECT COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as total
             FROM reward_claims m
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
             WHERE s1.status='valid' AND a2.address=?`, [source]);
        let collects = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.amount,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                reward_claims m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [source]);
        // One wire type for all three figures: a fixed-8 decimal STRING, matching how
        // every other XCHAIN amount is serialized. The SQL sums come back at the CAST's
        // 18 decimal places and bcsub returns a mathjs bignumber OBJECT, so both are
        // formatted rather than passed through; an unformatted bignumber serializes as a
        // mathjs envelope, not as a number a page can print.
        let accruedTotal = (accrued && accrued.length) ? accrued[0].total : 0;
        let claimedTotal = (claimed && claimed.length) ? claimed[0].total : 0;
        return {
            rewards_total:   this.util.bcformat(accruedTotal, 8),
            collected_total: this.util.bcformat(claimedTotal, 8),
            claimable:       this.util.bcformat(this.util.bcsub(accruedTotal, claimedTotal, 8), 8),
            collects:        collects || []
        };
    }

    // Per-capability qualification rows for ONE signing pubkey, on the same dual transport
    // getValidatorCapabilities serves the list view over. Kept as its own helper so the
    // composition cannot drift into a second, differently-degrading copy of that rule.
    // The RPC leg filters server-side by signing_pubkey; an EMPTY array back is a legitimate
    // "qualified for nothing", while a null past the stale ceiling is an OUTAGE and throws.
    async _validatorCapabilityRows(config, pubkey, limit){
        let ops = this.explorer ? this.explorer.hubOperational : null;
        if(ops && ops.enabled()){
            let rows = await ops.getValidatorCapabilities({ signing_pubkey: pubkey });
            if(rows) return this._normalizeHubOperationalRows(rows.slice(0, limit));
            this._hubOperationalOutage('validator_capabilities');
        }
        let src  = this._hubSource(config, 'validator_capabilities');
        let rows = await this.doQuery(config,
            `SELECT
                m.id,
                m.signing_pubkey,
                m.capability,
                m.qualified,
                m.self_test_ok,
                m.enabled,
                m.qualified_at_block,
                m.updated_at
            FROM ${src.table} m
            WHERE m.signing_pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);
        return this._normalizeHubOperationalRows(rows || []);
    }

    // ATTEST v2 (expire) mints an action and writes NO ROW, so `attests` names neither
    // side of the pair. The two are correlated POSITIONALLY WITHIN THE BLOCK, which is
    // exact rather than a guess, because the indexer fixes both orders:
    //   - the sweep selects what it expires in ONE deterministic order
    //     (xchain-indexer db.getExpiredAttestationRequests: deadline_block ASC,
    //     action_index ASC) and mints one v2 action per selected request in that loop,
    //     so the v2 action indexes ascend in exactly that order;
    //   - request_status 'expired' is written by that sweep and by NOTHING else (the
    //     v1/v3/v4 response paths write only 'fulfilled' or 'errored'; a retryable
    //     round leaves the request pending), so the two lists cover the same set.
    // Equal length is therefore an INVARIANT, and it is checked rather than assumed:
    // a block where the two disagree yields no link at all, because a rank correlation
    // over unequal lists names the WRONG request, which is worse than naming none.
    //
    // The rank machinery is only load-bearing for a block that expired several requests
    // at once; the common block carries one of each.
    async _correlateAttestationExpiries(config, blockIndex){
        if(this.util.isNull(blockIndex)) return [];
        // Bounded well above the indexer's per-block expiry cap
        // (ATTEST_MAX_EXPIRIES_PER_BLOCK = 25) so a raised cap widens the read instead of
        // silently truncating one list and disabling the correlation.
        let cap = 100;
        let acts = await this.doQuery(config,
            `SELECT
                a1.action_index
            FROM
                actions a1
                INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
            WHERE a1.block_index=? AND a2.action='ATTEST' AND a1.action_format=2
            ORDER BY a1.action_index ASC
            LIMIT ` + cap, [blockIndex]);
        if(!acts || !acts.length) return [];
        let reqs = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.request_id,
                m.provider_id,
                m.contract_index,
                m.callback_method,
                m.deadline_block,
                m.request_status,
                m.resolved_block
            FROM attests m
            WHERE m.version=0 AND m.request_status='expired' AND m.resolved_block=?
            ORDER BY m.deadline_block ASC, m.action_index ASC
            LIMIT ` + cap, [blockIndex]);
        if(!reqs || reqs.length !== acts.length) return [];
        return acts.map((a, i) => ({
            expire_action_index: a.action_index,
            request:             reqs[i]
        }));
    }

    // The v2 expire action that retired one v0 request row, or null when the block's
    // two lists do not line up (see _correlateAttestationExpiries).
    async _resolveAttestationExpireAction(config, request){
        if(!request || String(request.request_status) !== 'expired') return null;
        let pairs = await this._correlateAttestationExpiries(config, request.resolved_block);
        let hit   = pairs.find(p => p.request && String(p.request.request_id) === String(request.request_id));
        return (hit) ? hit.expire_action_index : null;
    }

    // The inverse read, for the ACTION page of a v2: the v0 request this expire retired.
    async resolveAttestationExpireRequest(config, expireActionIndex, blockIndex){
        let pairs = await this._correlateAttestationExpiries(config, blockIndex);
        let hit   = pairs.find(p => Number(p.expire_action_index) === Number(expireActionIndex));
        return (hit) ? hit.request : null;
    }

    // Seed the lifecycle page from a v2 expire's own action_index. Reads the action's
    // block (the expire writes no attests row, so there is nothing else to key on) and
    // hands back the correlated v0 request row.
    async _seedAttestationFromExpireAction(config, actionIndex){
        if(!this.util.isNumeric(actionIndex)) return null;
        let rows = await this.doQuery(config,
            `SELECT
                a1.block_index,
                a1.action_format
            FROM
                actions a1
                INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
            WHERE a1.action_index=? AND a2.action='ATTEST' AND a1.action_format=2
            LIMIT 1`, [Number(actionIndex)]);
        if(!rows || !rows.length) return null;
        return await this.resolveAttestationExpireRequest(config, Number(actionIndex), rows[0].block_index);
    }

    // The system-injected callback EXECUTE for one request.
    //
    // attests.callback_execute_action_index is stamped on the v1 RESPONSE row only
    // (xchain-indexer setAttestationResponseCallbackIndex ... WHERE version = 1), so an
    // EXPIRED request has no stored link anywhere: the v2 sweep injects the expired
    // callback (_injectExpiredCallback) and there is no v1 row to stamp. The execution
    // itself is unambiguous on its own columns: the injected EXECUTE calls the request's
    // OWN contract and callback method with the request_id as its first positional
    // parameter (INPUT_PARAMS is the '|'-joined argument list), and a request id is
    // unique chain-wide, so this identifies exactly the callback for THIS request.
    //
    // The id is re-validated as 64 hex before it reaches the LIKE: a request_id is the
    // only user-influenced part of the pattern and hex carries no % or _ wildcard.
    async _deriveAttestationCallbackExecute(config, request){
        if(!request) return null;
        let requestId = String(request.request_id || '').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(requestId)) return null;
        if(this.util.isNull(request.contract_index) || this.util.isNull(request.callback_method)) return null;
        let rows = await this.doQuery(config,
            `SELECT
                m.action_index
            FROM contract_executions m
            WHERE m.contract_index=? AND m.method_name=? AND m.input_params LIKE CONCAT(?, '|%')
            ORDER BY m.action_index ASC
            LIMIT 1`, [request.contract_index, request.callback_method, requestId]);
        return (rows && rows.length) ? rows[0].action_index : null;
    }

    // Composed ATTESTATION lifecycle (M4.3). QUERY is EITHER the 64-hex request_id (the
    // correlation key every leg carries) or the action_index of any ATTEST action in the
    // round. A numeric QUERY resolves through getAttestationByActionIndex, the positional-arg
    // point read the WS ChangeDetector already owns: it is REUSED here rather than re-routed
    // or reshaped, because the detector depends on its signature exactly as it stands.
    //
    // WHAT THE SCHEMA FORCED, and it contradicts the obvious reading of the lifecycle:
    // ATTEST v2 (expire) writes NO ROW OF ITS OWN. It is system-synthesized, allocates an
    // action_index with FORMAT 2, and then only FLIPS the v0 request row's request_status to
    // 'expired' and stamps resolved_block (xchain-indexer attest.js _parseExpire). So the
    // expiry leg below is DERIVED from the request row, not selected from a v2 row. The
    // expire ACTION does exist and has a working page, so it is resolved through the
    // in-block correlation above and named here rather than declared unlinkable.
    //
    // Relay legs (ATTEST v3/v4) likewise write ordinary version 0 / version 1 rows carrying
    // origin_chain + origin_action_index, so they arrive in the same request_id read; the
    // relay block below names them rather than issuing a second query for rows that are by
    // construction on ANOTHER chain's indexer DB.
    async getAttestation(config){
        let limit  = this._detailLimit(config);
        let search = config.data.search;
        let requestId = null;
        if(this.util.isNumeric(search)){
            let seed = await this.getAttestationByActionIndex(config, Number(search));
            // A v2 expire has no attests row, so the point read answers nothing for it and
            // the lifecycle page for the expire's own action_index rendered NOT FOUND. The
            // in-block correlation resolves it to the request it retired.
            if(!seed) seed = await this._seedAttestationFromExpireAction(config, Number(search));
            if(!seed) return [null];
            requestId = seed.request_id;
        } else {
            requestId = String(search || '').toLowerCase();
        }
        if(!requestId) return [null];

        // Every leg of one round in one bounded read, oldest first so the caller renders the
        // lifecycle in the order it happened. request_id+version is indexed.
        //
        // `blocks` resolves off the action's own block_index, not the transaction's: a
        // mirror-applied response has an action_index but no transaction row, and routing
        // through t1 left the timestamp NULL for it (attest-response-mirror spec section 4.4).
        let rows = await this.doQuery(config,
            `SELECT
                a4.action,
                m.action_index,
                a1.action_format,
                m.version,
                m.request_id,
                m.provider_id,
                m.contract_index,
                a2.address as source,
                fp.address as fee_payer,
                m.payload,
                m.callback_method,
                m.callback_params_json,
                m.redundancy,
                m.deadline_block,
                m.gas_escrow,
                ft.tick as fee_tick,
                m.fee_amount,
                m.request_status,
                m.resolved_block,
                m.responsible_set_json,
                m.origin_chain,
                m.origin_action_index,
                m.response_hash,
                m.response_payload,
                m.response_status,
                m.meta,
                m.validator_signatures,
                m.callback_execute_action_index,
                m.batch_action_index,
                m.block_index,
                b1.block_time as timestamp,
                t2.hash as tx_hash,
                t1.tx_index,
                s1.status
            FROM
                attests m
                LEFT JOIN actions             a1 ON (a1.action_index=m.action_index)
                LEFT JOIN transactions        t1 ON (t1.tx_index=a1.tx_index)
                LEFT JOIN blocks              b1 ON (b1.block_index=a1.block_index)
                LEFT JOIN index_addresses     a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                LEFT JOIN index_addresses     fp ON (fp.id=m.fee_payer_id)
                LEFT JOIN index_tickers       ft ON (ft.id=m.fee_tick_id)
                LEFT JOIN index_statuses      s1 ON (s1.id=m.status_id)
                LEFT JOIN index_transactions  t2 ON (t2.id=t1.tx_hash_id)
                LEFT JOIN index_actions       a4 ON (a4.id=a1.action_id)
            WHERE m.request_id=?
            ORDER BY m.version ASC, m.action_index ASC
            LIMIT ` + limit, [requestId]);
        if(!rows || !rows.length) return [null];

        let request  = rows.find(r => Number(r.version) === 0) || null;
        let response = rows.find(r => Number(r.version) === 1) || null;
        if(request){
            try { request.callback_params = this.util.isNull(request.callback_params_json) ? null : JSON.parse(request.callback_params_json); }
            catch(e){ request.callback_params = request.callback_params_json; }
            // The responsible set was PINNED as-of the request block; it is the electorate a
            // reader checks the response signatures against, so it is parsed, not echoed raw.
            request.responsible_set = this._parseSignaturesArray(request.responsible_set_json);
        }
        if(response)
            response.quorum_signatures = this._parseSignaturesArray(response.validator_signatures);

        let status = (request) ? request.request_status : null;

        // The stored callback link lives on the v1 RESPONSE row alone, so an EXPIRED
        // request - which has no v1 row at all - reported "no callback execution
        // recorded" while the injected expired-callback EXECUTE sat on chain a couple of
        // indexes away. Derive it for that case, and flag the derivation so the page can
        // say where the link came from instead of implying the indexer stamped it.
        let callbackIndex   = (response) ? response.callback_execute_action_index : null;
        let callbackDerived = false;
        let expireAction    = null;
        if(request && status === 'expired'){
            expireAction = await this._resolveAttestationExpireAction(config, request);
            if(this.util.isNull(callbackIndex)){
                callbackIndex   = await this._deriveAttestationCallbackExecute(config, request);
                callbackDerived = !this.util.isNull(callbackIndex);
            }
        }

        return [{
            query:      config.data.search,
            request_id: requestId,
            provider_id: rows[0].provider_id,
            legs:       rows,
            request:    request,
            response:   response,
            // Derived, because ATTEST v2 persists no ROW. It does mint an ACTION, and
            // expire_action_index names it (null when the block's expire actions and
            // expired requests do not line up). `expired` is the stored terminal state,
            // never a clock comparison against deadline_block: a request past its deadline
            // that the expiry sweep has not reached yet is still 'pending'.
            expiry: {
                request_status:      status,
                deadline_block:      (request) ? request.deadline_block : null,
                resolved_block:      (request) ? request.resolved_block : null,
                expired:             status === 'expired',
                expire_action_index: expireAction
            },
            relay: {
                is_relay:            !!(request && !this.util.isNull(request.origin_chain)),
                origin_chain:        (request) ? request.origin_chain : null,
                origin_action_index: (request) ? request.origin_action_index : null,
                response_relayed:    !!(response && !this.util.isNull(response.origin_action_index))
            },
            callback_execute_action_index: callbackIndex,
            callback_execute_derived:      callbackDerived
        }];
    }

    // Composed ANCHOR detail (M4.5). QUERY is the ANCHOR's action_index, or the DOGE
    // transaction hash it landed in. The two are told apart in JS rather than bound into one
    // OR: action_index is a BIGINT column and a 64-hex hash compared against it is coerced,
    // not matched, so an OR would answer 0 rows for the hash form without erroring.
    //
    // Three legs beyond the payload, and each reads a DIFFERENT source:
    //   - the covering hub-mirror state_checkpoints row, through the SAME correlated
    //     latest-checkpoint_seq-per-height predicate getCheckpoints/getCommitments use
    //     (_latestCheckpointPredicate), never a fourth differently-bounded variant;
    //   - the publisher ELECTION, from capability_snapshots at this anchor's snapshot_block.
    //     That table is CHAIN-AGNOSTIC (no chain/network columns; its key is
    //     snapshot_block+capability+signing_pubkey+source), so src.filter/filterParams are
    //     deliberately NOT bound to it;
    //   - the reward-attestation trail, from anchor_reward_attestations, which IS
    //     chain-scoped (chain/network are in uq_reward_tuple), so the same src.filter IS
    //     bound there, first, exactly as getAnchorRewardAttestations binds it.
    // Getting that asymmetry backwards yields a query that is silently wrong rather than one
    // that errors, in whichever direction the blanket rule was applied.
    //
    // archive_b64 is never selected. It is a MEDIUMTEXT gzip chunk with nothing legible in
    // it; its LENGTH and crc32 are what a reader can actually check an archive against.
    async getAnchor(config){
        let limit  = this._detailLimit(config);
        let search = config.data.search;
        let numeric   = this.util.isNumeric(search);
        let predicate = numeric ? 'm.action_index=?' : 't2.hash=?';
        let key       = numeric ? Number(search) : String(search || '').toLowerCase();
        let rows = await this.doQuery(config,
            `SELECT
                a4.action,
                m.action_index,
                m.section_index,
                a1.action_format,
                m.version,
                m.chain,
                m.network,
                m.block_index,
                m.block_hash,
                m.ledger_hash,
                m.actions_hash,
                m.contract_hash,
                m.checkpoint_seq,
                m.snapshot_block,
                m.state_root,
                m.state_root_version,
                m.block_merkle_root,
                m.block_merkle_version,
                m.match_batch_seq,
                m.match_count,
                m.batch_crc32,
                m.total_chunks,
                m.chunk_index,
                CHAR_LENGTH(m.archive_b64) as archive_b64_length,
                m.validator_signatures,
                m.publisher,
                m.publisher_attestations,
                m.block_index_doge,
                b1.block_time as timestamp,
                t2.hash as tx_hash,
                t1.tx_index,
                s1.status
            FROM
                anchor_actions m
                INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
            WHERE ` + predicate + `
            ORDER BY m.action_index DESC, m.section_index ASC
            LIMIT 1`, [key]);
        if(!rows || !rows.length) return [null];
        let row = rows[0];
        row.validator_signatures   = this._parseSignaturesArray(row.validator_signatures);
        // The v4/v5/v6 XANCPUB tail is RAW WIRE transport, not the quorum-verified subset
        // (anchor_actions.sql), so it is parsed for display and named as attestations to
        // re-verify, never presented as a verified quorum.
        row.publisher_attestations = this._parseSignaturesArray(row.publisher_attestations);

        // A v0 ANCHOR is a BUNDLE: one action carrying every checkpointed chain, stored as
        // N sibling rows sharing one action_index at section_index 0..N-1. Each row holds
        // its OWN chain, block_index, checkpoint_seq, roots and validator signatures; the
        // bundle-level fields (version, network, publisher, publisher_attestations, status,
        // txid, the DOGE block it landed in) are denormalized identically onto every row,
        // which is why the spine above can serve as the header no matter which section it
        // matched. Archive rows (v1/v2) and every retired per-chain version stay at
        // section_index 0, so they take no second query at all.
        //
        // snapshot_block on the header is the BUNDLE's block, the MAX over the sections: a
        // chain that lagged rides at its own older SECTION_SNAPSHOT_BLOCK, but the election
        // and the publisher attestation were both drawn at the MAX. Reading section 0's
        // block as the bundle's would look the electorate up at the wrong height.
        row.sections      = [];
        row.section_count = 1;
        if(Number(row.version) === 0){
            let sections = await this.doQuery(config,
                `SELECT
                    m.section_index,
                    m.chain,
                    m.network,
                    m.block_index,
                    m.block_hash,
                    m.ledger_hash,
                    m.actions_hash,
                    m.contract_hash,
                    m.checkpoint_seq,
                    m.snapshot_block,
                    m.state_root,
                    m.state_root_version,
                    m.block_merkle_root,
                    m.block_merkle_version,
                    m.validator_signatures,
                    s1.status
                FROM
                    anchor_actions m
                    LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
                WHERE m.action_index=?
                ORDER BY m.section_index ASC
                LIMIT ` + limit, [Number(row.action_index)]) || [];
            row.sections = sections.map(s => {
                s.validator_signatures = this._parseSignaturesArray(s.validator_signatures);
                return s;
            });
            if(row.sections.length){
                row.section_count = row.sections.length;
                let blocks = row.sections
                    .map(s => this.util.isNull(s.snapshot_block) ? null : Number(s.snapshot_block))
                    .filter(v => v !== null);
                if(blocks.length) row.snapshot_block = Math.max(...blocks);
            }
        }

        // Continuation chunks (v2) share the archive batch id. Bounded: a large archive
        // splits into as many chunks as it needs, so this list has no natural ceiling.
        let chunks = [];
        if(!this.util.isNull(row.match_batch_seq))
            chunks = await this.doQuery(config,
                `SELECT
                    m.action_index,
                    m.version,
                    m.chunk_index,
                    m.total_chunks,
                    CHAR_LENGTH(m.archive_b64) as archive_b64_length,
                    m.block_index_doge,
                    s1.status
                FROM
                    anchor_actions m
                    LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
                WHERE m.match_batch_seq=?
                ORDER BY m.chunk_index ASC
                LIMIT ` + limit, [row.match_batch_seq]) || [];

        let src         = this._checkpointSource(config);
        let scFilter    = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let latest      = this._latestCheckpointPredicate(src, 'sc');
        // The anchor names the CHECKPOINTED height on the CHECKPOINTED chain, which is what
        // state_checkpoints is keyed by too, so this coin's own (chain, network) identity is
        // the right filter here (the same reasoning getCommitments' anchor leg carries).
        //
        // A BUNDLE carries several chains at once, so the height to look up is THIS coin's
        // own section, not whichever section the spine happened to match. Keying a
        // chain-filtered mirror query by another chain's height cannot error: it returns
        // zero rows, and the page then reads a perfectly good bundle as uncovered.
        let localSection = row.sections.find(s =>
            String(s.chain || '').toUpperCase() === String(src.filterParams[0] || '').toUpperCase()) || null;
        let coveredHeight = localSection ? localSection.block_index : row.block_index;
        row.local_section_index = localSection ? localSection.section_index : null;
        let checkpoint = [];
        if(!this.util.isNull(coveredHeight))
            checkpoint = await this.doQuery(config,
                `SELECT
                    sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash,
                    sc.actions_hash, sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block,
                    sc.state_root, sc.state_root_version, sc.block_merkle_root,
                    sc.block_merkle_version, sc.validator_signatures, sc.created_at
                FROM ${src.table} sc
                WHERE sc.block_index = ?${scFilter}${latest.sql}
                LIMIT 1`, [Number(coveredHeight), ...src.filterParams, ...latest.params]) || [];

        // Publisher election. capability_snapshots is CHAIN-AGNOSTIC: no chain/network
        // filter is bound, matching getCapabilitySnapshots. 'oracle_publish' is the
        // capability the publisher election draws its set from.
        let electorate = [];
        if(!this.util.isNull(row.snapshot_block))
            electorate = await this.doQuery(config,
                `SELECT
                    m.signing_pubkey,
                    m.amount,
                    m.source
                FROM ${src.capTable} m
                WHERE m.snapshot_block=? AND m.capability=?
                ORDER BY m.id ASC
                LIMIT ` + limit, [Number(row.snapshot_block), 'oracle_publish']) || [];

        // Reward trail. CHAIN-SCOPED, so filterParams lead. Correlated on the mined DOGE
        // txid this anchor landed in, OR on the table's own natural key minus publisher
        // (snapshot_block + the round this anchor closed: checkpoint_seq for a checkpoint
        // anchor, match_batch_seq for an archive one, the SNAPSHOT BLOCK itself for a v0
        // bundle, whose single anchor_bundle reward is keyed round_reference =
        // SNAPSHOT_BLOCK rather than to any one section's checkpoint_seq).
        let outerFilter = src.filter.replace(/\b(chain|network)\b/g, 'm.$1');
        let rounds = [row.checkpoint_seq, row.match_batch_seq,
                      (Number(row.version) === 0) ? row.snapshot_block : null]
            .filter(v => !this.util.isNull(v)).map(v => Number(v));
        let rewardWhere = 'm.doge_anchor_txid=?';
        let rewardArgs  = [...src.filterParams, row.tx_hash];
        if(rounds.length && !this.util.isNull(row.snapshot_block)){
            rewardWhere += ` OR (m.snapshot_block=? AND m.round_reference IN (${rounds.map(() => '?').join(',')}))`;
            rewardArgs.push(Number(row.snapshot_block), ...rounds);
        }
        let rewards = await this.doQuery(config,
            `SELECT
                m.id,
                m.chain,
                m.network,
                m.reward_type,
                m.round_reference,
                m.snapshot_block,
                m.publisher,
                m.reward_amount,
                m.doge_anchor_txid,
                m.created_at
            FROM ${src.rewardTable} m
            WHERE 1=1` + outerFilter + ` AND (` + rewardWhere + `)
            ORDER BY m.id DESC
            LIMIT ` + limit, rewardArgs) || [];

        row.chunks             = chunks;
        row.checkpoint         = (checkpoint.length) ? this._normalizeCheckpointRows(checkpoint)[0] : null;
        row.publisher_election = electorate;
        row.reward_attestations = rewards;
        return [row];
    }

    // Composed ADDRESS STAKING panel (M4.6). One address, four questions the raw tabs below
    // it cannot answer together: what is staked, what is cooling down and when it matures,
    // what is claimable, and what has been slashed out from under it.
    //
    // Maturity is computed against the indexer's own tip (getMaxBlockIndex), not wall clock,
    // so every explorer host answers identically and the number matches the consensus rule
    // that releases the funds.
    //
    // Slash exposure has to reach the address through the KEYS it staked with, because
    // neither slash table carries an address of the slashed party: capability_slash_events
    // and slash_events both name a signing pubkey. So each family is scoped by the pubkey set
    // this address staked, drawn from the ledger that family actually burns from (`stakes`
    // for the capability family, `contract_stakes` for the contract family). Scoping both
    // from one ledger would over- or under-report, depending which one was picked.
    async getAddressStaking(config){
        let limit   = this._detailLimit(config);
        let address = config.data.search;
        if(this.util.isNull(address)) return [null];
        let tip = await this.getMaxBlockIndex(config);

        let positions = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.version,
                a3.pubkey as signing_pubkey,
                m.target_contract_index,
                t3.tick,
                m.amount,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                contract_stakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

        let capabilityPositions = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.version,
                a3.pubkey as signing_pubkey,
                m.amount,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                stakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

        let cooldowns = await this.doQuery(config,
            `SELECT
                m.action_index,
                a3.pubkey as signing_pubkey,
                m.target_contract_index,
                t3.tick,
                m.amount,
                m.cooldown_end_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                contract_unstakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

        let capabilityCooldowns = await this.doQuery(config,
            `SELECT
                m.action_index,
                a3.pubkey as signing_pubkey,
                m.amount,
                m.cooldown_end_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                unstakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

        for(let row of [...(cooldowns || []), ...(capabilityCooldowns || [])]){
            let end = Number(row.cooldown_end_block);
            row.blocks_remaining = Math.max(0, end - tip);
            row.matured          = tip >= end;
        }

        let trail = await this._collectTrail(config, address, limit);
        let rewards = await this.doQuery(config,
            `SELECT
                m.id,
                a3.pubkey as signing_pubkey,
                m.reward_type,
                m.round_reference,
                m.amount,
                m.block_index,
                b1.block_time as timestamp
            FROM
                validator_rewards m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
            WHERE a2.address=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [address]);

        // Row shape matches getCapabilitySlashEvents and the validator page's slash
        // leg (slashed key + submitter + destination), so the same slash reads
        // identically wherever it surfaces.
        let capabilitySlashes = await this.doQuery(config,
            `SELECT
                m.id,
                m.slash_action_index,
                pk.pubkey as slashed_pubkey,
                m.capability,
                m.equiv_key,
                m.amount,
                m.bounty_amount,
                m.treasury_amount,
                sub.address as submitter,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                capability_slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   pk  ON (pk.id=m.signing_pubkey_id)
                LEFT  JOIN index_addresses sub ON (sub.id=m.submitter_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE m.signing_pubkey_id IN (
                SELECT s.signing_pubkey_id FROM stakes s
                    INNER JOIN index_addresses sa ON (sa.id=s.source_id)
                WHERE sa.address=?)
            ORDER BY m.id DESC
            LIMIT ` + limit, [address]);

        let contractSlashes = await this.doQuery(config,
            `SELECT
                m.id,
                m.execution_index,
                m.target_contract_index,
                pk.pubkey as slashed_pubkey,
                t3.tick,
                m.amount,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   pk  ON (pk.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3  ON (t3.id=m.tick_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE m.signing_pubkey_id IN (
                SELECT cs.signing_pubkey_id FROM contract_stakes cs
                    INNER JOIN index_addresses sa ON (sa.id=cs.source_id)
                WHERE sa.address=?)
            ORDER BY m.id DESC
            LIMIT ` + limit, [address]);

        return [{
            address:              address,
            chain_tip:            tip,
            positions:            positions           || [],
            capability_positions: capabilityPositions || [],
            cooldowns:            cooldowns           || [],
            capability_cooldowns: capabilityCooldowns || [],
            rewards:              rewards             || [],
            rewards_total:        trail.rewards_total,
            collected_total:      trail.collected_total,
            claimable:            trail.claimable,
            collects:             trail.collects,
            capability_slash_events: capabilitySlashes || [],
            slash_events:            contractSlashes   || []
        }];
    }

    // XCALL phase transitions latched since the cursor's block (spec
    // explorer-coverage-completion M5.4). This is the XCALL analogue of
    // getBetFeedsClosedSince and exists for the same reason: the transition that ends a
    // call's life on the SOURCE chain - request_status going pending -> completed - is a
    // direct status write performed by the callback interlock, with NO action row of its
    // own for the ChangeDetector's actions cursor to find. `resolved_block` is the height
    // at which that write happened, so it is the cursor column.
    //
    // Expired calls are included even though XCALL v2 does mint an action row: the v2
    // action is a SEPARATE xcalls row (version 2) whose action name is XCALL, so a
    // subscriber filtering on the phase events would otherwise see completions but not
    // expiries, which is the asymmetry that makes a live timeline wrong rather than
    // merely incomplete. The event carries `synthetic` so a consumer can tell which of
    // the two had a causing action.
    // Current phase of ONE cross-chain call, for the WS `xcall` channel's SNAPSHOT
    // frame (spec explorer-coverage-completion M5.4). Sibling of getBetFeedInfo /
    // getDispenserInfo: a plain (config, key) point read that the WS server can call
    // without assembling a request config. Null when this chain has no row for the
    // call_id, which is a normal answer on the TARGET chain of a call.
    //
    // Pinned to the VALID row for the same reason getXcall is: a call_id can carry
    // more than one xcalls row (a rejected attempt indexes alongside the accepted
    // request), and a snapshot built from an invalid row would open the subscription
    // on a lifecycle that never happened.
    async getXcallInfo(config, callId){
        let rows = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.version,
                m.call_id,
                m.contract_index,
                a2.address as source,
                m.target_chain,
                m.target_contract_index,
                m.method,
                m.gas_limit,
                m.deadline_block,
                m.request_status,
                m.result_status,
                m.resolved_block,
                m.callback_action_index,
                m.block_index,
                s1.status
            FROM
                xcalls m
                LEFT JOIN actions         a1 ON (a1.action_index=m.action_index)
                LEFT JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                LEFT JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                LEFT JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE m.call_id=? AND s1.status='valid'
            ORDER BY m.action_index DESC
            LIMIT 1`, [callId]);
        return (rows && rows.length) ? rows[0] : null;
    }

    async getXcallPhasesSince(config, sinceBlockIndex, limit){
        let query = `SELECT
                        m.action_index,
                        m.call_id,
                        m.version,
                        m.contract_index,
                        m.target_chain,
                        m.target_contract_index,
                        m.method,
                        m.request_status,
                        m.result_status,
                        m.resolved_block,
                        m.callback_action_index,
                        m.deadline_block,
                        a2.address as source,
                        s1.status
                    FROM
                        xcalls m
                        LEFT JOIN actions         a1 ON (a1.action_index=m.action_index)
                        LEFT JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT JOIN index_statuses  s1 ON (s1.id=m.status_id)
                    WHERE
                        m.resolved_block > ?
                        AND m.request_status IN ('completed','expired')
                        AND s1.status='valid'
                    ORDER BY m.resolved_block ASC, m.action_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlockIndex, limit]);
        return results || [];
    }

    async getAttestationsSince(config, sinceBlockIndex, limit){
        let query = `SELECT
                        m.action_index,
                        m.version,
                        m.request_id,
                        m.provider_id,
                        m.contract_index,
                        m.request_status,
                        m.response_status,
                        m.payload,
                        m.callback_params_json,
                        a2.address as source,
                        fp.address as fee_payer,
                        m.block_index,
                        s1.status
                    FROM
                        attests m
                        LEFT JOIN actions             a1 ON (a1.action_index=m.action_index)
                        LEFT JOIN transactions        t1 ON (t1.tx_index=a1.tx_index)
                        LEFT JOIN index_addresses     a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT JOIN index_addresses     fp ON (fp.id=m.fee_payer_id)
                        LEFT JOIN index_statuses      s1 ON (s1.id=m.status_id)
                    WHERE
                        m.block_index > ?
                    ORDER BY m.action_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlockIndex, limit]);
        return results || [];
    }

    async getAttestationByActionIndex(config, action_index){
        let query = `SELECT
                        m.action_index, m.version, m.request_id, m.provider_id, m.contract_index,
                        m.request_status, m.response_status, m.payload, m.callback_params_json, m.block_index,
                        fp.address as fee_payer
                    FROM attests m
                        LEFT JOIN index_addresses fp ON (fp.id=m.fee_payer_id)
                    WHERE m.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [action_index]);
        return (results && results.length) ? results[0] : null;
    }

}

// The families that have moved out under proposal B are attached here, after the
// class exists. Order is irrelevant: mixinReaders refuses a collision rather than
// letting require order decide a winner.
mixinReaders(Database.prototype, connectionMethods, queryBuilder,
    actionListReaders, marketReaders, stakingGovernanceReaders, checkpointReaders, entityReaders);

module.exports = Database;
module.exports.DbQueryError = DbQueryError;
module.exports.DbInputError = DbInputError;
module.exports.ACTION_SUMMARY_FIELDS = ACTION_SUMMARY_FIELDS;
module.exports.MUTABLE_ACTION_FIELDS = MUTABLE_ACTION_FIELDS;