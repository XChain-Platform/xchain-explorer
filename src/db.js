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
const mariadb = require('mariadb');
const DecoderConnector = require('./XChainDecoderConnector.js');
const { extractMethods } = require('./contract-introspect.js');
const coinsRegistry = require('./coins');
const poolSizing = require('./poolSizing');
const listEditResolution = require('./list_edit_resolution_activation');
const actionDetail = require('./action-detail');

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
    'vote_kind'                                                                                                    // Governance
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

// TTL of the cached per-coin tip-staleness verdict. Short enough that a freeze
// surfaces within one status poll, long enough that the per-request availability
// gate costs no extra query on a busy explorer.
const TIP_STALE_CACHE_TTL_MS = 15000;

// Raised by doQuery when the underlying query genuinely FAILED (connection
// unavailable after retries, or the DB rejected the statement), as opposed to
// succeeding with an empty result set. The request layer maps it to a 5xx so a
// transient DB outage reads as an outage, not as "no data" (M-4): before this,
// doQuery swallowed the error into `false` and callers rendered it as an empty
// result (e.g. an address showing a zero balance during an outage).
class DbQueryError extends Error {
    constructor(message, cause){
        super(message);
        this.name = 'DbQueryError';
        this.code = 'DB_ERROR';
        if(cause) this.cause = cause;
    }
}

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
            'getCheckpoints','getCapabilitySnapshots','getAnchorRewardAttestations','getCommitments'
        ];

    }

    async init(){
        await this.setupConnectionPools()
    }

    /******************************************************************
     * LRU Cache Helpers
     *****************************************************************/

    _cacheGet(cache, key){
        if(!cache.has(key)) return undefined;
        const val = cache.get(key);
        cache.delete(key);
        cache.set(key, val);
        return val;
    }

    _cacheSet(cache, key, value, maxSize = 1000){
        if(cache.has(key)) cache.delete(key);
        else if(cache.size >= maxSize) cache.delete(cache.keys().next().value);
        cache.set(key, value);
    }

    // May this action response be memoized? Only when it is genuinely immutable.
    // A DISPENSER / ORDER / SWAP response carries a live `state` block whose
    // give_remaining, status, expiration and allow/block lists are derived from
    // rows written after the action confirmed, so caching one freezes it: the
    // action LRU has no TTL and is invalidated only by a reorg.
    //
    // A NOT-FOUND response is not immutable either. When getActionType finds no
    // row yet (the normal state of an action_index in the seconds between its
    // block landing and the indexer writing its typed row), getActionData
    // builds an all-null response with no `state` block, so it used to pass
    // this guard and get memoized forever with no TTL and reorg-only
    // invalidation - permanently blanking the action for anyone who asked one
    // moment too early. A real response always carries `action_index` (every
    // handler selects it, and deblankBaseline supplies it for a row-less
    // variant), so its absence is exactly the not-found case and nothing else.
    _isCacheableAction(data){
        if(this.util.isNull(data) || this.util.isNull(data['action_index'])) return false;
        return this.util.isNull(data['state']);
    }
    // Build an id/action cache key scoped to the coin AND its current reorg
    // generation (M-3). Coin-scoping also stops a bare address/tick key from
    // colliding across coins on a multi-coin explorer; the generation prefix is
    // what makes a reorg invalidation cheap (see bumpReorgGeneration).
    _cacheKey(coin, key){
        return coin + ':' + (this._reorgGen[coin] || 0) + ':' + key;
    }

    // Invalidate this coin's id/action LRU entries after a reorg by advancing its
    // generation counter. Nothing is deleted eagerly: the old-generation keys are
    // simply unreachable and evicted by normal LRU pressure. Called from the
    // ChangeDetector tip-poll loop via checkReorgAndInvalidate.
    bumpReorgGeneration(coin){
        this._reorgGen[coin] = (this._reorgGen[coin] || 0) + 1;
    }

    // Detect a reorg cheaply on the ChangeDetector poll loop and invalidate the
    // id/action caches for the coin when one is seen (M-3). We can't observe the
    // indexer's internal reorg events without a new interface, but a reorg is
    // visible in the already-polled blocks table: the block at a previously-seen
    // height either vanishes (the tip rewound) or its hash changes (same height,
    // a different block). Either way the ^id / action_index space below that
    // height may have been reassigned, so we bump the generation. A failed read
    // throws (see doQuery) and is caught by the caller's poll guard, so a
    // transient DB blip does NOT spuriously invalidate: _lastTip is only advanced
    // after a clean read, and the missing-block check is skipped when the probe
    // itself fails. Piggybacks on the tip query the poll loop already needs.
    async checkReorgAndInvalidate(config){
        const coin = config.coin;
        // The blocks table stores no chain block hash; its identity columns are
        // *_hash_id references into index_transactions (ledger_hash_id is the
        // per-block ledger-state hash the indexer recomputes when a height is
        // replaced). Resolve it through the join and use it as the block's
        // identity for reorg detection.
        const tip  = await this.doQuery(config,
            `SELECT b1.block_index, t1.hash AS block_hash
             FROM blocks b1
             LEFT JOIN index_transactions t1 ON (t1.id=b1.ledger_hash_id)
             ORDER BY b1.block_index DESC LIMIT 1`, []);
        // Empty chain (no blocks yet): nothing to compare, nothing to invalidate.
        if(!tip || !tip.length || tip[0].block_index === null) return false;
        const curIndex = Number(tip[0].block_index);
        const curHash  = (tip[0].block_hash === undefined) ? null : tip[0].block_hash;
        const prev     = this._lastTip[coin];
        let reorg = false;
        if(prev){
            if(curIndex < prev.index){
                // Tip height went backwards: the chain was rolled back.
                reorg = true;
            } else {
                // Tip height is unchanged or higher; confirm the block still
                // present at the previously-seen height carries the same hash.
                // A differing (or absent) hash means blocks at/below that height
                // were replaced. doQuery throws on a read failure, so an absent
                // row here is a genuine "block is gone", not a swallowed error.
                const at = await this.doQuery(config,
                    `SELECT t1.hash AS block_hash
                     FROM blocks b1
                     LEFT JOIN index_transactions t1 ON (t1.id=b1.ledger_hash_id)
                     WHERE b1.block_index=? LIMIT 1`, [prev.index]);
                if(!at || !at.length){
                    // The row at the previously-seen height is gone entirely.
                    reorg = true;
                } else if(prev.hash !== null){
                    // Compare hashes only when the prior poll actually saw one;
                    // a NULL ledger_hash_id (hashing disabled or not yet
                    // computed) carries no identity to compare, and treating it
                    // as a mismatch would bump the generation on every poll.
                    const atHash = (at[0].block_hash === undefined) ? null : at[0].block_hash;
                    if(atHash !== prev.hash) reorg = true;
                }
            }
        }
        if(reorg) this.bumpReorgGeneration(coin);
        this._lastTip[coin] = { index: curIndex, hash: curHash };
        return reorg;
    }

    /******************************************************************
     * Database Connection Pool Functions
     *****************************************************************/

    // Best-effort close of every DISTINCT pool handle held in the given maps.
    // Entries are either {config, pool} wrappers (this.pools) or bare pools
    // (this.decoderPools), and the setup loop deliberately assigns ONE pool
    // object to several keys when they resolve to the same host/port/user/db, so
    // handles are deduped by identity: end() must run once per handle, not once
    // per key. Failures are swallowed because this runs on the way to replacing
    // the map, and a pool that cannot be closed must not block the rebuild.
    async _endPools(maps){
        let seen = new Set();
        for(let map of maps){
            if(!map) continue;
            for(let key in map){
                let entry = map[key];
                let pool  = (entry && entry.pool) ? entry.pool : entry;
                if(!pool || typeof pool.end !== 'function' || seen.has(pool)) continue;
                seen.add(pool);
                try { await pool.end(); } catch(e){ /* best-effort */ }
            }
        }
    }

    // Release every pool this instance holds and leave the maps empty. Called from
    // the process shutdown drain (src/shutdown.js), which is the only caller: a
    // serving explorer holds its pools for its whole lifetime. Public wrapper over
    // _endPools so the drain does not reach into a private method, and so the map
    // list stays in ONE place - a future third pool map added to setupConnectionPools
    // must be added to the _endPools call there, and this inherits it.
    async close(){
        await this._endPools([this.pools, this.decoderPools]);
        this.pools        = {};
        this.decoderPools = {};
    }

    async setupConnectionPools(){
        let coinConfigs = await this.configInfo.getConfig()

        // End previous pools before discarding the maps. Without this, any
        // re-entry to setup (config refresh, manual reload) reassigns
        // this.pools and orphans the prior mariadb.createPool() handles;
        // their kept-alive connections linger until the explorer process
        // exits, and MariaDB hits its max_connections ceiling in minutes
        // once refresh is active.
        //
        // decoderPools was missed when the guard above was first written, and it
        // is the DEFAULT shape rather than an edge case, because xchain-node
        // installs provision per-service DB users and so always take the
        // dedicated-pool branch below. _rebuildPoolsIfStale() re-enters here as
        // often as every 10s, so the omission leaked the decoder pool's 3
        // connections per coin per rebuild: one live regtest explorer had
        // accumulated 870 of that server's 1000 connections over four days, which
        // surfaced as OTHER services being unable to connect at all.
        await this._endPools([this.pools, this.decoderPools]);

        this.pools = {};
        // Per-coin decoder database name, used for the colocated-decoder reads
        // (decoder tip for /api/status lag, mempool rows, raw FILE bytes).
        // When the decoder DB shares server + credentials with the indexer DB
        // the reads reuse the indexer pool with database-qualified queries;
        // otherwise a DEDICATED per-coin pool is created (decoderPools below).
        this.decoderDb = {};
        // Per-coin dedicated decoder-DB pools, created when the decoder DB does
        // NOT share credentials with the indexer DB (the norm on xchain-node
        // installs, which provision per-service DB users. Same-credentials
        // deployments make no entry here and reuse the indexer pool.
        this.decoderPools = {};
        // Per-coin decoder JSON-RPC endpoint (NOT a database), derived from the
        // same config entry the decoder pool above is built from. Feeds the
        // chain_tip / chain_lag_blocks / decoder_health block of /api/status,
        // which is the only place the chain->decoder gap is visible: the
        // explorer reads DBs only, so a decoder stalled behind its coin node
        // still reports decoder_lag_blocks 0 once the indexer catches up to it.
        // Absent for a coin whose config carries no endpoint; that coin reports
        // decoder_health 'unconfigured'. See _decoderApiUrlFromConfig.
        this.decoderApiUrl = {};
        // Per-coin checkpoint-source database: the MANDATORY co-located hub DB for
        // serving the hub-mirrored tables (state_checkpoints, capability_snapshots,
        // cross_chain_matches, price_snapshots, oracle_prices). xchain-sync excludes
        // these tables from every snapshot and stream, so a serving node has no
        // replicated copy and MUST read them from the hub DB on the same server via a
        // per-network `checkpoint` config block, honored only when it shares server +
        // credentials with the indexer pool and read database-qualified, filtered by
        // chain/network so the per-coin endpoints don't leak siblings. This is a hard
        // requirement: a serving coin with no entry here makes _checkpointSource /
        // _matchSource / _oracleMirrorSource throw instead of falling back to a stale
        // local mirror, and _assertCheckpointDbForServingCoins() turns the same gap
        // into a fatal startup error so a misconfigured thin replica never silently
        // serves empty hub data.
        this.checkpointDb = {};
        // Per-key base chain name (RBTC → 'BTC'), used by the project-registry
        // queries to honor only same-chain LINKs (LINK skips owner validation
        // when COIN2 is remote; see protocol/Project_Registry.md).
        this.baseCoin = {};
        let networks = ['mainnet', 'testnet', 'regtest'];
        for(let coin in coinConfigs){
            let info = coinConfigs[coin];
            if(info.mainnet || info.testnet || info.regtest){
                for(let net in info){
                    if(networks.includes(net) && !this.util.isNull(info[net].database) && !this.util.isNull(info[net].database.indexer)){
                        let pool = false;
                        let cfg  = info[net].database.indexer;
                        // Remap host/port to db_host/db_port if needed (e.g. local config.json)
                        if(!("db_host" in cfg) && ("host" in cfg)) cfg.db_host = cfg.host;
                        if(!("db_port" in cfg) && ("port" in cfg)) cfg.db_port = cfg.port;
                        let key  = coin;
                        if(net=='testnet') key = 'T' + coin;
                        if(net=='regtest') key = 'R' + coin;
                        // Record the base chain name for this key (RBTC -> BTC):
                        // LINK/LIST rows store the bare chain name in index_coins
                        this.baseCoin[key] = coin;
                        // Decoder JSON-RPC endpoint for this coin/network, if the
                        // config carries one. Resolved here rather than in the pool
                        // branch below so a coin whose indexer entry is not usable
                        // as a pool can still report decoder health.
                        let dApiUrl = this._decoderApiUrlFromConfig(info[net].database.decoder);
                        if(dApiUrl) this.decoderApiUrl[key] = dApiUrl;
                        if (("db_host" in cfg) && ("db_port" in cfg)){
                            this.pools[key] = {
                                "config": {
                                    host:     cfg.db_host,
                                    port:     cfg.db_port,
                                    user:     cfg.user,
                                    password: cfg.pass,
                                    database: cfg.name,
                                    // Connection options. The indexer default of 10
                                    // matches xchain-indexer, xchain-decoder, and
                                    // xchain-hub; the previous 25 pushed total demand
                                    // past MariaDB's default max_connections=151 once
                                    // 3+ coins were active. Sized per dbType via
                                    // DB_POOL_SIZE_INDEXER (see poolSizing.js), since
                                    // the indexer and decoder pools carry very
                                    // different loads.
                                    connectionLimit:  poolSizing.resolvePoolSize('indexer'),
                                    //connectTimeout: 0,
                                    insertIdAsNumber: true,
                                    queryTimeout:     poolSizing.resolveQueryTimeout('indexer')
                                }
                            };
                            // Reuse an existing pool ONLY when it targets the SAME database too.
                            // A MariaDB pool is bound to one default database (`database:` above)
                            // and the explorer issues unqualified queries (e.g. `FROM blocks`)
                            // that run against it. The old code shared a pool across entries with
                            // the same host/port/user/pass but DIFFERENT databases, so when every
                            // coin used one MariaDB user (e.g. the single-server NO_HUB deployment
                            // reading synced DBs) all 9 collapsed onto the first pool and every
                            // coin served the first database's data (BTC). Including the database
                            // name keeps per-DB pools correct; 9 coin/networks is <=90 connections,
                            // under MariaDB's default max_connections=151. (Uses the normalized
                            // db_host/db_port so config.json and hub-config both match.)
                            for(let existingKey in this.pools){
                                let data = this.pools[existingKey];
                                if( cfg.db_host==data.config.host &&
                                    cfg.db_port==data.config.port &&
                                    cfg.user==data.config.user &&
                                    cfg.pass==data.config.password &&
                                    cfg.name==data.config.database &&
                                    !this.util.isNull(data.pool) )
                                    pool = data.pool;
                            }
                            if(!pool)
                                pool = mariadb.createPool(this.pools[key].config);

                            this.pools[key].pool = pool;

                            // Record the decoder DB name for this coin so /api/status can
                            // read the decoder tip (decoder's highest processed block), serve
                            // mempool rows, and serve raw FILE bytes. Same credentials as the
                            // indexer DB → reuse this indexer pool with database-qualified
                            // queries; different credentials (xchain-node installs provision
                            // per-service DB users) → create a DEDICATED decoder pool so the
                            // colocated-decoder features still work.
                            let dcfg = info[net].database.decoder;
                            if(dcfg && !this.util.isNull(dcfg.name)){
                                let dHost = ("db_host" in dcfg) ? dcfg.db_host : dcfg.host;
                                let dPort = ("db_port" in dcfg) ? dcfg.db_port : dcfg.port;
                                if(!this.util.isNull(dHost) && !this.util.isNull(dPort)){
                                    this.decoderDb[key] = dcfg.name;
                                    if(!(dHost==cfg.db_host && dPort==cfg.db_port && dcfg.user==cfg.user && dcfg.pass==cfg.pass)){
                                        this.decoderPools[key] = mariadb.createPool({
                                            host:             dHost,
                                            port:             dPort,
                                            user:             dcfg.user,
                                            password:         dcfg.pass,
                                            database:         dcfg.name,
                                            // Smaller than the indexer pool: decoder
                                            // reads are low-volume (status tip, mempool
                                            // page, raw FILE bytes). Tunable on its own
                                            // via DB_POOL_SIZE_DECODER, because at the
                                            // old hardcoded 3 a busy mempool/FILE view
                                            // queued behind three connections with no
                                            // knob to raise it.
                                            connectionLimit:  poolSizing.resolvePoolSize('decoder'),
                                            insertIdAsNumber: true,
                                            queryTimeout:     poolSizing.resolveQueryTimeout('decoder')
                                        });
                                    }
                                }
                            }

                            // Record the checkpoint-source DB name for this coin (see
                            // the checkpointDb note above); same same-server/same-creds
                            // rule as decoderDb, read by reusing this indexer pool.
                            // self_sync marks a mirror schema this explorer populates
                            // itself via HubMirrorSyncManager (the #4138 decoupling)
                            // rather than an externally-maintained hub schema; the
                            // connection details ride along so the mirror writer can
                            // open its own small pool on the same server.
                            let kcfg = info[net].database.checkpoint;
                            if(kcfg && !this.util.isNull(kcfg.name)){
                                let kHost = ("db_host" in kcfg) ? kcfg.db_host : kcfg.host;
                                let kPort = ("db_port" in kcfg) ? kcfg.db_port : kcfg.port;
                                if(kHost==cfg.db_host && kPort==cfg.db_port && kcfg.user==cfg.user && kcfg.pass==cfg.pass)
                                    this.checkpointDb[key] = {
                                        name: kcfg.name, chain: coin, network: net,
                                        selfSync: kcfg.self_sync === true || kcfg.self_sync === 'true',
                                        host: kHost, port: kPort, user: kcfg.user, pass: kcfg.pass
                                    };
                            }
                        }
                    }
                }
            }
        }

        // Mandatory co-located mirror invariant (#4138). The hub-mirrored tables
        // (state_checkpoints, capability_snapshots, cross_chain_matches) are NEVER
        // replicated by xchain-sync, so a serving coin with no checkpoint schema
        // (self-synced via HubMirrorSyncManager, or externally maintained) has
        // only a stale/empty bootstrap copy. Fail loud at startup rather than
        // letting a thin replica silently serve empty hub-mirror data with no alarm.
        this._assertCheckpointDbForServingCoins();
    }

    // Decoder JSON-RPC endpoint for one coin/network, read out of the config the
    // explorer already holds. Two config shapes reach here and they disagree on
    // what `host`/`port` mean, so the shape is discriminated rather than guessed:
    //
    //   - Hub config (xchain-node's updateconfig push): the xchain-decoder entry
    //     carries db_host/db_port for the DATABASE and host/port for the decoder's
    //     API (SERVICE_REGISTRY maps them from DECODER_URL + DECODER_API_PORT), the
    //     same pair xchain-hub's own _resolveIndexerUrl builds an indexer URL from.
    //   - src/config.json: host/port ARE the database and there is no API entry, so
    //     reading them as an endpoint would point the health poll at MariaDB.
    //
    // Hence the db_host/db_port test: only their presence proves the hub shape, in
    // which host/port are free to mean the API. api_url (or api_host + api_port) is
    // an explicit operator override honored in EITHER shape, so a config.json
    // deployment can name the endpoint beside the DB instead of exporting one env
    // var per chain. Returns null when the entry carries nothing usable.
    _decoderApiUrlFromConfig(dcfg){
        if(!dcfg || typeof dcfg !== 'object') return null;
        let trim = (v) => this.util.isNull(v) ? '' : String(v).trim();
        // Accept a host written with or without a scheme; default to http, which
        // is what the decoder's API serves (TLS terminates upstream when present).
        let join = (host, port) => {
            host = trim(host).replace(/\/+$/, '');
            port = trim(port);
            if(!host || !port) return null;
            return (/^https?:\/\//i.test(host) ? host : 'http://' + host) + ':' + port;
        };
        let explicitUrl = trim(dcfg.api_url).replace(/\/+$/, '');
        if(explicitUrl) return explicitUrl;
        let explicit = join(dcfg.api_host, dcfg.api_port);
        if(explicit) return explicit;
        if(this.util.isNull(dcfg.db_host) || this.util.isNull(dcfg.db_port)) return null;
        return join(dcfg.host, dcfg.port);
    }

    // Startup assertion: every coin/network this explorer serves (has an indexer
    // pool for) MUST have a checkpoint schema configured (database.checkpoint,
    // same host+credentials as the indexer DB): either a self-synced mirror
    // (database.checkpoint.self_sync + HUB_API_URL, populated by
    // HubMirrorSyncManager) or an externally-maintained hub schema. Without one
    // the hub-mirrored tables cannot be served, because xchain-sync never
    // replicates them. A missing entry is a fatal misconfiguration: throw a
    // clear, named error so a mis-provisioned thin replica fails to start
    // instead of silently serving empty state_checkpoints /
    // capability_snapshots / cross_chain_matches (#4138), or empty
    // price_snapshots / oracle_prices (items 4062 / 4063).
    // Opt-out: ALLOW_NO_COLOCATED_HUB_DB=1 downgrades the fatal error to a warning,
    // for deployments that intentionally do not expose the hub-mirrored endpoints.
    _assertCheckpointDbForServingCoins(){
        let missing = [];
        for(let key in this.pools){
            if(!this.checkpointDb[key]) missing.push(key);
        }
        if(missing.length){
            let msg = 'Checkpoint schema missing for serving coin(s): ' + missing.join(', ') +
                '. The hub-mirrored tables (state_checkpoints, capability_snapshots, ' +
                'cross_chain_matches, price_snapshots, oracle_prices) are never replicated ' +
                'by xchain-sync and must be served ' +
                'from a local schema on the same server: add a database.checkpoint block ' +
                '(same host + credentials as the indexer DB) for each serving coin/network, ' +
                'either self-synced (self_sync: true + HUB_API_URL) or pointing at an ' +
                'externally-maintained hub schema. Set ALLOW_NO_COLOCATED_HUB_DB=1 to start ' +
                'anyway (hub-mirrored endpoints will fail loud per request instead).';
            if(process.env.ALLOW_NO_COLOCATED_HUB_DB === '1'){
                console.warn('[explorer] WARNING: ' + msg);
                return;
            }
            throw new Error(msg);
        }
    }

    /******************************************************************
     * Common database connection functions (connect / release)
     *****************************************************************/

    async getConnection(config){
        if(this.transactionConnection)
            return this.transactionConnection;
        let connection = null,
            retryCount = 0,
            maxRetrys  = 3;
        let pool = (this.pools[config.coin]) ? this.pools[config.coin].pool : null;
        // Lazy recovery: a missing pool usually means the explorer started before
        // the hub was reachable and never built pools for this coin. Rebuild from
        // current config once (throttled) and retry, rather than failing every
        // read until a manual restart.
        if(!pool){
            await this._rebuildPoolsIfStale();
            pool = (this.pools[config.coin]) ? this.pools[config.coin].pool : null;
        }
        if(pool){
            while(connection == null){
                try {
                    connection = await pool.getConnection();
                } catch (e){
                    if(process.env.DEBUG) console.log('Database connection error:', e);
                    connection = null;
                    if(retryCount <= maxRetrys){
                        retryCount++;
                        console.log("Can't connect to database. Trying again (attempt " + retryCount + ")...");
                        await this.util.sleep(1000);
                    } else {
                        console.log('Failed to get database connection after ' + maxRetrys + ' attempts');
                        break;
                    }
                }
            }
        } else {
            console.log("Unable to get database connection pool");
        }
        this.transactionConnection = connection;
        return connection;
    }


    // Rebuild connection pools from the current config, at most once per 10s and
    // never concurrently. Used as a lazy recovery path when a query finds no pool
    // (e.g. the explorer came up before the hub and the config arrived later).
    async _rebuildPoolsIfStale(){
        let now = Date.now();
        if(this._lastPoolRebuild && (now - this._lastPoolRebuild) < 10000)
            return;
        if(this._poolRebuildPromise)
            return this._poolRebuildPromise;
        this._lastPoolRebuild = now;
        this._poolRebuildPromise = (async () => {
            try { await this.setupConnectionPools(); }
            catch(e){ console.log('Pool rebuild failed: ' + (e && e.message)); }
            finally { this._poolRebuildPromise = null; }
        })();
        return this._poolRebuildPromise;
    }

    async releaseConnection(){
        if(this.transactionConnection != null){
            await this.transactionConnection.release();
            this.transactionConnection = null;
        }  
    }

    /******************************************************************
     * General database functions
     *****************************************************************/

    async getData(config){
        let data  = [];
        let total = null;

        // Short-TTL result cache for the unauthenticated filesort-heavy list paths.
        // getHolders sorts by ABS(amount) on a VARCHAR column,
        // getBalances sorts by tick across a balances/tokens join, and getTokens is a
        // multi-table join whose token/subtoken search is a leading-% LIKE: none of
        // these have an index-only path, so each call to the public /api or /explorer
        // route is a full filesort and a cheap DoS-amplification vector. A small
        // per-request-shape cache collapses a request burst into one query. TTL is
        // short so lists stay fresh; each map is size-capped (oldest-evicted) so the
        // cache itself cannot grow unbounded. The key is built from the raw request
        // inputs (search, type, and every pagination/order query param) BEFORE
        // getQuery derives the SQL, so distinct pages/orders never collide.
        const RESULT_CACHES = {
            getHolders:  ['_holdersCache',  'EXPLORER_HOLDERS_CACHE'],
            getTokens:   ['_tokensCache',   'EXPLORER_TOKENS_CACHE'],
            getBalances: ['_balancesCache', 'EXPLORER_BALANCES_CACHE']
        };
        let cacheName = null;
        let cacheKey  = null;
        if(RESULT_CACHES[config.data.method]){
            let envPrefix;
            [cacheName, envPrefix] = RESULT_CACHES[config.data.method];
            const q = config.data.query || {};
            // Include the per-coin reorg generation (M-3) so a detected reorg
            // makes every pre-reorg result-cache entry unreachable instead of
            // serving reassigned-id rows until the TTL expires.
            cacheKey = [config.coin, this._reorgGen[config.coin] || 0,
                        config.type, config.data.type, config.data.search,
                        q.page, q.limit, q.sortorder, q.offset, q.start, q.length, q.action].join('|');
            const ttl = parseInt(process.env[envPrefix + '_MS'], 10) || 15000;
            if(!this[cacheName]) this[cacheName] = new Map();
            const hit = this[cacheName].get(cacheKey);
            if(hit && (Date.now() - hit.at) < ttl)
                return [hit.data, hit.total];
        }

        let [query, args, count] = await this.getQuery(config);
        if(typeof query === 'object'){
            data = query;
            if(this.util.isNumeric(count))
                total = count;
        } else {
            // Align the data-WHERE bind args with their placeholders. getQueryWhereSql only
            // adds a data-WHERE placeholder when a TYPE (address/token/block/...) is set, so a
            // pure list-all request (no QUERY and no TYPE) has none. Many action methods still
            // seed args=[config.data.search] (= [undefined] here); that phantom prepends to the
            // offset args, shifting `m.action_index < ?` to bind NULL and returning zero rows.
            // Drop the phantom for pure list-all so only the offset args remain. Typed requests
            // (search and/or a resource type present) keep the method's args, or the
            // single-search fallback.
            //
            // The phantom is dropped by VALUE, not by discarding the whole array: a method can
            // add a placeholder of its own that has nothing to do with search or type, and
            // discarding its args left that placeholder unbound. getCrossChainMatches appends
            // `AND m.network = ?` on every request, so a bare
            // GET /{COIN}/api/cross_chain_matches answered 500 "Parameter at position 1 is not
            // set" on any install with the mandatory checkpoint schema actually configured.
            // On the list-all path the seeded search is null/undefined by construction, so
            // filtering nulls removes exactly the phantom and nothing a method meant to bind.
            let baseArgs;
            let listAll = !config.data.search && !config.data.type;
            if(Array.isArray(args))
                baseArgs = listAll ? args.filter(a => !this.util.isNull(a)) : args;
            else if(listAll)
                baseArgs = [];
            else if(args && typeof args === 'object')
                baseArgs = args;
            else
                baseArgs = this.util.isNull(config.data.search) ? [] : [config.data.search];
            let queryArgs = [...baseArgs];
            let offsetArgs = config.data.sql.where.offsetArgs;
            if(offsetArgs && offsetArgs.length)
                queryArgs.push(...offsetArgs);
            // Append SQL OFFSET for API pagination (page > 1)
            if(config.type == 'api' && config.data.sql.apiOffset > 0){
                query += ' OFFSET ?';
                queryArgs.push(config.data.sql.apiOffset);
            }
            if(query!='')
                data = await this.doQuery(config, query, queryArgs);
            // Count query uses only base args (no offset/limit placeholders)
            if(count){
                let rows = await this.doQuery(config, count, baseArgs);
                total = (rows) ? Number(rows[0].total) : 0;
            }
        }
        // The dispenser list lane used to serve no escrow at all, so a client
        // listing dispensers could not say how full any of them was. give_escrow
        // now comes back with the row and the live remainder is derived here
        // through the same shared method the per-action detail path uses (one
        // batched pass for the whole page, not a query per row).
        if(config.data.method=='getDispensers' && Array.isArray(data) && data.length){
            let escrow = await this.getDispenserEscrowBatch(config, data.map((r) => r.action_index));
            for(let row of data){
                let entry = escrow[String(row.action_index)];
                row.escrow_remaining = (entry) ? entry.escrow_remaining : null;
            }
        }
        // /validators stays the ONE validator table (no second federation-registry
        // page), so every on-chain active-set row also carries the hub registry's view of
        // the same signing pubkey: network addr, served chains, registration status. One
        // registry read serves the whole page, not a lookup per row. A pubkey the hub does
        // not list is 'unregistered'; a deployment with no reachable hub registry leaves
        // all three null, which the page renders as unknown rather than as unregistered.
        if(config.data.method=='getValidators' && Array.isArray(data) && data.length){
            let registry = await this.getFederationRegistry(config);
            for(let row of data){
                let entry = (registry && !this.util.isNull(row.signing_pubkey))
                    ? registry[String(row.signing_pubkey).toLowerCase()]
                    : null;
                row.hub_addr   = (entry) ? entry.addr   : null;
                row.hub_chains = (entry) ? entry.chains : null;
                row.hub_status = (entry) ? entry.status : (registry ? 'unregistered' : null);
            }
        }
        // Populate the result cache. Cap each map and evict the oldest entry on
        // overflow so a flood of distinct ticks/addresses/pages cannot grow the
        // cache without bound.
        if(cacheKey !== null){
            const envPrefix = RESULT_CACHES[config.data.method][1];
            const MAX = parseInt(process.env[envPrefix + '_MAX'], 10) || 500;
            if(this[cacheName].size >= MAX)
                this[cacheName].delete(this[cacheName].keys().next().value);
            this[cacheName].set(cacheKey, { at: Date.now(), data, total });
        }
        return [data, total];
    }

    async getQuery(config){
        let count = '';
        let query = '';
        let args  = null;
        let data  = config.data;
        let q     = (data.query) ? data.query : false;
        let max   = this.getMaxMethodResults(data.method);
        let limit = (q && q.limit && this.util.isInteger(Number(q.limit))) ? q.limit : max;
        limit = Math.max(1, Math.min(Number(limit), max));
        let default_order = (['getBalances'].includes(data.method)) ? 'ASC' : 'DESC';
        let order         = (q && q.sortorder && ['ASC','DESC'].includes(String(q.sortorder).toUpperCase())) ? String(q.sortorder).toUpperCase() : default_order;
        if(config.type=='api'){
            // Use SQL OFFSET for pagination instead of fetching all preceding pages
            let page  = (q && q.page  && this.util.isInteger(Number(q.page)))  ? q.page  : 1;
            page = Math.max(1, Number(page));
            // Cap the API OFFSET the same way the explorer fetch-and-slice path caps
            // `start` (see the 100k ceiling in the explorer branch below). An uncapped
            // OFFSET lets an unauthenticated request with a huge `page` force MariaDB to
            // join/order/skip a full-table row set for a single zero-row page
            // (query-complexity DoS); the list routes are multi-table joins. Deep
            // browsing uses the cursor next/prev path, so a 100k ceiling is invisible
            // to legitimate use while killing the scan blow-up.
            config.data.sql.apiOffset = Math.min((page - 1) * limit, 100000);
        }
        if(config.type=='explorer'){
            let offset = (q.offset) ? q.offset : false;
            let start  = (q.start) ? q.start : 0;
            let length = (q.length) ? q.length : 10;
            let action = (q.action) ? q.action : false;
            start  = Math.max(0, Number(start));
            if(!Number.isFinite(Number(length))) length = 10;
            length = Math.max(1, Math.min(Number(length), max));
            if(['getHolders','getBalances'].includes(data.method) && ['prev','last'].includes(action))
                config.data.query.action = config.data.offset.action = action = 'next';
            limit = length;
            if(limit > max)
                limit = max;
            // Size the jump-to-last page from the client's own record total, but clamp
            // it to the same per-method max the branches above enforce. `total` and
            // `start` are raw query-string input, so without the clamp
            // `?action=last&total=1e15` reached the LIMIT clause verbatim (full-table
            // scan on an unauthenticated list route) and a missing, non-numeric, or
            // repeated `total` emitted `LIMIT NaN` as a 500. A real last page never
            // exceeds one page of rows, so the ceiling is invisible to the UI; an
            // unusable total falls back to the already-clamped page length.
            if(action=='last'){
                let tail = Number(config.data.query.total) - Number(start);
                if(Number.isFinite(tail))
                    limit = Math.max(1, Math.min(tail, max));
            }
            // token/subtoken/roster searches paginate by fetch-and-slice (no action_index offsets),
            // so the SQL limit must cover start+length rows. Cap the offset fed to the
            // SQL LIMIT: without a bound, an unauthenticated request with a huge `start`
            // forces MariaDB to scan start+length rows for a single page (query-complexity
            // DoS). Deep browsing uses the cursor next/prev path, not raw offsets, so a
            // 100k ceiling is invisible to legitimate use while killing the scan blow-up.
            if(['getBalances', 'getHolders','getSearch','getProjectTokens'].includes(data.method) ||
                (data.method=='getTokens' && ['token','subtoken'].includes(data.type)))
                limit = this.util.bcadd(Math.min(start, 100000), length);
            if(['prev','last'].includes(action))
                order = 'ASC';
            let [offset1, offset2] = await this.getQueryOffsets(config, offset, limit);
            config.data.offset.start = offset1;
            config.data.offset.stop  = offset2;
            let [offsetSql, offsetArgs] = await this.getQueryOffsetSql(config);
            config.data.sql.where.offset     = offsetSql;
            config.data.sql.where.offsetArgs = offsetArgs;
        }
        config.data.sql.where.data = await this.getQueryWhereSql(config);
        config.data.sql.order = order
        config.data.sql.limit = limit;
        if(typeof this[data.method] === 'function')
            [query, args, count] = await this[data.method](config);
        return [query, args, count];
    }

    // Run a decoder-DB read. Same-credentials deployments reuse the indexer
    // pool (the query is database-qualified); xchain-node installs (per-service
    // DB users) run on the dedicated per-coin decoder pool created at init.
    async doDecoderQuery(config, query, args){
        let dedicated = this.decoderPools ? this.decoderPools[config.coin] : null;
        return this.doQuery(config, query, args, dedicated || null);
    }

    // Runs a read and returns the rows. A GENUINE failure (no pool, connection
    // unavailable after retries, or a rejected statement) THROWS a DbQueryError
    // rather than returning a falsy value (M-4). A swallowed-into-false failure
    // is indistinguishable at the call site from a successful empty SELECT, so a
    // transient outage used to render as "no data" (an address showing zero
    // balance). The request layer catches DbQueryError and answers 5xx; a
    // successful query still returns its (possibly empty) array, so a genuinely
    // empty result stays 200. A null query is an explicit no-op and returns false
    // (not a failure). Callers that must tolerate an outage (the /status health
    // read, the WS poll loops, decoder-tip reads) wrap their own calls.
    async doQuery(config, query, args, poolOverride = null){
        if(this.util.isNull(query)) return false;
        let pool = poolOverride || ((this.pools[config.coin]) ? this.pools[config.coin].pool : null);
        if(!pool){
            console.log('Unable to get database connection pool');
            throw new DbQueryError('No database connection pool for ' + (config && config.coin));
        }
        let db = null,
            retryCount = 0,
            maxRetrys  = 3;
        while(db === null){
            try {
                db = await pool.getConnection();
            } catch (e){
                if(process.env.DEBUG) console.log('Database connection error:', e);
                db = null;
                if(retryCount <= maxRetrys){
                    retryCount++;
                    console.log("Can't connect to database. Trying again (attempt " + retryCount + ")...");
                    await this.util.sleep(1000);
                } else {
                    console.log('Failed to get database connection after ' + maxRetrys + ' attempts');
                    throw new DbQueryError('Database connection unavailable after ' + maxRetrys + ' retries', e);
                }
            }
        }
        let result = false;
        try {
            result = await db.query(query, args);
        } catch (error){
            if(process.env.DEBUG) console.log('SQL Query Error:', error);
            else console.error('SQL query failed:', error.message, error.stack);
            throw new DbQueryError('SQL query failed: ' + (error && error.message), error);
        } finally {
            db.release();
        }
        return result;
    }

    async getQueryWhereSql(config){
        // The base predicate is a WHERE ANCHOR: callers append ` AND ...`
        // fragments, so the clause always needs a first term. On mappings_actions
        // and mappings_files action_index is declared NOT NULL, so that anchor is
        // deliberately always-true and filters nothing; the address_id and
        // block_index branches below anchor on nullable columns and do drop
        // orphan rows. Do not read either as a state filter.
        let sql    = `m.action_index IS NOT NULL`;
        let type   = config.data.type;
        let method = config.data.method;
        // Contract custody lives in the standard `balances` table keyed by the
        // contract's derived address C:<CHAIN>:<action_index> (the legacy
        // contract_balances table was removed), so filter by that address like a
        // normal balance lookup. Early-return so the type=='contract' branch
        // below doesn't append a contract_index clause balances has no column for.
        if(method=='getContractBalance')
            return `m.address_id IS NOT NULL AND a2.address=?`;
        if(['getBalances','getHolders'].includes(method))
            sql = `m.address_id IS NOT NULL`;
        if(['getBlocks','getBlock'].includes(method))
            sql = `b1.block_index IS NOT NULL`;
        if(method=='getTransaction')
            sql = `m.tx_index IS NOT NULL`;
        // contract_state is queried via the `cs` alias (+ a latest-per-key subquery
        // that already filters by contract_index); it has no `m` table.
        if(method=='getContractState')
            sql = `cs.id IS NOT NULL`;
        if(['getMarket','getMarkets'].includes(method))
            sql = `m.id IS NOT NULL`;
        // validator_rewards is the per-round accrual ledger; no action_index, keyed by m.id
        if(method=='getValidatorRewards')
            sql = `m.id IS NOT NULL`;
        // slash_events has no action_index; its PK is m.id
        if(method=='getSlashEvents')
            sql = `m.id IS NOT NULL`;
        // capability_slash_events has no action_index of its own; its PK is m.id
        if(method=='getCapabilitySlashEvents')
            sql = `m.id IS NOT NULL`;
        // price_snapshots is a materialized consensus-round table with no action_index; its PK is m.id
        if(method=='getPriceSnapshots')
            sql = `m.id IS NOT NULL`;
        // contract_emissions carries no reliable action_index of its own (it is nullable
        // for internal emissions such as SLASH, which move ledger state without minting a
        // new on-wire action); its PK is m.id
        if(method=='getEmissions')
            sql = `m.id IS NOT NULL`;
        // attest_validator_stats is an upsert-incremented counter rollup with no
        // action_index; it gained a surrogate m.id (xchain-indexer migration
        // 2026-08-19-attest-validator-stats-surrogate-id) precisely so it could be paged
        // on a monotonic AND unique cursor, since last_updated_block ties whenever a
        // whole ATTEST responsible set misses in one block
        if(method=='getAttestValidatorStats')
            sql = `m.id IS NOT NULL`;
        // cross_chain_matches is a standalone mirror of the hub's match table with no action_index; its PK is m.id
        if(method=='getCrossChainMatches')
            sql = `m.id IS NOT NULL`;
        // oracle_prices is the hub-mirrored user-published oracle row table; no action_index, keyed by m.id
        if(method=='getOraclePrices')
            sql = `m.id IS NOT NULL`;
        // state_checkpoints is the hub-mirrored quorum-signed checkpoint table; no
        // action_index, keyed by m.id (the cursor used for paging is m.block_index,
        // set separately in getQueryOffsetSql; this anchor only opens the WHERE clause).
        if(method=='getCheckpoints')
            sql = `m.id IS NOT NULL`;
        // capability_snapshots is the hub-mirrored historical electorate (which signing
        // keys carried which stake weight at a snapshot block); no action_index, keyed by m.id
        if(method=='getCapabilitySnapshots')
            sql = `m.id IS NOT NULL`;
        // anchor_reward_attestations is the hub-mirrored quorum-attested ANCHOR publisher
        // reward record; no action_index, keyed by m.id
        if(method=='getAnchorRewardAttestations')
            sql = `m.id IS NOT NULL`;
        // state_tree_roots is the indexer-local per-block SPV commitment row; no
        // action_index, keyed by m.id (the paging cursor is m.block_index, set separately
        // in getQueryOffsetSql, same shape as getCheckpoints)
        if(method=='getCommitments')
            sql = `m.id IS NOT NULL`;
        // co-located hub capability/governance tables; no action_index, keyed by m.id
        if(['getValidatorCapabilities','getGovernanceProposals','getGovernanceVotes'].includes(method))
            sql = `m.id IS NOT NULL`;
        // reorg_attestations is the hub-mirrored cross-chain reorg record; no action_index,
        // keyed by m.id (same PK-cursor shape as the three tables above)
        if(method=='getReorgs')
            sql = `m.id IS NOT NULL`;
        // slash_proposals is the hub-owned federation slash-evidence table; no
        // action_index, keyed by m.id (same PK-cursor shape as the tables above)
        if(method=='getSlashProposals')
            sql = `m.id IS NOT NULL`;
        // co-located hub operational tables (p2p_peers/consensus_state/configs/telemetry_pings); keyed by m.id
        if(['getPeers','getConsensusState','getConfigs','getTelemetryPings'].includes(method))
            sql = `m.id IS NOT NULL`;
        if(method=='getHistory'){
            if(type=='address')
                sql += ' AND m.type_id=2 AND m.id=?';
            if(type=='token')
                sql += ' AND m.type_id=1 AND m.id=?';
            if(type=='block')
                sql += ' AND b1.block_index=?';
        } else if(method=='getMarket'){
            sql += ` AND ((t1.tick=? AND t2.tick=?) OR (t1.tick=? AND t2.tick=?))`;
        } else if(method=='getMarkets'){
            if(type=='token')
                sql += ` AND (t1.tick=? OR t2.tick=?)`;
        } else if(['getMarketOrders','getOrderbook','getMarketHistory'].includes(method)){
            sql += ` AND ((t1.tick=? AND t2.tick=?) OR (t1.tick=? AND t2.tick=?))`;
            if(!this.util.isNull(config.data.search3)){
                if(method=='getMarketHistory'){
                    sql += ' AND (a2.address=? OR a3.address=?)';
                } else {
                    sql += ' AND a2.address=?';
                }
            }
        } else if(method=='getTokens' && ['token','subtoken'].includes(type)){
            sql += ' AND t3.tick LIKE ?';
        } else if(method=='getSlashEvents'){
            // slash_events has no actions/transactions chain; join directly via m.block_index
            // and resolve type=address through the staker's pubkey (signing_pubkey_id).
            if(type=='block')    sql += ' AND m.block_index=?';
            if(type=='contract') sql += ' AND m.target_contract_index=?';
            if(type=='address')  sql += ` AND m.signing_pubkey_id IN (
                SELECT DISTINCT signing_pubkey_id FROM contract_stakes
                WHERE source_id = (SELECT id FROM index_addresses WHERE address=?)
            )`;
        } else if(method=='getCapabilitySlashEvents'){
            // capability_slash_events joins blocks directly; filter by block, capability engine, or pubkey.
            if(type=='block')      sql += ' AND m.block_index=?';
            if(type=='capability') sql += ' AND m.capability=?';
            if(type=='pubkey')     sql += ' AND pk.pubkey=?';
            if(type=='address')    sql += ' AND sub.address=?';
        } else if(method=='getFullNodeVerifications'){
            // full_node_verifications joins the actions/transactions/blocks chain via
            // m.action_index (one row per verified validator). Filter on the verdict's own
            // block (m.block_index), the challenge epoch (m.epoch_height), the verified
            // signing pubkey (pk), or the staking source address (a3, joined on m.source_id).
            if(type=='block')   sql += ' AND m.block_index=?';
            if(type=='epoch')   sql += ' AND m.epoch_height=?';
            if(type=='pubkey')  sql += ' AND pk.pubkey=?';
            if(type=='address') sql += ' AND a3.address=?';
        } else if(method=='getPriceSnapshots'){
            // price_snapshots is a standalone table; filter on its own columns directly
            if(type=='pair')   sql += ' AND m.coin_pair=?';
            if(type=='round')  sql += ' AND m.round_number=?';
            if(type=='status') sql += ' AND m.status=?';
        } else if(method=='getOraclePrices'){
            // oracle_prices is a standalone hub-mirror table; filter on its own columns
            if(type=='token')   sql += ' AND m.tick=?';
            if(type=='address') sql += ' AND m.source_address=?';
        } else if(method=='getAttestValidatorStats'){
            // attest_validator_stats is a standalone counters table; filter on its own
            // unique-key columns directly. No 'block' type: last_updated_block is a
            // mutable "most recently touched" stamp, not a stable per-row block identity,
            // so filtering on it would answer a question that drifts under the caller.
            if(type=='pubkey')   sql += ' AND m.validator_pubkey=?';
            if(type=='provider') sql += ' AND m.provider_id=?';
        } else if(method=='getValidatorCapabilities'){
            if(type=='capability') sql += ' AND m.capability=?';
            if(type=='pubkey')     sql += ' AND m.signing_pubkey=?';
        } else if(method=='getCapabilitySnapshots'){
            // capability_snapshots is the historical electorate: which signing keys
            // carried which stake weight for a capability at a given snapshot block.
            // 'block' answers the row's core question (electorate AT block N);
            // 'capability' and 'pubkey' narrow the other two axes.
            if(type=='block')      sql += ' AND m.snapshot_block=?';
            if(type=='capability') sql += ' AND m.capability=?';
            if(type=='pubkey')     sql += ' AND m.signing_pubkey=?';
        } else if(method=='getGovernanceProposals'){
            if(type=='status')    sql += ' AND m.status=?';
            if(type=='parameter') sql += ' AND m.parameter=?';
            if(type=='proposal')  sql += ' AND m.proposal_id=?';
        } else if(method=='getGovernanceVotes'){
            if(type=='proposal') sql += ' AND m.proposal_id=?';
            if(type=='voter')    sql += ' AND m.voter_pubkey=?';
        } else if(method=='getPeers'){
            // p2p_peers is a hub-local operational table; filter on its own columns.
            if(type=='validator') sql += ' AND m.validator_id=?';
        } else if(method=='getConsensusState'){
            // consensus_state is a key/value table; filter by key_name.
            if(type=='key') sql += ' AND m.key_name=?';
        } else if(method=='getConfigs'){
            // configs is the hub config oracle store (coin/network/module/param);
            // filter by coin or module.
            if(type=='coin')   sql += ' AND m.coin=?';
            if(type=='module') sql += ' AND m.module=?';
        } else if(method=='getTelemetryPings'){
            // telemetry_pings is anonymous xchain-node telemetry; filter by event
            // type, anonymous install UUID, or country.
            if(type=='event')   sql += ' AND m.event=?';
            if(type=='install') sql += ' AND m.install_id=?';
            if(type=='country') sql += ' AND m.country=?';
        } else if(method=='getPolls'){
            // polls (VOTE v0) joins the actions/transactions/blocks chain (b1 via t1) like
            // getAttestations. tick joins index_tickers (pt) on m.tick_id; source is the poll
            // creator (a2 via t1.source_id); status filters the poll lifecycle enum directly.
            if(type=='block')  sql += ' AND b1.block_index=?';
            if(type=='tick')   sql += ' AND pt.tick=?';
            if(type=='status') sql += ' AND m.poll_status=?';
            if(type=='source') sql += ' AND a2.address=?';
        } else if(method=='getPoll'){
            // single poll keyed by its creating action_index (the poll id)
            sql += ' AND m.action_index=?';
        } else if(method=='getPollResults'){
            // poll_results is keyed by poll_index (the poll's creating action_index); the frozen
            // per-option tally has no actions chain of its own to filter on.
            sql += ' AND m.poll_index=?';
        } else if(method=='getVotes'){
            // votes (VOTE v1 ballots) joins the actions/transactions/blocks chain; the voter IS
            // the source that cast the ballot (a2 via t1.source_id), so address filters on a2.
            if(type=='address') sql += ' AND a2.address=?';
            if(type=='poll')    sql += ' AND m.poll_index=?';
            if(type=='block')   sql += ' AND b1.block_index=?';
        } else if(method=='getVoteDelegations'){
            // vote_delegations (VOTE v3 liquid democracy) joins the actions/transactions/
            // blocks chain via m.action_index like getContractDelegations. tick resolves
            // through index_tickers (t3) on m.tick_id; delegator/delegate resolve through
            // index_addresses (dgr/dg) on delegator_address_id/delegate_address_id. The
            // latest-active-per-key exclusion lives in getVoteDelegations' own SQL (a
            // correlated MAX), not here: this branch only narrows by the requested TYPE.
            if(type=='tick')      sql += ' AND t3.tick=?';
            if(type=='delegator') sql += ' AND dgr.address=?';
            if(type=='delegate')  sql += ' AND dg.address=?';
            if(type=='block')     sql += ' AND b1.block_index=?';
        } else if(method=='getBetFeeds'){
            // bet_feeds (BET format 0) joins the actions/transactions/blocks chain like
            // getPolls. tick joins index_tickers (pt) on the wager token; source is the
            // oracle that created the feed (a2 via t1.source_id); status filters the
            // STORED feed lifecycle enum through index_statuses (fs), never a clock
            // recomputation. 'address' is an alias of 'source' here because a feed has
            // exactly one participating address of its own (the oracle); bettors are
            // reachable via getBets(feed).
            if(type=='block')   sql += ' AND b1.block_index=?';
            if(type=='token')   sql += ' AND pt.tick=?';
            if(type=='status')  sql += ' AND fs.status=?';
            if(type=='source')  sql += ' AND a2.address=?';
            if(type=='address') sql += ' AND a2.address=?';
        } else if(method=='getBetFeed'){
            // single market keyed by its creating action_index (the feed id)
            sql += ' AND m.action_index=?';
        } else if(method=='getBets'){
            // bets (BET format 2 ballots-equivalent) joins the actions/transactions/blocks
            // chain; the bettor IS the source that placed the wager (a2 via t1.source_id).
            // 'feed' filters to one market, matching getVotes' 'poll'.
            if(type=='address') sql += ' AND a2.address=?';
            if(type=='feed')    sql += ' AND m.feed_action_index=?';
            if(type=='token')   sql += ' AND pt.tick=?';
            if(type=='status')  sql += ' AND bs.status=?';
            if(type=='block')   sql += ' AND b1.block_index=?';
        } else if(['getCrossChainMatches','getCrossChainSettlements'].includes(method)){
            // standalone mirror tables (no actions/transactions chain); filter on
            // their own columns directly. matches carry snapshot_block (the
            // BTC-anchored quorum block); settlements carry the local block_index.
            if(type=='match')  sql += ' AND m.match_id=?';
            if(type=='block')  sql += (method=='getCrossChainSettlements') ? ' AND m.block_index=?' : ' AND m.snapshot_block=?';
            if(type=='status' && method=='getCrossChainMatches') sql += ' AND m.status=?';
        } else if(method=='getReorgs'){
            // reorg_attestations is a hub-mirrored, cross-chain table; the mandatory
            // per-coin chain scope is appended separately in getReorgs (matching
            // getCrossChainMatches' network filter above), so this branch only narrows
            // WITHIN that scope. 'block' reuses the platform-wide block-height type name
            // (reorg_height IS a block height).
            if(type=='status') sql += ' AND m.status=?';
            if(type=='block')  sql += ' AND m.reorg_height=?';
        } else if(method=='getSlashProposals'){
            // Platform-global table (no chain axis), so these are the only two
            // filters, and they mirror the hub RPC's two server-side filters exactly
            // so neither transport has to post-filter. No 'block' type: round_number
            // is an oracle round (or an attestation pseudo-round), not a block height,
            // and QUERY_DESC['block'] reads 'block height'.
            if(type=='status') sql += ' AND m.status=?';
            if(type=='pubkey') sql += ' AND m.validator_pubkey=?';
        } else if(method=='getEmissions'){
            // contract_emissions carries no contract_index of its own (it is reachable
            // only by joining through contract_executions on execution_index), so
            // contract/block filter the joined `ce` alias. block_index lives on
            // contract_executions directly, which is why this does NOT reuse the generic
            // b1.block_index branch below (that one assumes an actions/blocks join this
            // method does not make). 'execution' filters contract_emissions' own indexed
            // execution_index column.
            if(type=='contract')  sql += ' AND ce.contract_index=?';
            if(type=='execution') sql += ' AND m.execution_index=?';
            if(type=='block')     sql += ' AND ce.block_index=?';
        } else if(method=='getXcalls'){
            // xcalls joins the actions/transactions/blocks chain (b1 alias); filter on its own columns.
            // contract = the source contract that emitted the call (contract_index, now indexed).
            if(type=='block')    sql += ' AND b1.block_index=?';
            if(type=='contract') sql += ' AND m.contract_index=?';
            if(type=='status')   sql += ' AND m.request_status=?';
        } else if(method=='getAnchors'){
            // anchor_actions joins the actions/transactions/blocks chain (b1 via t1); filter on its own columns.
            if(type=='block')   sql += ' AND b1.block_index=?';
            if(type=='chain')   sql += ' AND m.chain=?';
            if(type=='network') sql += ' AND m.network=?';
            if(type=='status')  sql += ' AND s1.status=?';
        } else if(method=='getAnchorRewardAttestations'){
            // anchor_reward_attestations is a standalone hub-mirror table (no actions/
            // transactions chain); filter on its own columns. 'anchor' answers "the rewards
            // behind THIS ANCHOR transaction"; 'block' matches the table's own
            // idx_snapshot_block (network, snapshot_block) key; 'pubkey' narrows to one
            // elected publisher's reward history.
            if(type=='anchor')  sql += ' AND m.doge_anchor_txid=?';
            if(type=='block')   sql += ' AND m.snapshot_block=?';
            if(type=='pubkey')  sql += ' AND m.publisher=?';
        } else if(method=='getCommitments'){
            // state_tree_roots has no actions/transactions/blocks chain; filter on its own
            // column directly, matching getAnchors/getCrossChainMatches above.
            if(type=='block') sql += ' AND m.block_index=?';
        } else if(method=='getXcall'){
            // single-call lifecycle keyed by the deterministic 64-hex call_id
            sql += ' AND m.call_id=?';
        } else if(!['getBlocks'].includes(method)){
            if(type=='address'){
                if(['getMessages','getMints','getOrders','getSends','getSweeps','getDispensers','getDispenses'].includes(method)){
                    sql += ' AND (a2.address=? OR a3.address=?)';
                } else if(method=='getCoinpayObligations'){
                    sql += ' AND (a1.address=? OR a2.address=?)';
                } else {
                    sql += ' AND a2.address=?';
                }
            }
            if(type=='block'){
                // coinpay_obligations carries block_index directly and has no
                // blocks join (b1); every other action query resolves the
                // block through its actions/blocks joins. Without this branch
                // the block lane 500s with an unknown-column error (PC-16).
                sql += (method=='getCoinpayObligations') ? ' AND m.block_index=?' : ' AND b1.block_index=?';
            }
            if(type=='destination')
                sql += ' AND a3.address=?';
            if(type=='source')
                sql += ' AND a2.address=?';
            // getDispensers only: the oracle lane answers "which dispensers price
            // against this ORACLE_ADDRESS", which is what an oracle operator needs
            // before republishing a quote (PC-30) and who pays them the usage fee.
            // Resolved by subselect rather than through the a5 join the row query
            // uses, because the count query carries no a5.
            if(type=='oracle' && method=='getDispensers')
                sql += ' AND m.oracle_address_id=(SELECT id FROM index_addresses WHERE address=?)';
            // getDispenses only: the fills of ONE dispenser, keyed by the
            // dispenser's own action_index. The address/source lanes answer
            // "fills on this address", which is a different question whenever
            // an address hosts more than one dispenser - the normal case,
            // since dispensers open on their creator's source address. Ticks
            // cannot separate them either (two dispensers can share a pair,
            // and a coin-paid fill carries get_tick NULL).
            if(type=='dispenser' && method=='getDispenses')
                sql += ' AND m.dispenser_action_index=?';
            if(type=='contract'){
                if(['getContractStakes','getContractUnstakes','getContractDelegations','getSlashEvents'].includes(method))
                    sql += ' AND m.target_contract_index=?';
                else if(method=='getContract')
                    // The contracts table has no contract_index column; it is keyed by action_index.
                    sql += ' AND m.action_index=?';
                else if(method=='getContractState')
                    // contract_index filter is applied inside the latest-per-key subquery; no outer clause/arg.
                    ;
                else
                    sql += ' AND m.contract_index=?';
            }
            if(type=='token'){
                if(method=='getFiles'){
                    sql += ' AND m.type_id=1 AND t4.tick=?';
                } else {
                    sql += ' AND t3.tick=?';
                }
            }
            // getFiles 'name' mode (spec explorer-coverage-completion M1.7):
            // discovery-by-filename. files.name is a plain VARCHAR column on the base
            // `files` table (not interned like tick/address), and only 'token' routes
            // getFiles to the mappings_files/interned-tick query shape above; every
            // other type (including 'name') keeps the base `files m` FROM-clause where
            // `m` already resolves to `files`, so `m.name` is index-friendly here: an
            // exact-match equality on a plain column, no leading wildcard and no
            // function wrapping the column, so a `files(name)` index (sibling migration
            // in xchain-indexer, out of this surface) can serve it directly.
            if(type=='name' && method=='getFiles')
                sql += ' AND m.name=?';
        }
        return sql;
    }


    /******************************************************************
     * Explorer Paging / Offset specific code
     *****************************************************************/

    // table `m` is a universal reference to the main action table
    async getQueryOffsetSql(config){
        let method = config.data.method;
        let offset = (config.data.offset) ? config.data.offset : false;
        let action = (offset && !this.util.isNull(offset.action)) ? offset.action : false;
        let start  = (offset && !this.util.isNull(offset.start) && this.util.isNumeric(offset.start)) ? this.util.sanitizeInt(offset.start, false) : false;
        let stop   = (offset && !this.util.isNull(offset.stop) && this.util.isNumeric(offset.stop)) ? this.util.sanitizeInt(offset.stop, false) : false;
        if(start === false || stop === false) { /* sanitizeInt handles NaN/Infinity */ }
        let sql    = '';
        let args   = [];
        if(method=='getBlocks')
            stop = false;
        if(action && start !== false){
            // hardcoded whitelist, never from user input
            let field = 'm.action_index';
            if(method=='getBlocks')
                field = 'b1.block_index';
            if(method=='getTokens')
                field = 'm.id';
            // state_checkpoints has no action_index, and unlike the id-keyed views below
            // it is not keyed by m.id either: the list ORDERs BY m.block_index (the
            // checkpointed height, one row per height after the MAX(checkpoint_seq)
            // GROUP BY), so the cursor must compare that column, not insertion order.
            // state_tree_roots (getCommitments) has the same shape: no action_index, one
            // row per height, and the list ORDERs BY m.block_index.
            if(['getCheckpoints','getCommitments'].includes(method))
                field = 'm.block_index';
            // id-keyed list views: their main query ORDERs BY m.id (these tables have no
            // action_index cursor column, or a fan-out where action_index is not unique
            // per displayed row), so the paging cursor must compare m.id rather than the
            // default m.action_index. Must stay in lockstep with each method's ORDER BY.
            if(['getSlashEvents','getCapabilitySlashEvents','getOraclePrices',
                'getFullNodeVerifications','getPriceSnapshots','getCrossChainMatches',
                'getValidatorCapabilities','getGovernanceProposals','getGovernanceVotes',
                'getPeers','getConsensusState','getConfigs','getTelemetryPings',
                'getEmissions','getAttestValidatorStats','getCapabilitySnapshots',
                'getAnchorRewardAttestations','getReorgs','getSlashProposals'].includes(method))
                field = 'm.id';
            if(action=='prev'){
                sql = ` AND ` + field + ` > ?`;
                args.push(start);
                if(stop){
                    sql += ` AND ` + field + ` < ?`;
                    args.push(stop);
                }
            } else if(action=='last'){
                sql = ` AND ` + field + ` <= ?`;
                args.push(start);
            } else {
                sql = ` AND ` + field + ` < ?`;
                args.push(start);
                if(stop){
                    sql += ` AND ` + field + ` > ?`;
                    args.push(stop);
                }
            }
        }
        return [sql, args];
    }

    async getQueryOffsets(config, offset1, length){
        let offset2  = false;
        let method = config.data.method;
        let type   = config.data.type;
        let offset = (config.data.offset) ? config.data.offset : false;
        let action = (offset && !this.util.isNull(offset.action)) ? offset.action : false;
        let q      = (config.data.query) ? config.data.query : false;
        let table  = false;
        let sql    = false;
        let args   = false;
        let rows   = false;
        let id     = false;
        let where     = '';
        let whereArgs = [];
        let limit  = 1;
        let order  = 'DESC';
        if(['getBalances','getHolders','getTransaction','getSearch','getMarkets','getMarket'].includes(method))
            return [];
        // token/subtoken searches paginate by fetch-and-slice (no action_index offsets)
        if(method=='getTokens' && ['token','subtoken'].includes(type))
            return [];
        if(['address','oracle','token','block'].includes(type)){
            if(type=='address' || type=='oracle')
                sql = `SELECT id FROM index_addresses WHERE address=? LIMIT 1`;
            if(type=='token')
                sql = `SELECT id FROM index_tickers WHERE tick=? LIMIT 1`;
            if(sql){
                rows = await this.doQuery(config, sql, [config.data.search]);
                if(rows.length>0)
                    id = Number(rows[0].id);
            }
            if(type=='address'){
                if(['getMessages','getMints','getSends','getSweeps'].includes(method)){
                    where = ` AND (t1.source_id=? OR m.destination_id=?)`;
                    whereArgs.push(id, id);
                } else if(['getTokens'].includes(method)){
                    where = ` AND m.owner_id=?`;
                    whereArgs.push(id);
                } else if(method=='getCoinpayObligations'){
                    where = ` AND (m.payer_address_id=? OR m.payee_address_id=?)`;
                    whereArgs.push(id, id);
                } else if(['getCredits','getDebits','getEscrows'].includes(method)){
                    where = ` AND m.address_id=?`;
                    whereArgs.push(id);
                } else if(['getHistory'].includes(method)){
                    where = ` AND m.type_id=2 AND m.id=?`;
                    whereArgs.push(id);
                } else {
                    where = ` AND t1.source_id=?`;
                    whereArgs.push(id);
                }
            } else if(type=='oracle'){
                // Paging boundary for the getDispensers oracle lane. The boundary
                // query joins only m/a1/b1/t1, so filter on the dispenser row's own
                // column rather than the a5 address join the row query uses.
                where = ` AND m.oracle_address_id=?`;
                whereArgs.push(id);
            } else if(type=='block' && !this.util.isNull(config.data.search)){
                where = ` AND b1.block_index=?`;
                whereArgs.push(this.util.sanitizeInt(config.data.search));
            } else if(type=='token'){
                if(['getOrders','getSwaps'].includes(method)){
                    where = ` AND (m.get_tick_id=? OR m.give_tick_id=?)`;
                    whereArgs.push(id, id);
                } else if(['getDispensers','getDispenses'].includes(method)){
                    where = ` AND m.get_tick_id=?`;
                    whereArgs.push(id);
                } else if(['getHistory','getFiles'].includes(method)){
                    where = ` AND m.type_id=1 AND m.id=?`;
                    whereArgs.push(id);
                } else {
                    where = ` AND m.tick_id=?`;
                    whereArgs.push(id);
                }
            }
        }
        table = String(method).toLowerCase().replace('get','');
        if(!this.actionTables.includes(table) && !['blocks','tokens','history','files','markets','market'].includes(table)){
            // The boundary-discovery query below keys off this derived table name, which
            // does not exist for these methods (anchor_actions, slash_events, the hub
            // governance/match mirrors, etc.), so it cannot run. It is not needed: the
            // main list query already filters and orders on the right cursor column. For
            // the known cursor-paged views, pass the inbound client cursor through
            // unchanged (offset1) so next/prev advance; returning [] here discards it and
            // resets every page to the newest rows. Unknown methods keep the old no-op.
            if(this.cursorPagedMethods.includes(method))
                return [offset1, false];
            return [];
        }
        if(['first','last'].includes(action)){
            if(action=='first')
                order = 'DESC';
            if(action=='last'){
                order = 'ASC';
                limit = this.util.bcadd(length,1);
            }
            if(type=='block' && this.util.isNull(config.data.search)){
                sql = `SELECT
                            b1.block_index as offset_index
                        FROM
                            blocks b1
                        WHERE
                            b1.block_index IS NOT NULL
                            ` + where + `
                        ORDER BY b1.block_index ` + order + `
                        LIMIT ` + limit;
            } else if(method=='getTokens'){
                sql = `SELECT
                            m.id as offset_index
                        FROM
                            tokens m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.id ` + order + `
                        LIMIT ` + limit;
            } else if(method=='getHistory'){
                sql = `SELECT
                            m.action_index as offset_index
                        FROM
                            mappings_actions m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
            } else if(method=='getFiles' && type=='token'){
                sql = `SELECT
                            m.action_index as offset_index
                        FROM
                            mappings_files m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
             } else {
                sql = `SELECT
                            m.action_index as offset_index
                        FROM
                            ` + table + ` m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
            }
            rows = await this.doQuery(config, sql, whereArgs.length ? whereArgs : undefined);
            if(rows.length>0){
                for(let row of rows){
                    offset1 = Number(row.offset_index);
                    // Increase/Decrease offset by 1 so latest results are returned
                    if(action=='first')
                        offset1++;
                    if(action=='last')
                        offset--;
                }
            }
        }
        if(offset1){
            if(type=='block'){
                if(action=='last'){
                    offset2 = this.util.bcsub(this.util.bcadd(offset1,1),q.length);
                } else {
                    offset2 = this.util.bcsub(this.util.bcsub(offset1,1),q.length);
                }
            } else {
                limit = this.util.bcadd(length,1);
                order = 'DESC';
                let stopWhereArgs = [...whereArgs];
                if(action && offset1){
                    if(action=='prev'){
                        where += ' AND m.action_index > ?';
                        stopWhereArgs.push(offset1);
                    } else {
                        where += ' AND m.action_index < ?';
                        stopWhereArgs.push(offset1);
                    }
                }
                if(method=='getHistory'){
                    sql = `SELECT
                            m.action_index as offset_index
                        FROM
                            mappings_actions m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
            } else if(method=='getFiles' && type=='token'){
                sql = `SELECT
                            m.action_index as offset_index
                        FROM
                            mappings_files m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
                } else {
                    sql = `SELECT
                            m.action_index as offset_index
                        FROM
                            ` + table + ` m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
                }
                rows = await this.doQuery(config, sql, stopWhereArgs.length ? stopWhereArgs : undefined);
                // Only set the stop offset when we have more data to show
                if(rows.length>0 && rows.length == limit){
                    for(let row of rows)
                        offset2 = Number(row.offset_index);
                }
            }
        }
        return [offset1, offset2];
    }

    getMaxMethodResults(method){
        let methods = {
            getBalances: 500,
            getHolders:  500
        }
        let max = (this.util.isInteger(methods[method])) ? methods[method] : 100;
        return max;
    }

    /******************************************************************
     *
     * API Endpoints
     * 
     *****************************************************************/

    /******************************************************************
     * XChain API ACTION Endpoints
     * 
     * Endpoints                                     Method Name         Types
     * -----------------------------------------------------------------
     * /{COIN}/api/addresses/{QUERY}/{TYPE}          getAddresses        block, address
     * /{COIN}/api/airdrops/{QUERY}/{TYPE}           getAirdrops         block, address, token
     * /{COIN}/api/batches/{QUERY}/{TYPE}            getBatches          block, address
     * /{COIN}/api/broadcasts/{QUERY}/{TYPE}         getBroadcasts       block, address
     * /{COIN}/api/callbacks/{QUERY}/{TYPE}          getCallbacks        block, address, token
     * /{COIN}/api/destroys/{QUERY}/{TYPE}           getDestroys         block, address, token
     * /{COIN}/api/dispensers/{QUERY}/{TYPE}         getDispensers       block, address, token, source, destination, oracle
     * /{COIN}/api/dispenser_cancels/{QUERY}/{TYPE}  getDispenserCancels block, address
     * /{COIN}/api/dispenser_closes/{QUERY}/{TYPE}   getDispenserCloses  block, address
     * /{COIN}/api/dispenser_expires/{QUERY}/{TYPE}  getDispenserExpires block, address
     * /{COIN}/api/dispenser_edits/{QUERY}/{TYPE}    getDispenserEdits   block, address
     * /{COIN}/api/dispenses/{QUERY}/{TYPE}          getDispenses        block, address, token, source, destination, dispenser
     * /{COIN}/api/fees/{QUERY}/{TYPE}               getFees             block, address, token, source, destination
     * /{COIN}/api/files/{QUERY}/{TYPE}              getFiles            block, address, token
     * /{COIN}/api/issues/{QUERY}/{TYPE}             getIssues           block, address, token
     * /{COIN}/api/links/{QUERY}/{TYPE}              getLinks            block, address
     * /{COIN}/api/lists/{QUERY}/{TYPE}              getLists            block, address
     * /{COIN}/api/messages/{QUERY}/{TYPE}           getMessages         block, address, token, source, destination
     * /{COIN}/api/mints/{QUERY}/{TYPE}              getMints            block, address, token, source, destination
     * /{COIN}/api/orders/{QUERY}/{TYPE}             getOrders           block, address, token
     * /{COIN}/api/order_cancels/{QUERY}/{TYPE}      getOrderCancels     block, address
     * /{COIN}/api/order_edits/{QUERY}/{TYPE}        getOrderEdits       block, address
     * /{COIN}/api/order_expires/{QUERY}/{TYPE}      getOrderExpires     block, address
     * /{COIN}/api/order_matches/{QUERY}/{TYPE}      getOrderMatches     block 
     * /{COIN}/api/sends/{QUERY}/{TYPE}              getSends            block, address, token, source, destination
     * /{COIN}/api/sleeps/{QUERY}/{TYPE}             getSleeps           block, address, token
     * /{COIN}/api/swaps/{QUERY}/{TYPE}              getSwaps            block, address, token
     * /{COIN}/api/swap_cancels/{QUERY}/{TYPE}       getSwapCancels      block, address
     * /{COIN}/api/swap_edits/{QUERY}/{TYPE}         getSwapEdits        block, address
     * /{COIN}/api/swap_expires/{QUERY}/{TYPE}       getSwapExpires      block, address
     * /{COIN}/api/swap_matches/{QUERY}/{TYPE}       getSwapMatches      block 
     * /{COIN}/api/sweeps/{QUERY}/{TYPE}             getSweeps           block, address
     ******************************************************************/

     /******************************************************************
     * XChain Explorer Endpoints
     * 
     * Endpoints                                     Method Name             Types
     * -----------------------------------------------------------------
     * /{COIN}/explorer/addresses/{QUERY}/{TYPE}     getAddresses    block, address
     * /{COIN}/explorer/airdrops/{QUERY}/{TYPE}      getAirdrops     block, address, token
     * /{COIN}/explorer/balances/{QUERY}/{TYPE}      getBalances     address
     * /{COIN}/explorer/batches/{QUERY}/{TYPE}       getBatches      block, address
     * /{COIN}/explorer/blocks/{TYPE}                getBlocks       block
     * /{COIN}/explorer/broadcasts/{QUERY}/{TYPE}    getBroadcasts   block, address
     * /{COIN}/explorer/callbacks/{QUERY}/{TYPE}     getCallbacks    block, address, token
     * /{COIN}/explorer/credits/{QUERY}/{TYPE}       getCredits      block, address
     * /{COIN}/explorer/debits/{QUERY}/{TYPE}        getDebits       block, address
     * /{COIN}/explorer/destroys/{QUERY}/{TYPE}      getDestroys     block, address, token
     * /{COIN}/explorer/dispensers/{QUERY}/{TYPE}    getDispensers   block, address, token
     * /{COIN}/explorer/dispenses/{QUERY}/{TYPE}     getDispenses    block, address, token
     * /{COIN}/explorer/escrows/{QUERY}/{TYPE}       getEscrows      block, address
     * /{COIN}/explorer/fees/{QUERY}/{TYPE}          getFees         block, address, token
     * /{COIN}/explorer/files/{QUERY}/{TYPE}         getFiles        block, address, token
     * /{COIN}/explorer/holders/{TYPE}               getHolders      token
     * /{COIN}/explorer/history/{QUERY}/{TYPE}       getHistory      block, address, token, recent
     * /{COIN}/explorer/issues/{QUERY}/{TYPE}        getIssues       block, address, token
     * /{COIN}/explorer/links/{QUERY}/{TYPE}         getLinks        block, address, token
     * /{COIN}/explorer/lists/{QUERY}/{TYPE}         getLists        block, address
     * /{COIN}/explorer/messages/{QUERY}/{TYPE}      getMessages     block, address
     * /{COIN}/explorer/mints/{QUERY}/{TYPE}         getMints        block, address, token
     * /{COIN}/explorer/orders/{QUERY}/{TYPE}        getOrders       block, address, token
     * /{COIN}/explorer/sends/{QUERY}/{TYPE}         getSends        block, address, token
     * /{COIN}/explorer/sleeps/{QUERY}/{TYPE}        getSleeps       block, address, token
     * /{COIN}/explorer/swaps/{QUERY}/{TYPE}         getSwaps        block, address, token
     * /{COIN}/explorer/sweeps/{QUERY}/{TYPE}        getSweeps       block, address
     * /{COIN}/explorer/tokens/{QUERY}/{TYPE}        getTokens       block, address
     ******************************************************************/

    async getAddresses(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        addresses m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        m.fee_preference,
                        m.require_memo,
                        m.dispenser_preference,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        addresses m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getAirdrops(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        airdrops m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        t3.tick,
                        m.list_action_index,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        airdrops m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getBatches(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        batches m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        batches m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getBroadcasts(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        broadcasts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.message,
                        m.value,
                        m.fee,
                        m.broadcast_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        broadcasts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getCallbacks(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        callbacks m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.callback_tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        t3.tick,
                        t4.tick as callback_tick,
                        m.callback_amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        callbacks m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.callback_tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDestroys(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        destroys m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        t3.tick,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        destroys m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // TODO: update this SQL to pull all fields once dispensers are implemented in indexer
    async getDispensers(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or dispenser address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispensers m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.address as address,
                        c1.coin as give_coin,
                        t3.tick as give_tick,
                        m.give_amount,
                        m.give_escrow,
                        m.give_ownership,
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        m.get_amount,
                        a5.address as oracle_address,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        dispensers m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_addresses    a5 ON (a5.id=m.oracle_address_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getDispenserCancels(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispenser_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.dispenser_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        dispenser_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDispenserCloses(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispenser_closes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.dispenser_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=d1.get_address_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        m.dispenser_action_index,
                        a2.address as dispenser_address,
                        c1.coin as give_coin,
                        t2.tick as give_tick,
                        d1.give_amount,
                        c2.coin as get_coin,
                        t3.tick as get_tick,
                        d1.get_amount,
                        f1.code as fiat,
                        d1.fiat_amount,
                        a5.address as oracle_address,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        dispenser_closes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.dispenser_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=d1.get_address_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=d1.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=d1.get_coin_id)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=d1.give_tick_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=d1.get_tick_id)
                        LEFT  JOIN index_fiats        f1 ON (f1.id=d1.fiat_id)
                        LEFT  JOIN index_addresses    a5 ON (a5.id=d1.oracle_address_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDispenserEdits(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispenser_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.dispenser_action_index,
                        a2.address as source,
                        m.give_escrow,
                        m.expiration,
                        m.allow_list,
                        m.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        dispenser_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDispenserExpires(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispenser_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN orders             o1 ON (o1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.dispenser_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        m.dispenser_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        dispenser_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.dispenser_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDispenses(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // get_amount here is dispenses.get_amount (a fill), not dispensers.get_amount
        // (a price). When one payment fills several dispensers behind the same
        // address in a batch, each fill's get_amount is its share of the payment
        // rather than the whole payment restated per row (mainnet not yet armed;
        // testnet/regtest already this way) - do not "fix" this label back to the
        // whole-payment reading, see protocol/actions/dispenser.md "One Payment,
        // Several Dispensers".
        // Support searching by both source or dispenser address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        dispenses m
                        INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=d1.get_address_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        m.dispenser_action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.address as destination,
                        c1.coin as give_coin,
                        t3.tick as give_tick,
                        m.give_amount,
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        m.get_amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        dispenses m
                        INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=d1.get_address_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getDividends(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        dividends m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.dividend_tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        t3.tick,
                        t4.tick as dividend_tick,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        dividends m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.dividend_tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getFees(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        fees m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id) 
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        a1.action_format, 
                        a4.action,
                        a2.address as source,
                        a3.address as destination,
                        t3.tick,
                        m.method,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m.gas_cost,
                        m.gas_price,
                        m.xchain_amount,
                        m.payment_mode,
                        m.native_coin_amount,
                        m.native_coin,
                        m.oracle_round,
                        m.fee_preference,
                        m.fee_version
                    FROM
                        fees m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id) 
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }  

    async getFiles(config){
        let sql   = config.data.sql;
        let count = null;
        let query = null;
        // type=='name' (M1.7) falls into the else branch below like
        // block/address/list-all: it queries the base `files` table directly, not
        // the interned mappings_files/tick join `type=='token'` uses. The actual
        // `m.name=?` predicate is added by getQueryWhereSql (the shared WHERE
        // builder every getXxx method routes through); nothing here needs to branch
        // on it. Same column set as every other mode, gated-file columns included
        // (gate_ticker/gate_min_amount/encryption_method/key_hash), so a by-name
        // lookup discloses nothing block/address/list-all don't already return.
        if(config.data.type=='token'){
            count = `SELECT
                            count(*) as total
                        FROM
                            mappings_files m
                            INNER JOIN files              f1 ON (f1.action_index=m.action_index)
                            INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                            LEFT  JOIN index_tickers      t4 on (t4.id=m.id)
                            LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        WHERE ` + sql.where.data;
            query = `SELECT
                            a3.action,
                            f1.action_index,
                            a1.action_format,
                            f1.name,
                            f1.title,
                            t3.type as type,
                            a2.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status,
                            gf.gate_ticker,
                            gf.gate_min_amount,
                            gf.encryption_method,
                            gf.key_hash
                        FROM
                            mappings_files m
                            INNER JOIN files              f1 ON (f1.action_index=m.action_index)
                            INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                            LEFT  JOIN index_tickers      t4 on (t4.id=m.id)
                            LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                            LEFT  JOIN gated_files        gf ON (gf.action_index=f1.action_index)
                        WHERE ` + sql.where.data + sql.where.offset +`
                        ORDER BY m.action_index ` + sql.order + `
                        LIMIT ` + sql.limit;
        } else {
            count = `SELECT
                            count(*) as total
                        FROM
                            files m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_mime_types   t3 ON (t3.id=m.type_id)
                            LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        WHERE ` + sql.where.data;
            query = `SELECT
                            a3.action,
                            m.action_index,
                            a1.action_format,
                            m.name,
                            m.title,
                            t3.type as type,
                            a2.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status,
                            gf.gate_ticker,
                            gf.gate_min_amount,
                            gf.encryption_method,
                            gf.key_hash
                        FROM
                            files m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_mime_types   t3 ON (t3.id=m.type_id)
                            LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                            LEFT  JOIN gated_files        gf ON (gf.action_index=m.action_index)
                        WHERE ` + sql.where.data + sql.where.offset +`
                        ORDER BY m.action_index ` + sql.order + `
                        LIMIT ` + sql.limit;
        }
        return [query, null, count];
    }    

    async getIssues(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        issues m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.transfer_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=m.transfer_supply_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.callback_tick_id)
                        LEFT  JOIN index_actions      a5 ON (a5.id=a1.action_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a5.action,
                        m.action_index,
                        a1.action_format, 
                        t3.tick,
                        m.max_supply,
                        m.max_mint,
                        m.decimals,
                        m.description,
                        m.mint_supply,
                        a3.address as transfer,
                        a4.address as transfer_supply,
                        m.lock_max_supply,
                        m.lock_mint,
                        m.lock_mint_supply,
                        m.lock_max_mint,
                        m.lock_description,
                        m.lock_sleep,
                        m.lock_callback,
                        m.callback_block,
                        t4.tick as callback_tick,
                        m.callback_amount,
                        m.allow_list,
                        m.block_list,
                        m.mint_address_max,
                        m.mint_start_block,
                        m.mint_stop_block,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        issues m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.transfer_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=m.transfer_supply_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.callback_tick_id)
                        LEFT  JOIN index_actions      a5 ON (a5.id=a1.action_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getLinks(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        links m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.coin1_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.coin2_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        c1.coin as coin1,
                        m.coin1_action_index,
                        c2.coin as coin2,
                        m.coin2_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        links m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.coin1_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.coin2_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }    

    async getLists(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        lists m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.type,
                        m.edit,
                        m.list_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        lists m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getMessages(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or destination address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        messages m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        a3.address as destination,
                        m.encryption_method,
                        m.encryption_key,
                        m.encrypted_message,
                        m.plaintext_message,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status,
                        m.coin
                    FROM
                        messages m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getMints(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or destination address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        mints m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        a3.address as destination,
                        t3.tick,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        mints m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getOrders(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or destination address and both sides of an order for a specific token
        if(['address','token'].includes(config.data.type))
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        orders m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        c1.coin as give_coin,
                        t3.tick as give_tick,
                        m.give_amount,
                        m.give_ownership,
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        m.get_amount,
                        m.get_ownership,
                        a2.address as source,
                        a3.address as get_address,
                        m.expiration,
                        m.allow_list,
                        m.block_list,
                        m.payout_legs,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        orders m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getOrderCancels(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        order_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.order_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        order_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getOrderEdits(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        order_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.order_action_index,
                        a2.address as source,
                        m.expiration,
                        m.allow_list,
                        m.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        order_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getOrderExpires(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        order_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN orders             o1 ON (o1.action_index=m.order_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.order_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        m.order_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        order_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN orders             o1 ON (o1.action_index=m.order_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.order_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getOrderMatches(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        order_matches m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a2.action,
                        m.action_index,
                        a1.action_format,
                        c1.coin as give_coin,
                        m.give_action_index,
                        m.give_amount,
                        c2.coin as get_coin,
                        m.get_action_index,
                        m.get_amount,
                        m.settlement_type,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        order_matches m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getCoinpays(config){
        // coin_amount/vout here are the settlement record's, not the obligation's
        // (coinpay_obligations.coin_amount is the amount OWED). When one
        // transaction pays more than one obligation, each row's coin_amount/vout
        // name the specific output that paid THAT obligation, not the
        // transaction's first output (mainnet not yet armed; testnet/regtest
        // already this way) - do not "fix" this back to a single shared output.
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        coinpays m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a2.action,
                        m.action_index,
                        m.obligation_action_index,
                        m.coin_amount,
                        m.txid,
                        m.vout,
                        a3.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        s1.status
                    FROM
                        coinpays m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getCoinpayExpires(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        coinpay_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a2.action,
                        m.action_index,
                        m.obligation_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        coinpay_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getCoinpayObligations(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        coinpay_obligations m
                        INNER JOIN index_addresses    a1 ON (a1.id=m.payer_address_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=m.payee_address_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.coin_id)
                        INNER JOIN coinpay_statuses   s1 ON (s1.coinpay_action_index=m.action_index)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT MAX(s3.action_index) FROM coinpay_statuses s3 WHERE s3.coinpay_action_index=m.action_index
                        ) AND ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        a1.address as payer_address,
                        a2.address as payee_address,
                        c1.coin,
                        m.coin_amount,
                        m.expiration,
                        m.block_index,
                        s2.status as coinpay_status
                    FROM
                        coinpay_obligations m
                        INNER JOIN index_addresses    a1 ON (a1.id=m.payer_address_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=m.payee_address_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.coin_id)
                        INNER JOIN coinpay_statuses   s1 ON (s1.coinpay_action_index=m.action_index)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                    WHERE
                        s1.action_index = (
                            SELECT MAX(s3.action_index) FROM coinpay_statuses s3 WHERE s3.coinpay_action_index=m.action_index
                        ) AND ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getSends(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or destination address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        sends m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        a3.address as destination,
                        t3.tick,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        sends m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    } 

    async getSleeps(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        sleeps m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT JOIN index_tickers       t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.type,
                        a2.address as source,
                        t3.tick,
                        m.resume_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        sleeps m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT JOIN index_tickers       t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    } 

    async getSwaps(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or destination address and both sides of swap for a specific token
        if(['address','token'].includes(config.data.type))
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        swaps m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        c1.coin as give_coin,
                        t3.tick as give_tick,
                        m.give_amount,
                        m.give_ownership,
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        m.get_amount,
                        m.get_ownership,
                        a2.address as source,
                        a3.address as get_address,
                        m.expiration,
                        m.allow_list,
                        m.block_list,
                        m.payout_legs,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status,
                        ss_ist.status as swap_status
                    FROM
                        swaps m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                        LEFT  JOIN swap_statuses      ss ON (ss.swap_action_index=m.action_index
                            AND ss.action_index=(SELECT MAX(ss2.action_index) FROM swap_statuses ss2 WHERE ss2.swap_action_index=m.action_index))
                        LEFT  JOIN index_statuses     ss_ist ON (ss_ist.id=ss.status_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getSwapCancels(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        swap_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.swap_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        swap_cancels m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getSwapEdits(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        swap_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        m.swap_action_index,
                        a2.address as source,
                        m.expiration,
                        m.allow_list,
                        m.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        swap_edits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getSwapExpires(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        swap_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN orders             o1 ON (o1.action_index=m.swap_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.swap_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        m.swap_action_index,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        swap_expires m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN swaps              s2 ON (s2.action_index=m.swap_action_index)
                        INNER JOIN actions            a3 ON (a3.action_index=m.swap_action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a3.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getSwapMatches(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        swap_matches m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a2.action,
                        m.action_index,
                        a1.action_format, 
                        c1.coin as give_coin,
                        m.give_action_index,
                        c2.coin as get_coin,
                        m.get_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        swap_matches m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        LEFT  JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
         return [query, null, count];
    }

    async getSweeps(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        // Support searching by both source or destination address
        if(config.data.type=='address')
            args.push(config.data.search);
        let count = `SELECT
                        count(*) as total
                    FROM
                        sweeps m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.address as destination,
                        m.balances,
                        m.ownerships,
                        m.orders,
                        m.swaps,
                        m.dispensers,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        sweeps m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    } 

    async getTokens(config){
        let sql    = config.data.sql;
        let search = config.data.search;
        let type   = config.data.type;
        // Default to no bind args: the list-all WHERE ('m.action_index IS NOT NULL') has
        // no placeholder, so seeding [search] (= [null] with no QUERY/TYPE) prepends a
        // phantom bind that shifts the offset args (m.id < NULL) and returns zero rows.
        // token/subtoken set a LIKE pattern below; list-all stays [].
        let args   = [];
        let order  = 'm.id ' + sql.order;
        if(['token','subtoken'].includes(type)){
            order = 't3.tick ' + sql.order;
            if(type=='token')
                args = ['%' + this.util.escapeLike(config.data.search) + '%'];
            if(type=='subtoken')
                args = [this.util.escapeLike(config.data.search) + '.%'];
        } else if(['block','address'].includes(type)){
            // type=block/address falls into the generic getQueryWhereSql filter
            // (b1.block_index=? / a2.address=?), so the search value (block height or
            // owner address) MUST be bound as the data-WHERE arg. Leaving args=[] left
            // that placeholder unbound (500 "Parameter at position 1 is not set"). Other
            // action methods reach the same arg via the executor's [config.data.search]
            // fallback; getTokens returns an explicit args array, so it must set it here.
            args = [config.data.search];
        }
        let count = `SELECT
                        count(*) as total
                    FROM
                        tokens m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.owner_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
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
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.owner_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY ` + order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    } 

    /******************************************************************
     * XChain API Market Endpoints
     * 
     * Endpoints                                          Method Name  
     * -----------------------------------------------------------------
     * /{COIN}/api/markets                                getMarkets
     * /{COIN}/api/markets/{QUERY}                        getMarkets
     * /{COIN}/api/market/{QUERY}/{QUERY}                 getMarket
     * /{COIN}/api/market/{QUERY}/{QUERY}/history         getMarketHistory
     * /{COIN}/api/market/{QUERY}/{QUERY}/history/{QUERY} getMarketHistory
     * /{COIN}/api/market/{QUERY}/{QUERY}/orders/{QUERY}  getMarketOrders
     * /{COIN}/api/market/{QUERY}/{QUERY}/orderbook       getOrderbook
     ******************************************************************/

    async getMarkets(config){
        let data  = [];
        let total = 0;
        let tick  = config.data.search;
        let sql   = config.data.sql;
        let args  = [tick, tick];
        let count = `SELECT
                        count(*) as total
                    FROM
                        markets m
                        INNER JOIN index_tickers t1 ON (t1.id=m.tick1_id)
                        INNER JOIN index_tickers t2 ON (t2.id=m.tick2_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        t1.tick as tick1,
                        m.tick1_price,
                        m.tick1_bid,
                        m.tick1_ask,
                        m.tick1_24hr_price,
                        m.tick1_24hr_high,
                        m.tick1_24hr_low,
                        m.tick1_24hr_change,
                        m.tick1_24hr_volume,
                        t2.tick as tick2,
                        m.tick2_price,
                        m.tick2_bid,
                        m.tick2_ask,
                        m.tick2_24hr_price,
                        m.tick2_24hr_high,
                        m.tick2_24hr_low,
                        m.tick2_24hr_change,
                        m.tick2_24hr_volume,
                        m.last_updated
                    FROM
                        markets m
                        INNER JOIN index_tickers t1 ON (t1.id=m.tick1_id)
                        INNER JOIN index_tickers t2 ON (t2.id=m.tick2_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        let results = await this.doQuery(config, count, args);
        if(results.length > 0)
            total = results[0].total;
        if(count){
            results = await this.doQuery(config, query, args);
            if(results.length > 0){
                for(let row of results){
                    let reverse = (!this.util.isNull(tick) && String(tick).toLowerCase()==String(row.tick2).toLowerCase()) ? true : false;
                    data.push({
                        id                : row.id,
                        tick1             : (reverse) ? row.tick1             : row.tick2,
                        tick1_price       : (reverse) ? row.tick1_price       : row.tick2_price,
                        tick1_bid         : (reverse) ? row.tick1_bid         : row.tick2_bid,
                        tick1_ask         : (reverse) ? row.tick1_ask         : row.tick2_ask,
                        tick1_24hr_price  : (reverse) ? row.tick1_24hr_price  : row.tick2_24hr_price,
                        tick1_24hr_high   : (reverse) ? row.tick1_24hr_high   : row.tick2_24hr_high,
                        tick1_24hr_low    : (reverse) ? row.tick1_24hr_low    : row.tick2_24hr_low,
                        tick1_24hr_change : (reverse) ? row.tick1_24hr_change : row.tick2_24hr_change,
                        tick1_24hr_volume : (reverse) ? row.tick1_24hr_volume : row.tick2_24hr_volume,
                        tick2             : (reverse) ? row.tick2             : row.tick1,
                        tick2_price       : (reverse) ? row.tick2_price       : row.tick1_price,
                        tick2_bid         : (reverse) ? row.tick2_bid         : row.tick1_bid,
                        tick2_ask         : (reverse) ? row.tick2_ask         : row.tick1_ask,
                        tick2_24hr_price  : (reverse) ? row.tick2_24hr_price  : row.tick1_24hr_price,
                        tick2_24hr_high   : (reverse) ? row.tick2_24hr_high   : row.tick1_24hr_high,
                        tick2_24hr_low    : (reverse) ? row.tick2_24hr_low    : row.tick1_24hr_low,
                        tick2_24hr_change : (reverse) ? row.tick2_24hr_change : row.tick1_24hr_change,
                        tick2_24hr_volume : (reverse) ? row.tick2_24hr_volume : row.tick1_24hr_volume,
                        last_updated      : row.last_updated
                    });
                }
            }
        }
        return [data, null, total];
    } 

    async getMarket(config){
        let data  = [];
        let total = 0;
        let tick1 = config.data.search;
        let tick2 = config.data.search2;
        let sql   = config.data.sql;
        let args  = [tick1, tick2, tick2, tick1];
        let query = `SELECT
                        m.id,
                        t1.tick as tick1,
                        m.tick1_price,
                        m.tick1_bid,
                        m.tick1_ask,
                        m.tick1_24hr_price,
                        m.tick1_24hr_high,
                        m.tick1_24hr_low,
                        m.tick1_24hr_change,
                        m.tick1_24hr_volume,
                        t2.tick as tick2,
                        m.tick2_price,
                        m.tick2_bid,
                        m.tick2_ask,
                        m.tick2_24hr_price,
                        m.tick2_24hr_high,
                        m.tick2_24hr_low,
                        m.tick2_24hr_change,
                        m.tick2_24hr_volume,
                        m.last_updated
                    FROM
                        markets m
                        INNER JOIN index_tickers t1 ON (t1.id=m.tick1_id)
                        INNER JOIN index_tickers t2 ON (t2.id=m.tick2_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        let results = await this.doQuery(config, query, args);
        if(results.length > 0){
            for(let row of results){
                let reverse = (!this.util.isNull(tick2) && String(tick2).toLowerCase()==String(row.tick2).toLowerCase()) ? true : false;
                data.push({
                    id                : row.id,
                    tick1             : (reverse) ? row.tick1             : row.tick2,
                    tick1_price       : (reverse) ? row.tick1_price       : row.tick2_price,
                    tick1_bid         : (reverse) ? row.tick1_bid         : row.tick2_bid,
                    tick1_ask         : (reverse) ? row.tick1_ask         : row.tick2_ask,
                    tick1_24hr_price  : (reverse) ? row.tick1_24hr_price  : row.tick2_24hr_price,
                    tick1_24hr_high   : (reverse) ? row.tick1_24hr_high   : row.tick2_24hr_high,
                    tick1_24hr_low    : (reverse) ? row.tick1_24hr_low    : row.tick2_24hr_low,
                    tick1_24hr_change : (reverse) ? row.tick1_24hr_change : row.tick2_24hr_change,
                    tick1_24hr_volume : (reverse) ? row.tick1_24hr_volume : row.tick2_24hr_volume,
                    tick2             : (reverse) ? row.tick2             : row.tick1,
                    tick2_price       : (reverse) ? row.tick2_price       : row.tick1_price,
                    tick2_bid         : (reverse) ? row.tick2_bid         : row.tick1_bid,
                    tick2_ask         : (reverse) ? row.tick2_ask         : row.tick1_ask,
                    tick2_24hr_price  : (reverse) ? row.tick2_24hr_price  : row.tick1_24hr_price,
                    tick2_24hr_high   : (reverse) ? row.tick2_24hr_high   : row.tick1_24hr_high,
                    tick2_24hr_low    : (reverse) ? row.tick2_24hr_low    : row.tick1_24hr_low,
                    tick2_24hr_change : (reverse) ? row.tick2_24hr_change : row.tick1_24hr_change,
                    tick2_24hr_volume : (reverse) ? row.tick2_24hr_volume : row.tick1_24hr_volume,
                    last_updated      : row.last_updated
                });
            }
        }
        return data;
    } 

    async getMarketOrders(config){
        let data    = [];
        let total   = 0;
        let tick1   = config.data.search;
        let tick2   = config.data.search2;
        let address = config.data.search3;
        let sql     = config.data.sql;
        let args    = [tick1, tick2, tick2, tick1];
        if(!this.util.isNull(address))
            args.push(address)
        let count = `SELECT
                        count(*) as total
                    FROM
                        orders m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        LEFT  JOIN transactions       t3 ON (t3.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t3.source_id)
                        INNER JOIN index_tickers      t1 ON (t1.id=m.give_tick_id)
                        INNER JOIN index_tickers      t2 ON (t2.id=m.get_tick_id)
                        INNER JOIN order_statuses     s1 ON (s1.order_action_index=m.action_index)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                    WHERE 
                        ` + sql.where.data + ` AND 
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                order_statuses s3
                            WHERE
                                s3.order_action_index=m.action_index
                        ) AND
                        s2.status='open'`;
        let results = await this.doQuery(config, count, args);
        if(results.length > 0)
            total = results[0].total;
        if(total){
            let query   = `SELECT
                            m.action_index
                        FROM
                            orders m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            LEFT  JOIN transactions       t3 ON (t3.tx_index=a1.tx_index)
                            LEFT  JOIN index_addresses    a2 ON (a2.id=t3.source_id)
                            INNER JOIN index_tickers      t1 ON (t1.id=m.give_tick_id)
                            INNER JOIN index_tickers      t2 ON (t2.id=m.get_tick_id)
                            INNER JOIN order_statuses     s1 ON (s1.order_action_index=m.action_index)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        WHERE 
                            ` + sql.where.data + ` AND 
                            s1.action_index = (
                                SELECT
                                    MAX(s3.action_index)
                                FROM
                                    order_statuses s3
                                WHERE
                                    s3.order_action_index=m.action_index
                            ) AND
                            s2.status='open'
                        ORDER BY m.action_index ` + sql.order + `
                        LIMIT ` + sql.limit;
            let results = await this.doQuery(config, query, args);
            if(results.length > 0){
                // Batch-fetch all order info in one round-trip instead of N+1 queries.
                let action_indexes = results.map(r => Number(r.action_index));
                let orderMap = await this.getOrderInfoBatch(config, action_indexes);
                for(let info of results){
                    let order = orderMap[Number(info.action_index)];
                    if(!order) continue;
                    let reverse = (order.give_tick==tick2) ? true : false;
                    data.push({
                        type         : (reverse) ? 'buy' : 'sell',
                        price        : (reverse) ? order.get_price : order.give_price,
                        amount       : (reverse) ? order.get_amount : order.give_amount,
                        action_index : order.action_index,
                        timestamp    : order.timestamp,
                        expiration   : order.expiration
                    });
                }
            }
        }
        return [data, null, total];
    }

    async getMarketHistory(config){
        let data    = [];
        let total   = 0;
        let tick1   = config.data.search;
        let tick2   = config.data.search2;
        let address = config.data.search3;
        let sql     = config.data.sql;
        let args    = [tick1, tick2, tick2, tick1];
        if(!this.util.isNull(address))
            args.push(address, address);
        let count = `SELECT
                        count(*) as total
                    FROM
                        order_matches m
                        INNER JOIN orders             o1 ON (o1.action_index=m.give_action_index)
                        INNER JOIN orders             o2 ON (o2.action_index=m.get_action_index)
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        INNER JOIN index_tickers      t1 ON (t1.id=m.give_tick_id)
                        INNER JOIN index_tickers      t2 ON (t2.id=m.get_tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=o1.get_address_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=o2.get_address_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    WHERE 
                        ` + sql.where.data + ` AND 
                        s1.status='valid'`;
        let results = await this.doQuery(config, count, args);
        if(results.length > 0)
            total = results[0].total;
        if(total){
            let query   = `SELECT
                            m.action_index,
                            t1.tick as give_tick,
                            t2.tick as get_tick,
                            m.give_amount,
                            m.get_amount,
                            b1.block_index,
                            b1.block_time as timestamp
                        FROM
                            order_matches m
                            INNER JOIN orders             o1 ON (o1.action_index=m.give_action_index)
                            INNER JOIN orders             o2 ON (o2.action_index=m.get_action_index)
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN index_tickers      t1 ON (t1.id=m.give_tick_id)
                            INNER JOIN index_tickers      t2 ON (t2.id=m.get_tick_id)
                            INNER JOIN index_addresses    a2 ON (a2.id=o1.get_address_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=o2.get_address_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        WHERE 
                            ` + sql.where.data + ` AND 
                            s1.status='valid'
                        ORDER BY m.action_index ` + sql.order + `
                        LIMIT ` + sql.limit;
            let results = await this.doQuery(config, query, args);
            if(results.length > 0){
                for(let order of results){
                    let reverse    = (order.give_tick==tick2) ? true : false;
                    let give_price = this.util.getPrice(order.get_amount, order.give_amount);
                    let get_price  = this.util.getPrice(order.give_amount, order.get_amount);
                    data.push({
                        type         : (reverse) ? 'sell' : 'buy',
                        price        : (reverse) ? get_price : give_price,
                        amount       : (reverse) ? this.util.bcnum(order.get_amount) : this.util.bcnum(order.give_amount),
                        action_index : order.action_index,
                        block_index  : order.block_index,
                        timestamp    : order.timestamp
                    });
                }
            }
        }
        return [data, null, total];
    } 

    async getOrderbook(config){
        let data   = {
            asks: [],
            bids: []
        };
        let bids   = [];
        let asks   = [];
        let tick1  = config.data.search;
        let tick2  = config.data.search2;
        let sql    = config.data.sql;
        let args   = [tick1, tick2, tick2, tick1];
        let query  = `SELECT
                        m.action_index
                    FROM
                        orders m
                        INNER JOIN index_tickers  t1 ON (t1.id=m.give_tick_id)
                        INNER JOIN index_tickers  t2 ON (t2.id=m.get_tick_id)
                        INNER JOIN order_statuses s1 ON (s1.order_action_index=m.action_index)
                        INNER JOIN index_statuses s2 ON (s2.id=s1.status_id)
                    WHERE 
                        ` + sql.where.data + ` AND 
                        s1.action_index = (
                            SELECT
                                MAX(s3.action_index)
                            FROM
                                order_statuses s3
                            WHERE
                                s3.order_action_index=m.action_index
                        ) AND
                        s2.status='open'`;
        let results = await this.doQuery(config, query, args);
        if(results.length > 0){
            // Batch fetch all order info in parallel instead of N+1 queries
            let action_indexes = results.map(r => Number(r.action_index));
            let orderMap = await this.getOrderInfoBatch(config, action_indexes);
            for(let info of results){
                let order = orderMap[Number(info.action_index)];
                if(!order) continue;
                let type  = (order.give_tick==tick2) ? 'bid' : 'ask';
                let price = (order.give_tick==tick2) ? order.get_price : order.give_price;
                let found = false;
                if(type=='bid'){
                    for(let bid of bids){
                        if(bid.price==price){
                            bid.amount = this.util.bcadd(bid.amount, order.get_remaining);
                            found = true;
                        }
                    }
                    if(!found)
                        bids.push({ price: price, amount: order.get_remaining });
                }
                if(type=='ask'){
                    for(let ask of asks){
                        if(ask.price==price){
                            ask.amount = this.util.bcadd(ask.amount, order.give_remaining);
                            found = true;
                        }
                    }
                    if(!found)
                        asks.push({ price: price, amount: order.give_remaining });
                }
            }
            // Sort asks and bids
            bids = this.util.priceSort(bids,'DESC');
            asks = this.util.priceSort(asks,'ASC');
            // Add the bids and asks to the response object
            for(let bid of bids)
                data.bids.push([bid.price, bid.amount]);
            for(let ask of asks)
                data.asks.push([ask.price, ask.amount]);
            data.market = tick1 + '/' + tick2;
        }
        return [data];
    } 

    /******************************************************************
     * XChain API Misc Endpoints
     * 
     * Endpoints                              Method Name      Query Types
     * -----------------------------------------------------------------
     * /{COIN}/api/action/{QUERY}             getAction       action_index
     * /{COIN}/api/address/{QUERY}            getAddress      address
     * /{COIN}/api/balances/{QUERY}/{TYPE}    getBalances     address
     * /{COIN}/api/block/{QUERY}              getBlock        block
     * /{COIN}/api/credits/{QUERY}/{TYPE}     getCredits      block, address
     * /{COIN}/api/debits/{QUERY}/{TYPE}      getDebits       block, address
     * /{COIN}/api/escrows/{QUERY}/{TYPE}     getEscrows      block, address
     * /{COIN}/api/history/{QUERY}/{TYPE}     getHistory      block, address, token
     * /{COIN}/api/holders/{QUERY}            getHolders      token
     * /{COIN}/api/mempool/{QUERY}/{TYPE}     getMempool      address, token,
     * /{COIN}/api/network                    getNetwork
     * /{COIN}/api/status                     getStatus
     * /{COIN}/api/token/{QUERY}              getToken        token
     * /{COIN}/api/transaction/{QUERY}/{TYPE} getTransaction  tx_hash, tx_index
     ******************************************************************/

    async getAction(config){
        let data = await this.getActionData(config, config.data.search);
        return [data];
    }

    async getActions(config){
        let sql   = config.data.sql;
        let q     = (config.data.query) ? config.data.query : {};
        let args  = [];
        let extra = '';
        if (!this.util.isNull(q.blockIndex)) {
            extra += ' AND b1.block_index=?';
            args.push(this.util.sanitizeInt(q.blockIndex));
        }
        if (!this.util.isNull(q.txid)) {
            extra += ' AND t2.hash=?';
            args.push(q.txid);
        }
        if (!this.util.isNull(q.tick)) {
            extra += ` AND m.action_index IN (
                            SELECT ma.action_index FROM mappings_actions ma
                            INNER JOIN index_tickers it ON it.id=ma.id
                            WHERE ma.type_id=1 AND it.tick=?)`;
            args.push(q.tick);
        }
        let count = `SELECT
                        count(*) as total
                    FROM
                        actions m
                        INNER JOIN transactions       t1 ON (t1.tx_index=m.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data + extra;
        let query = `SELECT
                        m.action_index,
                        a1.action,
                        m.action_format,
                        a2.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index
                    FROM
                        actions m
                        INNER JOIN transactions       t1 ON (t1.tx_index=m.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_actions      a1 ON (a1.id=m.action_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data + extra + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // TODO: pull balance data from the utxo-tracker API instead of placeholder values
    async getAddress(config){
        const address = config.data.search;
        // Native-coin balance / UTXO figures come from this coin's xchain-utxo-tracker (the
        // explorer is DB-only and never talks to a node). When no tracker is configured for the
        // coin or it is unreachable, the fields stay null and the page shows "Unavailable" rather
        // than the old hardcoded placeholder values. See getAddressTrackerInfo().
        let data = {
            address: address,
            type: null,
            balances: { confirmed: null, pending: null, received: null },
            utxos: { confirmed: null, pending: null },
            estimated_value: { btc: null, usd: null },
            tracker_available: false
        };
        let info = await this.getAddressTrackerInfo(config, address);
        if(info && info.balances && info.utxos){
            data.type     = info.type || null;
            data.balances = {
                confirmed: info.balances.confirmed,
                pending:   info.balances.pending,
                received:  info.balances.received
            };
            data.utxos = {
                confirmed: info.utxos.confirmed,
                pending:   info.utxos.pending
            };
            data.tracker_available = true;
            if(info.mempool_ready !== undefined) data.mempool_ready = info.mempool_ready;
            // Estimated fiat value of the confirmed balance: confirmed amount * live USD price
            // (null on testnet/regtest or when the hub oracle has no price for this coin).
            let price = await this.getCoinPriceUsd(config);
            data.estimated_value = {
                btc: data.balances.confirmed,
                usd: (price != null && data.balances.confirmed != null)
                    ? this.util.bcmul(String(data.balances.confirmed), String(price), 2)
                    : null
            };
        }
        // Controller bindings still gating this address's native actions
        // (protocol/Controller_Bound_Tokens.md). [] when nothing gates.
        data.controllers = await this.getAddressControllerBindings(config, config.data.search);
        // Surface the immutable index_addresses id (mirrors how getToken surfaces
        // tick_id in info). The SDK address compactor reads info.address_id to rewrite
        // an address to its smaller ^<id> wire form (see xchain-sdk addressResolver.js).
        // F3 (id-determinism): expose it ONLY when the id is in the DETERMINISTIC set
        // (block_index IS NOT NULL). An out-of-band id (recovery pre-seed, pre-F1a) is not
        // reproducible across nodes, so the SDK must never compact an address to it; the
        // indexer's resolveAddressRef rejects such a ^id anyway, this stops the leak at the
        // source. getCompactableAddressId, NOT getAddressId (the internal string<->id
        // resolver), so display/lookup paths are unaffected. null => SDK emits the full address.
        let addressId = await this.getCompactableAddressId(config, config.data.search);
        data.info = {
            address:    config.data.search,
            address_id: (addressId !== null && addressId !== undefined) ? Number(addressId) : null
        };
        return [data];
    }

    // Live native-coin balance / UTXO info for an address from this coin's xchain-utxo-tracker.
    // The explorer is DB-only and never talks to a node, so it asks the tracker's read API. The
    // base URL is per coin (each tracker instance is single-coin): UTXO_TRACKER_URL_<CODE> (e.g.
    // UTXO_TRACKER_URL_BTC, UTXO_TRACKER_URL_TBTC), falling back to a generic UTXO_TRACKER_URL.
    // The tracker's GET /info/<address> response already matches the address-page shape
    // (type + balances{confirmed,pending,received} + utxos{confirmed,pending}, full-precision
    // decimal strings). Returns null when no tracker is configured for this coin or it is
    // unreachable, so getAddress can fall back to an honest "Unavailable" instead of fake values.
    async getAddressTrackerInfo(config, address){
        const code = config.coin;
        const base = process.env['UTXO_TRACKER_URL_' + code] || process.env.UTXO_TRACKER_URL;
        if(!base || !address) return null;
        try {
            const url = base.replace(/\/+$/, '') + '/info/' + encodeURIComponent(address);
            const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
            if(!res.ok) throw new Error('HTTP ' + res.status);
            const j = await res.json();
            if(j && j.balances && j.utxos) return j;
            throw new Error('malformed /info response');
        } catch(e){
            console.warn('getAddressTrackerInfo: tracker unavailable for ' + code + ': ' + (e && e.message ? e.message : e));
            return null;
        }
    }

    async getBalances(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                        INNER JOIN tokens          t4 ON (t4.tick_id=m.tick_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        t1.tick,
                        m.amount,
                        t4.supply,
                        t4.decimals,
                        t4.coin_price
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                        INNER JOIN tokens          t4 ON (t4.tick_id=m.tick_id)
                    WHERE ` + sql.where.data + `
                    ORDER BY t1.tick ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getBlock(config){
        let data = null;
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let query = `SELECT
                        b1.block_index,
                        b1.block_time as timestamp,
                        t1.hash as ledger_hash,
                        t2.hash as actions_hash,
                        t3.hash as contract_hash,
                        t4.hash as state_hash
                    FROM
                        blocks b1
                        LEFT  JOIN index_transactions t1 ON (t1.id=b1.ledger_hash_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=b1.actions_hash_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=b1.contract_hash_id)
                        LEFT  JOIN index_transactions t4 ON (t4.id=b1.state_hash_id)
                    WHERE ` + sql.where.data + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            data = results[0];
        return [data];
    }

    async getCredits(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        credits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        t1.tx_index,
                        a2.address,
                        t2.tick,
                        m.amount,
                        a3.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t3.hash as tx_hash
                    FROM
                        credits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDebits(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        debits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        t1.tx_index,
                        a2.address,
                        t2.tick,
                        m.amount,
                        a3.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t3.hash as tx_hash
                    FROM
                        debits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getEscrows(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        escrows m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        t1.tx_index,
                        a2.address,
                        t2.tick,
                        m.amount,
                        a3.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t3.hash as tx_hash
                    FROM
                        escrows m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get history information for a given address
    async getHistory(config){
        let [data, count] = await this.getHistoryData(config);
        return [data, null, count];
    }

    async getHolders(config){
        let sql   = config.data.sql;
        // Guard: for a token-type query, verify the tick exists before joining
        // against the full balances table. Without this check, a nonexistent
        // tick produces a WHERE t3.tick=? that forces a full balances scan (the
        // LEFT JOIN does not short-circuit) which was reported as a DoS-shaped
        // hang; returning [] immediately avoids the scan.
        if(config.data.type === 'token'){
            let tickCheck = await this.doQuery(config,
                `SELECT id FROM index_tickers WHERE tick=? LIMIT 1`,
                [config.data.search]);
            if(!tickCheck || tickCheck.length === 0)
                return [[], null, 0];
        }
        let count = `SELECT
                        count(*) as total
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                        INNER JOIN tokens          t4 ON (t4.tick_id=m.tick_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a2.address,
                        m.amount,
                        t3.tick,
                        t4.supply,
                        t4.decimals,
                        t4.coin_price
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                        INNER JOIN tokens          t4 ON (t4.tick_id=m.tick_id)
                    WHERE ` + sql.where.data + `
                    ORDER BY ABS(m.amount) ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    //
    // /{COIN}/api/mempool[/{QUERY}/{TYPE}]: unconfirmed actions read from the
    // colocated decoder DB (see getDecoderMempoolRows). Rows are PRE-VALIDATION
    // (the indexer can still reject them at confirmation), carry a destination
    // column that is always NULL (see getDecoderMempoolRows: never read, never
    // filtered on), and the full decoded action string ships in `data`; clients
    // with format knowledge (e.g. the SDK's x402 verifier) parse fields out of it.
    // Filtering is a best-effort prefilter done in JS rather than in SQL (the
    // action string is one opaque pipe-joined column, so a LIKE would match
    // across field boundaries): TYPE=address matches the source OR any exact
    // pipe-segment of the action string (covers SEND destinations across
    // versions); TYPE=token matches any exact segment against the uppercased
    // tick. No TYPE (bare /api/mempool, or the /explorer/mempool list-all
    // fallback) lists every decoded row (spec explorer-coverage-completion
    // M1.2): the old code matched ONLY address/token and silently returned []
    // for the list-all case, which is the bug this row fixes.
    //
    // PAGING (deliberate §8 exception, spec-approved): this is a direct-return
    // method (getData's `typeof query === 'object'` branch), and the source is
    // the decoder's mempool table, not an indexer action table: there is no
    // action_index/id cursor column pre-confirmation for the standard SQL
    // OFFSET/cursor machinery (getQueryOffsets/getQueryOffsetSql) to key off,
    // and getDecoderMempoolRows already caps its read at one bounded window
    // (500 rows, clamped in getDecoderMempoolRows itself) rather than scanning
    // the whole table. Given that bounded window, paging is done here by a
    // plain JS-side slice honoring sql.limit (computed by getQuery: the
    // per-method max for /api, the DataTables page `length` for /explorer)
    // and whichever offset numbering the caller already uses: `sql.apiOffset`
    // for /api (page-based), or the raw DataTables `query.start` row offset
    // for /explorer. The action_index next/prev/first/last cursor dance the
    // other list feeds use does not apply here, since there is no cursor
    // column to carry it on, so /explorer/mempool pages by plain numeric
    // offset instead, which is safe specifically because the source window
    // is already capped.
    // `total` is the full filtered-match count (pre-slice), matching every
    // other list feed's envelope semantics for recordsTotal/json.total.
    async getMempool(config){
        let search = String(config.data.search || '');
        let type   = String(config.data.type || '').toLowerCase();
        let rows   = await this.getDecoderMempoolRows(config, 500);
        let out    = [];
        for(let row of rows){
            let decoded = this.decodeMempoolRow(row);
            if(!decoded) continue;
            if(!type){
                out.push(decoded);
                continue;
            }
            let segments = decoded.data.split('|');
            let match = false;
            if(type=='address')
                match = (decoded.source===search) || segments.includes(search);
            if(type=='token')
                match = segments.includes(search.toUpperCase());
            if(match) out.push(decoded);
        }
        let total = out.length;
        let sql   = config.data.sql || {};
        // Fall back to the full matched set when no request-shaped sql/limit is
        // present (e.g. an internal caller building a minimal config), so this
        // method never truncates output it wasn't asked to page.
        let limit = (this.util.isInteger(Number(sql.limit)) && Number(sql.limit) > 0)
            ? Number(sql.limit) : (total || 1);
        let offset = 0;
        if(config.type === 'api')
            offset = Number(sql.apiOffset) || 0;
        else if(config.type === 'explorer')
            offset = Number(config.data.query && config.data.query.start) || 0;
        return [out.slice(offset, offset + limit), null, total];
    }

    async getNetwork(config){
        // Resolve the coin this request is for. config.coin is the route code
        // (BTC / TBTC / RDOGE …); the per-coin chain identity (name + ticker)
        // lives in the loaded explorer config under the BASE coin key (BTC/LTC/DOGE).
        let code = config.coin;
        let coinName = String(code), coinTick = String(code);
        // Network of THIS request, derived from the route-code prefix (T=testnet,
        // R=regtest, none=mainnet). Used for the finality clamp below so an
        // override may only raise the depth on mainnet. Defaults to mainnet (the
        // safe, clamping choice) when config is momentarily unavailable.
        let reqNetwork = 'mainnet';
        try {
            let full  = await this.configInfo.getConfig();
            let bases = Object.keys(full['COIN_NETWORKS'] || {});            // ['BTC','LTC','DOGE']
            let base  = bases.find(c => String(code).endsWith(c)) || code;   // 'TBTC' -> 'BTC'
            let chain = (full[base] && full[base].chain) ? full[base].chain : {};
            if(chain.name) coinName = chain.name;
            if(chain.tick) coinTick = chain.tick;
            let prefixes = full['COIN_PREFIXES'] || { mainnet: '', testnet: 'T', regtest: 'R' };
            let upper = String(code).toUpperCase();
            for(const net in prefixes){
                const p = prefixes[net];
                if(p && upper.startsWith(p) && bases.includes(upper.slice(p.length))){ reqNetwork = net; break; }
            }
        } catch(e){ /* keep code-based fallbacks if config is momentarily unavailable */ }

        // Real indexer tip + last-block time for this coin (same source as /status).
        let block       = await this.getMaxBlockIndex(config);
        let blockTime   = await this.getMaxBlockTime(config);
        // Real unconfirmed (mempool) count from the decoder API/DB (XChain-carrying
        // txs), plus the coin node's TOTAL mempool size (any tx), which only the
        // decoder API can report (null when it isn't configured/reachable).
        let unconfirmed     = await this.getDecoderMempoolCount(config);
        let unconfirmedNode = await this.getNodeMempoolCount(config);
        // Live fee tiers from this coin's encoder (estimatesmartfee), cached.
        let fee = await this.getFeeEstimate(config);
        // Live USD price from the xchain-hub oracle (mainnet coins only; null for
        // testnet/regtest or when no oracle price is available (see getCoinPriceUsd()).
        let coinPriceUsd = await this.getCoinPriceUsd(config);

        let data = {
            // Per-action-type record counts (real; populated below).
            totals : {},
            // Network information: block/time are the real indexer tip for this coin.
            network: {
                block : block,
                time  : blockTime,
                // Real mempool size: count of unconfirmed XChain-carrying txs for
                // this coin (0 if neither the decoder API nor DB is reachable).
                unconfirmed: unconfirmed,
                // The coin node's TOTAL mempool tx count (XChain or not), from
                // the decoder API. null when no decoder API resolves for this
                // coin (a DB-only deployment cannot know it); clients hide it.
                unconfirmed_node: unconfirmedNode,
            },
            // Suggested fee tiers (sat/vByte) from this coin's encoder, which reads
            // the node's estimatesmartfee. Falls back to {1,2,3} when no encoder is
            // configured (ENCODER_URL) or it's unreachable. See getFeeEstimate().
            fee: fee,
            // Coin identity is REAL (from the per-coin chain config). usd price is
            // REAL for mainnet coins (from the xchain-hub oracle); testnet/regtest
            // keep the $0.00 placeholder (no market). price.btc stays the identity
            // 1.0 (coin priced in itself); a coin/BTC cross is future work.
            coin: {
                name: coinName,
                symbol: coinTick,
                price: {
                    btc: '1.00000000',
                    usd: coinPriceUsd != null ? coinPriceUsd : '0.00'
                }
            },
            // XChain token info: price is a PLACEHOLDER pending XCHAIN issuance + a
            // market (it must be DEX-derived, not an external feed).
            xchain: {
                name: 'XChain',
                symbol: 'XCHAIN',
                price: {
                    btc: '0.00000000',
                    usd: '0.00'
                }
            },
            // Same-chain finality guidance (display/UX only). The indexer processes
            // actions at the chain tip, so this is a recommended "treat a receipt as
            // final after N confirmations" value per chain, not a gate. Sourced from
            // the vendored coin registry (single source of truth) rather than a
            // hand-copied literal map, so a re-tune of a coin's `confirmations` in the
            // bundle can no longer leave the explorer showing a stale depth, and the
            // registry's mainnet floor clamp (overrides may only RAISE the depth on
            // mainnet) is honored instead of silently dropped. Still honors the same
            // XCHAIN_CONFIRMATIONS_<COIN> env overrides (#3212).
            finality: coinsRegistry.resolveConfirmations(config, reqNetwork)
        };
        // Per-action-type record counts for the homepage counters. Exact COUNT(*) per table
        // (cached per coin, see getActionTotals), replacing the old information_schema.TABLE_ROWS
        // estimate that drifted by hundreds of rows from the exact counts the list views show.
        data.totals = await this.getActionTotals(config);
        return [data];
    }

    // Exact per-action-table record counts for the homepage counters, cached per coin.
    // COUNT(*) is exact (information_schema.TABLE_ROWS is only an optimizer estimate and
    // visibly disagreed with the list views), but scanning the large action tables on every
    // /api/network call would be wasteful, so the result is cached for EXPLORER_TOTALS_CACHE_MS
    // (default 60s) per coin. The browser additionally caches the network response for 5 min.
    async getActionTotals(config){
        const coin = config.coin;
        const ttl  = parseInt(process.env.EXPLORER_TOTALS_CACHE_MS, 10) || 60000;
        if(!this._totalsCache) this._totalsCache = {};
        const cached = this._totalsCache[coin];
        if(cached && (Date.now() - cached.at) < ttl)
            return cached.totals;
        let tables = structuredClone(this.actionTables);
        tables.push('tokens');
        let totals = {};
        let dbName = this.pools && this.pools[coin] && this.pools[coin].config
            ? this.pools[coin].config.database
            : null;
        // full_node_verifications fans out per validator, so COUNT(*) over-counts; it needs
        // COUNT(DISTINCT action_index). Every other whitelist table gets an exact COUNT(*).
        let countTables = tables.filter(t => t !== 'full_node_verifications');
        if(dbName && countTables.length){
            // Restrict to tables that actually exist so a not-yet-migrated table can't fail the
            // whole UNION, then count the survivors in one round trip. Table names come from the
            // hardcoded actionTables whitelist (never user input), so interpolating them is safe.
            let placeholders = countTables.map(() => '?').join(',');
            let existing = await this.doQuery(config,
                `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME IN (${placeholders})`,
                [dbName, ...countTables]);
            let names = (existing || []).map(r => r.TABLE_NAME);
            if(names.length){
                let unionSql = names.map(t => `SELECT '${t}' AS t, COUNT(*) AS c FROM \`${t}\``).join(' UNION ALL ');
                let rows = await this.doQuery(config, unionSql);
                if(rows && rows.length)
                    for(let row of rows)
                        totals[row.t] = Number(row.c);
            }
        }
        let fnvResult = await this.doQuery(config, `SELECT count(DISTINCT action_index) as count FROM full_node_verifications`);
        if(fnvResult && fnvResult.length)
            totals['full_node_verifications'] = Number(fnvResult[0].count);
        this._totalsCache[coin] = { at: Date.now(), totals };
        return totals;
    }

    async getStatus(config){
        let coinConfigs = await this.configInfo.getConfig();
        // Age of the explorer's last successful hub-config fetch. The explorer caches hub
        // config (in memory + on disk) and serves it even when the hub is unreachable, so a
        // climbing age here is the only signal that the served hub-derived config is stale.
        // null until the first successful fetch. getHubConfigFetchedAt may be absent against
        // an older config module; guard so /status never throws on the lookup.
        let hubFetchedAtMs = (typeof this.configInfo.getHubConfigFetchedAt === 'function')
                                ? this.configInfo.getHubConfigFetchedAt()
                                : null;
        let data = {
            supported:       coinConfigs['COIN_SUPPORTED'],
            // Copied, not aliased: the staleness gate below deletes stale coins from
            // this map and must not mutate the shared hub-config object.
            available:       Object.assign({}, coinConfigs['COIN_AVAILABLE']),
            hub_config_fetched_at:  (hubFetchedAtMs != null) ? new Date(hubFetchedAtMs).toISOString() : null,
            hub_config_age_seconds: (hubFetchedAtMs != null) ? Math.floor((Date.now() - hubFetchedAtMs) / 1000) : null,
            last_block:      {},
            last_block_time: {},
            // Decoder-tip reference and indexer lag per coin. decoder_tip is the
            // decoder's highest *processed* block; decoder_lag_blocks is
            // decoder_tip - last_block, i.e. how far the indexer trails the decoder.
            // This is the indexer->decoder slice of the pipeline ONLY, not a
            // whole-pipeline health signal. The coin node's actual chain tip is not
            // visible here: the explorer reads only the indexer/decoder DBs and never
            // talks to a coin node, so a decoder that has fallen behind the chain node
            // (the chain->decoder gap) is NOT reflected in these fields. That gap is
            // surfaced separately below via chain_tip / chain_lag_blocks /
            // decoder_health, aggregated from each decoder's own health() JSON-RPC.
            // Both fields are null for a coin when the decoder tip is
            // unavailable; last_block/last_block_time are unaffected.
            decoder_tip:        {},
            decoder_lag_blocks: {},
            // Wall-clock age of each measured coin's newest indexed block, and whether
            // that age has passed the coin's max tip age. Unlike decoder_lag_blocks these
            // see a JOINT indexer+decoder freeze, because they are measured against the
            // local clock rather than against the other replica.
            tip_age_seconds: {},
            // How far AHEAD of this host's clock each measured coin's newest
            // indexed block is dated, 0 when it is not ahead. Published because
            // tip_age_seconds is clamped at 0: without this field a future-dated
            // tip would be indistinguishable from a block mined this second, and
            // that skew is the thing an operator has to fix. null when block_time
            // is missing or unreadable, the same as tip_age_seconds.
            tip_future_seconds: {},
            stale:           {},
            // Durable consensus-divergence halt xchain-sync records into the same
            // replica DB this pool serves (sync_halt, cleared_at IS NULL = active).
            // A halted replica applies no further blocks but keeps reporting a
            // small lag until its source mints past it, so neither stale nor
            // tip_age_seconds can see it; this is the only fail-closed signal that
            // can. true = an active halt row exists; false = the table was read
            // successfully and holds none; null = the signal could not be
            // determined (no pool, table absent, or a failed read) and MUST NOT
            // collapse to false, since a consumer reads false as healthy.
            replica_halted:  {}
        };
        let available = coinConfigs['COIN_AVAILABLE'] || {};
        for (let coin of Object.keys(available)) {
            if (this.pools && this.pools[coin] && this.pools[coin].pool) {
                // /status is a health endpoint: a DB read now throws on failure
                // (M-4), but here we must still return the rest of the report
                // rather than 500 the whole thing, so a failed per-coin read
                // degrades to null for that coin (the outage is exactly what an
                // operator is checking status to see). Other endpoints let the
                // throw bubble to a 5xx.
                try {
                    // Indexer position per coin: highest block index processed and its
                    // block_time.
                    data.last_block[coin]      = await this.getMaxBlockIndex({ coin, data: {} });
                    data.last_block_time[coin] = await this.getMaxBlockTime({ coin, data: {} });
                    // Decoder tip (decoder's highest processed block) and the gap to the
                    // indexer. decoder_tip can be null when the decoder DB is
                    // unreachable/unknown; decoder_lag_blocks is then null too. Clamp to
                    // >= 0: the indexer reads from the decoder so it can never lead the
                    // decoder's tip.
                    let decoderTip = await this.getDecoderTip({ coin, data: {} });
                    data.decoder_tip[coin]        = decoderTip;
                    data.decoder_lag_blocks[coin] = (decoderTip === null) ? null : Math.max(0, decoderTip - data.last_block[coin]);
                } catch (e) {
                    data.last_block[coin]         = null;
                    data.last_block_time[coin]    = null;
                    data.decoder_tip[coin]        = null;
                    data.decoder_lag_blocks[coin] = null;
                }
                // Fail closed on a frozen replica: a coin whose newest indexed block has
                // aged past its threshold stops being advertised as available, so a
                // consumer reading this map cannot mistake a 55-hour-old tip for live
                // data. Only coins this instance actually MEASURED are gated; a coin with
                // no pool here is the pre-existing "supported but not configured" case.
                let nowSec = Math.floor(Date.now() / 1000);
                let tipSec = data.last_block_time[coin];
                // Split the signed difference into two non-negative fields. The raw
                // subtraction went negative whenever a tip was dated ahead of this
                // host's clock, and a negative age passes every "older than X"
                // comparison a consumer writes, so a genuinely frozen coin read as
                // fresher than fresh. Age clamps at 0 and the skew is published
                // separately rather than being thrown away.
                let tipDelta = (Number.isFinite(Number(tipSec)) && Number(tipSec) > 0)
                                    ? (nowSec - Number(tipSec)) : null;
                data.tip_age_seconds[coin]    = (tipDelta === null) ? null : Math.max(0, tipDelta);
                data.tip_future_seconds[coin] = (tipDelta === null) ? null : Math.max(0, -tipDelta);
                data.stale[coin] = this.isTipStale(coin, tipSec, nowSec);
                if (data.stale[coin]) delete data.available[coin];
                // Published beside stale, not folded into the gate: available already
                // drops a coin once its tip ages, so the two compose (halted detects
                // immediately, stale removes eventually) rather than duplicating.
                data.replica_halted[coin] = await this.getReplicaHaltStatus(coin);
            }
        }
        // Chain->decoder visibility: the slice the DB-derived fields above can't
        // see (the explorer never talks to a coin node, so a decoder stalled far
        // behind the chain still shows decoder_lag_blocks=0 once the indexer
        // catches up to its tip). Best-effort per coin via the decoder's own
        // health() JSON-RPC: chain_tip is the coin node's tip as the decoder
        // sees it, chain_lag_blocks the decoder's self-reported gap to it, and
        // decoder_health the decoder's own status ('healthy'/'unhealthy'),
        // 'unconfigured' when no endpoint resolves for the coin (neither the
        // loaded config nor DECODER_API_URL[_<COIN>_<NETWORK>]), or 'unreachable'
        // when the call fails. Calls run in parallel and are bounded by the
        // connector timeout so /status stays responsive.
        data.chain_tip        = {};
        data.chain_lag_blocks = {};
        data.decoder_health   = {};
        let prefixes = coinConfigs['COIN_PREFIXES'] || { mainnet: '', testnet: 'T', regtest: 'R' };
        let networks = coinConfigs['COIN_NETWORKS'] || {};
        let parseCode = (code) => {
            code = String(code || '').toUpperCase();
            // Non-empty prefixes (T/R) first so 'TBTC' isn't read as a mainnet coin named 'TBTC'.
            for(let network in prefixes){
                let p = prefixes[network];
                if(p && code.startsWith(p)){
                    let base = code.slice(p.length);
                    if(networks[base]) return { coin: base, network };
                }
            }
            if(networks[code]) return { coin: code, network: 'mainnet' };
            return null;
        };
        await Promise.all(Object.keys(available).map(async (code) => {
            data.chain_tip[code]        = null;
            data.chain_lag_blocks[code] = null;
            let parsed = parseCode(code);
            // Per-chain endpoint from the loaded config first (setupConnectionPools),
            // so a hub-provisioned deployment reports real chain_tip / chain_lag_blocks
            // without nine DECODER_API_URL_<COIN>_<NETWORK> env vars; the specific env
            // var still overrides it, the generic one is still the last resort.
            let url    = DecoderConnector.resolveDecoderUrl(
                            parsed ? parsed.coin    : null,
                            parsed ? parsed.network : null,
                            (this.decoderApiUrl || {})[code] || null);
            if(!url){
                data.decoder_health[code] = 'unconfigured';
                return;
            }
            try {
                let h = await new DecoderConnector(url).health();
                // node_height_stale is set by the decoder when its coin-node RPC
                // has not refreshed for 2x the normal poll interval, meaning the
                // cached tip is frozen. In that state chain_tip and chain_lag_blocks
                // are misleading (lag reads as 0 while the chain may be advancing),
                // so we null them out and override health to 'node-stale' to make
                // the outage visible on the /status page.
                let tipStale = h && h.node_height_stale === true;
                // A decoder that has never completed getblockchaininfo reports
                // chainTipBlock -1 and a negative blockLag (its -1 tip sentinel),
                // and node_height_stale stays false because it never had a tip to
                // freeze. Publish unknown as null: a -1 tip is not a height, and
                // clamping the negative lag to 0 would read as "at the tip" for a
                // decoder that cannot see the chain. Prefer the decoder's own
                // null-when-unknown lag_blocks; fall back to blockLag for decoders
                // that predate it, treating a negative value as unknown.
                let tip = (h && !tipStale && typeof h.chainTipBlock === 'number' && h.chainTipBlock >= 0) ? h.chainTipBlock : null;
                let lag = null;
                if(h && !tipStale){
                    if(Object.prototype.hasOwnProperty.call(h, 'lag_blocks')){
                        lag = (typeof h.lag_blocks === 'number') ? h.lag_blocks : null;
                    } else if(typeof h.blockLag === 'number' && h.blockLag >= 0){
                        lag = h.blockLag;
                    }
                }
                data.chain_tip[code]        = tip;
                data.chain_lag_blocks[code] = lag;
                data.decoder_health[code]   = tipStale ? 'node-stale' : ((h && h.status) ? h.status : 'unreachable');
            } catch(e){
                data.decoder_health[code] = 'unreachable';
            }
        }));
        return [data];
    }

    async getToken(config){
        let data  = null;
        // A token may be looked up by its full name (PEPE) or by its numeric id
        // with a caret prefix (^1234). For the id form, filter on tick_id instead
        // of the name so both references resolve to the same token.
        let search   = String(config.data.search);
        let tickIdRef = (search.charAt(0) === '^' && this.util.isNumeric(search.substring(1)));
        let tickWhere = tickIdRef ? 't1.tick_id=?' : 't2.tick=?';
        let args  = [ tickIdRef ? Number(search.substring(1)) : config.data.search ];
        let query = `SELECT
                        t2.tick,
                        -- F3 (id-determinism): expose tick_id for SDK ^<id> compaction ONLY when it
                        -- is in the deterministic set (index_tickers.block_index IS NOT NULL). An
                        -- out-of-band id is not reproducible across nodes, so the SDK must never
                        -- compact to it (the indexer would reject the ^id). Gates the SDK-facing
                        -- info.tick_id only; the t1.tick_id lookup/WHERE below is unaffected.
                        (CASE WHEN t2.block_index IS NOT NULL THEN t1.tick_id ELSE NULL END) AS tick_id,
                        t1.supply,
                        t1.max_supply,
                        t1.max_mint,
                        t1.decimals,
                        t1.description,
                        t1.lock_max_supply,
                        t1.lock_mint,
                        t1.lock_mint_supply,
                        t1.lock_max_mint,
                        t1.lock_description,
                        t1.lock_sleep,
                        t1.lock_callback,
                        t1.callback_block,
                        t3.tick as callback_tick,
                        t4.decimals as callback_decimals,
                        t4.coin_price as callback_coin_price,
                        t1.callback_amount,
                        t1.allow_list,
                        t1.block_list,
                        t1.mint_address_max,
                        t1.mint_start_block,
                        t1.mint_stop_block,
                        a1.address as owner,
                        t1.coin_price,
                        t1.coin_floor,
                        t1.escrow_action_index
                    FROM
                        tokens t1
                        LEFT  JOIN index_tickers      t2 ON (t2.id=t1.tick_id)
                        LEFT  JOIN index_addresses    a1 ON (a1.id=t1.owner_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=t1.callback_tick_id)
                        LEFT  JOIN tokens             t4 ON (t4.tick_id=t1.callback_tick_id)
                    WHERE
                        ` + tickWhere + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            data = {
                info: {
                    coin: config.coin,   // Current COIN (BTC, LTC, DOGE, etc)
                    tick: null,
                    description : null,
                    owner: null
                },
                callback: {
                    tick: null,  // Callback tick
                    price: null, // Callback tick price (tokens.coin_price)
                    block: null, // Callback block
                    amount: null // Callback amount
                },
                market: {
                    price: null, // Tick  price (tokens.coin_price)
                    floor: null, // Floor price (tokens.floor_price)
                },
                lists: {
                    allow: null,
                    block: null
                },
                locks: {
                    callback: false,
                    description: false,
                    max_mint: false,
                    max_supply: false,
                    mint: false,
                    mint_supply: false,
                    sleep: false
                },
                mints: {
                    max: null,
                    address_max: null,
                    start_block: null,
                    stop_block: null
                },
                supply: {
                    current: null,
                    max: null
                }
            };
            for( let key in row ){
                let name  = key;
                let value = row[key];
                // Skip/Ignore any decimal fields
                if(String(key).includes('decimals'))
                    continue;
                // Group LOCK fields
                if(String(key).substring(0,5)=='lock_'){
                    name  = String(key).replace('lock_','');
                    value = (row[key]=="1") ? true : false;
                    data.locks[name] = value;
                // Group LIST fields
                } else if(String(key).substring(5,10)=='_list'){
                    name = String(key).replace('_list','');
                    data.lists[name] = (this.util.isNumeric(value)) ? Number(value) : null;
                // Group MINT fields
                } else if(String(key).substring(0,5)=='mint_' || key=='max_mint'){
                    name = String(key).replace('mint_','').replace('_mint','');
                    data.mints[name] = Number(value);
                // Group CALLBACK fields
                } else if(String(key).substring(0,9)=='callback_'){
                    name = String(key).replace('callback_','').replace('coin_','');
                    if(name=='amount'){
                        data.callback[name] = this.util.bcformat(value, row['callback_decimals']);
                    } else {
                        data.callback[name] = value;
                    }
                // Group SUPPLY fields
                } else if(['supply','max_supply'].includes(key)){
                    if(name=='supply')     name = 'current';
                    if(name=='max_supply') name = 'max';
                    data.supply[name] = this.util.bcformat(value, row['decimals']);
                // Group COIN fields
                } else if(String(key).substring(0,5)=='coin_'){
                    name = String(key).replace('coin_','');
                    data.market[name] = Number(value);
                } else {
                    data.info[name] = value;
                }
            }
            // Expose the token's own decimals (the grouping loop above skips every
            // *decimals* column so callback_decimals doesn't leak into info).
            // Clients need it for NFT-pattern classification (NFT_Standard.md:
            // DECIMALS=0 AND LOCK_MAX_SUPPLY=1 (the lock is already in locks.max_supply).
            data.info.decimals   = Number(row.decimals);
            data.supply.decimals = Number(row.decimals);
            // Expose the immutable numeric ticker id (index_tickers.id) so clients
            // (e.g. the SDK) can compact a ticker name into its `^<id>` wire form.
            data.info.tick_id    = (row.tick_id !== undefined && row.tick_id !== null) ? Number(row.tick_id) : null;
            // Project registry surfaces (protocol/Project_Registry.md):
            // projects = registries whose CURRENT roster includes this token
            // (drives the "Official: part of X" banner); registry = this token's
            // own roster metadata when it IS a project (null otherwise).
            data.projects = await this.getTokenProjects(config, data.info.tick);
            data.registry = await this.getProjectRosterInfo(config, data.info.tick);
            // Controller bindings still gating this token's native actions
            // (protocol/Controller_Bound_Tokens.md). [] when nothing gates.
            data.controllers = await this.getTokenControllerBindings(config, data.info.tick);
            // Open governance polls over this token (VOTE v0, poll_status='open').
            // Drives the token page's Active Governance card: voter apathy is the
            // attack surface (a poll nobody sees is a poll nobody out-votes), so
            // open polls surface on the token itself, binding polls flagged.
            data.open_polls = await this.getTokenOpenPolls(config, data.info.tick);
        }
        return [data];
    }

    async getTransaction(config){
        let data = {
            actions: []
        };
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let where = '';
        if(config.data.type=='tx_hash')
            where = ' AND t1.hash=?';
        if(config.data.type=='tx_index')
            where = ' AND m.tx_index=?';
        let query = `SELECT
                        m.tx_index,
                        t1.hash as tx_hash,
                        b1.block_index,
                        b1.block_time as timestamp,
                        a1.address as source
                    FROM
                        transactions m
                        LEFT  JOIN index_transactions t1 ON (t1.id=m.tx_hash_id)
                        LEFT  JOIN index_addresses    a1 ON (a1.id=m.source_id)
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                    WHERE 
                        ` + sql.where.data + where + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            data = Object.assign({}, data, results[0]);
        if(data.tx_index){
            args = [data.tx_index];
            query = `SELECT
                            m.action_index,
                            a1.action
                        FROM
                            actions m
                            LEFT  JOIN index_actions a1 ON (a1.id=m.action_id)
                        WHERE 
                            m.tx_index=?
                        ORDER BY m.action_index DESC `;
            results = await this.doQuery(config, query, args);
            if(results && results.length){
                for(let row of results){
                    data.actions.push(row);
                }
            }
        }
        // Try to lookup raw transaction data
        let txData = await this.getTransactionData(config, data.tx_hash);
        data.tx_data = (!this.util.isNull(txData)) ? txData.data : null;
        // Get summary data for actions
        data.actions = await this.getActionSummaryData(config, data.actions);
        return [data]
    }

    async getPublicKey(config){
        let data = null;
        let query = `SELECT
                        p.pubkey
                    FROM
                        pubkeys p
                        INNER JOIN index_addresses a ON (a.id=p.address_id)
                    WHERE
                        a.address=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [config.data.search]);
        if(results && results.length)
            data = results[0];
        return [data];
    }

    async getTransactionData(config, hash){
        let data = null;
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
                        t2.hash=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [hash]);
        if(results && results.length)
            data = results[0];
        return data;
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
        // would freeze that state for the process lifetime (previously measured on regtest:
        // a fully-drained, closed dispenser kept serving `give_remaining: 200, status: open`
        // until the explorer restarted, letting the wallet's detail page show a buyer an
        // open dispenser they could pay for nothing).
        if(this._isCacheableAction(data))
            this._cacheSet(this._actionDataCache, this._cacheKey(config.coin, action_index), structuredClone(data));
        return data;
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
                        LEFT  JOIN index_addresses a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses a3 ON (a3.id=f1.destination_id)
                    WHERE 
                        f1.action_index=?`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            fee = results[0];
        return fee;
    }

    async getAddressId(config, address){
        let key    = this._cacheKey(config.coin, address);
        let cached = this._cacheGet(this._addressIdCache, key);
        if(cached !== undefined) return cached;
        let id    = null;
        let args  = [address];
        let query = `SELECT
                        id
                    FROM
                        index_addresses
                    WHERE
                        address=?
                    LIMIT 1`
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            id = results[0].id;
        if(id !== null) this._cacheSet(this._addressIdCache, key, id);
        return id;
    }

    // Resolve an address to its index id ONLY when that id is in the DETERMINISTIC set
    // (assigned inside a block tx, block_index IS NOT NULL) - the id-space a wire ^<id>
    // may safely reference. Backs the SDK-facing info.address_id in getAddress (F3
    // id-determinism). Distinct from getAddressId, which resolves ANY id (incl. out-of-band
    // recovery pre-seeds) for internal string<->id display/lookup paths that must not change.
    // Uncached: one call per getAddress request, and a NULL-block id must never be cached as
    // compactable (it could be upgraded to a deterministic id on a later reindex).
    async getCompactableAddressId(config, address){
        let query = `SELECT
                        id
                    FROM
                        index_addresses
                    WHERE
                        address=? AND block_index IS NOT NULL
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [address]);
        return (results && results.length) ? results[0].id : null;
    }

    async getTickId(config, tick){
        // A `^<id>` reference resolves directly to the numeric id, no lookup
        // needed. Everything after the caret is the id (do not drop any digit).
        let str = String(tick);
        if(str.charAt(0) === '^' && this.util.isNumeric(str.substring(1)))
            return Number(str.substring(1));
        let key    = this._cacheKey(config.coin, tick);
        let cached = this._cacheGet(this._tickIdCache, key);
        if(cached !== undefined) return cached;
        let id    = null;
        let args  = [tick];
        let query = `SELECT
                        id
                    FROM
                        index_tickers
                    WHERE
                        tick=?
                    LIMIT 1`
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            id = results[0].id;
        if(id !== null) this._cacheSet(this._tickIdCache, key, id);
        return id;
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
                        count(DISTINCT(m.action_index)) as count
                    FROM
                        mappings_actions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
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
                where += ' AND m.action_index > ?';
                args.push(start);
            } else {
                where += ' AND m.action_index < ?';
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
                        DISTINCT(m.action_index) as action_index,
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
                        mappings_actions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY m.action_index ` + sql.order + `
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
                        LEFT  JOIN index_addresses a2 ON (a2.id=t1.source_id)
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
            indexes: new Set(idxs),
            types:   new Map(),
            fees:    new Map(),
            txs:     new Map(),
            effects: null
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
        return preload;
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

    async getBlocks(config){
        let sql     = config.data.sql;
        let offset  = config.data.offset;
        let data    = [];
        let total   = 0;
        let query   = '';
        let results = null;
        query = `SELECT
                    count(*) as total
                FROM
                    blocks b1
                WHERE ` + sql.where.data;
        results = await this.doQuery(config, query);
        if(results && results.length)
            total = results[0].total;
        query = `SELECT
                    block_index,
                    block_time
                FROM
                    blocks b1
                WHERE 
                    ` + sql.where.data + sql.where.offset + `
                ORDER BY block_index ` + sql.order + `
                LIMIT ` + sql.limit;
        results = await this.doQuery(config, query);
        if(results && results.length){
            let blockIndexes = results.map(r => r.block_index);
            let blockMap = {};
            for(let row of results){
                blockMap[row.block_index] = {
                    block_index: row.block_index,
                    timestamp: row.block_time,
                    actions: {}
                };
            }
            let query2 = '';
            let blockArgs = [];
            let placeholders = blockIndexes.map(() => '?').join(',');
            for(let table of this.actionTables){
                if(query2 != '')
                    query2 += ' UNION ALL ';
                // full_node_verifications writes one row per validator pubkey sharing one
                // action_index (NODEPROOF fan-out), so COUNT(*) over-counts by validator
                // set size. Use COUNT(DISTINCT action_index) for this table only.
                const countExpr = (table === 'full_node_verifications')
                    ? 'count(DISTINCT m.action_index)'
                    : 'count(*)';
                query2 += `SELECT
                            '` + table + `' as action,
                            b1.block_index,
                            ` + countExpr + ` as count
                        FROM
                            ` + table + ` m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            b1.block_index IN (` + placeholders + `)
                        GROUP BY b1.block_index`;
                blockArgs.push(...blockIndexes);
            }
            let results2 = await this.doQuery(config, query2, blockArgs);
            if(results2 && results2.length){
                for(let row of results2){
                    let bIdx = Number(row.block_index);
                    if(blockMap[bIdx])
                        blockMap[bIdx].actions[row.action] = row.count;
                }
            }
            data = results.map(r => blockMap[r.block_index]);
        }
        return [data, null, total];
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
            return [{ data: [], totals: { addresses: 0, broadcasts: 0, tokens: 0, transactions: 0 } }, null, 0];
        }
        // Cap the result LIMIT to a safe ceiling regardless of what the pager computed,
        // as a defense-in-depth measure against runaway scans on popular terms.
        const SEARCH_MAX_ROWS = 100;
        // --- End Fix A ---
        let searchTypes = ['address', 'broadcast', 'token', 'transaction'];
        let dataType    = config.data.type;
        let search      = '%' + this.util.escapeLike(searchRaw) + '%';
        let total       = 0;
        let sql  = config.data.sql;
        const searchLimit = Math.min(Number(sql.limit) || SEARCH_MAX_ROWS, SEARCH_MAX_ROWS);
        let data = {
            data: [],
            totals: {
                addresses:    0,
                broadcasts:   0,
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
        let countResults = await Promise.all(countQueries.map(q => this.doQuery(config, q.query, q.args)));
        for(let i = 0; i < countQueries.length; i++){
            let results = countResults[i];
            let type    = countQueries[i].type;
            if(results && results.length){
                let cnt = Number(results[0].count);
                if(type=='address')     data.totals.addresses    = cnt;
                if(type=='broadcast')   data.totals.broadcasts   = cnt;
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
            if(query){
                let results = await this.doQuery(config, query, args);
                if(results && results.length)
                    data.data = results;
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
                        INNER JOIN index_addresses a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses a3 ON (a3.id=o1.get_address_id)
                        INNER JOIN index_tickers   t2 ON (t2.id=o1.give_tick_id)
                        INNER JOIN index_tickers   t3 ON (t3.id=o1.get_tick_id)
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
                        INNER JOIN index_addresses a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses a3 ON (a3.id=o1.get_address_id)
                        INNER JOIN index_tickers   t2 ON (t2.id=o1.give_tick_id)
                        INNER JOIN index_tickers   t3 ON (t3.id=o1.get_tick_id)
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

    // Cached tip-staleness verdict for the per-request availability gate. An
    // unreadable indexer counts as stale: the gate exists to stop this instance
    // presenting data it cannot vouch for as current.
    /**
     * @param {string} coin coin code
     * @returns {Promise<boolean>}
     */
    async isCoinTipStale(coin) {
        if (!this._tipStaleCache) this._tipStaleCache = {};
        const cached = this._tipStaleCache[coin];
        if (cached && (Date.now() - cached.at) < TIP_STALE_CACHE_TTL_MS) return cached.stale;
        let stale;
        try { stale = this.isTipStale(coin, await this.getMaxBlockTime({ coin, data: {} })); }
        catch (e) { stale = this.tipMaxAgeSeconds(coin) !== 0; }
        this._tipStaleCache[coin] = { at: Date.now(), stale };
        return stale;
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
                    return v;
                }
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

    // Get the raw AES-256-GCM ciphertext bytes for a gated FILE by action_index.
    // Returns the result rows (0 or 1) so the caller can distinguish "no such gated
    // file" (empty) from a stored ciphertext. Keeps the gated_files table/column
    // names in the model layer alongside the gated_files joins used elsewhere here.
    async getGatedFileRaw(config, actionIndex) {
        let query = `SELECT raw_data FROM gated_files WHERE action_index=? LIMIT 1`;
        return await this.doQuery(config, query, [Number(actionIndex)]);
    }

    // Raw bytes + declared MIME type for a non-gated FILE action. The indexer DB
    // stores only FILE metadata (files table); the bytes live in the colocated
    // decoder DB's transactions.raw_data, read with the same DB-qualified pattern
    // and identifier guard as getDecoderTip. The decoder row is matched by tx HASH
    // (each DB numbers tx_index/tx_hash_id independently, so ids can't be joined
    // across them). Returns null when the FILE is unknown, has no stored bytes,
    // or the decoder DB isn't reachable from this server.
    async getFileRaw(config, actionIndex) {
        // Resolve the FILE's tx hash + declared MIME type from the indexer DB
        let meta = `SELECT
                        t2.hash,
                        t3.type
                    FROM
                        files f1
                        INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                    WHERE
                        f1.action_index=?
                    LIMIT 1`;
        let rows = await this.doQuery(config, meta, [Number(actionIndex)]);
        if(!rows || !rows.length || this.util.isNull(rows[0].hash))
            return null;
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return null;
        // dbName is config-derived, not client input, but database identifiers
        // can't be bound; restrict to a safe identifier charset before use
        // (same rule as getDecoderTip).
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return null;
        try {
            // `data` (the FULL stored ACTION string) rides along so the serve
            // path can derive the trailing COMPRESSION field at serve time
            // (protocol spec §5.1). It must NEVER come from a parsed-at-ingest
            // column: shipped indexers drop unknown trailing fields at parse, so
            // a compressed FILE mined before an indexer upgrade would be stored
            // marker-less and served as deflated garbage forever. The decoder's
            // `data` column preserves the action string verbatim, so deriving
            // here is always correct, including for history.
            let query = 'SELECT t1.raw_data, t1.data FROM `' + dbName + '`.transactions t1 ' +
                        'INNER JOIN `' + dbName + '`.index_transactions t2 ON (t2.id=t1.tx_hash_id) ' +
                        'WHERE t2.hash=? LIMIT 1';
            let results = await this.doDecoderQuery(config, query, [rows[0].hash]);
            if(results && results.length && !this.util.isNull(results[0].raw_data))
                return { raw_data: results[0].raw_data, type: rows[0].type, data: results[0].data };
        } catch(e){
            // Decoder DB unreachable, missing, or no cross-DB grant: omit the bytes.
            console.warn('getFileRaw: decoder raw_data unavailable for ' + config.coin + ' action ' + actionIndex + ': ' + (e && e.message ? e.message : e));
        }
        return null;
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

    // Resolve the checkpoint-table source for a coin. These hub-mirrored tables
    // (state_checkpoints, capability_snapshots) are pushed/retracted by the hub
    // out-of-band with block apply, so xchain-sync EXCLUDES them from every
    // snapshot and stream. A serving node therefore MUST read them from the
    // same-server `checkpoint` schema (config database.checkpoint,
    // database-qualified + chain/network-filtered; the hub table carries every
    // chain): either an externally-maintained hub schema or a self-synced mirror
    // kept live by HubMirrorSyncManager over the hub's /hub-db feed. There is
    // deliberately NO fallback to the replicated indexer DB: a thin replica has
    // only a stale/empty bootstrap copy of these tables, and silently serving
    // that would publish wrong consensus-relevant data with no alarm (#4138; a
    // never-bootstrapped self-sync mirror is likewise gated by the mirror-status
    // check in the routes). When the checkpoint schema is absent or its
    // configured name is not a safe identifier we FAIL LOUD by throwing,
    // surfacing the misconfiguration to the route (HTTP 500 + log) instead of
    // serving stale rows. dbName is config-derived, not client input, but
    // database identifiers can't be bound; restrict to a safe identifier charset
    // before use (same rule as the decoderDb readers above).
    _checkpointSource(config){
        let src = this.checkpointDb ? this.checkpointDb[config.coin] : null;
        if (src && /^[A-Za-z0-9_$]+$/.test(src.name))
            return { table: '`' + src.name + '`.state_checkpoints',
                     capTable: '`' + src.name + '`.capability_snapshots',
                     // Quorum-attested ANCHOR publisher rewards (HUB_STATE_TABLES in
                     // hub_db_sync.js, mirrored on the same terms as state_checkpoints).
                     // Neither `table` nor `capTable`, so it gets a third accessor on the
                     // same helper rather than a hand-built schema-qualified name, keeping
                     // ONE place that knows the mirror's shape.
                     rewardTable: '`' + src.name + '`.anchor_reward_attestations',
                     // `filter`/`filterParams` scope `table` and `rewardTable`, which both
                     // carry chain/network columns. They do NOT apply to `capTable`:
                     // capability_snapshots is chain-agnostic (keyed by capability + BTC
                     // snapshot block) and has no such columns - see getCapabilitySnapshots
                     // and getCapabilitySnapshotRows, which bind none of these.
                     filter: ' AND chain = ? AND network = ?',
                     filterParams: [src.chain, src.network] };
        throw new Error('No co-located hub DB configured for coin ' + config.coin +
            ': state_checkpoints / capability_snapshots / anchor_reward_attestations are served only from the mandatory ' +
            'co-located hub DB (config database.checkpoint, same host+credentials as the indexer DB), ' +
            'never from a stale local replica mirror. Configure the checkpoint DB block to serve this coin.');
    }

    // Resolve the cross_chain_matches source for a coin, mirroring _checkpointSource:
    // same hub-mirror-only rule, same FAIL LOUD posture, same identifier-safety
    // restriction. The hub table carries every chain AND network here, so a network
    // filter is required (unlike the state_checkpoints table above). Self-sync note:
    // batch_root/anchor_txid are backfilled hub-side by UPDATE after anchor
    // publication and the feed has no update event, so on a self-synced mirror those
    // two audit columns can read NULL; all settlement-relevant columns arrive on the
    // insert.
    _matchSource(config){
        let src = this.checkpointDb ? this.checkpointDb[config.coin] : null;
        if (src && /^[A-Za-z0-9_$]+$/.test(src.name))
            return { table: '`' + src.name + '`.cross_chain_matches',
                     networkFilter: ' AND m.network = ?',
                     networkParam: src.network };
        throw new Error('No co-located hub DB configured for coin ' + config.coin +
            ': cross_chain_matches is served only from the mandatory co-located hub DB ' +
            '(config database.checkpoint, same host+credentials as the indexer DB), never from ' +
            'a stale local replica mirror. Configure the checkpoint DB block to serve this coin.');
    }

    // Resolve an ORACLE hub-mirror table for a coin (price_snapshots, oracle_prices),
    // mirroring _matchSource: same hub-mirror-only, FAIL LOUD rule. A serving node's
    // local copy is an empty bootstrap table the live stream never fills. Neither
    // table carries a network column, so there is no network filter to apply (unlike
    // cross_chain_matches); `table` is whitelisted to lowercase identifiers and
    // dbName to a safe identifier charset, since database identifiers cannot be bound.
    _oracleMirrorSource(config, table){
        let src = this.checkpointDb ? this.checkpointDb[config.coin] : null;
        if (src && /^[A-Za-z0-9_$]+$/.test(src.name) && /^[a-z0-9_]+$/.test(table))
            return { table: '`' + src.name + '`.' + table };
        throw new Error('No co-located hub DB configured for coin ' + config.coin +
            ': ' + table + ' is served only from the mandatory co-located hub DB ' +
            '(config database.checkpoint, same host+credentials as the indexer DB), never from ' +
            'a stale local replica mirror. Configure the checkpoint DB block to serve this coin.');
    }

    // Apply the generic id-keyed datatable paging semantics to RPC-sourced rows in
    // JS, mirroring what getQueryOffsetSql + ORDER BY m.id + LIMIT do in SQL for the
    // id-keyed list methods: action 'prev' keeps id > start (and < stop), 'last'
    // keeps id <= start, 'next'/default keeps id < start (and > stop). total is the
    // filtered count BEFORE the cursor window (matching the SQL count query, which
    // uses where.data but not where.offset). Rows arrive server-filtered and capped
    // hub-side (500), so totals saturate there; these are small operational datasets.
    _pageHubOperationalRows(config, rows){
        let filtered = rows.slice();
        let total    = filtered.length;
        let offset = config.data.offset || {};
        let action = !this.util.isNull(offset.action) ? offset.action : false;
        let start  = (!this.util.isNull(offset.start) && this.util.isNumeric(offset.start)) ? Number(offset.start) : false;
        let stop   = (!this.util.isNull(offset.stop)  && this.util.isNumeric(offset.stop))  ? Number(offset.stop)  : false;
        if(action && start !== false){
            if(action=='prev')
                filtered = filtered.filter(r => Number(r.id) > start && (stop === false || Number(r.id) < stop));
            else if(action=='last')
                filtered = filtered.filter(r => Number(r.id) <= start);
            else
                filtered = filtered.filter(r => Number(r.id) < start && (stop === false || Number(r.id) > stop));
        }
        let order = (config.data.sql && config.data.sql.order === 'ASC') ? 'ASC' : 'DESC';
        filtered.sort((a, b) => order === 'ASC' ? Number(a.id) - Number(b.id) : Number(b.id) - Number(a.id));
        let limit = (config.data.sql && this.util.isNumeric(config.data.sql.limit)) ? Number(config.data.sql.limit) : 100;
        let from  = (config.type == 'api' && config.data.sql && Number(config.data.sql.apiOffset) > 0)
            ? Number(config.data.sql.apiOffset) : 0;
        return [this._normalizeHubOperationalRows(filtered.slice(from, from + limit)), null, total];
    }

    // One wire type for the BIGINT columns these three endpoints serve, on both
    // transports. The hub RPC path carries them as JS Numbers (the hub's pool sets
    // bigIntAsNumber, xchain-hub/src/db.js), while the legacy co-located-schema read
    // returns BigInt that the response sink stringifies (utility.jsonStringify), so
    // an unnormalized pass-through flips `id` between 100 and "100" whenever the hub
    // goes unreachable mid-deployment. Coerce to decimal STRING, matching
    // _normalizeCheckpointRows and the platform-wide BIGINT-as-string convention.
    // Key-guarded because the three row shapes carry different subsets
    // (validator_capabilities has qualified_at_block, governance_proposals has
    // activation_block, governance_votes has neither): an absent or null column must
    // stay absent or null, never become the literal string "undefined".
    _normalizeHubOperationalRows(rows){
        const bigintKeys = ['id', 'qualified_at_block', 'activation_block',
                            'reorg_height', 'reorg_timestamp', 'round_number'];
        return (rows || []).map(r => {
            let out = { ...r };
            for(const k of bigintKeys)
                if(out[k] !== undefined && out[k] !== null) out[k] = String(out[k]);
            return out;
        });
    }

    // Resolve a co-located hub-DB federation/governance table for a coin
    // (validator_capabilities, governance_proposals, governance_votes). Mirrors
    // _matchSource: DB-qualified to the co-located hub DB, read directly, never a
    // local replica. `table` is whitelisted to lowercase identifiers (no injection).
    // Federation data is platform-global (no per-chain network column), so there is
    // no network filter.
    //
    // NO-HUB DEPLOYMENT SHAPE ONLY: the primary transport for these hub-LOCAL
    // operational tables is the hub JSON-RPC read path (explorer.hubOperational,
    // HubOperationalCache); this direct-schema read serves only deployments with NO
    // hub endpoint configured at all (hubOperational.enabled() false). It is NOT a
    // fallback for a configured-but-unreachable hub: that case fails loud through
    // _hubOperationalOutage below, because this table carries no freshness bound and
    // would otherwise serve indefinitely stale operational rows. New deployments
    // should set HUB_API_URL instead of provisioning a co-located hub schema.
    _hubSource(config, table){
        let src = this.checkpointDb ? this.checkpointDb[config.coin] : null;
        if (src && /^[A-Za-z0-9_$]+$/.test(src.name) && /^[a-z0-9_]+$/.test(table))
            return { table: '`' + src.name + '`.' + table };
        throw new Error('No co-located hub DB configured for coin ' + config.coin +
            ': ' + table + ' is served only from the mandatory co-located hub DB ' +
            '(config database.checkpoint, same host+credentials as the indexer DB). ' +
            'Configure the checkpoint DB block to serve this coin.');
    }

    // FAIL LOUD when a CONFIGURED hub is unreachable past HubOperationalCache's stale
    // ceiling (EXPLORER_HUB_CACHE_STALE_MAX_MS, default 600s). Once a hub endpoint is
    // configured, validator_capabilities/governance_proposals/governance_votes are
    // served from the hub or not at all: the co-located schema carries no freshness
    // bound (governance_proposals has no freshness column at all), so falling back to
    // it would serve indefinitely stale operational state that looks live. The
    // accepted cost is that these three pages blank on a co-located install whose hub
    // PROCESS is down while its hub DB is still up; a blank page with a reason beats a
    // stale page without one.
    _hubOperationalOutage(table){
        let ops     = this.explorer ? this.explorer.hubOperational : null;
        let ceiling = (ops && this.util.isNumeric(ops.staleMaxMs)) ? Math.round(ops.staleMaxMs / 1000) : 600;
        throw new Error('Hub unreachable: ' + table + ' could not be read over hub JSON-RPC and the ' +
            'last cached rows are older than the ' + ceiling + 's stale ceiling ' +
            '(EXPLORER_HUB_CACHE_STALE_MAX_MS). With a hub endpoint configured this table is served ' +
            'from the hub only, never from the co-located hub schema, which carries no freshness ' +
            'bound. Restore the hub endpoint, or unset HUB_API_URL and hub discovery to run this ' +
            'install on the co-located schema.');
    }

    // BIGINT columns (block_index/checkpoint_seq/snapshot_block) come back from
    // the mariadb driver as BigInt, which res.json() cannot serialize. Coerce to
    // STRING, not Number: every other serialized index on this server's REST and
    // WS surface is a decimal string (utility.jsonStringify and ws/serialize.js
    // both stringify BigInt), so a numeric checkpoint block_index would be the one
    // endpoint where `100 !== "100"` against a WS NEW_BLOCK index. String also
    // keeps the wire type precision-safe past 2^53. Consensus-safe: the canonical
    // signing string String()s these fields (canonicalCheckpointString) and the
    // flag-day gates parseInt them, so the verified bytes are unchanged.
    _normalizeCheckpointRows(rows){
        return (rows || []).map(r => ({
            ...r,
            block_index:    String(r.block_index),
            checkpoint_seq: String(r.checkpoint_seq),
            snapshot_block: String(r.snapshot_block),
            // One wire type across the checkpoint REST family: a parsed array,
            // matching proofServer._shapeCheckpoint. The DB column is a JSON
            // string; leaving it raw here made /checkpoints and /verify emit a
            // STRING while /checkpoints/range emitted an ARRAY for the same
            // logical field (api-contracts drift). Malformed JSON degrades to
            // [] like the SDK's own defensive coercion.
            validator_signatures: this._parseSignaturesArray(r.validator_signatures)
        }));
    }

    _parseSignaturesArray(v){
        if (Array.isArray(v)) return v;
        if (typeof v !== 'string' || !v.length) return [];
        try {
            let parsed = JSON.parse(v);
            return Array.isArray(parsed) ? parsed : [];
        } catch { return []; }
    }

    // Quorum-signed state checkpoints (hub-mirrored state_checkpoints table).
    // blockIndex null → latest N (one per height: MAX(checkpoint_seq) wins);
    // blockIndex set → that height's latest-seq row only.
    async getCheckpointRows(config, blockIndex, limit) {
        let src = this._checkpointSource(config);
        if (blockIndex !== null && blockIndex !== undefined) {
            let query = `SELECT chain, network, block_index, block_hash, ledger_hash, actions_hash,
                                contract_hash, checkpoint_seq, snapshot_block,
                                state_root, state_root_version, block_merkle_root, block_merkle_version,
                                validator_signatures, created_at
                         FROM ${src.table}
                         WHERE block_index = ?${src.filter}
                         ORDER BY checkpoint_seq DESC LIMIT 1`;
            return this._normalizeCheckpointRows(await this.doQuery(config, query, [Number(blockIndex), ...src.filterParams]));
        }
        // Shares the latest-per-height rule with getCheckpoints rather than carrying a
        // second list query with its own bounding. This branch backs the public
        // /api/checkpoints route, so an unbounded whole-table GROUP BY here reaches
        // further than the same mistake would in the internal feed.
        let scFilter = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let latest   = this._latestCheckpointPredicate(src, 'sc');
        let query = `SELECT sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash, sc.actions_hash,
                            sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block,
                            sc.state_root, sc.state_root_version, sc.block_merkle_root, sc.block_merkle_version,
                            sc.validator_signatures, sc.created_at
                     FROM ${src.table} sc
                     WHERE 1=1${scFilter}${latest.sql}
                     ORDER BY sc.block_index DESC
                     LIMIT ?`;
        return this._normalizeCheckpointRows(await this.doQuery(config, query, [...src.filterParams, ...latest.params, Number(limit) || 10]));
    }

    // Detail-page load for ONE checkpointed height (highest checkpoint_seq wins,
    // mirroring getCheckpointRows' blockIndex branch). Deliberately does NO signature
    // verification: that is processCheckpointVerifyRequest's job (getCheckpointRows +
    // the quorum predicates), a separate and more expensive path. This is the cheap
    // read the detail page renders around, so it stays a plain keyed SELECT.
    // config.data.search carries the requested height. Returned wrapped in a
    // single-element array (null when not found), matching getBlock's convention for
    // a getData-dispatched detail getter.
    async getCheckpoint(config){
        let src   = this._checkpointSource(config);
        let query = `SELECT chain, network, block_index, block_hash, ledger_hash, actions_hash,
                            contract_hash, checkpoint_seq, snapshot_block,
                            state_root, state_root_version, block_merkle_root, block_merkle_version,
                            validator_signatures, created_at
                     FROM ${src.table}
                     WHERE block_index = ?${src.filter}
                     ORDER BY checkpoint_seq DESC LIMIT 1`;
        let rows = this._normalizeCheckpointRows(
            await this.doQuery(config, query, [Number(config.data.search), ...src.filterParams]));
        return [(rows && rows.length) ? rows[0] : null];
    }

    // List quorum-signed checkpoints (DataTables paging leg, spec explorer-coverage-
    // completion M2.1). Keeps getCheckpointRows' "latest checkpoint_seq per
    // block_index" semantics (a reorged height is superseded by a fresh row at the
    // same block_index, so MAX(checkpoint_seq) resolves the current one), but
    // getCheckpointRows' own list branch GROUP BYs the WHOLE mirrored history to
    // compute that per-height max, which cannot back a paged list view (a full-table
    // aggregate on every page). Bound the raw rows fed into the GROUP BY instead: a
    // duplicate checkpoint_seq for one height only arises from a rare split-brain
    // resubmission, so a window many pages deep still resolves effectively every
    // reachable height to one row, while the aggregate itself stops being a
    // full-table scan. total/paging both report against that same bounded window
    // rather than the unbounded eternity, so the two numbers stay consistent with
    // what is actually reachable by paging.
    // "The latest checkpoint_seq at this height" as a correlated point lookup.
    // Both checkpoint list queries need it and they must agree, so it is built
    // once here rather than written twice with different bounding rules.
    //
    // This replaced a derived table that pre-selected a fixed window of raw rows
    // and GROUPed it. That shape was wrong in two different ways: the window was
    // pinned to the tip while the paging cursor was applied OUTSIDE it, so on a
    // chain with more raw rows than the window, deep pages joined against a set
    // that could not contain them and came back empty with a capped total; and
    // the sibling query in getCheckpointRows had no window at all and grouped the
    // whole table. The correlated form rides the (chain, checkpoint_seq) unique
    // key one row at a time, so it needs no window, cannot truncate a page, and
    // leaves the cursor in the outer WHERE where getData's arg assembly expects
    // it (baseArgs first, offsetArgs appended last).
    _latestCheckpointPredicate(src, alias){
        let innerFilter = src.filter.replace(/\b(chain|network)\b/g, 's.$1');
        return {
            sql: ` AND ${alias}.checkpoint_seq = (SELECT MAX(s.checkpoint_seq)
                       FROM ${src.table} s
                       WHERE s.block_index = ${alias}.block_index${innerFilter})`,
            params: [...src.filterParams]
        };
    }

    async getCheckpoints(config){
        let sql   = config.data.sql;
        let src   = this._checkpointSource(config);
        // Requalify the bare chain/network filter to the `m` alias: the latest-per-
        // height predicate alone is not enough to scope by coin, since checkpoint_seq
        // is only unique WITHIN one (chain, network) pair (uq_chain_seq), not globally.
        let outerFilter = src.filter.replace(/\b(chain|network)\b/g, 'm.$1');
        let latest      = this._latestCheckpointPredicate(src, 'm');
        let count = `SELECT
                        count(*) as total
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + outerFilter + latest.sql;
        let query = `SELECT
                        m.block_index,
                        m.created_at,
                        m.checkpoint_seq,
                        m.snapshot_block,
                        m.state_root,
                        m.block_merkle_root,
                        JSON_LENGTH(m.validator_signatures) AS signer_count
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + outerFilter + latest.sql + sql.where.offset + `
                    ORDER BY m.block_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        // Placeholders in left-to-right text order: the outer chain/network filter,
        // then the same pair inside the correlated subquery. getData() appends the
        // cursor args after these, and the count query reuses the SAME array because
        // it carries the identical two occurrences and no cursor.
        let args = [...src.filterParams, ...latest.params];
        return [query, args, count];
    }

    // List quorum-attested ANCHOR publisher-reward rows (hub-mirrored
    // anchor_reward_attestations, one of HUB_STATE_TABLES in hub_db_sync.js, mirrored on
    // the SAME terms as state_checkpoints: id-parity INSERT IGNORE, never retracted). Read
    // from the same co-located checkpoint schema as getCheckpoints via
    // _checkpointSource().rewardTable, NEVER through HubOperationalCache and never over a
    // hub RPC: this is locally-mirrored transport, not an RPC-served cache with a TTL and
    // a row cap. Unlike capability_snapshots (chain-agnostic), this table carries its own
    // chain/network columns and its unique key is scoped by them, so src.filter/
    // src.filterParams ARE bound here, first, exactly as getCheckpoints binds them.
    //
    // Placement note: the filter text leads and the optional TYPE clause follows, which is
    // the reverse of getCheckpoints' literal order. getCheckpoints has no TYPE filter at
    // all, so nothing there could land a client placeholder ahead of the filter's;
    // here one could, which would break the args order.
    //
    // reward_amount (audit-only: the indexer credits a frozen protocol constant, never
    // this wire value) and publisher_attestations (the raw quorum-signature JSON blob) are
    // deliberately excluded from the list SELECT. type in {anchor, block, pubkey}.
    async getAnchorRewardAttestations(config){
        let sql   = config.data.sql;
        let src   = this._checkpointSource(config);
        let outerFilter = src.filter.replace(/\b(chain|network)\b/g, 'm.$1');
        let count = `SELECT
                        count(*) as total
                    FROM
                        ${src.rewardTable} m
                    WHERE 1=1` + outerFilter + ` AND ` + sql.where.data;
        let query = `SELECT
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
                    FROM
                        ${src.rewardTable} m
                    WHERE 1=1` + outerFilter + ` AND ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        // filterParams (chain, network) come first, matching this table's own unique-key
        // scoping; the type-bound placeholder getQueryWhereSql appends to sql.where.data
        // follows, and only when a TYPE is actually set.
        let typeArgs = ['anchor','block','pubkey'].includes(config.data.type) ? [config.data.search] : [];
        let args = [...src.filterParams, ...typeArgs];
        return [query, args, count];
    }

    // ── SPV light-client proof serving (Phase 3, spec §8.1) ──────────────────
    // All read-only. The signed checkpoint (with the committed state_root) is read
    // from the co-located hub DB; the SMT node store + per-block sub-roots + the
    // authoritative balance derivation are read from the indexer DB (the default
    // per-coin pool). state_tree_nodes is NOT replicated by xchain-sync, so a proof
    // server MUST point at a full indexer DB (a thin replica cannot serve proofs).

    // The signed checkpoint at the nearest checkpointed height >= `height` (or the
    // latest when height is null), resolving MAX(checkpoint_seq) per height. Carries
    // the Phase 2 committed roots so a client can bind a proof to the signed state_root.
    // With a height: the nearest signed checkpoint at or above it (ASC). With a null
    // height (a "latest" balance-proof query): the freshest signed checkpoint (DESC),
    // not the oldest, so a no-height query binds to current state rather than genesis.
    async getCheckpointAtOrAbove(config, height) {
        let src = this._checkpointSource(config);
        let scFilter   = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let heightInner = (height != null) ? ' AND block_index >= ?' : '';
        let order       = (height != null) ? 'ASC' : 'DESC';
        let q = `SELECT sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash, sc.actions_hash,
                        sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block, sc.state_root, sc.state_root_version,
                        sc.block_merkle_root, sc.block_merkle_version, sc.validator_signatures
                 FROM ${src.table} sc
                 JOIN (SELECT block_index, MAX(checkpoint_seq) AS max_seq FROM ${src.table}
                       WHERE 1=1${src.filter}${heightInner} GROUP BY block_index) t
                   ON t.block_index = sc.block_index AND t.max_seq = sc.checkpoint_seq
                 WHERE 1=1${scFilter}
                 ORDER BY sc.block_index ${order} LIMIT 1`;
        let params = (height != null)
            ? [...src.filterParams, Number(height), ...src.filterParams]
            : [...src.filterParams, ...src.filterParams];
        let rows = await this.doQuery(config, q, params);
        return (rows && rows.length) ? rows[0] : null;
    }

    // Ordered signed checkpoints in [from, to] (forward-following, spec §8.1).
    async getCheckpointRange(config, fromH, toH, limit) {
        let src = this._checkpointSource(config);
        let scFilter = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let q = `SELECT sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash, sc.actions_hash,
                        sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block, sc.state_root, sc.state_root_version,
                        sc.block_merkle_root, sc.block_merkle_version, sc.validator_signatures, sc.created_at
                 FROM ${src.table} sc
                 JOIN (SELECT block_index, MAX(checkpoint_seq) AS max_seq FROM ${src.table}
                       WHERE 1=1${src.filter} AND block_index BETWEEN ? AND ? GROUP BY block_index) t
                   ON t.block_index = sc.block_index AND t.max_seq = sc.checkpoint_seq
                 WHERE 1=1${scFilter}
                 ORDER BY sc.block_index ASC LIMIT ?`;
        let params = [...src.filterParams, Number(fromH), Number(toH), ...src.filterParams, Number(limit) || 100];
        return await this.doQuery(config, q, params) || [];
    }

    // Per-block sub-roots from the indexer DB (state_tree_nodes' companion roots).
    async getStateTreeRow(config, blockIndex) {
        // contract_state_root is the reserved-slot extension column (SPV sub-tree
        // spec Stage A). NULL means the slot committed EMPTY at this height, which
        // is every historical row and every row on a chain that has not armed it.
        // It MUST be selected here: the sub-root set this row reassembles to is
        // what binds a served proof to the signed checkpoint, and omitting a
        // populated column reassembles to the wrong state_root and refuses to
        // serve every proof at that height.
        let rows = await this.doQuery(config,
            `SELECT balances_root, stakes_root, state_root, block_merkle_root, contract_state_root
             FROM state_tree_roots WHERE block_index = ? LIMIT 1`, [Number(blockIndex)]);
        return (rows && rows.length) ? rows[0] : null;
    }

    // Raw stored state_value for one contract state key AS-OF a height, or null
    // when the key has no row at or below it OR its winning row is a deletion
    // tombstone. This is the leaf preimage for a contract-state proof, so it must
    // mirror the commitment's mapping exactly (contractStateSubtree.js):
    //
    //   - state_key_bin, the utf8_bin shadow, NEVER state_key. contract_state is
    //     utf8_general_ci, so matching on state_key can return a row for a
    //     DIFFERENT key that merely case-folds to the requested one, and the proof
    //     would be cryptographically valid while binding the wrong key.
    //   - highest id at or below the height, tombstones INCLUDED in the ordering
    //     and tested afterwards. Filtering NULLs first would return the last
    //     surviving write of a deleted key, contradicting the commitment, which
    //     has no leaf for it.
    //   - the RAW stored string, never JSON.parse'd: the client hashes these bytes.
    async getContractStateValueAtHeight(config, contractIndex, stateKey, blockIndex) {
        let rows = await this.doQuery(config,
            `SELECT state_value FROM contract_state
             WHERE contract_index = ? AND state_key_bin = ? AND block_index <= ?
             ORDER BY id DESC LIMIT 1`,
            [Number(contractIndex), String(stateKey), Number(blockIndex)]);
        if (!rows || !rows.length) return null;
        return (rows[0].state_value == null) ? null : String(rows[0].state_value);
    }

    // Locked-balance (XCHAIN_ESC) leaf preimage as-of a height: the latest
    // escrow_leaf_journal row at or below it. The journal is append-only with a
    // block_index (the indexer's writer appends one row per key per block whose
    // total changed), so this read is exact, exactly like contract_state above.
    // MAX(id) runs over ALL rows including NULL tombstones: filtering them
    // before the max would resurrect a released lock at its last positive value.
    // NULL (tombstone) and no-row both return null, which the proof layer maps
    // to "zero locked", matching the reader's delete-on-zero rule.
    async getLockedAmountAtHeight(config, address, tick, blockIndex) {
        let rows = await this.doQuery(config,
            `SELECT j.locked_amount FROM escrow_leaf_journal j
             INNER JOIN index_addresses a ON a.id = j.address_id
             INNER JOIN index_tickers   t ON t.id = j.tick_id
             WHERE a.address = ? AND t.tick = ? AND j.block_index <= ?
             ORDER BY j.id DESC LIMIT 1`,
            [String(address), String(tick), Number(blockIndex)]);
        if (!rows || !rows.length) return null;
        return (rows[0].locked_amount == null) ? null : String(rows[0].locked_amount);
    }

    // One internal SMT node (content-addressed) from the indexer node store.
    async getStateNode(config, nodeHashHex) {
        let rows = await this.doQuery(config,
            'SELECT left_hash, right_hash FROM state_tree_nodes WHERE node_hash = ? LIMIT 1',
            [String(nodeHashHex)]);
        return (rows && rows.length) ? rows[0] : null;
    }

    // Authoritative net-spendable balance (SUM credits - SUM debits) at 18 dp,
    // resolved by canonical strings (never the mutable balances cache), matching
    // the indexer's stateCommitment.getNetBalance leaf source.
    async getNetBalance18(config, address, tick) {
        let rows = await this.doQuery(config,
            `SELECT CAST(
                (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                    INNER JOIN index_addresses a ON a.id=c.address_id
                    INNER JOIN index_tickers   t ON t.id=c.tick_id
                    WHERE a.address=? AND t.tick=?)
              - (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                    INNER JOIN index_addresses a ON a.id=d.address_id
                    INNER JOIN index_tickers   t ON t.id=d.tick_id
                    WHERE a.address=? AND t.tick=?)
             AS DECIMAL(60,18)) AS net`,
            [address, tick, address, tick]);
        return (rows && rows.length) ? String(rows[0].net) : '0';
    }

    // Height-bounded net-spendable balance: the SAME query shape/arithmetic as
    // getNetBalance18 (DECIMAL(60,18) SUM(credits)-SUM(debits), returned as a
    // canonical string), but each side is bounded to actions committed at or
    // before blockIndex. credits/debits carry no block_index of their own, so we
    // bind height through actions.action_index (the canonical "at height" join,
    // same as stateHash.js's tick-touch query), matching the state at the moment
    // the indexer computed the checkpoint-height balances leaf. A balance proof
    // must serve the amount committed at cp.block_index, NOT the current tip, or
    // the SDK's amountLeaf(amount) check false-rejects with LEAF_AMOUNT_MISMATCH.
    async getNetBalance18AtHeight(config, address, tick, blockIndex) {
        let rows = await this.doQuery(config,
            `SELECT CAST(
                (SELECT COALESCE(SUM(CAST(c.amount AS DECIMAL(60,18))),0) FROM credits c
                    INNER JOIN index_addresses a  ON a.id=c.address_id
                    INNER JOIN index_tickers   t  ON t.id=c.tick_id
                    INNER JOIN actions         ac ON ac.action_index=c.action_index
                    WHERE a.address=? AND t.tick=? AND ac.block_index<=?)
              - (SELECT COALESCE(SUM(CAST(d.amount AS DECIMAL(60,18))),0) FROM debits d
                    INNER JOIN index_addresses a  ON a.id=d.address_id
                    INNER JOIN index_tickers   t  ON t.id=d.tick_id
                    INNER JOIN actions         ac ON ac.action_index=d.action_index
                    WHERE a.address=? AND t.tick=? AND ac.block_index<=?)
             AS DECIMAL(60,18)) AS net`,
            [address, tick, Number(blockIndex), address, tick, Number(blockIndex)]);
        return (rows && rows.length) ? String(rows[0].net) : '0';
    }

    // The action's own block_index (its consensus block, a.block_index), used to
    // resolve which block's block_merkle_root an action proof binds to. Null if the
    // action does not exist on this server.
    async getActionBlockIndex(config, actionIndex) {
        let rows = await this.doQuery(config,
            'SELECT block_index FROM actions WHERE action_index=? LIMIT 1', [Number(actionIndex)]);
        return (rows && rows.length && rows[0].block_index != null) ? Number(rows[0].block_index) : null;
    }

    // The signed checkpoint AT EXACTLY this height (MAX(checkpoint_seq)). An action
    // proof binds to the checkpoint that commits THIS block's block_merkle_root, which
    // is per-block, so unlike a balance proof (nearest at-or-above) it needs the exact
    // height. Null if that block was never checkpointed (D3: checkpointed heights only).
    async getCheckpointAt(config, blockIndex) {
        let src = this._checkpointSource(config);
        let scFilter = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let q = `SELECT sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash, sc.actions_hash,
                        sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block, sc.state_root, sc.state_root_version,
                        sc.block_merkle_root, sc.block_merkle_version, sc.validator_signatures
                 FROM ${src.table} sc
                 JOIN (SELECT block_index, MAX(checkpoint_seq) AS max_seq FROM ${src.table}
                       WHERE 1=1${src.filter} AND block_index=? GROUP BY block_index) t
                   ON t.block_index = sc.block_index AND t.max_seq = sc.checkpoint_seq
                 WHERE 1=1${scFilter}
                 ORDER BY sc.block_index ASC LIMIT 1`;
        let params = [...src.filterParams, Number(blockIndex), ...src.filterParams];
        let rows = await this.doQuery(config, q, params);
        return (rows && rows.length) ? rows[0] : null;
    }

    // The canonical per-block leaf rows (ledger/actions/contracts) in the EXACT order
    // + binary collations the indexer's getBlockHashes hashes them (SPV spec §5.1).
    // A verbatim port of the indexer gather (db.js getBlockHashes): every query scopes
    // by the ACTION's own block_index (a.block_index, covering tx_index-NULL synthetic
    // actions), resolves canonical strings (never local AUTO_INCREMENT ids), and pins
    // BINARY collations on the tie-order keys so the order is collation-independent.
    // Returns the shape merkle.blockMerkleLeaves consumes; a single byte of drift from
    // the indexer gather silently invalidates every produced action proof.
    async getBlockLeafRows(config, block_index) {
        const bi = Number(block_index);
        const ledger = { credits: [], debits: [], escrows: [] };
        ledger.credits = await this.doQuery(config,
            `SELECT c.action_index, a1.address AS address, t1.tick AS tick, c.amount
             FROM credits c
                INNER JOIN actions a ON (a.action_index=c.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=c.address_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=c.tick_id)
             WHERE a.block_index=?
             ORDER BY c.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, c.amount ASC`, [bi]);
        ledger.debits = await this.doQuery(config,
            `SELECT d.action_index, a1.address AS address, t1.tick AS tick, d.amount
             FROM debits d
                INNER JOIN actions a ON (a.action_index=d.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=d.address_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=d.tick_id)
             WHERE a.block_index=?
             ORDER BY d.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, d.amount ASC`, [bi]);
        ledger.escrows = await this.doQuery(config,
            `SELECT e.action_index, a1.address AS address, t1.tick AS tick, e.amount
             FROM escrows e
                INNER JOIN actions a ON (a.action_index=e.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=e.address_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=e.tick_id)
             WHERE a.block_index=?
             ORDER BY e.action_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, e.amount ASC`, [bi]);
        const actions = await this.doQuery(config,
            `SELECT a.action_index, a.tx_index, ia.action AS action
             FROM actions a
                LEFT JOIN index_actions ia ON (ia.id=a.action_id)
             WHERE a.block_index=?
             ORDER BY a.action_index ASC`, [bi]);
        const contracts = { contracts: [], state: [], executions: [], emissions: [], deposits: [], withdrawals: [] };
        contracts.contracts = await this.doQuery(config,
            `SELECT c.action_index, a1.address AS source_address, c.code_hash, s1.status AS status
             FROM contracts c
                INNER JOIN actions a ON (a.action_index=c.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=c.source_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=c.status_id)
             WHERE a.block_index=?
             ORDER BY c.action_index ASC`, [bi]);
        contracts.state = await this.doQuery(config,
            `SELECT cs.contract_index, cs.state_key, cs.state_value
             FROM contract_state cs
                INNER JOIN (SELECT MAX(id) as max_id FROM contract_state
                            WHERE block_index=? GROUP BY contract_index, state_key) latest
                   ON cs.id = latest.max_id
             ORDER BY cs.contract_index ASC, cs.state_key ASC`, [bi]);
        contracts.executions = await this.doQuery(config,
            `SELECT ce.action_index, ce.contract_index, a1.address AS caller_address, ce.gas_used, s1.status AS status, ce.emitted_count
             FROM contract_executions ce
                INNER JOIN actions a ON (a.action_index=ce.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=ce.caller_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=ce.status_id)
             WHERE a.block_index=?
             ORDER BY ce.action_index ASC`, [bi]);
        contracts.emissions = await this.doQuery(config,
            `SELECT em.execution_index, em.emitted_action, em.action_index, em.position
             FROM contract_emissions em
                INNER JOIN contract_executions ce ON (ce.action_index=em.execution_index)
                INNER JOIN actions a ON (a.action_index=ce.action_index)
             WHERE a.block_index=?
             ORDER BY em.execution_index ASC, em.position ASC`, [bi]);
        contracts.deposits = await this.doQuery(config,
            `SELECT d.action_index, d.contract_index, a1.address AS source_address, t1.tick AS tick, d.amount, s1.status AS status
             FROM deposits d
                INNER JOIN actions a ON (a.action_index=d.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=d.source_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=d.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=d.status_id)
             WHERE a.block_index=?
             ORDER BY d.action_index ASC, d.contract_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, d.amount ASC, s1.status COLLATE utf8_bin ASC`, [bi]);
        contracts.withdrawals = await this.doQuery(config,
            `SELECT w.action_index, w.contract_index, a1.address AS source_address, t1.tick AS tick, w.amount, s1.status AS status
             FROM withdrawals w
                INNER JOIN actions a ON (a.action_index=w.action_index)
                LEFT  JOIN index_addresses a1 ON (a1.id=w.source_id)
                LEFT  JOIN index_tickers   t1 ON (t1.id=w.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=w.status_id)
             WHERE a.block_index=?
             ORDER BY w.action_index ASC, w.contract_index ASC, a1.address COLLATE utf8_bin ASC, t1.tick COLLATE utf8mb4_bin ASC, w.amount ASC, s1.status COLLATE utf8_bin ASC`, [bi]);
        return { block_index: bi, ledger, actions, contracts };
    }

    // Hub-mirrored qualifying validator set for a capability at a snapshot block;
    // what checkpoint signatures verify against (presence = qualified).
    // capability_snapshots is chain-agnostic (keyed by capability + BTC snapshot
    // block), so the configured checkpoint DB needs no chain/network filter here.
    async getCapabilitySnapshotRows(config, capability, snapshotBlock) {
        let src = this._checkpointSource(config);
        // `source` carries the stake-weight grouping key (the staking source a
        // signing key delegates from); `amount` is that key's stake weight. Both
        // are needed for stake-weighted quorum at/above the activation flag-day;
        // below it `source` is the empty string and only the count matters.
        let query = `SELECT signing_pubkey, amount, source FROM ${src.capTable}
                     WHERE capability = ? AND snapshot_block = ?`;
        return await this.doQuery(config, query, [String(capability), Number(snapshotBlock)]);
    }

    // The same historical electorate as a routed, paged LIST view: which signing keys
    // carried which stake weight for a capability at a snapshot block. Sibling of
    // getCapabilitySnapshotRows above (positional, two mandatory binds, no paging, used
    // by the checkpoint-verify path) rather than a shared predicate: the two have
    // different bind arity and column sets, and a bare list-all with no filter is a normal
    // request here, which the raw reader's two-mandatory-arg contract must never acquire.
    // Same getCheckpoints/getCheckpoint precedent.
    //
    // Never routed through HubOperationalCache and never an RPC call: capability_snapshots
    // is not hub-RPC data, it is pushed into the co-located checkpoint-mirror schema
    // out-of-band, so this list must answer with the hub completely unreachable. id-keyed
    // (the paging cursor); capability_snapshots is chain-agnostic (no chain/network
    // columns), so unlike getCheckpoints there is no src.filter/src.filterParams to bind.
    async getCapabilitySnapshots(config){
        let sql   = config.data.sql;
        let src   = this._checkpointSource(config);
        let count = `SELECT count(*) as total FROM ${src.capTable} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.snapshot_block,
                        m.capability,
                        m.signing_pubkey,
                        m.amount,
                        m.source,
                        m.created_at
                    FROM
                        ${src.capTable} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getBlocksSince(config, sinceBlockIndex, limit) {
        let query = `SELECT
                        b1.block_index,
                        b1.block_time,
                        t1.hash as block_hash,
                        t3.hash as contract_hash,
                        t4.hash as state_hash,
                        (SELECT COUNT(*) FROM transactions t WHERE t.block_index=b1.block_index) as tx_count,
                        (SELECT COUNT(*) FROM actions a
                            INNER JOIN transactions t ON t.tx_index=a.tx_index
                            WHERE t.block_index=b1.block_index) as action_count
                    FROM
                        blocks b1
                        LEFT JOIN index_transactions t1 ON (t1.id=b1.ledger_hash_id)
                        LEFT JOIN index_transactions t3 ON (t3.id=b1.contract_hash_id)
                        LEFT JOIN index_transactions t4 ON (t4.id=b1.state_hash_id)
                    WHERE
                        b1.block_index > ?
                    ORDER BY b1.block_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlockIndex, limit]);
        return results || [];
    }

    async getActionsSince(config, sinceActionIndex, limit) {
        // Pass the cursor as a BigInt (or a Number below 2^53), NEVER a decimal
        // string: the connector quotes a string param, and MariaDB compares a
        // quoted literal against a BIGINT column as a DOUBLE, which reintroduces
        // exactly the >2^53 collapse the BigInt cursor exists to prevent.
        // The generic `actions` table carries no status_id or status column (status
        // lives on the per-ACTION-type tables, e.g. issues/sends/mints, joined as
        // m.status_id elsewhere), so this feed reports status as NULL; a prior
        // `s1.id=a1.status_id` join against that non-existent column threw
        // ER_BAD_FIELD_ERROR and silently killed the WebSocket NEW_ACTION stream, since
        // getActionsSince returned [] every poll while the pointer kept advancing.
        // Source is taken from actions.source_id (a1): the action's true source,
        // which for VM-emitted actions differs from the EXECUTE caller on transactions.
        // action_format rides along because one action NAME can carry several
        // formats whose live meanings are unrelated: a BET v2 is a stake placed and
        // a BET v3 is the payout decision. Without it a subscriber is told only
        // "a BET happened" and has to re-fetch to learn which, which defeats the
        // point of a push channel (ChangeDetector routes BET on it, §11.1).
        let query = `SELECT
                        a1.action_index,
                        a3.action,
                        a1.action_format,
                        t3.hash as tx_hash,
                        a1.block_index,
                        a4.address as source,
                        NULL as status
                    FROM
                        actions a1
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=a1.source_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE
                        a1.action_index > ?
                    ORDER BY a1.action_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceActionIndex, limit]);
        return results || [];
    }

    /******************************************************************
     * WebSocket Snapshot & Entity Detail Queries
     *
     * Used for snapshot-on-subscribe and lifecycle event enrichment.
     *****************************************************************/

    async getAddressBalances(config, address) {
        let query = `SELECT
                        t1.tick,
                        m.amount
                    FROM
                        balances m
                        INNER JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=m.address_id)
                    WHERE
                        a1.address=?
                    ORDER BY t1.tick ASC`;
        let results = await this.doQuery(config, query, [address]);
        return results || [];
    }

    async getTokenInfo(config, tick) {
        let query = `SELECT
                        t2.tick,
                        t1.supply,
                        t1.decimals,
                        t1.description,
                        (SELECT COUNT(*) FROM balances b
                            INNER JOIN index_tickers t3 ON (t3.id=b.tick_id)
                            WHERE t3.tick=? AND b.amount > 0) as holders
                    FROM
                        tokens t1
                        INNER JOIN index_tickers t2 ON (t2.id=t1.tick_id)
                    WHERE
                        t2.tick=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [tick, tick]);
        if (results && results.length) return results[0];
        return null;
    }

    async getMarketInfo(config, tick1, tick2) {
        let query = `SELECT
                        t1.tick as tick1,
                        t2.tick as tick2,
                        m.last_price,
                        m.volume_24h,
                        m.bid,
                        m.ask
                    FROM
                        markets m
                        INNER JOIN index_tickers t1 ON (t1.id=m.tick1_id)
                        INNER JOIN index_tickers t2 ON (t2.id=m.tick2_id)
                    WHERE
                        t1.tick=? AND t2.tick=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [tick1, tick2]);
        if (results && results.length) return results[0];
        return null;
    }

    // Dispenser snapshot for the WebSocket dispenser channel. give_remaining is
    // DERIVED: the dispensers table has no such column, so selecting it used to
    // throw 'Unknown column' on every subscribe/update and the channel silently
    // pushed nothing.
    async getDispenserInfo(config, actionIndex) {
        let query = `SELECT
                        d.action_index,
                        a2.address as source,
                        t1.tick as give_tick,
                        d.give_amount,
                        d.give_escrow,
                        t2.tick as get_tick,
                        d.get_amount,
                        d.expiration,
                        s1.status
                    FROM
                        dispensers d
                        INNER JOIN actions            a1 ON (a1.action_index=d.action_index)
                        INNER JOIN transactions        t3 ON (t3.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t3.source_id)
                        LEFT  JOIN index_tickers      t1 ON (t1.id=d.give_tick_id)
                        LEFT  JOIN index_tickers      t2 ON (t2.id=d.get_tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=d.status_id)
                    WHERE
                        d.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [actionIndex]);
        if (results && results.length){
            let info   = results[0];
            let escrow = await this.getDispenserEscrowBatch(config, [actionIndex]);
            let entry  = escrow[String(actionIndex)];
            info.escrow_remaining = (entry) ? entry.escrow_remaining : null;
            info.give_remaining   = info.escrow_remaining;
            return info;
        }
        return null;
    }

    async getCoinpayObligation(config, orderMatchActionIndex) {
        // NOTE: obligation_action_index and order_match_action_index are the SAME
        // column (co.action_index = the ORDER_MATCH action_index that created this
        // obligation). There is no separate obligation identifier; obligation_action_index
        // is a wire-contract alias of the ORDER_MATCH index, kept for compatibility.
        let query = `SELECT
                        co.action_index as obligation_action_index,
                        co.action_index as order_match_action_index,
                        a1.address as payer_address,
                        a2.address as payee_address,
                        co.coin_amount,
                        co.expiration
                    FROM
                        coinpay_obligations co
                        LEFT JOIN index_addresses a1 ON (a1.id=co.payer_address_id)
                        LEFT JOIN index_addresses a2 ON (a2.id=co.payee_address_id)
                    WHERE
                        co.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [orderMatchActionIndex]);
        if (results && results.length) return results[0];
        return null;
    }

    async getOrderMatchSettlement(config, actionIndex) {
        let query = `SELECT
                        om.action_index,
                        s1.status as settlement_type
                    FROM
                        order_matches om
                        LEFT JOIN index_statuses s1 ON (s1.id=om.settlement_type_id)
                    WHERE
                        om.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [actionIndex]);
        if (results && results.length) return results[0];
        return null;
    }

    // Parent-dispenser lookup for DISPENSE lifecycle enrichment. The event's own
    // action_index is the dispense; SDK consumers correlate a dispense to its
    // dispenser via data.dispenser_action_index (xchain-sdk XChainSDK DISPENSE
    // handler), so the ChangeDetector attaches this value to the event.
    async getDispenseDispenserIndex(config, actionIndex) {
        let query = `SELECT
                        dispenser_action_index
                    FROM
                        dispenses
                    WHERE
                        action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [actionIndex]);
        if (results && results.length && results[0].dispenser_action_index != null)
            return results[0].dispenser_action_index;
        return null;
    }

    // Resolve the parent dispenser's opening action_index for a DISPENSER_CLOSE
    // or DISPENSER_EXPIRE lifecycle action, so those events can be routed to the
    // per-dispenser websocket channel (coin:dispenser:<dispenser_action_index>)
    // the SDK's onDispenser() subscribes to. `table` is dispenser_closes or
    // dispenser_expires, both of which map action_index -> dispenser_action_index.
    async getDispenserLifecycleDispenserIndex(config, table, actionIndex) {
        const allowed = { dispenser_closes: true, dispenser_expires: true };
        if (!allowed[table]) return null;
        let query = `SELECT
                        dispenser_action_index
                    FROM
                        ${table}
                    WHERE
                        action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [actionIndex]);
        if (results && results.length && results[0].dispenser_action_index != null)
            return results[0].dispenser_action_index;
        return null;
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
                        LEFT  JOIN index_addresses a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_tickers   pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses  fs ON (fs.id=m.feed_status_id)
                    WHERE
                        m.closed_block > ?
                    ORDER BY m.closed_block ASC, m.action_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlock, limit]);
        return results || [];
    }

    async getContracts(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contracts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    sd ON (sd.id=m.slash_destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
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
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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

    async getStakes(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        stakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.version,
                        m.amount,
                        m.activation_block,
                        m.deactivation_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        stakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of capability UNSTAKE actions (UNSTAKE v0; the `unstakes` table). A capability
    // unstake begins the global cooldown on a staked signing key; contract-targeted unstakes
    // (UNSTAKE v1) live in contract_unstakes and have their own list view. Mirrors getStakes
    // minus the token join. type in {block, address, source}; not in actionTables, so it serves
    // the newest page ordered by m.action_index DESC.
    async getUnstakes(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        unstakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.amount,
                        m.cooldown_end_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        unstakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of DELEGATE key-revocation actions (DELEGATE v2/v3; the `stake_key_revocations`
    // table). A revocation invalidates a stake's signing key as of deactivation_block. Mirrors
    // getUnstakes. type in {block, address, source}; ordered newest-first by m.action_index.
    async getStakeKeyRevocations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        stake_key_revocations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.deactivation_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        stake_key_revocations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getValidators(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        stakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE s1.status='valid' AND ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.version,
                        m.amount,
                        m.activation_block,
                        m.deactivation_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        stakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE s1.status='valid' AND ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // The hub's own federation registry (`validators`: addr, chains,
    // registration status), keyed by LOWERCASED signing pubkey. There is no separate
    // federation-registry page; these hub-only columns are folded onto the on-chain
    // active set that /validators already renders, so one table answers both "who is
    // staked on chain" and "what does the hub know about that key".
    //
    // Hub JSON-RPC first (HubOperationalCache, TTL-cached), co-located hub schema as
    // the fallback. This is DELIBERATELY the one exception to the fail-loud rule the
    // three list endpoints follow: the registry only decorates rows that
    // /validators already renders from on-chain state, so a hub outage must degrade
    // the decoration, never blank a page of consensus data. Returns NULL when no
    // registry is reachable at all (no hub endpoint configured, hub down past the
    // stale ceiling, and no co-located hub schema). Null is the "unknown" signal:
    // the caller must not render it as "not registered".
    async getFederationRegistry(config){
        let rows = null;
        let ops  = this.explorer ? this.explorer.hubOperational : null;
        if(ops && ops.enabled()){
            try { rows = await ops.getFederationValidators(); }
            catch(e){ console.log('Federation registry RPC read failed: ' + (e && e.message)); }
        }
        if(!rows){
            try {
                let src = this._hubSource(config, 'validators');
                rows = await this.doQuery(config,
                    'SELECT signing_pubkey, addr, chains, status FROM ' + src.table, []);
            } catch(e){
                if(process.env.DEBUG) console.log('Federation registry schema read failed:', e);
                return null;
            }
        }
        if(!Array.isArray(rows)) return null;
        let registry = {};
        for(let row of rows){
            if(!row || this.util.isNull(row.signing_pubkey)) continue;
            // `chains` is absent on a hub older than the getvalidators column add;
            // absent and NULL both mean "the hub did not say", never the string
            // "undefined".
            registry[String(row.signing_pubkey).toLowerCase()] = {
                addr:   this.util.isNull(row.addr)   ? null : String(row.addr),
                chains: this.util.isNull(row.chains) ? null : String(row.chains),
                status: this.util.isNull(row.status) ? null : String(row.status)
            };
        }
        return registry;
    }

    async getPrices(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        prices m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_fiats        f1 ON (f1.id=m.fiat_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.version,
                        a2.address as source,
                        m.round_number,
                        m.round_timestamp,
                        m.pair_count,
                        m.pairs_json,
                        m.sig_count,
                        m.sigs_json,
                        c1.coin,
                        t3.tick,
                        f1.code as fiat,
                        m.value,
                        m.fee,
                        m.validation_status,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m1.memo,
                        s1.status
                    FROM
                        prices m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_coins        c1 ON (c1.id=m.coin_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_fiats        f1 ON (f1.id=m.fiat_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of hub-mirrored price_snapshots rows (federation PRICE v0 consensus
    // snapshots replicated by hub_db_sync). Never replicated by xchain-sync, so the
    // read is database-qualified to the mandatory co-located hub schema and fails loud
    // without one (item 4063); see _oracleMirrorSource.
    async getPriceSnapshots(config){
        let sql   = config.data.sql;
        let src   = this._oracleMirrorSource(config, 'price_snapshots');
        let count = `SELECT
                        count(*) as total
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.round_number,
                        m.coin_pair,
                        m.price,
                        m.reference_block,
                        m.reference_chain,
                        m.block_timestamp,
                        m.validator_count,
                        m.consensus_round,
                        m.consensus_proof,
                        m.status,
                        m.created_at
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of hub-mirrored oracle_prices rows (user-published PRICE v1 oracle rows
    // replicated by hub_db_sync). These are the aggregated hub-effective published-oracle
    // prices that feed oracle-priced DISPENSERs. type in {token, address}.
    // Never replicated by xchain-sync, so the read is database-qualified to the
    // mandatory co-located hub schema and fails loud without one (item 4062);
    // see _oracleMirrorSource.
    async getOraclePrices(config){
        let sql   = config.data.sql;
        let src   = this._oracleMirrorSource(config, 'oracle_prices');
        let count = `SELECT
                        count(*) as total
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.source_address,
                        m.source_chain,
                        m.coin,
                        m.tick,
                        m.fiat,
                        m.value,
                        m.fee,
                        m.memo,
                        m.block_time,
                        m.effective_at,
                        m.action_index,
                        m.created_at
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Controller bind/unbind event stream (programmable-policy guards, Controller_Bound_Tokens.md).
    // UNION of BOTH logs: token_controllers (ISSUE-bound, per-tick) + address_controllers
    // (ADDRESS-bound, self-signed). Each is append-only (one immutable row per bind/unbind); the
    // *effective* gating set is resolved on the token/address detail pages; this list surfaces the
    // raw events. status is the literal 'valid': the indexer records a controller event ONLY while
    // applying a valid bind/unbind, and reorg rollback DELETEs the rows (DELETE WHERE action_index >=
    // orphan), so every surviving row is a valid event by construction. (We do NOT join the parent
    // action table for status; an ADDRESS v1 controller-bind never writes the `addresses` table,
    // which is the fee-preference variant, so that join would always be NULL → false 'invalid'.)
    // Like the sibling VM list views (getExecutions/getContracts), this is not in actionTables, so the
    // cursor-offset optimizer no-ops and the list serves the newest page ordered by m.action_index DESC.
    _controllerUnionSql(){
        return `
            SELECT
                c.action_index       AS action_index,
                'token'              AS scope,
                b1.block_index       AS block_index,
                b1.block_time        AS timestamp,
                tk.tick              AS subject,
                c.action_class       AS action_class,
                c.contract_index     AS contract_index,
                c.is_unbind          AS is_unbind,
                c.cooldown_blocks    AS cooldown_blocks,
                c.cooldown_end_block AS cooldown_end_block,
                'valid'              AS status,
                signer.address       AS bound_by
            FROM token_controllers c
                INNER JOIN actions        a1     ON (a1.action_index=c.action_index)
                INNER JOIN transactions   t1     ON (t1.tx_index=a1.tx_index)
                INNER JOIN blocks         b1     ON (b1.block_index=t1.block_index)
                LEFT  JOIN index_tickers  tk     ON (tk.id=c.tick_id)
                LEFT  JOIN index_addresses signer ON (signer.id=c.bound_by_id)
            UNION ALL
            SELECT
                c.action_index       AS action_index,
                'address'            AS scope,
                b1.block_index       AS block_index,
                b1.block_time        AS timestamp,
                ad.address           AS subject,
                c.action_class       AS action_class,
                c.contract_index     AS contract_index,
                c.is_unbind          AS is_unbind,
                c.cooldown_blocks    AS cooldown_blocks,
                c.cooldown_end_block AS cooldown_end_block,
                'valid'              AS status,
                NULL                 AS bound_by
            FROM address_controllers c
                INNER JOIN actions         a1 ON (a1.action_index=c.action_index)
                INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                INNER JOIN blocks          b1 ON (b1.block_index=t1.block_index)
                LEFT  JOIN index_addresses ad ON (ad.id=c.address_id)
        `;
    }

    async getControllers(config){
        let sql   = config.data.sql;
        let union = this._controllerUnionSql();
        let count = `SELECT count(*) as total FROM ( ` + union + ` ) m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        m.scope,
                        m.block_index,
                        m.timestamp,
                        m.subject,
                        m.action_class,
                        m.contract_index,
                        m.is_unbind,
                        m.cooldown_blocks,
                        m.cooldown_end_block,
                        m.status,
                        m.bound_by
                    FROM ( ` + union + ` ) m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Chunked DEPLOY carriers (DEPLOY v4): one base64 code slice per row in deploy_chunks. The
    // assembler reassembles the VALID chunks of a (source, code_hash) group into the final contract
    // source (DEPLOY.md); the assembled contract itself appears under Contracts. This list surfaces
    // each on-chain carrier (its chunk position + group size + status). code_part (the base64 slice)
    // is intentionally NOT selected; it is large and only the assembler needs it. Not in actionTables
    // (sibling of getExecutions); serves the newest page ordered by m.action_index DESC.
    async getDeployChunks(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        deploy_chunks m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
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
                        m.chunk_index,
                        m.total_chunks,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        deploy_chunks m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDelegations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        delegations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.activation_block,
                        m.deactivation_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        delegations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getValidatorRewards(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        validator_rewards m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.reward_type,
                        m.round_reference,
                        m.amount,
                        m.block_index,
                        b1.block_time as timestamp
                    FROM
                        validator_rewards m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of COLLECT actions (validator reward claims; the `reward_claims` table). Each row
    // is one on-chain claim of accrued capability-validator rewards by the broadcasting address.
    // The per-reward-type accrual ledger is validator_rewards (getValidatorRewards); this is the
    // claim event. type in {block, address, source}; ordered newest-first by m.action_index.
    async getCollects(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        reward_claims m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        reward_claims m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of FULL-NODE VERIFICATION records (NODEPROOF v0 possession-proof verdicts).
    // One row per (epoch, verified validator): the validator answered the derived possession
    // challenge for `epoch_height` correctly, as recorded by a quorum-signed NODEPROOF verdict.
    // signing_pubkey resolves the verified full node (index_pubkeys); staking_source resolves
    // the stake the share dedupes by (index_addresses on m.source_id); source is the verdict
    // submitter. Like the sibling list views this is ordered newest-first by m.id.
    async getFullNodeVerifications(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        full_node_verifications m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_pubkeys      pk ON (pk.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.source_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.challenge_id,
                        m.epoch_height,
                        m.target_height,
                        m.signing_pubkey_id,
                        pk.pubkey as signing_pubkey,
                        m.source_id,
                        a3.address as staking_source,
                        a2.address as source,
                        m.passed,
                        m.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index
                    FROM
                        full_node_verifications m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_pubkeys      pk ON (pk.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.source_id)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getContractStakes(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_stakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.target_contract_index,
                        t3.tick,
                        m.amount,
                        m.version,
                        m.activation_block,
                        m.deactivation_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contract_stakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getContractUnstakes(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_unstakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.target_contract_index,
                        t3.tick,
                        m.amount,
                        m.cooldown_end_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contract_unstakes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of CONTRACT DELEGATION actions (DELEGATE v1/v3, type in {address, block, contract}).
    // Mirrors getContractStakes; contract_delegations carries no amount/version; the delegation
    // re-points a stake's signing pubkey, with activation/deactivation block bounds.
    async getContractDelegations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_delegations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        a3.pubkey as signing_pubkey,
                        m.target_contract_index,
                        t3.tick,
                        m.activation_block,
                        m.deactivation_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contract_delegations m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of VOTE v3 delegation rows (liquid democracy, type in {tick, delegator,
    // delegate, block}). vote_delegations is an APPEND-ONLY event log: a holder can set,
    // re-point, or clear (revoke) their standing per-token delegation, and every one of
    // those actions writes a NEW row rather than mutating the old one, so a naive
    // SELECT * shows every revoked/superseded delegation as if it were still live.
    //
    // The live delegation for a (tick_id, delegator) is its LATEST row (highest
    // action_index), and only if that latest row is not a CLEAR (delegate_address_id IS
    // NOT NULL). This mirrors xchain-indexer's Database#getActiveDelegations (which feeds
    // getPollTally) exactly, minus its `block_index <= ?` bound: that bound answers "what
    // was live AT some past height", which a poll close needs; this list answers "what is
    // live now", so the bound is simply omitted. Every TYPE narrows WHICH keys are shown,
    // never what "live" means.
    //
    // Implemented as a correlated MAX on the (tick_id, delegator_address_id) key, in the
    // outer WHERE where the paging cursor also lives - never a GROUP BY over a "newest N
    // rows" derived table, which is the defect class that a cursor applied OUTSIDE the
    // window silently truncates.
    async getVoteDelegations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        vote_delegations m
                        INNER JOIN actions            a1  ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1  ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1  ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t3  ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses    dgr ON (dgr.id=m.delegator_address_id)
                        LEFT  JOIN index_addresses    dg  ON (dg.id=m.delegate_address_id)
                        LEFT  JOIN index_statuses     s1  ON (s1.id=m.status_id)
                    WHERE
                        m.action_index = (
                            SELECT MAX(s.action_index) FROM vote_delegations s
                            WHERE s.tick_id=m.tick_id AND s.delegator_address_id=m.delegator_address_id
                        )
                        AND m.delegate_address_id IS NOT NULL
                        AND ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        t3.tick,
                        dgr.address as delegator,
                        dg.address as delegate,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        vote_delegations m
                        INNER JOIN actions            a1  ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1  ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1  ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t3  ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses    dgr ON (dgr.id=m.delegator_address_id)
                        LEFT  JOIN index_addresses    dg  ON (dg.id=m.delegate_address_id)
                        LEFT  JOIN index_statuses     s1  ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2  ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4  ON (a4.id=a1.action_id)
                    WHERE
                        m.action_index = (
                            SELECT MAX(s.action_index) FROM vote_delegations s
                            WHERE s.tick_id=m.tick_id AND s.delegator_address_id=m.delegator_address_id
                        )
                        AND m.delegate_address_id IS NOT NULL
                        AND ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Per-validator per-provider ATTEST accountability rollup (indexer-owned counters).
    // fulfilled_count/missed_count are live (incremented per verified signature and per
    // expired-round absence by xchain-indexer's incrementAttestationValidatorStat);
    // slashed_count and quality_score are Phase 4 columns the indexer defines and defaults
    // to 0 but has no producer for yet. The table carries no action_index (rows are
    // upsert-incremented counters, not action-chain rows); it pages on the surrogate m.id
    // added for exactly this purpose, NOT on last_updated_block, which ties whenever a
    // whole ATTEST responsible set misses in one block and so would split a keyset page
    // boundary. type in {pubkey, provider}.
    async getAttestValidatorStats(config){
        let sql   = config.data.sql;
        let count = `SELECT count(*) as total FROM attest_validator_stats m WHERE ` + sql.where.data;
        let query = `SELECT
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
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of cross-chain MATCH records (type ∈ {match, block, status}; block = snapshot_block).
    // cross_chain_matches is a standalone mirror of the hub's finalized match table with no
    // actions/transactions chain, so no joins; ordered by the mirror cursor m.id.
    // validator_signatures (the 2f+1 quorum proof) is included: matches have no separate
    // detail endpoint, and the proof is the point of inspecting one.
    async getCrossChainMatches(config){
        let sql   = config.data.sql;
        // cross_chain_matches is hub-mirrored: xchain-sync never replicates it, so it is
        // served only from the mandatory co-located hub DB, never from a stale local mirror.
        // _matchSource throws (fail loud) if no co-located hub DB is configured for this coin.
        // The hub table is multi-network, so a network filter rides along; it appends one `?`
        // AFTER any type filter in sql.where.data, so the returned args must be ordered
        // [<type filter?>, network].
        let src   = this._matchSource(config);
        let count = `SELECT
                        count(*) as total
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + src.networkFilter;
        let query = `SELECT
                        m.id,
                        m.match_id,
                        m.snapshot_block,
                        m.network,
                        m.a_chain,
                        m.a_action_index,
                        m.a_kind,
                        m.a_tick,
                        m.a_amount,
                        m.a_filled_before,
                        m.a_ownership,
                        m.a_payout_addr,
                        m.b_chain,
                        m.b_action_index,
                        m.b_kind,
                        m.b_tick,
                        m.b_amount,
                        m.b_filled_before,
                        m.b_ownership,
                        m.b_payout_addr,
                        m.effective_time,
                        m.validator_signatures,
                        m.status,
                        m.batch_root,
                        m.anchor_txid,
                        m.finalizing_view,
                        m.created_at
                    FROM
                        ${src.table} m
                    WHERE ` + sql.where.data + src.networkFilter + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        // Non-redirect path: keep args null (baseArgs defaults to [config.data.search],
        // current behavior). Redirect path: supply explicit args so the network `?` binds;
        // [config.data.search] only when a type filter (match/block/status) added its own `?`.
        let args = null;
        if(src.networkParam !== null){
            let typeArgs = ['match','block','status'].includes(config.data.type) ? [config.data.search] : [];
            args = [...typeArgs, src.networkParam];
        }
        return [query, args, count];
    }

    async getCrossChainSettlements(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        cross_chain_settlements m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.action_index,
                        m.match_id,
                        m.local_action_index,
                        m.block_index,
                        b1.block_time as timestamp
                    FROM
                        cross_chain_settlements m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of SLASH events (xchain.contract.slash emissions, type in {address, block, contract})
    // slash_events has no action_index of its own (side-effect of an EXECUTE), so this joins
    // blocks directly via m.block_index and orders by m.id rather than action_index.
    async getSlashEvents(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        slash_events m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=m.destination_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.execution_index,
                        m.target_contract_index,
                        a3.pubkey as slashed_pubkey,
                        a4.address as destination,
                        t3.tick,
                        m.amount,
                        m.block_index,
                        b1.block_time as timestamp
                    FROM
                        slash_events m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_pubkeys      a3 ON (a3.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=m.destination_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of capability_slash_events (equivocation bond-burns against consensus validators).
    // Mirrors getSlashEvents; joins blocks directly via m.block_index.
    // type in {block, capability, pubkey, address} where address matches the submitter.
    async getCapabilitySlashEvents(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        capability_slash_events m
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_pubkeys      pk ON (pk.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    sub ON (sub.id=m.submitter_id)
                        LEFT  JOIN index_addresses    dst ON (dst.id=m.destination_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
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
                        INNER JOIN blocks             b1 ON (b1.block_index=m.block_index)
                        LEFT  JOIN index_pubkeys      pk ON (pk.id=m.signing_pubkey_id)
                        LEFT  JOIN index_addresses    sub ON (sub.id=m.submitter_id)
                        LEFT  JOIN index_addresses    dst ON (dst.id=m.destination_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Per-validator per-capability qualification flags. type in {capability, pubkey}.
    // id-keyed. Primary transport: hub JSON-RPC via HubOperationalCache (these are
    // hub-LOCAL operational rows, not consensus mirror data). The co-located hub
    // schema read below serves ONLY the no-hub deployment shape; a configured hub
    // that is unreachable past the stale ceiling fails loud.
    async getValidatorCapabilities(config){
        let ops = this.explorer.hubOperational;
        if(ops && ops.enabled()){
            let rows = await ops.getValidatorCapabilities({
                capability:     config.data.type=='capability' ? config.data.search : undefined,
                signing_pubkey: config.data.type=='pubkey'     ? config.data.search : undefined
            });
            if(rows) return this._pageHubOperationalRows(config, rows);
            this._hubOperationalOutage('validator_capabilities');
        }
        let sql = config.data.sql;
        let src = this._hubSource(config, 'validator_capabilities');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.signing_pubkey,
                        m.capability,
                        m.qualified,
                        m.self_test_ok,
                        m.enabled,
                        m.qualified_at_block,
                        m.updated_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Governance parameter proposals. type in {status, parameter, proposal}. id-keyed.
    // Primary transport: hub JSON-RPC via HubOperationalCache; the co-located hub
    // schema read serves ONLY the no-hub deployment shape. A configured hub that is
    // unreachable past the stale ceiling fails loud; this table is the clearest
    // case for it, since governance_proposals carries no freshness column
    // at all, so a per-row freshness cap on the schema read is unbuildable.
    async getGovernanceProposals(config){
        let ops = this.explorer.hubOperational;
        if(ops && ops.enabled()){
            let rows = await ops.getGovernanceProposals({
                status:      config.data.type=='status'    ? config.data.search : undefined,
                parameter:   config.data.type=='parameter' ? config.data.search : undefined,
                proposal_id: config.data.type=='proposal'  ? config.data.search : undefined
            });
            if(rows) return this._pageHubOperationalRows(config, rows);
            this._hubOperationalOutage('governance_proposals');
        }
        let sql = config.data.sql;
        let src = this._hubSource(config, 'governance_proposals');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.proposal_id,
                        m.proposer_pubkey,
                        m.parameter,
                        m.current_value,
                        m.proposed_value,
                        m.status,
                        m.voting_end,
                        m.activation_block
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Per-validator governance votes. type in {proposal, voter}. id-keyed.
    // Primary transport: hub JSON-RPC via HubOperationalCache; the co-located hub
    // schema read serves ONLY the no-hub deployment shape. A configured hub that is
    // unreachable past the stale ceiling fails loud.
    async getGovernanceVotes(config){
        let ops = this.explorer.hubOperational;
        if(ops && ops.enabled()){
            let rows = await ops.getGovernanceVotes({
                proposal_id:  config.data.type=='proposal' ? config.data.search : undefined,
                voter_pubkey: config.data.type=='voter'    ? config.data.search : undefined
            });
            if(rows) return this._pageHubOperationalRows(config, rows);
            this._hubOperationalOutage('governance_votes');
        }
        let sql = config.data.sql;
        let src = this._hubSource(config, 'governance_votes');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.proposal_id,
                        m.voter_pubkey,
                        m.vote,
                        m.created_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
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
    async getAttestations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        attests m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
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
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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
    // token); source is the oracle that created the feed (a2 via t1.source_id);
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
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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
            data = row;
        }
        return data;
    }

    // Per-outcome pool totals for one feed. Sums ONLY bet_status='open' rows, which
    // is the normative settlement pool predicate (§7): a bet that already took a
    // terminal credit must never be counted again. Returned per outcome index so a
    // market page can show implied odds without re-deriving the predicate.
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
                        AND bs.status='open'
                    GROUP BY m.outcome
                    ORDER BY m.outcome ASC`;
        let rows = await this.doQuery(config, query, [feedIndex]);
        return rows || [];
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
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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
                        LEFT  JOIN index_addresses a2 ON (a2.id=t1.source_id)
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
        return [{ address: config.data.search, total_feeds: total, active_feeds: active,
                  counts, fees_earned: fees,
                  reputation_caveat: 'Per-address record with no bonding; addresses are free to create, so an empty history means unknown, not safe.' }];
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
                        LEFT  JOIN index_addresses ra ON (ra.id=t1.source_id)
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
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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
                    ORDER BY m.action_index ` + sql.order + `
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
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
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

    // ── M4 composed detail views (spec explorer-coverage-completion, rows 26/28/30/31) ──
    //
    // Four single-record compositions backing the M4 detail pages. They follow
    // getXcall/getPoll: the method runs its own reads and returns [object] (null when the
    // subject does not exist), so getData takes its `typeof query === 'object'` branch and
    // the builder arg-assembly path (baseArgs then offsetArgs, count reusing baseArgs) never
    // applies to them.
    //
    // NONE of them consume config.data.sql.where.data, and that is deliberate rather than an
    // omission. A composition's spine and its sub-lists sit on different tables under
    // different aliases, so one shared WHERE fragment cannot be correct for all of them;
    // each leg carries its own predicate and binds its own args in strict left-to-right
    // text order. The consequence worth knowing: these four need no getQueryWhereSql branch,
    // so a route registered against any TYPE cannot 500 them with an unknown-column error.
    //
    // What they DO take from config.data.sql is `limit`, already clamped to
    // 1..getMaxMethodResults() by getQuery, and EVERY sub-list interpolates it. An unbounded
    // sub-list inside a composition pulls the same whole table a missing LIMIT pulls on a
    // list route; it is only harder to see, because the response looks like one record.
    _detailLimit(config){
        let sql = config.data.sql;
        return (sql && this.util.isNumeric(sql.limit)) ? Number(sql.limit) : 100;
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
    // expiry leg below is DERIVED from the request row, not selected from a v2 row, and
    // there is no v2 action_index to link to: nothing in `attests` records it.
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
            if(!seed) return [null];
            requestId = seed.request_id;
        } else {
            requestId = String(search || '').toLowerCase();
        }
        if(!requestId) return [null];

        // Every leg of one round in one bounded read, oldest first so the caller renders the
        // lifecycle in the order it happened. request_id+version is indexed.
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
                m.block_index,
                b1.block_time as timestamp,
                t2.hash as tx_hash,
                t1.tx_index,
                s1.status
            FROM
                attests m
                LEFT JOIN actions             a1 ON (a1.action_index=m.action_index)
                LEFT JOIN transactions        t1 ON (t1.tx_index=a1.tx_index)
                LEFT JOIN blocks              b1 ON (b1.block_index=t1.block_index)
                LEFT JOIN index_addresses     a2 ON (a2.id=t1.source_id)
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
        return [{
            query:      config.data.search,
            request_id: requestId,
            provider_id: rows[0].provider_id,
            legs:       rows,
            request:    request,
            response:   response,
            // Derived, because ATTEST v2 persists nothing. `expired` is the stored terminal
            // state, never a clock comparison against deadline_block: a request past its
            // deadline that the expiry sweep has not reached yet is still 'pending'.
            expiry: {
                request_status: status,
                deadline_block: (request) ? request.deadline_block : null,
                resolved_block: (request) ? request.resolved_block : null,
                expired:        status === 'expired'
            },
            relay: {
                is_relay:            !!(request && !this.util.isNull(request.origin_chain)),
                origin_chain:        (request) ? request.origin_chain : null,
                origin_action_index: (request) ? request.origin_action_index : null,
                response_relayed:    !!(response && !this.util.isNull(response.origin_action_index))
            },
            callback_execute_action_index: (response) ? response.callback_execute_action_index : null
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
            ORDER BY m.action_index DESC
            LIMIT 1`, [key]);
        if(!rows || !rows.length) return [null];
        let row = rows[0];
        row.validator_signatures   = this._parseSignaturesArray(row.validator_signatures);
        // The v4/v5/v6 XANCPUB tail is RAW WIRE transport, not the quorum-verified subset
        // (anchor_actions.sql), so it is parsed for display and named as attestations to
        // re-verify, never presented as a verified quorum.
        row.publisher_attestations = this._parseSignaturesArray(row.publisher_attestations);

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
        let checkpoint = [];
        if(!this.util.isNull(row.block_index))
            checkpoint = await this.doQuery(config,
                `SELECT
                    sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash,
                    sc.actions_hash, sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block,
                    sc.state_root, sc.state_root_version, sc.block_merkle_root,
                    sc.block_merkle_version, sc.validator_signatures, sc.created_at
                FROM ${src.table} sc
                WHERE sc.block_index = ?${scFilter}${latest.sql}
                LIMIT 1`, [Number(row.block_index), ...src.filterParams, ...latest.params]) || [];

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
        // anchor, match_batch_seq for an archive one).
        let outerFilter = src.filter.replace(/\b(chain|network)\b/g, 'm.$1');
        let rounds = [row.checkpoint_seq, row.match_batch_seq]
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
                        LEFT JOIN index_addresses     a2 ON (a2.id=t1.source_id)
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

module.exports = Database;
module.exports.DbQueryError = DbQueryError;
module.exports.ACTION_SUMMARY_FIELDS = ACTION_SUMMARY_FIELDS;