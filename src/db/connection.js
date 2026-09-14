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
 * XChain Explorer - connection pools, query execution and the caches
 *
 * Proposal B stage 1: everything between the Database instance and a live
 * MariaDB connection. The per-coin pool set (indexer, decoder, checkpoint and
 * hub-mirror), the topology guards that refuse a misconfigured install, the
 * connect/release pair, the two statement runners (doQuery and its decoder
 * sibling), and the LRU caches whose keys carry the per-coin reorg generation
 * that makes them safe to hold across a rewind.
 *
 * Why these travel together: the caches are keyed by the reorg generation the
 * pool layer bumps, and doQuery is the only place a pool failure turns into a
 * DbQueryError rather than an empty result. Splitting the three would put a
 * cache invalidation in one file and the event that drives it in another.
 *
 * HOW THIS ATTACHES
 *
 * The methods are authored as a class body and exported as that class's
 * prototype, so db.js can copy them onto Database.prototype verbatim. Nothing
 * here is ever instantiated: `this` is the Database instance at call time,
 * exactly as it was when these methods sat inline, so every helper
 * (this.doQuery, this.util, this.explorer, ...) resolves the same way and no
 * caller changed. An object literal would have needed a comma between every
 * method, which turns a pure move into a diff nobody can read.
 *
 ********************************************************************/

'use strict';

const mariadb = require('mariadb');
const poolSizing = require('../mirror/pool_sizing');
const { resolveHubUrl } = require('../hub-mirror-url.js');
const { DbQueryError, MUTABLE_ACTION_FIELDS } = require('./shared.js');

// Structured logging. Cached at require time on purpose: getLogger() resolves
// lazily on every call, so this reaches the real shipper once api.js has run
// installObservability and falls through to bare console.* before that, which
// is the shape the unit suites see.
const { getLogger } = require('../observability');
const log = getLogger();

class DatabaseConnection {
    async init(){
        await this.setupConnectionPools()
    }

    /******************************************************************
     * LRU Cache Helpers
     *****************************************************************/

    cacheGet(cache, key){
        if(!cache.has(key)) return undefined;
        const val = cache.get(key);
        cache.delete(key);
        cache.set(key, val);
        return val;
    }

