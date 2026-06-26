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

const mariadb = require('mariadb');
const DecoderConnector = require('./XChainDecoderConnector.js');

class Database {

    constructor(explorer){
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
        this.cursorPagedMethods = [
            'getAnchors','getXcalls','getAttestations',
            'getContractStakes','getContractUnstakes','getContractDelegations',
            'getCrossChainSettlements','getCrossChainMatches',
            'getSlashEvents','getCapabilitySlashEvents','getFullNodeVerifications',
            'getPriceSnapshots','getOraclePrices',
            'getValidatorCapabilities','getGovernanceProposals','getGovernanceVotes'
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

    /******************************************************************
     * Database Connection Pool Functions
     *****************************************************************/

    async setupConnectionPools(){
        let coinConfigs = await this.configInfo.getConfig()

        // End previous pools before discarding the map. Without this, any
        // re-entry to setup (config refresh, manual reload) reassigns
        // this.pools and orphans the prior mariadb.createPool() handles;
        // their kept-alive connections linger until the explorer process
        // exits, and MariaDB hits its max_connections ceiling in minutes
        // once refresh is active.
        if(this.pools){
            for(let key in this.pools){
                let oldPool = this.pools[key] && this.pools[key].pool;
                if(oldPool && typeof oldPool.end === 'function'){
                    try { await oldPool.end(); } catch(e){ /* best-effort */ }
                }
            }
        }

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
        // Per-coin checkpoint-source database: the MANDATORY co-located hub DB for
        // serving the hub-mirrored tables (state_checkpoints, capability_snapshots,
        // cross_chain_matches). xchain-sync excludes these tables from every snapshot
        // and stream, so a serving node has no replicated copy: it MUST read them from
        // the hub DB on the same server, declared via a per-network `checkpoint` config
        // block. Like decoderDb, it is honored only when it shares server + credentials
        // with the indexer pool, and is read with a database-qualified query filtered by
        // chain/network (the hub table carries every chain; the per-coin endpoints must
        // not leak siblings). This is now a hard requirement, not an optional override:
        // when a serving coin has no entry here, _checkpointSource / _matchSource throw
        // (fail loud) instead of falling back to a stale local mirror (#4138), and
        // _assertCheckpointDbForServingCoins() turns the same gap into a fatal startup
        // error so a misconfigured thin replica never silently serves empty hub data.
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
                        if (("db_host" in cfg) && ("db_port" in cfg)){
                            this.pools[key] = {
                                "config": {
                                    host:     cfg.db_host,
                                    port:     cfg.db_port,
                                    user:     cfg.user,
                                    password: cfg.pass,
                                    database: cfg.name,
                                    // Connection options. 10 matches xchain-indexer,
                                    // xchain-decoder, and xchain-hub; the previous 25
                                    // pushed total demand past MariaDB's default
                                    // max_connections=151 once 3+ coins were active.
                                    connectionLimit:  10,
                                    //connectTimeout: 0,
                                    insertIdAsNumber: true,
                                    queryTimeout:     parseInt(process.env.DB_QUERY_TIMEOUT) || 30000
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
                                            // Small pool: decoder reads are low-volume
                                            // (status tip, mempool page, raw FILE bytes).
                                            connectionLimit:  3,
                                            insertIdAsNumber: true,
                                            queryTimeout:     parseInt(process.env.DB_QUERY_TIMEOUT) || 30000
                                        });
                                    }
                                }
                            }

                            // Record the checkpoint-source DB name for this coin (see
                            // the checkpointDb note above); same same-server/same-creds
                            // rule as decoderDb, read by reusing this indexer pool.
                            let kcfg = info[net].database.checkpoint;
                            if(kcfg && !this.util.isNull(kcfg.name)){
                                let kHost = ("db_host" in kcfg) ? kcfg.db_host : kcfg.host;
                                let kPort = ("db_port" in kcfg) ? kcfg.db_port : kcfg.port;
                                if(kHost==cfg.db_host && kPort==cfg.db_port && kcfg.user==cfg.user && kcfg.pass==cfg.pass)
                                    this.checkpointDb[key] = { name: kcfg.name, chain: coin, network: net };
                            }
                        }
                    }
                }
            }
        }

        // Mandatory co-located hub DB invariant (#4138). The hub-mirrored tables
        // (state_checkpoints, capability_snapshots, cross_chain_matches) are NEVER
        // replicated by xchain-sync, so a serving coin with no co-located hub DB has
        // only a stale/empty bootstrap copy. Fail loud at startup rather than letting
        // a thin replica silently serve empty hub-mirror data with no alarm.
        this._assertCheckpointDbForServingCoins();
    }

    // Startup assertion: every coin/network this explorer serves (has an indexer
    // pool for) MUST have a co-located hub DB configured (database.checkpoint,
    // same host+credentials as the indexer DB). Without it the hub-mirrored tables
    // cannot be served correctly, because xchain-sync never replicates them. A
    // missing entry is a fatal misconfiguration: throw a clear, named error so a
    // mis-provisioned thin replica fails to start instead of silently serving
    // empty state_checkpoints / capability_snapshots / cross_chain_matches (#4138).
    // Opt-out: ALLOW_NO_COLOCATED_HUB_DB=1 downgrades the fatal error to a warning,
    // for deployments that intentionally do not expose the hub-mirrored endpoints.
    _assertCheckpointDbForServingCoins(){
        let missing = [];
        for(let key in this.pools){
            if(!this.checkpointDb[key]) missing.push(key);
        }
        if(missing.length){
            let msg = 'Mandatory co-located hub DB missing for serving coin(s): ' + missing.join(', ') +
                '. The hub-mirrored tables (state_checkpoints, capability_snapshots, ' +
                'cross_chain_matches) are never replicated by xchain-sync and must be served ' +
                'from a co-located hub DB on the same server. Add a database.checkpoint block ' +
                '(same host + credentials as the indexer DB) for each serving coin/network. ' +
                'Set ALLOW_NO_COLOCATED_HUB_DB=1 to start anyway (hub-mirrored endpoints will ' +
                'fail loud per request instead).';
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

        // Short-TTL result cache for the holders path (item 5338). getHolders sorts by
        // ABS(amount) on a VARCHAR column, which is unindexable, so each call to a public,
        // unauthenticated /api/holders or /explorer/holders route is a full filesort: a cheap
        // DoS-amplification vector for a popular token. A small per-(coin,tick,page,order) cache
        // collapses a request burst into one query. TTL is short so holder lists stay fresh; the
        // map is size-capped (oldest-evicted) so the cache itself cannot grow unbounded.
        let holdersKey = null;
        if(config.data.method === 'getHolders'){
            const sql = config.data.sql || {};
            holdersKey = [config.coin, config.type, config.data.type, config.data.search,
                          sql.apiOffset, sql.order, sql.limit].join('|');
            const ttl = parseInt(process.env.EXPLORER_HOLDERS_CACHE_MS, 10) || 15000;
            if(!this._holdersCache) this._holdersCache = new Map();
            const hit = this._holdersCache.get(holdersKey);
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
            // Force [] for pure list-all so only the offset args remain. Typed requests (search
            // and/or a resource type present) keep the method's args, or the single-search fallback.
            let baseArgs;
            if(!config.data.search && !config.data.type)
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
        // Populate the holders cache (item 5338). Cap the map and evict the oldest entry on
        // overflow so a flood of distinct ticks/pages cannot grow the cache without bound.
        if(holdersKey !== null){
            const MAX = parseInt(process.env.EXPLORER_HOLDERS_CACHE_MAX, 10) || 500;
            if(this._holdersCache.size >= MAX)
                this._holdersCache.delete(this._holdersCache.keys().next().value);
            this._holdersCache.set(holdersKey, { at: Date.now(), data, total });
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
            config.data.sql.apiOffset = (page - 1) * limit;
        }
        if(config.type=='explorer'){
            let offset = (q.offset) ? q.offset : false;
            let start  = (q.start) ? q.start : 0;
            let length = (q.length) ? q.length : 10;
            let action = (q.action) ? q.action : false;
            start  = Math.max(0, Number(start));
            length = Math.max(1, Math.min(Number(length), max));
            if(['getHolders','getBalances'].includes(data.method) && ['prev','last'].includes(action))
                config.data.query.action = config.data.offset.action = action = 'next';
            limit = length;
            if(limit > max)
                limit = max;
            if(action=='last')
                limit = (config.data.query.total - config.data.query.start);
            // token/subtoken/nft/roster searches paginate by fetch-and-slice (no action_index offsets),
            // so the SQL limit must cover start+length rows. Cap the offset fed to the
            // SQL LIMIT: without a bound, an unauthenticated request with a huge `start`
            // forces MariaDB to scan start+length rows for a single page (query-complexity
            // DoS). Deep browsing uses the cursor next/prev path, not raw offsets, so a
            // 100k ceiling is invisible to legitimate use while killing the scan blow-up.
            if(['getBalances', 'getHolders','getSearch','getProjectTokens'].includes(data.method) ||
                (data.method=='getTokens' && ['token','subtoken','nft'].includes(data.type)))
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

    async doQuery(config, query, args, poolOverride = null){
        let result = false;
        if(this.util.isNull(query)) return result;
        let pool = poolOverride || ((this.pools[config.coin]) ? this.pools[config.coin].pool : null);
        if(!pool){
            console.log('Unable to get database connection pool');
            return result;
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
                    return result;
                }
            }
        }
        try {
            result = await db.query(query, args);
        } catch (error){
            if(process.env.DEBUG) console.log('SQL Query Error:', error);
            else console.error('SQL query failed:', error.message, error.stack);
        } finally {
            db.release();
        }
        return result;
    }

    async getQueryWhereSql(config){
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
        // slash_events has no action_index; its PK is m.id
        if(method=='getSlashEvents')
            sql = `m.id IS NOT NULL`;
        // capability_slash_events has no action_index of its own; its PK is m.id
        if(method=='getCapabilitySlashEvents')
            sql = `m.id IS NOT NULL`;
        // price_snapshots is a materialized consensus-round table with no action_index; its PK is m.id
        if(method=='getPriceSnapshots')
            sql = `m.id IS NOT NULL`;
        // cross_chain_matches is a standalone mirror of the hub's match table with no action_index; its PK is m.id
        if(method=='getCrossChainMatches')
            sql = `m.id IS NOT NULL`;
        // oracle_prices is the hub-mirrored user-published oracle row table; no action_index, keyed by m.id
        if(method=='getOraclePrices')
            sql = `m.id IS NOT NULL`;
        // co-located hub capability/governance tables; no action_index, keyed by m.id
        if(['getValidatorCapabilities','getGovernanceProposals','getGovernanceVotes'].includes(method))
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
        // NFT-pattern tokens (NFT_Standard.md#classification-rule-for-clients):
        // indivisible + permanently capped. Fixed predicate, no bind arg.
        } else if(method=='getTokens' && type=='nft'){
            sql += ' AND m.decimals=0 AND m.lock_max_supply=1';
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
        } else if(method=='getValidatorCapabilities'){
            if(type=='capability') sql += ' AND m.capability=?';
            if(type=='pubkey')     sql += ' AND m.signing_pubkey=?';
        } else if(method=='getGovernanceProposals'){
            if(type=='status')    sql += ' AND m.status=?';
            if(type=='parameter') sql += ' AND m.parameter=?';
            if(type=='proposal')  sql += ' AND m.proposal_id=?';
        } else if(method=='getGovernanceVotes'){
            if(type=='proposal') sql += ' AND m.proposal_id=?';
            if(type=='voter')    sql += ' AND m.voter_pubkey=?';
        } else if(['getCrossChainMatches','getCrossChainSettlements'].includes(method)){
            // standalone mirror tables (no actions/transactions chain); filter on
            // their own columns directly. matches carry snapshot_block (the
            // BTC-anchored quorum block); settlements carry the local block_index.
            if(type=='match')  sql += ' AND m.match_id=?';
            if(type=='block')  sql += (method=='getCrossChainSettlements') ? ' AND m.block_index=?' : ' AND m.snapshot_block=?';
            if(type=='status' && method=='getCrossChainMatches') sql += ' AND m.status=?';
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
            if(type=='block')
                sql += ' AND b1.block_index=?';
            if(type=='destination')
                sql += ' AND a3.address=?';
            if(type=='source')
                sql += ' AND a2.address=?';
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
            // id-keyed list views: their main query ORDERs BY m.id (these tables have no
            // action_index cursor column, or a fan-out where action_index is not unique
            // per displayed row), so the paging cursor must compare m.id rather than the
            // default m.action_index. Must stay in lockstep with each method's ORDER BY.
            if(['getSlashEvents','getCapabilitySlashEvents','getOraclePrices',
                'getFullNodeVerifications','getPriceSnapshots','getCrossChainMatches',
                'getValidatorCapabilities','getGovernanceProposals','getGovernanceVotes'].includes(method))
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
        // token/subtoken/nft searches paginate by fetch-and-slice (no action_index offsets)
        if(method=='getTokens' && ['token','subtoken','nft'].includes(type))
            return [];
        if(['address','token','block'].includes(type)){
            if(type=='address')
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
     * /{COIN}/api/dispensers/{QUERY}/{TYPE}         getDispensers       block, address, token, source, destination
     * /{COIN}/api/dispenser_cancels/{QUERY}/{TYPE}  getDispenserCancels block, address
     * /{COIN}/api/dispenser_closes/{QUERY}/{TYPE}   getDispenserCloses  block, address
     * /{COIN}/api/dispenser_expires/{QUERY}/{TYPE}  getDispenserExpires block, address
     * /{COIN}/api/dispenser_edits/{QUERY}/{TYPE}    getDispenserEdits   block, address
     * /{COIN}/api/dispenses/{QUERY}/{TYPE}          getDispenses        block, address, token, source, destination
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
                        s1.status
                    FROM
                        lists m
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
                        c2.coin as get_coin,
                        m.get_action_index,
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
        // token/subtoken set a LIKE pattern below; nft/list-all stay [].
        let args   = [];
        let order  = 'm.id ' + sql.order;
        if(['token','subtoken'].includes(type)){
            order = 't3.tick ' + sql.order;
            if(type=='token')
                args = ['%' + this.util.escapeLike(config.data.search) + '%'];
            if(type=='subtoken')
                args = [this.util.escapeLike(config.data.search) + '.%'];
        }
        // NFT-pattern filter is a fixed predicate (decimals=0 + lock_max_supply=1)
        // with no search placeholder; keep the default m.id ordering (newest first)
        if(type=='nft')
            args = [];
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
                        tick1_24hr_lo     : (reverse) ? row.tick1_24hr_low    : row.tick2_24hr_low,
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
    // /{COIN}/api/mempool/{QUERY}/{TYPE}: unconfirmed actions read from the
    // colocated decoder DB (see getDecoderMempoolRows). Rows are PRE-VALIDATION
    // (the indexer can still reject them at confirmation), carry no destination
    // column, and the full decoded action string ships in `data`; clients with
    // format knowledge (e.g. the SDK's x402 verifier) parse fields out of it.
    // Filtering is a best-effort prefilter done in JS (the data column is hex in
    // SQL): TYPE=address matches the source OR any exact pipe-segment of the
    // action string (covers SEND destinations across versions); TYPE=token
    // matches any exact segment against the uppercased tick.
    async getMempool(config){
        let search = String(config.data.search || '');
        let type   = String(config.data.type || '').toLowerCase();
        let rows   = await this.getDecoderMempoolRows(config, 500);
        let out    = [];
        for(let row of rows){
            let decoded = this.decodeMempoolRow(row);
            if(!decoded) continue;
            let segments = decoded.data.split('|');
            let match = false;
            if(type=='address')
                match = (decoded.source===search) || segments.includes(search);
            if(type=='token')
                match = segments.includes(search.toUpperCase());
            if(match) out.push(decoded);
        }
        return [out, null, out.length];
    }

    async getNetwork(config){
        // Resolve the coin this request is for. config.coin is the route code
        // (BTC / TBTC / RDOGE …); the per-coin chain identity (name + ticker)
        // lives in the loaded explorer config under the BASE coin key (BTC/LTC/DOGE).
        let code = config.coin;
        let coinName = String(code), coinTick = String(code);
        try {
            let full  = await this.configInfo.getConfig();
            let bases = Object.keys(full['COIN_NETWORKS'] || {});            // ['BTC','LTC','DOGE']
            let base  = bases.find(c => String(code).endsWith(c)) || code;   // 'TBTC' -> 'BTC'
            let chain = (full[base] && full[base].chain) ? full[base].chain : {};
            if(chain.name) coinName = chain.name;
            if(chain.tick) coinTick = chain.tick;
        } catch(e){ /* keep code-based fallbacks if config is momentarily unavailable */ }

        // Real indexer tip + last-block time for this coin (same source as /status).
        let block       = await this.getMaxBlockIndex(config);
        let blockTime   = await this.getMaxBlockTime(config);
        // Real unconfirmed (mempool) count from the decoder DB's mempool_transactions.
        let unconfirmed = await this.getDecoderMempoolCount(config);
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
                // Real mempool size: count of the decoder DB's mempool_transactions
                // for this coin (0 if the decoder DB isn't reachable from here).
                unconfirmed: unconfirmed,
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
            // final after N confirmations" value per chain, not a gate. Mirrors the
            // hub's per-chain cross-chain confirmation thresholds and honors the same
            // XCHAIN_CONFIRMATIONS_<COIN> overrides so display stays consistent.
            finality: {
                BTC:  parseInt(process.env.XCHAIN_CONFIRMATIONS_BTC,  10) || 6,
                LTC:  parseInt(process.env.XCHAIN_CONFIRMATIONS_LTC,  10) || 12,
                DOGE: parseInt(process.env.XCHAIN_CONFIRMATIONS_DOGE, 10) || 60
            }
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
            available:       coinConfigs['COIN_AVAILABLE'],
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
            decoder_lag_blocks: {}
        };
        let available = coinConfigs['COIN_AVAILABLE'] || {};
        for (let coin of Object.keys(available)) {
            if (this.pools && this.pools[coin] && this.pools[coin].pool) {
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
            }
        }
        // Chain->decoder visibility: the slice the DB-derived fields above can't
        // see (the explorer never talks to a coin node, so a decoder stalled far
        // behind the chain still shows decoder_lag_blocks=0 once the indexer
        // catches up to its tip). Best-effort per coin via the decoder's own
        // health() JSON-RPC: chain_tip is the coin node's tip as the decoder
        // sees it, chain_lag_blocks the decoder's self-reported gap to it, and
        // decoder_health the decoder's own status ('healthy'/'unhealthy'),
        // 'unconfigured' when no DECODER_API_URL[_<COIN>_<NETWORK>] is set, or
        // 'unreachable' when the call fails. Calls run in parallel and are
        // bounded by the connector timeout so /status stays responsive.
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
            let url    = parsed ? DecoderConnector.resolveDecoderUrl(parsed.coin, parsed.network) : null;
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
                data.chain_tip[code]        = (h && !tipStale && h.chainTipBlock != null) ? h.chainTipBlock : null;
                data.chain_lag_blocks[code] = (h && !tipStale && h.blockLag != null) ? Math.max(0, h.blockLag) : null;
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

    async getActionData(config, action_index){
        // Check LRU cache first (action data is immutable once confirmed on-chain).
        // Key MUST include config.coin: action_index is per-coin, and a multi-coin
        // explorer instance shares this one cache, so a bare-index key returns one
        // coin's action for the same index on another coin.
        let cached = this._cacheGet(this._actionDataCache, config.coin + ':' + action_index);
        if(cached !== undefined) return structuredClone(cached);
        let coinConfigs = await this.configInfo.getConfig()
        let data = {
            credits: null,
            debits:  null,
            escrows: null,
            fee:    null
        };
        let type = await this.getActionType(config, action_index);
        if(type){
            let query   = null;
            let query2  = null;
            let query3  = null;
            let args    = [action_index];
            let results = null;
            let credits = true;
            let debits  = true;
            let escrows = true;
            if(['ADDRESS','BROADCAST','XCALL','NODEPROOF'].includes(type))
                credits = debits = escrows = false;
            if(type=='ADDRESS'){
                query = `SELECT
                            a3.action,
                            a2.action_format,
                            a1.action_index,
                            a4.address as source,
                            a1.fee_preference,
                            a1.require_memo,
                            a1.dispenser_preference,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            addresses a1
                            INNER JOIN actions            a2 ON (a2.action_index=a1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=t1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            a1.action_index=?
                        LIMIT 1`;
            }
            if(type=='AIRDROP'){
                query = `SELECT
                            a3.action,
                            a2.action_format,
                            a1.action_index,
                            a4.address as source,
                            t3.tick,
                            a1.list_action_index,
                            a1.amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            airdrops a1
                            INNER JOIN actions            a2 ON (a2.action_index=a1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=t1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=a1.tick_id)
                        WHERE 
                            a1.action_index=?
                        LIMIT 1`;
            }
            if(type=='BATCH'){
                query = `SELECT
                            a3.action,
                            a2.action_format,
                            b1.action_index,
                            a4.address as source,
                            b2.block_index,
                            b2.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            batches b1
                            INNER JOIN actions            a2 ON (a2.action_index=b1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                            INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=t1.source_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            b1.action_index=?
                        LIMIT 1`;
                query2 = `SELECT
                            a1.action_index
                        FROM
                            actions a1
                        WHERE
                            a1.action_index!=? AND 
                            a1.tx_index=?
                        ORDER BY 
                            a1.action_index ASC`;
            }
            if(type=='BROADCAST'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            b1.action_index,
                            b1.message,
                            b1.value,
                            b1.fee,
                            b1.broadcast_action_index,
                            a3.address as source,
                            b2.block_index,
                            b2.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            broadcasts b1
                            INNER JOIN actions            a1 ON (a1.action_index=b1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=b1.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            b1.action_index=?
                        LIMIT 1`;
            }
            if(type=='CALLBACK'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            c1.action_index,
                            a3.address as source,
                            t3.tick,
                            t4.tick as callback_tick,
                            c1.callback_amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            callbacks c1
                            INNER JOIN actions            a1 ON (a1.action_index=c1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=c1.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=c1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=c1.tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=c1.callback_tick_id)
                        WHERE 
                            c1.action_index=?
                        LIMIT 1`;

            }
            if(type=='COINPAY'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            a3.address as source,
                            m.obligation_action_index,
                            m.coin_amount,
                            m.txid,
                            m.vout,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            coinpays m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            if(type=='COINPAY_EXPIRE'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            m.obligation_action_index,
                            b1.block_index,
                            b1.block_time as timestamp,
                            s1.status
                        FROM
                            coinpay_expires m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            if(type=='DESTROY'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            d1.action_index,
                            a3.address as source,
                            t3.tick,
                            d1.amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            destroys d1
                            INNER JOIN actions            a1 ON (a1.action_index=d1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=d1.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=d1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=d1.tick_id)
                        WHERE 
                            d1.action_index=?
                        LIMIT 1`;
            }
            // DISPENSER action
            if(type=='DISPENSER'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            d1.action_index,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            d1.give_amount,
                            d1.give_ownership,
                            d1.give_escrow,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            d1.get_amount,
                            a3.address as source,
                            a4.address as get_address,
                            f1.code as fiat_code,
                            d1.fiat_amount,
                            a5.address as oracle_address,
                            d1.expiration,
                            d1.allow_list,
                            d1.block_list,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status,
                            s3.status as current_status,
                            ia.address as cancelled_by
                        FROM
                            dispensers d1
                            INNER JOIN actions            a1 ON (a1.action_index=d1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=d1.get_address_id)
                            LEFT  JOIN index_addresses    a5 ON (a5.id=d1.oracle_address_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=d1.memo_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=d1.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=d1.get_coin_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=d1.give_tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=d1.get_tick_id)
                            LEFT  JOIN index_fiats        f1 ON (f1.id=d1.fiat_id)
                            LEFT  JOIN dispenser_statuses s1 ON (s1.dispenser_action_index=d1.action_index)
                            LEFT  JOIN index_statuses     s2 ON (s2.id=d1.status_id)
                            LEFT  JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                            LEFT  JOIN index_addresses    ia ON (ia.id=s1.cancelled_by_id)
                        WHERE
                            (s1.action_index IS NULL OR s1.action_index = (
                                SELECT
                                    MAX(s4.action_index)
                                FROM
                                    dispenser_statuses s4
                                WHERE
                                    s4.dispenser_action_index=d1.action_index
                            )) AND
                            d1.action_index=?
                        LIMIT 1`;
                // Get a list of dispenser edits
                query2 = `SELECT
                            m.give_escrow,
                            m.expiration,
                            m.allow_list,
                            m.block_list
                        FROM
                            dispenser_edits m
                            INNER JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            m.dispenser_action_index=? AND
                            s.status='valid'
                        ORDER BY action_index ASC`;
                // Get a list of dispenses
                query3 = `SELECT
                            m.give_amount
                        FROM
                            dispenses m
                            INNER JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            dispenser_action_index=? AND
                            s.status='valid'
                        ORDER BY m.action_index ASC`;
            }
            if(type=='DISPENSER_CLOSE'){
                query = `SELECT
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
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            if(type=='DISPENSER_CANCEL'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            m.dispenser_action_index,
                            a3.address as source,
                            a4.address as dispenser_address,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            d1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            d1.get_amount,
                            f1.code as fiat,
                            d1.fiat_amount,
                            a5.address as oracle_address,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s1.status
                        FROM
                            dispenser_cancels m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=d1.get_address_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=d1.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=d1.get_coin_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=d1.give_tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=d1.get_tick_id)
                            LEFT  JOIN index_fiats        f1 ON (f1.id=d1.fiat_id)
                            LEFT  JOIN index_addresses    a5 ON (a5.id=d1.oracle_address_id)
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            if(type=='DISPENSER_EDIT'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            m.dispenser_action_index,
                            a3.address as source,
                            a4.address as dispenser_address,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            d1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            d1.get_amount,
                            m.give_escrow,
                            m.expiration,
                            m.allow_list,
                            m.block_list,
                            f1.code as fiat,
                            d1.fiat_amount,
                            a5.address as oracle_address,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s1.status
                        FROM
                            dispenser_edits m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            LEFT  JOIN dispensers         d1 ON (d1.action_index=m.dispenser_action_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=d1.get_address_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=d1.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=d1.get_coin_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=d1.give_tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=d1.get_tick_id)
                            LEFT  JOIN index_fiats        f1 ON (f1.id=d1.fiat_id)
                            LEFT  JOIN index_addresses    a5 ON (a5.id=d1.oracle_address_id)
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            if(type=='DISPENSER_EXPIRE'){
                query = `SELECT
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
                            dispenser_expires m
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
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            if(type=='DISPENSE'){
                query = `SELECT
                        a4.action,
                        m.action_index,
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
                    WHERE 
                        m.action_index=?
                    LIMIT 1`;
            }

            if(type=='DIVIDEND'){
                query = `SELECT
                        a4.action,
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
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.dividend_tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                        LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                    WHERE 
                        m.action_index=?
                    LIMIT 1`;
            }
            if(type=='FILE'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            f1.action_index,
                            f1.name,
                            f1.title,
                            t3.type as type,
                            a3.address as source,
                            gf.gate_ticker,
                            gf.encryption_method,
                            gf.key_hash,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            files f1
                            INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                            LEFT  JOIN gated_files        gf ON (gf.action_index=f1.action_index)
                        WHERE
                            f1.action_index=?
                        LIMIT 1`;
                // TODO: Add code to lookup actual file data from transactions and return an `data` item
            }
            if(type=='ISSUE'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            i1.action_index,
                            t3.tick,
                            i1.max_supply,
                            i1.max_mint,
                            i1.decimals,
                            i1.description,
                            i1.mint_supply,
                            a4.address as transfer,
                            a5.address as transfer_supply,
                            i1.lock_max_supply,
                            i1.lock_mint,
                            i1.lock_mint_supply,
                            i1.lock_max_mint,
                            i1.lock_description,
                            i1.lock_sleep,
                            i1.lock_callback,
                            i1.callback_block,
                            t4.tick as callback_tick,
                            i1.callback_amount,
                            i1.allow_list,
                            i1.block_list,
                            i1.mint_address_max,
                            i1.mint_start_block,
                            i1.mint_stop_block,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            issues i1
                            INNER JOIN actions            a1 ON (a1.action_index=i1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=i1.transfer_id)
                            LEFT  JOIN index_addresses    a5 ON (a5.id=i1.transfer_supply_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=i1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=i1.tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=i1.callback_tick_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=i1.memo_id)
                        WHERE 
                            i1.action_index=?
                        LIMIT 1`;
            }
            if(type=='LINK'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            l1.action_index,
                            c1.coin as coin1,
                            c2.coin as coin2,
                            l1.coin1_action_index,
                            l1.coin2_action_index,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m1.memo,
                            s1.status
                        FROM
                            links l1
                            INNER JOIN actions            a1 ON (a1.action_index=l1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=l1.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=l1.coin1_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=l1.coin2_id)
                        WHERE 
                            l1.action_index=?
                        LIMIT 1`;
            }
            if(type=='LIST'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            l1.action_index,
                            l1.type,
                            l1.edit,
                            l1.list_action_index,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            lists l1
                            INNER JOIN actions            a1 ON (a1.action_index=l1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            l1.action_index=?
                        LIMIT 1`;
                // List
                query2 = `SELECT
                            a1.address,
                            t1.tick
                        FROM
                            list_items l1
                            LEFT JOIN index_addresses a1 ON (a1.id=l1.item_id)
                            LEFT JOIN index_tickers   t1 ON (t1.id=l1.item_id)
                        WHERE 
                            l1.action_index=?`;
                // List Edits
                query3 = `SELECT
                            a1.address,
                            t1.tick,
                            s1.status
                        FROM
                            list_edits l1
                            LEFT  JOIN index_statuses  s1 ON (s1.id=l1.status_id)
                            LEFT JOIN  index_addresses a1 ON (a1.id=l1.item_id)
                            LEFT JOIN  index_tickers   t1 ON (t1.id=l1.item_id)
                        WHERE 
                            l1.action_index=?`;
            }
            if(type=='MESSAGE'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m1.action_index,
                            a3.address as source,
                            a4.address as destination,
                            m1.encryption_method,
                            m1.encryption_key,
                            m1.encrypted_message,
                            m1.plaintext_message,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status,
                            m1.coin
                        FROM
                            messages m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`;
            }
            if(type=='MINT'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m1.action_index,
                            a3.address as source,
                            a4.address as destination,
                            t3.tick,
                            m1.amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s1.status
                        FROM
                            mints m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=m1.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=m1.tick_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`;
            }
            if(type=='ORDER'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            o1.action_index,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            o1.give_amount,
                            o1.give_ownership,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            o1.get_amount,
                            o1.get_ownership,
                            a3.address as source,
                            a4.address as get_address,
                            o1.expiration,
                            o1.allow_list,
                            o1.block_list,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status,
                            s3.status as current_status
                        FROM
                            orders o1
                            INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN order_statuses     s1 ON (s1.order_action_index=o1.action_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=o1.get_address_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                            LEFT  JOIN index_statuses     s2 ON (s2.id=o1.status_id)
                            LEFT  JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                        WHERE
                            (s1.action_index IS NULL OR s1.action_index = (
                                SELECT
                                    MAX(s3.action_index)
                                FROM
                                    order_statuses s3
                                WHERE
                                    s3.order_action_index=o1.action_index
                            )) AND
                            o1.action_index=?
                        LIMIT 1`;
                // Get a list of order edits
                query2 = `SELECT
                            m.expiration,
                            m.allow_list,
                            m.block_list
                        FROM
                            order_edits m
                            INNER JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            m.order_action_index=? AND
                            s.status='valid'
                        ORDER BY action_index ASC`;
                // Get a list of order matches
                query3 = `SELECT
                            m.give_action_index,
                            m.get_action_index,
                            m.give_amount,
                            m.get_amount
                        FROM
                            order_matches m
                            INNER JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            (m.give_action_index=? OR m.get_action_index=?) AND
                            s.status='valid'
                        ORDER BY action_index ASC`;
            }
            if(type=='ORDER_CANCEL'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            m.order_action_index,
                            a3.address as source,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            o1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            o1.get_amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s1.status
                        FROM
                            order_cancels m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN orders             o1 ON (o1.action_index=m.order_action_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                        WHERE 
                            m.action_index=?
                        LIMIT 1`;
            }
            if(type=='ORDER_EDIT'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            m.order_action_index,
                            a3.address as source,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            o1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            o1.get_amount,
                            m.expiration,
                            m.allow_list,
                            m.block_list,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s1.status
                        FROM
                            order_edits m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN orders             o1 ON (o1.action_index=m.order_action_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                        WHERE 
                            m.action_index=?
                        LIMIT 1`;
            }
            if(type=='ORDER_EXPIRE'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            m.order_action_index,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            o1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            o1.get_amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            s1.status
                        FROM
                            order_expires m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN orders             o1 ON (o1.action_index=m.order_action_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                        WHERE 
                            m.action_index=?
                        LIMIT 1`;
            }
            if(type=='ORDER_MATCH'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m1.action_index,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            m1.give_amount,
                            m1.give_action_index,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            m1.get_amount,
                            m1.get_action_index,
                            m1.settlement_type,
                            b1.block_index,
                            b1.block_time as timestamp,
                            s1.status
                        FROM
                            order_matches m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=m1.give_tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=m1.get_tick_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`;
            }
            if(type=='SEND'){
                // Get basic information on the send
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            s1.action_index,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index
                        FROM
                            sends s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            s1.action_index=?
                        LIMIT 1`;
                // Get a list of sends
                query2 = `SELECT
                            a1.address as destination,
                            t1.tick,
                            s1.amount,
                            m1.memo,
                            s2.status
                        FROM
                            sends s1
                            LEFT  JOIN index_addresses    a1 ON (a1.id=s1.destination_id)
                            LEFT  JOIN index_memos        m1 ON (m1.id=s1.memo_id)
                            LEFT  JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            LEFT  JOIN index_tickers      t1 ON (t1.id=s1.tick_id)
                        WHERE 
                            s1.action_index=?`;
            }
            if(type=='SLEEP'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            s1.action_index,
                            s1.type,
                            a3.address as source,
                            t3.tick,
                            s1.resume_block,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            sleeps s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            LEFT  JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT JOIN index_tickers       t3 ON (t3.id=s1.tick_id)
                        WHERE 
                            s1.action_index=?
                        LIMIT 1`;
            }
            if(type=='SWAP'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            s1.action_index,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            s1.give_amount,
                            s1.give_ownership,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            s1.get_amount,
                            s1.get_ownership,
                            a3.address as source,
                            a4.address as get_address,
                            s1.expiration,
                            s1.allow_list,
                            s1.block_list,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s3.status,
                            s4.status as current_status
                        FROM
                            swaps s1
                            LEFT  JOIN swap_statuses      s2 ON (s2.swap_action_index=s1.action_index)
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=s1.get_address_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            LEFT  JOIN index_statuses     s3 ON (s3.id=s1.status_id)
                            LEFT  JOIN index_statuses     s4 ON (s4.id=s2.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                        WHERE
                            (s2.action_index IS NULL OR s2.action_index = (
                                SELECT
                                    MAX(s4.action_index)
                                FROM
                                    swap_statuses s4
                                WHERE
                                    s4.swap_action_index=s1.action_index
                            )) AND
                            s1.action_index=?
                        LIMIT 1`;
                // Get a list of swap edits
                query2 = `SELECT
                            m.expiration,
                            m.allow_list,
                            m.block_list
                        FROM
                            swap_edits m
                            INNER JOIN index_statuses s ON (s.id=m.status_id)
                        WHERE
                            m.swap_action_index=? AND
                            s.status='valid'
                        ORDER BY action_index ASC`;
            }
            if(type=='SWAP_CANCEL'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            m.swap_action_index,
                            a3.address as source,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            s1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            s1.get_amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            swap_cancels m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            LEFT  JOIN swaps              s1 ON (s1.action_index=m.swap_action_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                            LEFT  JOIN index_statuses     s2 ON (s2.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                        WHERE 
                            m.action_index=?
                        LIMIT 1`;
            }
            if(type=='SWAP_EDIT'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            m.swap_action_index,
                            a3.address as source,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            s1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            s1.get_amount,
                            m.expiration,
                            m.allow_list,
                            m.block_list,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            swap_edits m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            LEFT  JOIN swaps              s1 ON (s1.action_index=m.swap_action_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=m.memo_id)
                            LEFT  JOIN index_statuses     s2 ON (s2.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                        WHERE 
                            m.action_index=?
                        LIMIT 1`;
            }
            if(type=='SWAP_EXPIRE'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            m.swap_action_index,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            s1.give_amount,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            s1.get_amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            s2.status
                        FROM
                            swap_expires m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            INNER JOIN swaps              s1 ON (s1.action_index=m.swap_action_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_statuses     s2 ON (s2.id=m.status_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                        WHERE 
                            m.action_index=?
                        LIMIT 1`;
            }
            if(type=='SWAP_MATCH'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m1.action_index,
                            c1.coin as give_coin,
                            t3.tick as give_tick,
                            m1.give_amount,
                            m1.give_action_index,
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            m1.get_amount,
                            m1.get_action_index,
                            b1.block_index,
                            b1.block_time as timestamp,
                            s1.status
                        FROM
                            swap_matches m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                            LEFT  JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                            LEFT  JOIN index_tickers      t3 ON (t3.id=m1.give_tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=m1.get_tick_id)
                        WHERE 
                            m1.action_index=?
                        LIMIT 1`;
            }
            // SWEEP
            if(type=='SWEEP'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            s1.action_index,
                            a3.address as source,
                            a4.address as destination,
                            s1.balances,
                            s1.ownerships,
                            s1.orders,
                            s1.swaps,
                            s1.dispensers,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            m2.memo,
                            s2.status
                        FROM
                            sweeps s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=s1.destination_id)
                            LEFT  JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            LEFT  JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            s1.action_index=?
                        LIMIT 1`;
                // Issues
                // TODO: Update query once each sweep issue is its own action_index
                query2 = `SELECT
                            a1.address,
                            t1.tick
                        FROM
                            issues i1
                            LEFT  JOIN index_tickers   t1 ON (t1.id=i1.tick_id)
                            LEFT  JOIN index_addresses a1 ON (a1.id=i1.transfer_id)
                        WHERE 
                            i1.action_index=?
                        ORDER BY
                            t1.tick ASC`;
            }
            // ATTEST action (v0 request / v1 response; both rows live in `attests`,
            // distinguished by `version`; verified federation sigs ride in the
            // validator_signatures JSON column on v1 rows)
            if(type=='ATTEST'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            m.version,
                            m.request_id,
                            m.provider_id,
                            m.contract_index,
                            fp.address as fee_payer,
                            m.callback_method,
                            m.redundancy,
                            m.deadline_block,
                            m.gas_escrow,
                            m.fee_amount,
                            ft.tick as fee_tick,
                            m.request_status,
                            m.response_hash,
                            m.response_status,
                            m.response_payload,
                            m.meta,
                            m.validator_signatures,
                            m.callback_execute_action_index,
                            m.payload,
                            m.callback_params_json,
                            a3.address as source,
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
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_addresses    fp ON (fp.id=m.fee_payer_id)
                            LEFT  JOIN index_tickers      ft ON (ft.id=m.fee_tick_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            // STAKE action (v1/v2 capability stake → stakes; v3 contract-targeted → contract_stakes)
            if(type=='STAKE'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            a1.action_index,
                            a3.address as source,
                            COALESCE(pk1.pubkey, pk2.pubkey) as signing_pubkey,
                            COALESCE(s.version, cs.version) as version,
                            COALESCE(s.amount, cs.amount) as amount,
                            cs.target_contract_index,
                            tk.tick,
                            COALESCE(s.activation_block, cs.activation_block) as activation_block,
                            COALESCE(s.deactivation_block, cs.deactivation_block) as deactivation_block,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            COALESCE(ss.status, css.status) as status
                        FROM
                            actions a1
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN stakes             s  ON (s.action_index=a1.action_index)
                            LEFT  JOIN index_pubkeys      pk1 ON (pk1.id=s.signing_pubkey_id)
                            LEFT  JOIN index_statuses     ss ON (ss.id=s.status_id)
                            LEFT  JOIN contract_stakes    cs ON (cs.action_index=a1.action_index)
                            LEFT  JOIN index_pubkeys      pk2 ON (pk2.id=cs.signing_pubkey_id)
                            LEFT  JOIN index_tickers      tk ON (tk.id=cs.tick_id)
                            LEFT  JOIN index_statuses     css ON (css.id=cs.status_id)
                        WHERE
                            a1.action_index=?
                        LIMIT 1`;
            }
            // UNSTAKE action (v0 capability → unstakes; v1 contract-targeted → contract_unstakes)
            if(type=='UNSTAKE'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            a1.action_index,
                            a3.address as source,
                            COALESCE(pk1.pubkey, pk2.pubkey) as signing_pubkey,
                            COALESCE(u.amount, cu.amount) as amount,
                            COALESCE(u.cooldown_end_block, cu.cooldown_end_block) as cooldown_end_block,
                            cu.target_contract_index,
                            tk.tick,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            COALESCE(us.status, cus.status) as status
                        FROM
                            actions a1
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN unstakes           u  ON (u.action_index=a1.action_index)
                            LEFT  JOIN index_pubkeys      pk1 ON (pk1.id=u.signing_pubkey_id)
                            LEFT  JOIN index_statuses     us ON (us.id=u.status_id)
                            LEFT  JOIN contract_unstakes  cu ON (cu.action_index=a1.action_index)
                            LEFT  JOIN index_pubkeys      pk2 ON (pk2.id=cu.signing_pubkey_id)
                            LEFT  JOIN index_tickers      tk ON (tk.id=cu.tick_id)
                            LEFT  JOIN index_statuses     cus ON (cus.id=cu.status_id)
                        WHERE
                            a1.action_index=?
                        LIMIT 1`;
            }
            // DELEGATE action (v0/v2 capability -> delegations; v1/v3 contract-targeted -> contract_delegations).
            // A DELEGATE may also write a stake_key_revocations row (revocation variant);
            // revoked_pubkey and deactivation_block are NULL when no revocation occurred.
            if(type=='DELEGATE'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            a1.action_index,
                            a3.address as source,
                            COALESCE(pk1.pubkey, pk2.pubkey) as signing_pubkey,
                            cd.target_contract_index,
                            tk.tick,
                            COALESCE(d.activation_block, cd.activation_block) as activation_block,
                            COALESCE(d.deactivation_block, cd.deactivation_block) as deactivation_block,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            COALESCE(ds.status, cds.status) as status,
                            pk3.pubkey as revoked_pubkey,
                            skr.deactivation_block as revocation_deactivation_block
                        FROM
                            actions a1
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN delegations        d  ON (d.action_index=a1.action_index)
                            LEFT  JOIN index_pubkeys      pk1 ON (pk1.id=d.signing_pubkey_id)
                            LEFT  JOIN index_statuses     ds ON (ds.id=d.status_id)
                            LEFT  JOIN contract_delegations cd ON (cd.action_index=a1.action_index)
                            LEFT  JOIN index_pubkeys      pk2 ON (pk2.id=cd.signing_pubkey_id)
                            LEFT  JOIN index_tickers      tk ON (tk.id=cd.tick_id)
                            LEFT  JOIN index_statuses     cds ON (cds.id=cd.status_id)
                            LEFT  JOIN stake_key_revocations skr ON (skr.action_index=a1.action_index)
                            LEFT  JOIN index_pubkeys      pk3 ON (pk3.id=skr.signing_pubkey_id)
                        WHERE
                            a1.action_index=?
                        LIMIT 1`;
            }
            if(type=='COLLECT'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            a3.address as source,
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
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=m.source_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            // SLASH action (permissionless equivocation proof -> capability_slash_events). Drives
            // from `actions` so the wire action always resolves even before the slash event row is
            // joined; capability_slash_events.slash_action_index points back to this SLASH action.
            if(type=='SLASH'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            a1.action_index,
                            a3.address as source,
                            pk.pubkey as slashed_pubkey,
                            m.capability,
                            m.equiv_key,
                            m.amount,
                            m.bounty_amount,
                            m.treasury_amount,
                            sub.address as submitter,
                            dst.address as destination,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index
                        FROM
                            actions a1
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN capability_slash_events m ON (m.slash_action_index=a1.action_index)
                            LEFT  JOIN index_pubkeys      pk  ON (pk.id=m.signing_pubkey_id)
                            LEFT  JOIN index_addresses    sub ON (sub.id=m.submitter_id)
                            LEFT  JOIN index_addresses    dst ON (dst.id=m.destination_id)
                        WHERE
                            a1.action_index=?
                        LIMIT 1`;
            }
            // DEPLOY action. The chunk carrier (v4) and the actual deploy (v0-v3) share the
            // DEPLOY action name but live in different tables, so pick the detail query by the
            // format version: v4 → deploy_chunks (one base64 code slice); v0-v3 → contracts
            // (v1 surfaces cooldown_blocks + slash_destination).
            if(type=='DEPLOY'){
                let fmtRows = await this.doQuery(config, 'SELECT action_format FROM actions WHERE action_index=? LIMIT 1', [action_index]);
                let actionFormat = (fmtRows && fmtRows.length) ? Number(fmtRows[0].action_format) : null;
                if(actionFormat === 4){
                    query = `SELECT
                                a2.action,
                                a1.action_format,
                                m.action_index,
                                a3.address as source,
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
                                LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                                LEFT  JOIN index_addresses    a3 ON (a3.id=m.source_id)
                                LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                                LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            WHERE
                                m.action_index=?
                            LIMIT 1`;
                } else {
                    query = `SELECT
                                a2.action,
                                a1.action_format,
                                m.action_index,
                                a3.address as source,
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
                                LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                                LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                                LEFT  JOIN index_addresses    sd ON (sd.id=m.slash_destination_id)
                                LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                                LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            WHERE
                                m.action_index=?
                            LIMIT 1`;
                }
            }
            // EXECUTE action (contract method call → contract_executions)
            if(type=='EXECUTE'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            m.contract_index,
                            a3.address as caller,
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
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=m.caller_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            // DEPOSIT / WITHDRAW action (contract custody transfers)
            if(type=='DEPOSIT' || type=='WITHDRAW'){
                let custodyTable = (type=='DEPOSIT') ? 'deposits' : 'withdrawals';
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
                            m.contract_index,
                            a3.address as source,
                            tk.tick,
                            m.amount,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index,
                            s1.status
                        FROM
                            ` + custodyTable + ` m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=m.source_id)
                            LEFT  JOIN index_tickers      tk ON (tk.id=m.tick_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            // UNKNOWN
            if(type=='UNKNOWN'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            a1.action_index,
                            a3.address as source,
                            b1.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            'invalid' as status,
                            t1.tx_index
                        FROM
                            actions                       a1
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                        WHERE 
                            a1.action_index=?
                        LIMIT 1`;
            }
            // PRICE action (v0 validator COIN/FIAT snapshot + v1 user TOKEN/FIAT oracle)
            if(type=='PRICE'){
                query = `SELECT
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
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            // XCALL action (cross-chain call request v0 / expire v2). VM-emitted; the
            // execution outcome + callback delivery are attached post-query by call_id.
            if(type=='XCALL'){
                query = `SELECT
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
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            // NODEPROOF action (full-node possession-proof verdict v0). The verdict is a
            // single quorum-signed action that writes one full_node_verifications row per
            // PASS pubkey, all sharing this action_index; so challenge_id/epoch_height/
            // target_height are verdict-level constants (pulled here from any one row) and
            // the per-validator PASS list is attached as `verifications` below.
            if(type=='NODEPROOF'){
                query = `SELECT
                            a4.action,
                            a1.action_format,
                            m.action_index,
                            m.challenge_id,
                            m.epoch_height,
                            m.target_height,
                            a2.address as source,
                            m.block_index,
                            b1.block_time as timestamp,
                            t2.hash as tx_hash,
                            t1.tx_index
                        FROM
                            full_node_verifications m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            LEFT  JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            // ANCHOR action (DOGE-only; v0 = checkpoint, v1 = checkpoint+archive, v2 = continuation chunk).
            // archive_b64 is intentionally omitted (large; only the recovery assembler needs it).
            // The four SPV root columns (state_root, state_root_version, block_merkle_root,
            // block_merkle_version) are NULL for v0/v1/v2 and populated for v3 once the
            // CHECKPOINT_COMMITMENT flag-day activates; included here so the detail view
            // matches the getAnchors() list and checkpoint-reader surfaces.
            if(type=='ANCHOR'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m.action_index,
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
                            LEFT  JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE
                            m.action_index=?
                        LIMIT 1`;
            }
            if(query){
                results = await this.doQuery(config, query, args);
                if(results && results.length)
                    data = Object.assign({}, data, results[0]);
            }
            // Create an state object with current state info
            if(['ORDER','SWAP','DISPENSER'].includes(type)){
                data['state'] = {
                    get_remaining:  data['get_amount'],
                    give_remaining: data['give_amount'],
                    expiration:     data['expiration'],
                    allow_list:     data['allow_list'],
                    block_list:     data['block_list'],
                    status:         data['current_status']
                }
                delete data['current_status'];
                if(type=='DISPENSER'){
                   data.state.give_remaining = data['give_escrow'];
                   delete data.state.get_remaining;
                }
            }
            // Expand the inlined validator-signature JSON on ATTEST responses into
            // a structured array the action-detail page can render.
            if(type=='ATTEST'){
                if(data['validator_signatures']){
                    try { data['signatures'] = JSON.parse(data['validator_signatures']); }
                    catch(_) { console.warn('getActionData: ATTEST validator_signatures parse failed for action_index=' + action_index + ':', _); data['signatures'] = []; }
                } else {
                    data['signatures'] = [];
                }
                delete data['validator_signatures'];
            }
            // Expand the inlined JSON columns on PRICE actions into structured arrays so
            // third parties can read the COIN/FIAT pairs and the PBFT signature set (v0).
            if(type=='PRICE'){
                if(data['pairs_json']){
                    try { data['pairs'] = JSON.parse(data['pairs_json']); }
                    catch(_) { console.warn('getActionData: PRICE pairs_json parse failed for action_index=' + action_index + ':', _); data['pairs'] = []; }
                }
                if(data['sigs_json']){
                    try { data['signatures'] = JSON.parse(data['sigs_json']); }
                    catch(_) { console.warn('getActionData: PRICE sigs_json parse failed for action_index=' + action_index + ':', _); data['signatures'] = []; }
                }
                delete data['pairs_json'];
                delete data['sigs_json'];
            }
            // XCALL: parse the params JSON arrays and attach the target-chain execution
            // outcome + source-chain callback delivery (each by call_id; null until the
            // call is relayed/executed/delivered). Mirrors getXcall's lifecycle assembly.
            if(type=='XCALL' && data['call_id']){
                try { data['params'] = this.util.isNull(data['params_json']) ? null : JSON.parse(data['params_json']); }
                catch(_) { data['params'] = data['params_json']; }
                try { data['callback_params'] = this.util.isNull(data['callback_params_json']) ? null : JSON.parse(data['callback_params_json']); }
                catch(_) { data['callback_params'] = data['callback_params_json']; }
                let exec = await this.doQuery(config,
                    `SELECT execute_action_index, result_status, return_payload_b64, gas_used, block_index as execution_block_index
                     FROM cross_chain_call_executions WHERE call_id=? LIMIT 1`, [data['call_id']]);
                data['execution'] = (exec && exec.length) ? exec[0] : null;
                let cb = await this.doQuery(config,
                    `SELECT result_status as callback_result_status, block_index as callback_block_index
                     FROM cross_chain_call_callbacks WHERE call_id=? LIMIT 1`, [data['call_id']]);
                data['callback_delivery'] = (cb && cb.length) ? cb[0] : null;
            }
            // EXECUTE: attach the actions this contract call emitted (emit.execute / emit.send /
            // internal SLASH etc.), ordered by emission position. Children link by action_index
            // (NULL for internal emissions that move ledger state without minting an on-wire
            // action, e.g. SLASH). Browsing children needs contract_emissions (actions.source_id
            // is the emitting contract address, not a parent→child pointer.
            if(type=='EXECUTE'){
                let emits = await this.doQuery(config,
                    `SELECT position, emitted_action, action_index
                     FROM contract_emissions WHERE execution_index=? ORDER BY position ASC`, [action_index]);
                data['emissions'] = (emits && emits.length) ? emits : [];
            }
            // NODEPROOF: attach the per-validator PASS list this verdict recorded. One row
            // per verified full node (sharing this action_index), each carrying the verified
            // signing pubkey and its staking source address (index_pubkeys / index_addresses).
            if(type=='NODEPROOF'){
                let verifs = await this.doQuery(config,
                    `SELECT
                            m.signing_pubkey_id,
                            pk.pubkey as signing_pubkey,
                            m.source_id,
                            a3.address as staking_source,
                            m.passed,
                            m.block_index
                     FROM full_node_verifications m
                        LEFT JOIN index_pubkeys   pk ON (pk.id=m.signing_pubkey_id)
                        LEFT JOIN index_addresses a3 ON (a3.id=m.source_id)
                     WHERE m.action_index=?
                     ORDER BY m.id ASC`, [action_index]);
                data['verifications'] = (verifs && verifs.length) ? verifs : [];
            }
            if(query2){
                // Set correct arguments for the query
                let args2 = [action_index];
                if(type=='BATCH')
                    args2.push(data.tx_index);
                results = await this.doQuery(config, query2, args2);
                if(results && results.length){
                    if(type=='BATCH'){
                        let actions = [];
                        for(let row of results){
                            let info = await this.getActionData(config, Number(row.action_index));
                            actions.push(info);
                        }
                        data.actions = actions;
                    }
                    // Handle populating the list based off the list TYPE field
                    if(type=='LIST'){
                        let list = [];
                        for(let row of results){
                            if(data.type==1) list.push(row.tick);
                            if(data.type==2) list.push(row.address);
                        }
                        data.list = list.sort();
                    }
                    // Add any ISSUES to the sweep data
                    if(type=='SWEEP')
                        data.issues = results;
                    // Add any SENDS to the send data
                    if(type=='SEND')
                        data.sends = results;
                    if(['ORDER','SWAP','DISPENSER'].includes(type)){
                        // Mirror consensus when deriving DISPENSER list-edit activation: the indexer
                        // gates activation on the deterministic block timestamp (block_time), never on
                        // wall-clock. Comparing against the latest indexed block_time keeps activation
                        // status identical across explorer hosts regardless of each host's local clock.
                        let now = await this.getMaxBlockTime(config);
                        for(let row of results){
                            let active = true;
                            if(type=='DISPENSER'){
                                // Update state with any additional tokens escrowed in dispenser edits
                                if(!this.util.isNull(row.give_escrow))
                                    data.state.give_remaining = String(this.util.bcadd(data.state.give_remaining, row.give_escrow));
                                // Determine if the allow/block list edits are active using DISPENSER_LIST_DELAY.
                                // Use a bignumber comparison (matching the indexer's bcgt-based consensus check)
                                // rather than a JS '>' on mixed Number/bignumber operands.
                                active = this.util.bcgt(now, this.util.bcadd(row.block_time, coinConfigs['DISPENSER_LIST_DELAY']));
                            } 
                            if(!this.util.isNull(row.expiration))  data.state.expiration  = row.expiration;
                            if(active){
                                if(!this.util.isNull(row.allow_list))  data.state.allow_list  = row.allow_list;
                                if(!this.util.isNull(row.block_list))  data.state.block_list  = row.block_list;
                            }
                        }
                    }
                }
            }
            if(query3){
                let args3 = [action_index];
                if(type=='ORDER')
                    args3.push(action_index);
                results = await this.doQuery(config, query3, args3);
                if(results && results.length){
                    if(type=='LIST'){
                        let edits = [];
                        for(let row of results){
                            if(data.type==1) edits.push({ tick: row.tick, status: row.status });
                            if(data.type==2) edits.push({ address: row.address, status: row.status });
                        }
                        data.edits = edits.sort();
                    }
                    if(type=='ORDER'){
                        let give_remaining = data['give_amount'],
                            get_remaining  = data['get_amount'];
                        for(let row of results){
                            let give_amount = (row.get_action_index==action_index) ? row.give_amount : row.get_amount;
                            let get_amount  = (row.get_action_index==action_index) ? row.get_amount  : row.give_amount;
                            give_remaining  = this.util.bcsub(give_remaining, give_amount);
                            get_remaining   = this.util.bcsub(get_remaining,  get_amount);
                        }
                        data.state.give_remaining = String(give_remaining);
                        data.state.get_remaining  = String(get_remaining);
                    }
                    // Determine give_remaining by subtracting any amounts given out in dispenses
                    if(type=='DISPENSER'){
                        for(let row of results)
                            data.state.give_remaining = String(this.util.bcsub(data.state.give_remaining, row.give_amount));
                    }
                }
            }
            if(credits){
                query = `SELECT
                            a1.address,
                            t1.tick,
                            c1.amount
                        FROM
                            credits c1
                            LEFT  JOIN index_tickers   t1 ON (t1.id=c1.tick_id)
                            LEFT  JOIN index_addresses a1 ON (a1.id=c1.address_id)
                        WHERE 
                            c1.action_index=?
                        ORDER BY
                            t1.tick ASC,
                            CAST(c1.amount as DECIMAL(64,18)) DESC,
                            a1.address ASC`;
                results = await this.doQuery(config, query, args);
                if(results && results.length)
                    data.credits = results;
            }
            if(debits){
                query = `SELECT
                            a1.address,
                            t1.tick,
                            d1.amount
                        FROM
                            debits d1
                            LEFT  JOIN index_tickers   t1 ON (t1.id=d1.tick_id)
                            LEFT  JOIN index_addresses a1 ON (a1.id=d1.address_id)
                        WHERE 
                            d1.action_index=?
                        ORDER BY
                            t1.tick ASC,
                            CAST(d1.amount as DECIMAL(64,18)) DESC,
                            a1.address ASC`;
                results = await this.doQuery(config, query, args);
                if(results && results.length)
                    data.debits = results;
            }
            if(escrows){
                query = `SELECT
                            a1.address,
                            t1.tick,
                            e1.amount
                        FROM
                            escrows e1
                            LEFT  JOIN index_tickers   t1 ON (t1.id=e1.tick_id)
                            LEFT  JOIN index_addresses a1 ON (a1.id=e1.address_id)
                        WHERE 
                            e1.action_index=?
                        ORDER BY
                            t1.tick ASC,
                            CAST(e1.amount as DECIMAL(64,18)) DESC,
                            a1.address ASC`;
                results = await this.doQuery(config, query, args);
                if(results && results.length)
                    data.escrows = results;
            }
            let fee = await this.getActionFeeData(config, action_index);
            if(fee)
                data.fee = fee;
            let txData = await this.getTransactionData(config, data.tx_hash);
            data.tx_data = (!this.util.isNull(txData)) ? txData.data : null;
            // data.related = await this.getRelatedActions(config, action_index);;
        }
        // Store in LRU cache for future lookups (per-coin key, see getActionData entry)
        this._cacheSet(this._actionDataCache, config.coin + ':' + action_index, structuredClone(data));
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
        let cached = this._cacheGet(this._addressIdCache, address);
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
        if(id !== null) this._cacheSet(this._addressIdCache, address, id);
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
        let cached = this._cacheGet(this._tickIdCache, tick);
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
        if(id !== null) this._cacheSet(this._tickIdCache, tick, id);
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

    // Get actions related to a given action_index
    // TODO: Circle back through and get related actions working
    async getRelatedActions(config, action_index){
        let type  = await this.getActionType(config, action_index);
        let query = null;
        if(type=='ORDER'){
            query = `
                SELECT action_index FROM order_edits   WHERE order_action_index=? UNION
                SELECT action_index FROM order_cancels WHERE order_

            `;
        }


        let actions = [];
        if(type){

        }
        return actions;
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
        // Skip COUNT query when total is passed on the querystring (speeds up explorer pagination)
        if(q && q.total){
            total = q.total;
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
                total = this.util.bcadd(total, results[0].count, 0);
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
        if(total){
            query = `SELECT
                        DISTINCT(m.action_index) as action_index,
                        a2.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index            
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

    async getActionSummaryData(config, actions){
        // --- Performance note (Fix B / #3841) ---
        // This loop issues one getActionData() call per row, which is a serial N+1 pattern.
        // The LRU _actionDataCache helps on repeated page views but not on first loads.
        //
        // Batched-fetch follow-up (post-launch): group the action_index set by action type
        // (the `action` column is already returned by the getHistoryData main query), issue
        // one per-type JOIN query for the whole page, and stitch results into the same
        // detailFields shape below. This would collapse ~100 round-trips to ~30 (one per
        // distinct action type on the page). Tracked as #3841.
        const t0 = Date.now();
        // --- End Fix B ---
        // Minimal field set for history list items; full info is available per-action.
        let detailFields = [
            'coin', 'tick',  'amount', 'source', 'destination', 'type', 'edit', 'expiration', 'allow_list', 'block_list',  // Common fields
            'action_format',                                                                                               // Action details
            'fee_preference', 'require_memo', 'dispenser_preference',                                                      // Addresses
            'message', 'value', 'broadcast_action_index',                                                                  // Broadcasts
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
            'balances', 'ownerships', 'orders', 'swaps', 'dispensers'                                                      // Sweeps
        ];
        for(let data of actions){
            let info = await this.getActionData(config, data.action_index);
            data.status = info.status;
            let details = false;
            for(let name of detailFields){
                let found  = false;
                let detail = false;
                if(typeof info[name] !== 'undefined'){
                    found  = true;
                    detail = info[name];
                }
                if(info.action=='SEND' && info.sends && info.sends.length>0){
                    found = true;
                    detail = info.sends[0][name];
                    if(this.util.isNull(data.status))
                        data.status = info.sends[0]['status'];
                }
                if(found){
                    // If details object does not exist yet, create it
                    if(!details)
                        details = {};
                    details[name] = detail;
                }

            }
            data.details = details;
        }
        // Slow-page observability (Fix B): warn when first-load latency is high so
        // the batched-fetch follow-up (#3841) can be prioritised against real data.
        const elapsed = Date.now() - t0;
        if(elapsed > 500)
            console.warn('getActionSummaryData: slow page (' + elapsed + 'ms, ' + actions.length + ' actions) -- N+1 serial getActionData; see #3841 for batched fix');
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
                        INNER JOIN index_memos     m1 ON (m1.id=o1.memo_id)
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
                        INNER JOIN index_memos     m1 ON (m1.id=o1.memo_id)
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

    // Count of unconfirmed (mempool) transactions for this coin, read from the
    // decoder DB's mempool_transactions table. Same access pattern + safety as
    // getDecoderTip (DB-qualified query on the indexer pool; only works when the
    // decoder DB shares the indexer's server/credentials). Returns 0 when the
    // decoder DB isn't reachable so callers always get a usable number.
    async getDecoderMempoolCount(config) {
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return 0;
        // dbName is config-derived, not client input, but database identifiers
        // can't be bound; restrict to a safe identifier charset before use.
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return 0;
        try {
            let query   = 'SELECT COUNT(*) as count FROM `' + dbName + '`.mempool_transactions';
            let results = await this.doDecoderQuery(config, query, []);
            if (results && results.length && results[0].count !== null)
                return Number(results[0].count);
        } catch(e){
            // Decoder DB unreachable, missing table, or no cross-DB grant: report 0.
            console.warn('getDecoderMempoolCount: mempool count unavailable for ' + config.coin + ': ' + (e && e.message ? e.message : e));
        }
        return 0;
    }

    // Raw unconfirmed (mempool) action rows from the decoder DB. As of the
    // 2026-06-15 mempool-raw-strings migration, mempool_transactions stores the
    // tx hash and source address as raw string columns (tx_hash, source) rather
    // than FK ids into the decoder's index tables, so the row reads directly with
    // no joins. Rows are PRE-VALIDATION: the decoder writes whatever parses out of
    // a mempool tx; the indexer may still reject it at confirmation time. The
    // destination is not populated as a column; destinations live inside the
    // decoded action string (`data`), which callers parse. Same access pattern +
    // safety rules as getDecoderMempoolCount. Returns [] when the decoder DB isn't
    // reachable.
    async getDecoderMempoolRows(config, limit) {
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return [];
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return [];
        let max = Math.max(1, Math.min(Number(limit) || 200, 500));
        try {
            let query = 'SELECT m.tx_hash AS tx_hash, m.source AS source, m.data AS data_hex ' +
                        'FROM `' + dbName + '`.mempool_transactions m ' +
                        'LIMIT ' + max;
            let results = await this.doDecoderQuery(config, query, []);
            return results || [];
        } catch(e){
            console.warn('getDecoderMempoolRows: mempool rows unavailable for ' + config.coin + ': ' + (e && e.message ? e.message : e));
        }
        return [];
    }

    // Decode one decoder mempool row: hex -> utf8 action string -> segments.
    // The wire layout is pipe-joined with the action name first
    // (e.g. SEND|0|TICK|AMOUNT|DESTINATION|MEMO). Returns null on garbage.
    decodeMempoolRow(row) {
        try {
            if(!row || this.util.isNull(row.data_hex)) return null;
            let text = Buffer.from(String(row.data_hex), 'hex').toString('utf8');
            if(!text.length) return null;
            let segments = text.split('|');
            let action = String(segments[0] || '').trim().toUpperCase();
            if(!/^[A-Z_]{2,32}$/.test(action)) return null;
            return {
                tx_hash: row.tx_hash || null,
                source:  row.source || null,
                action:  action,
                data:    text
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

    async getMaxActionIndex(config) {
        let query   = `SELECT MAX(action_index) as max_index FROM actions`;
        let results = await this.doQuery(config, query, []);
        if (results && results.length && results[0].max_index !== null)
            return Number(results[0].max_index);
        return 0;
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
            let query = 'SELECT t1.raw_data FROM `' + dbName + '`.transactions t1 ' +
                        'INNER JOIN `' + dbName + '`.index_transactions t2 ON (t2.id=t1.tx_hash_id) ' +
                        'WHERE t2.hash=? LIMIT 1';
            let results = await this.doDecoderQuery(config, query, [rows[0].hash]);
            if(results && results.length && !this.util.isNull(results[0].raw_data))
                return { raw_data: results[0].raw_data, type: rows[0].type };
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
    // { roster_action_index, link_action_index, total } or null when the
    // tick has never had an owner-valid roster link.
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
            roster_action_index: Number(rows[0].roster_action_index),
            link_action_index:   Number(rows[0].link_action_index),
            total: 0
        };
        let count = await this.doQuery(config, `SELECT count(*) AS total FROM list_items WHERE action_index=?`, [info.roster_action_index]);
        if(count && count.length)
            info.total = Number(count[0].total);
        return info;
    }

    // Projects whose CURRENT roster includes the given tick (the reverse
    // lookup behind the token-page "Official: part of X" banner). A project
    // whose latest roster dropped the tick does not match.
    async getTokenProjects(config, tick){
        let chain = this.baseCoin ? this.baseCoin[config.coin] : null;
        if(this.util.isNull(chain) || this.util.isNull(tick)) return [];
        let query = `SELECT
                        t1.tick                AS project,
                        latest.link_action_index,
                        lk.coin1_action_index  AS roster_action_index
                    FROM (
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
                        INNER JOIN links          lk ON (lk.action_index=latest.link_action_index)
                        INNER JOIN list_items     li ON (li.action_index=lk.coin1_action_index)
                        INNER JOIN index_tickers  t2 ON (t2.id=li.item_id AND t2.tick=?)
                        INNER JOIN index_tickers  t1 ON (t1.id=latest.tick_id)
                    ORDER BY latest.link_action_index DESC`;
        let rows = await this.doQuery(config, query, [chain, chain, tick]);
        if(!rows || !rows.length) return [];
        return rows.map(r => ({
            project:             r.project,
            link_action_index:   Number(r.link_action_index),
            roster_action_index: Number(r.roster_action_index)
        }));
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
    // [{ action_class, contract_index, cooldown_blocks, is_unbind, bind_block }].
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
        let rows = await this.doQuery(config, query, [info.roster_action_index]);
        let data = {
            tick:                String(tick).toUpperCase(),
            roster_action_index: info.roster_action_index,
            link_action_index:   info.link_action_index,
            total:               info.total,
            members:             []
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
        let args  = [info.roster_action_index];
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
    // mandatory co-located hub DB (the same-server `checkpoint` config block,
    // database-qualified + chain/network-filtered; the hub table carries every
    // chain). There is deliberately NO local-mirror fallback: a thin replica
    // without a co-located hub DB has only a stale/empty bootstrap copy of these
    // tables, and silently serving that would publish wrong consensus-relevant
    // data with no alarm (#4138). When the hub DB is absent or its configured
    // name is not a safe identifier we FAIL LOUD by throwing, surfacing the
    // misconfiguration to the route (HTTP 500 + log) instead of serving stale
    // rows. dbName is config-derived, not client input, but database identifiers
    // can't be bound; restrict to a safe identifier charset before use (same rule
    // as the decoderDb readers above).
    _checkpointSource(config){
        let src = this.checkpointDb ? this.checkpointDb[config.coin] : null;
        if (src && /^[A-Za-z0-9_$]+$/.test(src.name))
            return { table: '`' + src.name + '`.state_checkpoints',
                     capTable: '`' + src.name + '`.capability_snapshots',
                     filter: ' AND chain = ? AND network = ?',
                     filterParams: [src.chain, src.network] };
        throw new Error('No co-located hub DB configured for coin ' + config.coin +
            ': state_checkpoints / capability_snapshots are served only from the mandatory ' +
            'co-located hub DB (config database.checkpoint, same host+credentials as the indexer DB), ' +
            'never from a stale local replica mirror. Configure the checkpoint DB block to serve this coin.');
    }

    // Resolve the cross_chain_matches source for a coin, mirroring _checkpointSource.
    // cross_chain_matches is hub-mirrored (hub_db_sync), so xchain-sync EXCLUDES it from
    // every snapshot and per-block stream: a thin replica's local copy is a stale bootstrap
    // dump the live stream never refreshes. A serving node therefore MUST read matches from
    // the mandatory co-located hub DB (the same DB that already backs state_checkpoints/
    // capability_snapshots) so the endpoint serves live, retraction-aware rows. There is
    // deliberately NO local-mirror fallback (#4138): when the hub DB is absent or its name
    // is not a safe identifier we FAIL LOUD by throwing rather than silently serving the
    // stale local mirror. The hub table carries every chain AND network, so a network filter
    // is required. dbName is config-derived, not client input, but database identifiers can't
    // be bound; restrict to a safe identifier charset before use (same rule as
    // _checkpointSource / the decoderDb readers).
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

    // Resolve a co-located hub-DB federation/governance table for a coin (validators,
    // validator_capabilities, governance_proposals, governance_votes). Mirrors _matchSource:
    // the table is DB-qualified to the co-located hub DB (same host+creds as the indexer DB, so
    // the qualified name runs on the indexer pool) and read directly, never a local replica.
    // `table` is whitelisted to lowercase identifiers (no injection). Federation data is
    // platform-global (no per-chain network column), so there is no network filter.
    _hubSource(config, table){
        let src = this.checkpointDb ? this.checkpointDb[config.coin] : null;
        if (src && /^[A-Za-z0-9_$]+$/.test(src.name) && /^[a-z_]+$/.test(table))
            return { table: '`' + src.name + '`.' + table };
        throw new Error('No co-located hub DB configured for coin ' + config.coin +
            ': ' + table + ' is served only from the mandatory co-located hub DB ' +
            '(config database.checkpoint, same host+credentials as the indexer DB). ' +
            'Configure the checkpoint DB block to serve this coin.');
    }

    // BIGINT columns (block_index/checkpoint_seq/snapshot_block) come back from
    // the mariadb driver as BigInt, which res.json() cannot serialize; coerce
    // them to Number (chain heights are far below MAX_SAFE_INTEGER).
    _normalizeCheckpointRows(rows){
        return (rows || []).map(r => ({
            ...r,
            block_index:    Number(r.block_index),
            checkpoint_seq: Number(r.checkpoint_seq),
            snapshot_block: Number(r.snapshot_block)
        }));
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
        let scFilter = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let query = `SELECT sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash, sc.actions_hash,
                            sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block,
                            sc.state_root, sc.state_root_version, sc.block_merkle_root, sc.block_merkle_version,
                            sc.validator_signatures, sc.created_at
                     FROM ${src.table} sc
                     JOIN (SELECT block_index, MAX(checkpoint_seq) AS max_seq
                           FROM ${src.table} WHERE 1=1${src.filter} GROUP BY block_index) t
                       ON t.block_index = sc.block_index AND t.max_seq = sc.checkpoint_seq
                     WHERE 1=1${scFilter}
                     ORDER BY sc.block_index DESC
                     LIMIT ?`;
        return this._normalizeCheckpointRows(await this.doQuery(config, query, [...src.filterParams, ...src.filterParams, Number(limit) || 10]));
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
        let rows = await this.doQuery(config,
            `SELECT balances_root, stakes_root, state_root, block_merkle_root
             FROM state_tree_roots WHERE block_index = ? LIMIT 1`, [Number(blockIndex)]);
        return (rows && rows.length) ? rows[0] : null;
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
        // NOTE: the generic `actions` table carries no status_id (status lives on
        // the per-ACTION-type tables, e.g. issues/sends/mints, joined as m.status_id
        // elsewhere) and no status column; so this feed reports status as NULL.
        // The earlier `s1.id=a1.status_id` join referenced a non-existent column and
        // made the whole query throw (ER_BAD_FIELD_ERROR), which silently killed the
        // WebSocket NEW_ACTION stream: the ChangeDetector advanced its action pointer
        // but getActionsSince returned [] every poll, so no NEW_ACTION ever fired.
        // Source is taken from actions.source_id (a1): the action's true source,
        // which for VM-emitted actions differs from the EXECUTE caller on transactions.
        let query = `SELECT
                        a1.action_index,
                        a3.action,
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

    async getDispenserInfo(config, actionIndex) {
        let query = `SELECT
                        d.action_index,
                        a2.address as source,
                        t1.tick as give_tick,
                        d.give_amount,
                        d.give_remaining,
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
        if (results && results.length) return results[0];
        return null;
    }

    async getCoinpayObligation(config, orderMatchActionIndex) {
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

    async getPriceSnapshots(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        price_snapshots m
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
                        price_snapshots m
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get list of hub-mirrored oracle_prices rows (user-published PRICE v1 oracle rows
    // replicated by hub_db_sync). These are the aggregated hub-effective published-oracle
    // prices that feed oracle-priced DISPENSERs. type in {token, address}.
    async getOraclePrices(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        oracle_prices m
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
                        oracle_prices m
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
                        a3.address as signing_pubkey,
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
                        a3.address as signing_pubkey,
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

    // Federation registry (hub-owned `validators` table, read from the co-located hub DB).
    // One row per federation validator. type in {status, pubkey}. id-keyed (no action chain).
    // Per-validator per-capability qualification flags (hub-owned `validator_capabilities`,
    // read from the co-located hub DB). type in {capability, pubkey}. id-keyed.
    async getValidatorCapabilities(config){
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

    // Governance parameter proposals (hub-owned `governance_proposals`, read from the
    // co-located hub DB). type in {status, parameter, proposal}. id-keyed.
    async getGovernanceProposals(config){
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

    // Per-validator governance votes (hub-owned `governance_votes`, read from the co-located
    // hub DB). type in {proposal, voter}. id-keyed.
    async getGovernanceVotes(config){
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

    // Full XCALL lifecycle by call_id: the source request (xcalls) + the target-chain
    // execution outcome (cross_chain_call_executions) + the source-chain callback
    // delivery (cross_chain_call_callbacks). The latter two are null until the call is
    // relayed/executed/delivered. Mirrors getContract's single-item return ([data]);
    // data is null when the call_id is unknown.
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
                    WHERE ` + sql.where.data + `
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

module.exports = Database