    cacheSet(cache, key, value, maxSize = 1000){
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
    // builds an all-null response with no `state` block, so an unguarded check
    // would pass this guard and memoize it forever with no TTL and reorg-only
    // invalidation - permanently blanking the action for anyone who asked one
    // moment too early. A real response always carries `action_index` (every
    // handler selects it, and deblankBaseline supplies it for a row-less
    // variant), so its absence is exactly the not-found case and nothing else.
    //
    // The third exclusion is the same defect on types that carry their mutable
    // state as plain columns rather than a `state` block: an ATTEST or XCALL
    // request_status, a VOTE poll_status, a BET feed/bet status. Those are
    // listed, and the reasoning is written out, on MUTABLE_ACTION_FIELDS.
    //
    // The fourth is the status itself. A `pending:` status is the indexer saying
    // this action has not settled: a chunked DEPLOY assembler waiting on its
    // carriers reports `pending: CODE_HASH (awaiting chunks)` and a null
    // deployed_contract_index, and the action that completes the group is a
    // DIFFERENT action, so nothing about this response is rewritten when it
    // completes - the values simply resolve differently on the next read. Cached,
    // the null would be served for the life of the process to the very clients
    // polling this endpoint to learn where their contract landed. The status is
    // matched rather than deployed_contract_index being added to
    // MUTABLE_ACTION_FIELDS, because that list is matched by PRESENCE: the field
    // is on every DEPLOY response, so listing it would uncache every settled
    // deploy forever for a mutation only the pending case has.
    isCacheableAction(data){
        if(this.util.isNull(data) || this.util.isNull(data['action_index'])) return false;
        if(!this.util.isNull(data['state'])) return false;
        if(!this.util.isNull(data['status']) && /^pending:/i.test(String(data['status']))) return false;
        for(let field of MUTABLE_ACTION_FIELDS)
            if(Object.prototype.hasOwnProperty.call(data, field)) return false;
        return true;
    }
    // Build an id/action cache key scoped to the coin AND its current reorg
    // generation (M-3). Coin-scoping also stops a bare address/tick key from
    // colliding across coins on a multi-coin explorer; the generation prefix is
    // what makes a reorg invalidation cheap (see bumpReorgGeneration).
    cacheKey(coin, key){
        return coin + ':' + (this._reorgGen[coin] || 0) + ':' + key;
    }

    // Invalidate this coin's id/action LRU entries after a reorg by advancing its
    // generation counter. Nothing is deleted eagerly: the old-generation keys are
    // simply unreachable and evicted by normal LRU pressure. Called from the
    // ChangeDetector tip-poll loop via checkReorgAndInvalidate.
    bumpReorgGeneration(coin){
        this._reorgGen[coin] = (this._reorgGen[coin] || 0) + 1;
    }

    // Generation token for the getData result cache: the coin's current indexed
    // tip height.
    //
    // The cached list methods (getBalances/getHolders/getTokens) read tables the
    // indexer only rewrites when it applies a block, so a cached answer stays
    // correct exactly as long as the tip does not move. Keying on the tip means a
    // new block makes every pre-block entry unreachable, instead of letting the
    // TTL keep serving the previous block's answer. Without it, /balances/{ADDR}
    // reports the pre-block balance for up to the full TTL after the block that
    // moved it confirmed - the balance a wallet shows its own user right after
    // their send confirms (it is also what made the escrow e2e suite,
    // the one template suite that reads a balance before the deposit and again
    // after, read a 0 debit off a correctly-debited ledger).
    //
    // Cost: one index-max lookup per coin per memo window, NOT per request, so a
    // request burst still collapses onto a single heavy query. A probe that fails
    // returns null, which makes the caller skip the cache for that request: never
    // serve a possibly-stale list because the freshness check itself broke.
    async resultCacheGeneration(config){
        const coin = config.coin;
        const ttl  = parseInt(this.configInfo.env.EXPLORER_TIP_MEMO_MS, 10);
        const memo = this._tipMemo[coin];
        if(memo && (Date.now() - memo.at) < (Number.isFinite(ttl) ? ttl : 1000))
            return memo.tip;
        let tip = null;
        try {
            // MAX() over the blocks PK is an index-max lookup, not a scan.
            const rows = await this.doQuery(config, 'SELECT MAX(block_index) AS tip FROM blocks', []);
            if(rows && rows.length && !this.util.isNull(rows[0].tip))
                tip = String(rows[0].tip);
            // An empty blocks table is a real answer (nothing indexed yet), not a
            // failed probe: give it a generation of its own so a pre-genesis read
            // is still cacheable.
            else if(rows)
                tip = 'none';
        } catch(e){
            tip = null;
        }
        this._tipMemo[coin] = { tip, at: Date.now() };
        return tip;
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
                // present at the last-seen height carries the same hash.
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
    async endPools(maps){
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
    // endPools so the drain does not reach into a private method, and so the map
    // list stays in ONE place - a future third pool map added to setupConnectionPools
    // must be added to the endPools call there, and this inherits it.
    async close(){
        await this.endPools([this.pools, this.decoderPools]);
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
        // dedicated-pool branch below. rebuildPoolsIfStale() re-enters here as
        // often as every 10s, so the omission leaked the decoder pool's 3
        // connections per coin per rebuild: one live regtest explorer had
        // accumulated 870 of that server's 1000 connections over four days, which
        // surfaced as OTHER services being unable to connect at all.
        await this.endPools([this.pools, this.decoderPools]);

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
        // decoder_health 'unconfigured'. See decoderApiUrlFromConfig.
        this.decoderApiUrl = {};
        // Per-coin checkpoint-source database: the MANDATORY co-located hub DB for
        // serving the hub-mirrored tables (state_checkpoints, capability_snapshots,
        // cross_chain_matches, price_snapshots, oracle_prices). xchain-sync excludes
        // these tables from every snapshot and stream, so a serving node has no
        // replicated copy and MUST read them from the hub DB on the same server via a
        // per-network `checkpoint` config block, honored only when it shares server +
        // credentials with the indexer pool and read database-qualified, filtered by
        // chain/network so the per-coin endpoints don't leak siblings. This is a hard
        // requirement: a serving coin with no entry here makes checkpointSource /
        // matchSource / oracleMirrorSource throw instead of falling back to a stale
        // local mirror, and assertCheckpointDbForServingCoins() turns the same gap
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
                        let dApiUrl = this.decoderApiUrlFromConfig(info[net].database.decoder);
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
                                        // The hub endpoint the mirror writer follows,
                                        // carried in the SAME config block as self_sync
                                        // so the two cannot arrive by different paths
                                        // (the HUB_API_URL env remains the fallback;
                                        // see hub-mirror-url.js).
                                        hubUrl: this.util.isNull(kcfg.hub_url) ? '' : String(kcfg.hub_url),
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
        this.assertCheckpointDbForServingCoins();
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
    decoderApiUrlFromConfig(dcfg){
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
    // (database.checkpoint.self_sync plus a hub endpoint - hub_url in the same
    // block, else HUB_API_URL - populated by HubMirrorSyncManager) or an
    // externally-maintained hub schema. Without one
    // the hub-mirrored tables cannot be served, because xchain-sync never
    // replicates them. A missing entry is a fatal misconfiguration: throw a
    // clear, named error so a mis-provisioned thin replica fails to start
    // instead of silently serving empty state_checkpoints /
    // capability_snapshots / cross_chain_matches (#4138), or empty
    // price_snapshots / oracle_prices (items 4062 / 4063).
    // Opt-out: ALLOW_NO_COLOCATED_HUB_DB=1 downgrades the fatal error to a warning,
    // for deployments that intentionally do not expose the hub-mirrored endpoints.
    assertCheckpointDbForServingCoins(){
        let missing = [];
        // A self-synced schema with no hub endpoint is the SAME failure as a missing
        // schema, and a quieter one: the mirror exists, reads succeed, and every row
        // it returns is frozen at whatever the last working writer left, because
        // nothing repopulates it. It went undetected because self_sync arrives in the
        // hub's config push while HUB_API_URL was a container env written at install
        // time, so the two could be emitted under different conditions and the
        // mismatch cost one startup warning. Checked here, at the same fatal tier and
        // behind the same opt-out, so the pairing cannot silently half-exist.
        let unwritable = [];
        for(let key in this.pools){
            let kcfg = this.checkpointDb[key];
            if(!kcfg){ missing.push(key); continue; }
            if(kcfg.selfSync && !resolveHubUrl(kcfg)) unwritable.push(key);
        }
        if(unwritable.length){
            let msg = 'Self-synced checkpoint schema has no hub endpoint for serving coin(s): ' +
                unwritable.join(', ') + '. database.checkpoint.self_sync is set, so the hub-mirrored ' +
                'tables (state_checkpoints, capability_snapshots, cross_chain_matches, price_snapshots, ' +
                'oracle_prices) are expected to be written by this explorer, but no hub URL is ' +
                'configured (neither database.checkpoint.hub_url nor the HUB_API_URL env), so nothing ' +
                'writes them and every read serves stale rows. Set the hub URL, or drop self_sync and ' +
                'point database.checkpoint at an externally-maintained hub schema. Set ' +
                'ALLOW_NO_COLOCATED_HUB_DB=1 to start anyway (hub-mirrored endpoints then fail loud ' +
                'per request instead of serving a mirror nothing updates).';
            if(this.configInfo.env.ALLOW_NO_COLOCATED_HUB_DB === '1'){
                log.warn('CHECKPOINT_HUB_URL_MISSING', { coins: unwritable, detail: msg });
            } else {
                throw new Error(msg);
            }
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
            if(this.configInfo.env.ALLOW_NO_COLOCATED_HUB_DB === '1'){
                log.warn('CHECKPOINT_SCHEMA_MISSING', { coins: missing, detail: msg });
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
            await this.rebuildPoolsIfStale();
            pool = (this.pools[config.coin]) ? this.pools[config.coin].pool : null;
        }
        if(pool){
            while(connection == null){
                try {
                    connection = await pool.getConnection();
                } catch (e){
                    if(this.configInfo.env.DEBUG) log.debug('DB_CONNECTION_ERROR', { coin: config && config.coin, err: e && e.message ? e.message : e });
                    connection = null;
                    if(retryCount <= maxRetrys){
                        retryCount++;
                        log.info('DB_CONNECT_RETRY', { coin: config && config.coin, attempt: retryCount });
                        await this.util.sleep(1000);
                    } else {
                        log.info('DB_CONNECT_FAILED', { coin: config && config.coin, attempts: maxRetrys });
                        break;
                    }
                }
            }
        } else {
            log.info('DB_POOL_UNAVAILABLE', { coin: config && config.coin });
        }
        this.transactionConnection = connection;
        return connection;
    }


    // Rebuild connection pools from the current config, at most once per 10s and
    // never concurrently. Used as a lazy recovery path when a query finds no pool
    // (e.g. the explorer came up before the hub and the config arrived later).
    async rebuildPoolsIfStale(){
        let now = Date.now();
        if(this._lastPoolRebuild && (now - this._lastPoolRebuild) < 10000)
            return;
        if(this._poolRebuildPromise)
            return this._poolRebuildPromise;
        this._lastPoolRebuild = now;
        this._poolRebuildPromise = (async () => {
            try { await this.setupConnectionPools(); }
            catch(e){ log.info('POOL_REBUILD_FAILED', { err: e && e.message }); }
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
    // transient outage would render as "no data" (an address showing zero
    // balance). The request layer catches DbQueryError and answers 5xx; a
    // successful query still returns its (possibly empty) array, so a genuinely
    // empty result stays 200. A null query is an explicit no-op and returns false
    // (not a failure). Callers that must tolerate an outage (the /status health
    // read, the WS poll loops, decoder-tip reads) wrap their own calls.
    async doQuery(config, query, args, poolOverride = null){
        if(this.util.isNull(query)) return false;
        let pool = poolOverride || ((this.pools[config.coin]) ? this.pools[config.coin].pool : null);
        if(!pool){
            log.info('DB_POOL_UNAVAILABLE', { coin: config && config.coin });
            throw new DbQueryError('No database connection pool for ' + (config && config.coin));
        }
        let db = null,
            retryCount = 0,
            maxRetrys  = 3;
        while(db === null){
            try {
                db = await pool.getConnection();
            } catch (e){
                if(this.configInfo.env.DEBUG) log.debug('DB_CONNECTION_ERROR', { coin: config && config.coin, err: e && e.message ? e.message : e });
                db = null;
                if(retryCount <= maxRetrys){
                    retryCount++;
                    log.info('DB_CONNECT_RETRY', { coin: config && config.coin, attempt: retryCount });
                    await this.util.sleep(1000);
                } else {
                    log.info('DB_CONNECT_FAILED', { coin: config && config.coin, attempts: maxRetrys });
                    throw new DbQueryError('Database connection unavailable after ' + maxRetrys + ' retries', e);
                }
            }
        }
        let result = false;
        try {
            result = await db.query(query, args);
        } catch (error){
            if(this.configInfo.env.DEBUG) log.debug('SQL_QUERY_ERROR', { coin: config && config.coin, err: error && error.message, stack: error && error.stack });
            else log.error('SQL_QUERY_FAILED', { coin: config && config.coin, err: error.message, stack: error.stack });
            throw new DbQueryError('SQL query failed: ' + (error && error.message), error);
        } finally {
            db.release();
        }
        return result;
    }
}

module.exports = DatabaseConnection.prototype;
