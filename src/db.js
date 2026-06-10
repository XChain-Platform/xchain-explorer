/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Explorer - Database Class
 * 
 * This file handles connecting to databases and running SQL queries
 *
 ********************************************************************/

// Load required libraries
const mariadb = require('mariadb');

class Database {

    // Handle constructing a class instance
    constructor(explorer){

        // Setup alias to explorer configuration
        this.configInfo = explorer.configInfo

        // Setup alias to utility class instance
        this.util   = explorer.util;

        //create the database with new config data
        this.configInfo.onConfigChanged(()=>{
            // Setup the connection pools
            this.setupConnectionPools();
        })

        // Placeholder for transaction connection
        this.transactionConnection = null;

        // LRU caches for frequently-queried immutable lookups
        this._addressIdCache  = new Map();
        this._tickIdCache     = new Map();
        this._actionDataCache = new Map();

        // Define list of action tables to pull action_indexes from
        this.actionTables = [
            'addresses',
            'airdrops',
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

    }

    async init(){
        // Setup the connection pools
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

    // Handle initializing the database connection pool
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

        // Placeholder for connection pools
        this.pools = {};
        // Per-coin decoder database name, used to read the decoder-tip reference
        // (the decoder's highest processed block) for /api/status lag reporting. Only
        // populated when the decoder DB sits on the same server/credentials as
        // the indexer DB, since the tip is read by reusing the indexer pool with
        // a database-qualified query rather than a separate connection.
        this.decoderDb = {};
        // Define list of acceptable networks
        let networks = ['mainnet', 'testnet', 'regtest'];
        // Loop through config and setup pools based on if user/pass/host are different
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
                        // Make the key equal the the config.COINS value (BTC, TBTC, RBTC, etc) for easy matching
                        let key  = coin;
                        if(net=='testnet') key = 'T' + coin;
                        if(net=='regtest') key = 'R' + coin;
                        if (("db_host" in cfg) && ("db_port" in cfg)){
                            // Database connection information
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
                            // the same host/port/user/pass but DIFFERENT databases — so when every
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
                            // Setup new pool of connections
                            if(!pool)
                                pool = mariadb.createPool(this.pools[key].config);

                            // Save the pool connection under the COIN-NETWORK key for easy reference
                            this.pools[key].pool = pool;

                            // Record the decoder DB name for this coin so /api/status can
                            // read the decoder tip (decoder's highest processed block) and report
                            // indexer lag. The tip is read by reusing this indexer pool with a
                            // database-qualified query, so only do this when the decoder DB is
                            // on the same server with the same credentials; otherwise leave it
                            // unset and decoder_tip/decoder_lag_blocks are simply omitted for this coin.
                            let dcfg = info[net].database.decoder;
                            if(dcfg && !this.util.isNull(dcfg.name)){
                                let dHost = ("db_host" in dcfg) ? dcfg.db_host : dcfg.host;
                                let dPort = ("db_port" in dcfg) ? dcfg.db_port : dcfg.port;
                                if(dHost==cfg.db_host && dPort==cfg.db_port && dcfg.user==cfg.user && dcfg.pass==cfg.pass)
                                    this.decoderDb[key] = dcfg.name;
                            }
                        }
                    }
                }
            }
        }
    }

    /******************************************************************
     * Common database connection functions (connect / release)
     *****************************************************************/

    // Handle getting a database Connection    
    async getConnection(config){
        if(this.transactionConnection)
            return this.transactionConnection;
        let connection = null,
            retryCount = 0,
            maxRetrys  = 3;
        // Try to get connection from the database connection pool using config.coin
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
                    // console.log("Connected to database!");
                } catch (e){
                    if(process.env.DEBUG) console.log('Database connection error:', e);
                    connection = null;
                    // Retry getting a connection again after a brief delay
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

    // Handle releasing a connection and freeing it up for additional queries
    async releaseConnection(){
        if(this.transactionConnection != null){
            // console.log("releasing database connection");
            await this.transactionConnection.release();
            this.transactionConnection = null;
        }  
    }

    /******************************************************************
     * General database functions
     *****************************************************************/

    // Handle returning database data given a explorer config object
    async getData(config){
        // Placeholder for data and total record count
        let data  = [];
        let total = null;
        // Get database query based on config object
        let [query, args, count] = await this.getQuery(config);
        // If query is an object, it is data, so just pass it forward the data and total
        if(typeof query === 'object'){
            data = query;
            if(this.util.isNumeric(count))
                total = count;
        } else {
            // Default args to the search string if specific search args object was not given (null)
            let baseArgs = (args && typeof args === 'object') ? args : [config.data.search];
            // Build query args by appending parameterized offset args (if any)
            let queryArgs = [...baseArgs];
            let offsetArgs = config.data.sql.where.offsetArgs;
            if(offsetArgs && offsetArgs.length)
                queryArgs.push(...offsetArgs);
            // Append SQL OFFSET for API pagination (page > 1)
            if(config.type == 'api' && config.data.sql.apiOffset > 0){
                query += ' OFFSET ?';
                queryArgs.push(config.data.sql.apiOffset);
            }
            // Run the database query to get the data
            if(query!='')
                data = await this.doQuery(config, query, queryArgs);
            // Count query uses only base args (no offset/limit placeholders)
            if(count){
                let rows = await this.doQuery(config, count, baseArgs);
                total = (rows) ? Number(rows[0].total) : 0;
            }
        }
        return [data, total];
    }

    // Handle getting a SQL query given a explorer config object
    async getQuery(config){
        let count = '';   // Placeholder for sql query for total count
        let query = '';   // Placeholder for sql query for data
        let args  = null; // Placeholder for sql arguments (if needed)
        let data  = config.data;
        let q     = (data.query) ? data.query : false;
        let max   = this.getMaxMethodResults(data.method);
        let limit = (q && q.limit && this.util.isInteger(Number(q.limit))) ? q.limit : max;
        limit = Math.max(1, Math.min(Number(limit), max));
        // Handle determining record sort order based on request method
        let default_order = (['getBalances'].includes(data.method)) ? 'ASC' : 'DESC';
        let order         = (q && q.sortorder && ['ASC','DESC'].includes(String(q.sortorder).toUpperCase())) ? String(q.sortorder).toUpperCase() : default_order;
        // Handle API queries
        if(config.type=='api'){
            // Use SQL OFFSET for pagination instead of fetching all preceding pages
            let page  = (q && q.page  && this.util.isInteger(Number(q.page)))  ? q.page  : 1;
            page = Math.max(1, Number(page));
            config.data.sql.apiOffset = (page - 1) * limit;
        }
        // Handle Explorer queries
        if(config.type=='explorer'){
            let offset = (q.offset) ? q.offset : false;
            let start  = (q.start) ? q.start : 0;
            let length = (q.length) ? q.length : 10;
            let action = (q.action) ? q.action : false;
            start  = Math.max(0, Number(start));
            length = Math.max(1, Math.min(Number(length), max));
            // Tweak the action in special cases to display data in correct order
            if(['getHolders','getBalances'].includes(data.method) && ['prev','last'].includes(action))
                config.data.query.action = config.data.offset.action = action = 'next';
            // Set limit to the length
            limit = length;
            // Limit results to 100 max (except in special cases where we can not use an offset)
            if(limit > max)
                limit = max;
            // Tweak the limit on the last page
            if(action=='last')
                limit = (config.data.query.total - config.data.query.start);
            // Tweak limit in certain cases where we can't select just the data we want using offsets
            if(['getBalances', 'getHolders','getSearch'].includes(data.method))
                limit = this.util.bcadd(start,length);
            // Set the order to ascending for previous and last requests
            if(['prev','last'].includes(action))
                order = 'ASC';
            // Get the SQL query offset data (speeds up sql queries)
            let [offset1, offset2] = await this.getQueryOffsets(config, offset, limit);
            config.data.offset.start = offset1;
            config.data.offset.stop  = offset2;
            let [offsetSql, offsetArgs] = await this.getQueryOffsetSql(config);
            config.data.sql.where.offset     = offsetSql;
            config.data.sql.where.offsetArgs = offsetArgs;
        }
        // Save the SQL query data in the config object
        config.data.sql.where.data = await this.getQueryWhereSql(config);
        config.data.sql.order = order
        config.data.sql.limit = limit;
        // Get the SQL query and list of arguments
        if(typeof this[data.method] === 'function')
            [query, args, count] = await this[data.method](config);
        return [query, args, count];
    }

    // Handle getting a database connection and running a query and returning the results
    async doQuery(config, query, args){
        let result = false;
        if(this.util.isNull(query)) return result;
        // Get connection from pool directly (local scope — no shared state)
        let pool = (this.pools[config.coin]) ? this.pools[config.coin].pool : null;
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
            else console.log('SQL query failed');
        } finally {
            db.release();
        }
        return result;
    }

    // Handle building out WHERE sql based on the config
    // Note: we do this in a single function to reduce duplicated code
    async getQueryWhereSql(config){
        // console.log('getQueryWhereSql config=',config);
        let sql    = `m.action_index IS NOT NULL`;
        let type   = config.data.type;
        let method = config.data.method;
        // Force SQL and type on certain methods which do not have the action_index field
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
        // slash_events has no action_index — its PK is m.id
        if(method=='getSlashEvents')
            sql = `m.id IS NOT NULL`;
        // price_snapshots is a materialized consensus-round table — no action_index, its PK is m.id
        if(method=='getPriceSnapshots')
            sql = `m.id IS NOT NULL`;
        // getHistory uses the mappings_actions table to pull data
        if(method=='getHistory'){
            if(type=='address')
                sql += ' AND m.type_id=2 AND m.id=?';
            if(type=='token')
                sql += ' AND m.type_id=1 AND m.id=?';
            if(type=='block')
                sql += ' AND b1.block_index=?';
        // getMarkets uses tickers to pull data
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
        // Handle token searches
        } else if(method=='getTokens' && ['token','subtoken'].includes(type)){
            sql += ' AND t3.tick LIKE ?';
        } else if(method=='getSlashEvents'){
            // slash_events has no actions/transactions chain — join directly via m.block_index
            // and resolve type=address through the staker's pubkey (signing_pubkey_id).
            if(type=='block')    sql += ' AND m.block_index=?';
            if(type=='contract') sql += ' AND m.target_contract_index=?';
            if(type=='address')  sql += ` AND m.signing_pubkey_id IN (
                SELECT DISTINCT signing_pubkey_id FROM contract_stakes
                WHERE source_id = (SELECT id FROM index_addresses WHERE address=?)
            )`;
        } else if(method=='getPriceSnapshots'){
            // price_snapshots is a standalone table — filter on its own columns directly
            if(type=='pair')   sql += ' AND m.coin_pair=?';
            if(type=='round')  sql += ' AND m.round_number=?';
            if(type=='status') sql += ' AND m.status=?';
        } else if(!['getBlocks'].includes(method)){
            // Handle queries for specific types of data types 
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
                if(['getContractStakes','getContractUnstakes','getSlashEvents'].includes(method))
                    sql += ' AND m.target_contract_index=?';
                else if(method=='getContract')
                    // The contracts table has no contract_index column — it is keyed by action_index.
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

    // Handle getting basic WHERE query which uses offset values to speed up queries
    // Note: table `m` is a universal reference to the main action table
    async getQueryOffsetSql(config){
        // console.log('getQueryOffsetSql config=',config)
        let method = config.data.method;
        let offset = (config.data.offset) ? config.data.offset : false;
        let action = (offset && !this.util.isNull(offset.action)) ? offset.action : false;
        let start  = (offset && !this.util.isNull(offset.start) && this.util.isNumeric(offset.start)) ? this.util.sanitizeInt(offset.start, false) : false;
        let stop   = (offset && !this.util.isNull(offset.stop) && this.util.isNumeric(offset.stop)) ? this.util.sanitizeInt(offset.stop, false) : false;
        if(start === false || stop === false) { /* sanitizeInt handles NaN/Infinity */ }
        let sql    = '';
        let args   = [];
        // Unset stop offset in case of getBlocks
        if(method=='getBlocks')
            stop = false;
        if(action && start !== false){
            // Set field name to use for offset (hardcoded whitelist — never from user input)
            let field = 'm.action_index';
            if(method=='getBlocks')
                field = 'b1.block_index';
            if(method=='getTokens')
                field = 'm.id';
            if(method=='getSlashEvents')
                field = 'm.id';
            // Build out the Offset SQL using parameterized values
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

    // Handle getting query offset values using the action table
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
        // Bail out in certain instances
        if(['getBalances','getHolders','getTransaction','getSearch','getMarkets','getMarket'].includes(method))
            return [];
        // Bail out if we are doing a token or subtoken search
        if(method=='getTokens' && ['token','subtoken'].includes(type))
            return [];
        // Lookup id for address and tickers
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
            // Build out where SQL using parameterized values
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
        // Translate method into table for use in SQL queries (validated against actionTables whitelist)
        table = String(method).toLowerCase().replace('get','');
        if(!this.actionTables.includes(table) && !['blocks','tokens','history','files','markets','market'].includes(table))
            return [];
        // Lookup start offset for first and last page requests
        if(['first','last'].includes(action)){
            // Get offset for first page requests
            if(action=='first')
                order = 'DESC';
            // Get offset for last page requests
            if(action=='last'){
                order = 'ASC';
                limit = this.util.bcadd(length,1);
            }
            // Build out SQL to get start offset
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
            // Run Query to try and get offset information
            rows = await this.doQuery(config, sql, whereArgs.length ? whereArgs : undefined);
            if(rows.length>0){
                for(let row of rows){
                    offset1 = Number(row.offset_index);
                    // Increase/Decrease offset by 1, so latest results are returned
                    if(action=='first')
                        offset1++;
                    if(action=='last')
                        offset--;
                }
            }
        }
        // Lookup stop offset
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
                // If we have offset value and action, use parameterized SQL to speed up query
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
                // Build out SQL to get stop offset
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
                // Run Query to try and get offset information
                rows = await this.doQuery(config, sql, stopWhereArgs.length ? stopWhereArgs : undefined);
                // Only set the stop offset number if we have more data to show
                if(rows.length>0 && rows.length == limit){
                    for(let row of rows)
                        offset2 = Number(row.offset_index);
                }
            }
        }
        return [offset1, offset2];
    }

    // Method to determine the maximum results to return for each method
    getMaxMethodResults(method){
        // Define array of methods and the max results for each method
        let methods = {
            getBalances: 500,
            getHolders:  500
        }
        // Use defined method max or default max of 100
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

    // Get list of ADDRESS actions
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

    // Get list of AIRDROP actions
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

    // Get list of BATCH actions
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

    // Get list of BROADCAST actions
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

    // Get list of CALLBACK actions
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

    // Get list of DESTROY actions
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

    // Get list of DISPENSER actions
    // TODO: Circle back and update this SQL to pull all fields once dispensers are implemented in indexer
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

    // Get list of DISPENSER_CANCEL actions
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

    // Get list of DISPENSER_CLOSE actions
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

    // Get list of DISPENSER_EDIT actions
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

    // Get list of DISPENSER_EXPIRE actions
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

    // Get list of DISPENSE actions
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

    // Get list of DIVIDEND actions
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

    // Get list of FEE actions
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

    // Get list of FILE actions
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

    // Get list of ISSUE actions
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

    // Get list of LINK actions
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

    // Get list of LIST actions
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

    // Get list of MESSAGE actions
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

    // Get list of MINT actions
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

    // Get list of ORDER actions
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

    // Get list of ORDER_CANCEL actions
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

    // Get list of ORDER_EDIT actions
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

    // Get list of ORDER_EXPIRE actions
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

    // Get list of ORDER_MATCH actions
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

    // Get list of COINPAY actions
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

    // Get list of COINPAY_EXPIRE actions
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

    // Get list of COINPay obligations
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

    // Get list of SEND actions
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

    // Get list of SLEEP actions
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

    // Get list of SWAP actions
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

    // Get list of SWAP_CANCEL actions
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

    // Get list of SWAP_EDIT actions
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

    // Get list of SWAP_EXPIRE actions
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

    // Get list of SWAP_MATCH actions
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

    // Get list of SWEEP actions
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

    // Get list of tokens
    async getTokens(config){
        let sql    = config.data.sql;
        let search = config.data.search; 
        let type   = config.data.type;
        let args   = [search];
        let order  = 'm.id ' + sql.order;
        // Handle token wildcard searches 
        if(['token','subtoken'].includes(type)){
            order = 't3.tick ' + sql.order;
            if(type=='token')
                args = ['%' + this.util.escapeLike(config.data.search) + '%'];
            if(type=='subtoken')
                args = [this.util.escapeLike(config.data.search) + '.%'];
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

    // Get list of markets
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

    // Get market information
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

    // Get market orders (open orders)
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
                for(let info of results){
                    let order   = await this.getOrderInfo(config, info.action_index);
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

    // Get market history (order matches)
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

    // Get market orderbook
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
            // Set the market name
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

    // Get information on a given action_index
    async getAction(config){
        let data = await this.getActionData(config, config.data.search);
        return [data];
    }

    // Get list of actions with optional query-param filters: tick, txid, blockIndex
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

    // Get address information for a given address (tokens held/owned, estimated value, XCHAIN balance, etc)
    // TODO: Update this API call to pull data from the utxo-tracker API
    async getAddress(config){
        let data = {
            address: config.data.search,
            type: "p2pkh",
            balances: {
                confirmed: "1.23456789",
                pending: "0.00001234",
                received: "1.23458023"
            },
            utxos: {
                confirmed: 5,
                pending: 1
            },
            estimated_value: {
                btc: "1.12345678"
            }
        };
        return [data];
    }

    // Get list of address balances
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

    // Get block information for a given block
    async getBlock(config){
        let data = null;
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let query = `SELECT
                        b1.block_index,
                        b1.block_time as timestamp,
                        t1.hash as ledger_hash,
                        t2.hash as actions_hash,
                        t3.hash as contract_hash
                    FROM
                        blocks b1
                        LEFT  JOIN index_transactions t1 ON (t1.id=b1.ledger_hash_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=b1.actions_hash_id)
                        LEFT  JOIN index_transactions t3 ON (t3.id=b1.contract_hash_id)
                    WHERE ` + sql.where.data + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            data = results[0];
        return [data];
    }

    // Get list of credits
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

    // Get list of debits
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

    // Get list of escrows
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

    // Get list of holders of a token
    async getHolders(config){
        let sql   = config.data.sql;
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

    // Get list of mempool transactions
    async getMempool(config){
        // TODO
    }

    // Get network information
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
        // testnet/regtest or when no oracle price is available — see getCoinPriceUsd()).
        let coinPriceUsd = await this.getCoinPriceUsd(config);

        let data = {
            // Per-action-type record counts (real; populated below).
            totals : {},
            // Network information — block/time are the real indexer tip for this coin.
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
            // 1.0 (coin priced in itself) — a coin/BTC cross is future work.
            coin: {
                name: coinName,
                symbol: coinTick,
                price: {
                    btc: '1.00000000',
                    usd: coinPriceUsd != null ? coinPriceUsd : '0.00'
                }
            },
            // XChain token info — price is a PLACEHOLDER pending XCHAIN issuance + a
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
            // final after N confirmations" value per chain — not a gate. Mirrors the
            // hub's per-chain cross-chain confirmation thresholds and honors the same
            // XCHAIN_CONFIRMATIONS_<COIN> overrides so display stays consistent.
            finality: {
                BTC:  parseInt(process.env.XCHAIN_CONFIRMATIONS_BTC,  10) || 6,
                LTC:  parseInt(process.env.XCHAIN_CONFIRMATIONS_LTC,  10) || 12,
                DOGE: parseInt(process.env.XCHAIN_CONFIRMATIONS_DOGE, 10) || 60
            }
        };
        // Build out a list of tables to get stats on
        let tables = structuredClone(this.actionTables);
        tables.push('tokens');
        // Loop through tables and get count
        for(let table of tables){
            // Get total number of matching records for this type of action and add to grand total
            let count = `SELECT
                        count(*) as count
                    FROM
                        ` + table;
            let results = await this.doQuery(config, count);
            if(results && results.length)
                data.totals[table] = results[0].count;
        }
        return [data];
    }

    // Get explorer status
    async getStatus(config){
        let coinConfigs = await this.configInfo.getConfig();
        // Age of the explorer's last successful hub-config fetch. The explorer caches hub
        // config (in memory + on disk) and serves it even when the hub is unreachable, so a
        // climbing age here is the only signal that the served hub-derived config is stale.
        // null until the first successful fetch. getHubConfigFetchedAt may be absent against
        // an older config module — guard so /status never throws on the lookup.
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
            // This is the indexer->decoder slice of the pipeline ONLY — it is NOT a
            // whole-pipeline health signal. The coin node's actual chain tip is not
            // visible here: the explorer reads only the indexer/decoder DBs and never
            // talks to a coin node, so a decoder that has fallen behind the chain node
            // (the chain->decoder gap) is NOT reflected in these fields. That gap is
            // exposed by the decoder's own health() JSON-RPC (chainTipBlock /
            // blockLag). Both fields are null for a coin when the decoder tip is
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
                // >= 0 — the indexer reads from the decoder so it can never lead the
                // decoder's tip.
                let decoderTip = await this.getDecoderTip({ coin, data: {} });
                data.decoder_tip[coin]        = decoderTip;
                data.decoder_lag_blocks[coin] = (decoderTip === null) ? null : Math.max(0, decoderTip - data.last_block[coin]);
            }
        }
        return [data];
    }

    // Get token information
    async getToken(config){
        let data  = null;
        let args  = [config.data.search];
        let query = `SELECT
                        t2.tick,
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
                        t1.coin_floor
                    FROM
                        tokens t1
                        LEFT  JOIN index_tickers      t2 ON (t2.id=t1.tick_id)
                        LEFT  JOIN index_addresses    a1 ON (a1.id=t1.owner_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=t1.callback_tick_id)
                        LEFT  JOIN tokens             t4 ON (t4.tick_id=t1.callback_tick_id)
                    WHERE 
                        t2.tick=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            // Define basic token data object format
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
        }
        return [data];
    }

    // Get transaction information
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
        // Lookup transaction information
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
        // Lookup actions associated with transaction
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

    // Get public key for an address from indexer database
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

    // Get raw transaction data from indexer database
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

    // Get information for a given action_index, this includes looking up any related data
    async getActionData(config, action_index){
        // Check LRU cache first (action data is immutable once confirmed on-chain)
        let cached = this._cacheGet(this._actionDataCache, action_index);
        if(cached !== undefined) return structuredClone(cached);
        let coinConfigs = await this.configInfo.getConfig()
        // Define the basic data object with standardized fields
        let data = {
            credits: null,
            debits:  null,
            escrows: null,
            fee:    null
        };
        let type = await this.getActionType(config, action_index);
        if(type){
            // Placeholders for queries and arguments
            let query   = null;
            let query2  = null;
            let query3  = null;
            let args    = [action_index];
            let results = null;
            // Flag to indicate if we should return credits/debits/escrow data
            let credits = true;
            let debits  = true;
            let escrows = true;
            // Set credits/debits/escrow flags to false in certain cases
            if(['ADDRESS','BROADCAST'].includes(type))
                credits = debits = escrows = false;
            // ADDRESS action
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
            // AIRDROP action
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
            // BATCH action
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
                // Get list of associated action_indexes
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
            // BROADCAST action
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
            // CALLBACK action
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
            // COINPAY action
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
            // COINPAY_EXPIRE action
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
            // DESTROY action
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
            // DISPENSER_CLOSE action
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
            // DISPENSER_CANCEL action
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
            // DISPENSER_EDIT action
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
            // DISPENSER_EXPIRE action
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
            // DISPENSE action
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

            // DIVIDEND action
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
            // FILE action
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
            // ISSUE action
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
            // LINK action
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
            // LIST action
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
            // MESSAGE action
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
            // MINT action
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
            // ORDER action
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
            // ORDER_CANCEL action
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
            // ORDER_EDIT action
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
            // ORDER_EXPIRE action
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
            // ORDER_MATCH action
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
            // SEND action
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
            // SLEEP action
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
            // SWAP action
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
            // SWAP_CANCEL action
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
            // SWAP_EDIT action
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
            // SWAP_EXPIRE action
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
            // SWAP_MATCH action
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
            // ATTEST action (v0 request / v1 response — both rows live in `attests`,
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
                            m.request_status,
                            m.response_hash,
                            m.response_status,
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
            // DELEGATE action (v0/v2 capability → delegations; v1/v3 contract-targeted → contract_delegations)
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
                            COALESCE(ds.status, cds.status) as status
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
                        WHERE
                            a1.action_index=?
                        LIMIT 1`;
            }
            // COLLECT action (validator reward claim → reward_claims)
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
            // DEPLOY action (contract deployment; v1 surfaces cooldown_blocks + slash_destination)
            if(type=='DEPLOY'){
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
            // Run the SQL query to get the information on the action_index
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
                // Set the state a bit differently for dispensers
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
                    catch(_) { data['signatures'] = []; }
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
                    catch(_) { data['pairs'] = []; }
                }
                if(data['sigs_json']){
                    try { data['signatures'] = JSON.parse(data['sigs_json']); }
                    catch(_) { data['signatures'] = []; }
                }
                delete data['pairs_json'];
                delete data['sigs_json'];
            }
            // If we have a secondary query defined, run it and apply the data to the correct place in the data object
            if(query2){
                // Set correct arguments for the query
                let args2 = [action_index];
                if(type=='BATCH')
                    args2.push(data.tx_index);
                results = await this.doQuery(config, query2, args2);
                if(results && results.length){
                    // Loop through action_indexes and add to actions array
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
                            // Handle setting the current expiration and allow/block list based on any edits
                            if(!this.util.isNull(row.expiration))  data.state.expiration  = row.expiration;
                            if(active){
                                if(!this.util.isNull(row.allow_list))  data.state.allow_list  = row.allow_list;
                                if(!this.util.isNull(row.block_list))  data.state.block_list  = row.block_list;
                            }
                        }
                    }
                }
            }
            // If we have a third query defined, run it and apply the data to the correct place in the data object
            if(query3){
                // Set correct arguments for the query
                let args3 = [action_index];
                if(type=='ORDER')
                    args3.push(action_index);
                results = await this.doQuery(config, query3, args3);
                if(results && results.length){
                    // Handle populating the list edits based off the list TYPE field
                    if(type=='LIST'){
                        let edits = [];
                        for(let row of results){
                            if(data.type==1) edits.push({ tick: row.tick, status: row.status });
                            if(data.type==2) edits.push({ address: row.address, status: row.status });
                        }
                        data.edits = edits.sort();
                    }
                    // Determine get/give remaining and order status
                    if(type=='ORDER'){
                        let give_remaining = data['give_amount'],
                            get_remaining  = data['get_amount'];
                        // Loop through each order match and deduct amount from remaining
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
            // Handle looking up any CREDITS associated with this action
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
            // Handle looking up any DEBITS associated with this action
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
            // Handle looking up any ESCROWS associated with this action
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
            // Include any fee associated with this action_index
            let fee = await this.getActionFeeData(config, action_index);
            if(fee)
                data.fee = fee;
            // Include raw transaction data
            let txData = await this.getTransactionData(config, data.tx_hash);
            data.tx_data = (!this.util.isNull(txData)) ? txData.data : null;
            // Include any related action_indexes
            // data.related = await this.getRelatedActions(config, action_index);;
        }
        // Store in LRU cache for future lookups
        this._cacheSet(this._actionDataCache, action_index, structuredClone(data));
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

    // Get address id for a given address (cached)
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

    // Get tick id for a given token (cached)
    async getTickId(config, tick){
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
    // Get action type for a given action_index
    async getActionType(config, action_index){
        let type = null;
        // Lookup the ACTION based on the action_index
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
        // Lookup the related actions based on the action_index
        // let args = [action_index];
        // let sql  = `SELECT 
        //                 a2.action
        //             FROM
        //                 actions a1
        //                 LEFT  JOIN index_actions a2 ON (a2.id=a1.action_id)
        //             WHERE
        //                 a1.action_index=?`;
        // let results = await this.doQuery(config, sql, args);
        // if(results && results.length)
        //     type = results[0].action;
        return actions;
    }

    // Get history information for a given address
    // NOTE: Supports following search types ('block', 'address', 'token', 'recent')
    async getHistoryData(config){
        // console.log('getHistoryData config=');
        // console.dir(config, {
        //     colors: true,
        //     depth: 3
        // });
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
        // Get any IDs based on the query type
        if(type=='address')
            id = await this.getAddressId(config, config.data.search);
        if(type=='token')
            id = await this.getTickId(config, config.data.search);
        // Quickly set total to highest action_index if we are doing full history search (speeds up search by reducing number of queries)
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
        // Build out the correct WHERE sql arguments based on search type
        args = (type=='block') ? [config.data.search] : [id];
        // If we have a total passed on the querystring, then skip getting total count (speed up explorer queries)            
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
        // If we have offset value and action, use parameterized SQL to speed up query
        if(action && start){
            if(action=='prev'){
                where += ' AND m.action_index > ?';
                args.push(start);
            } else {
                where += ' AND m.action_index < ?';
                args.push(start);
            }
        }
        // If we have any records, then run the SQL query to pull the data
        if(total){
            // Get basic action data
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

    // Get action summary information for a given action_index
    async getActionSummaryData(config, actions){
        // Define a list of detail fields we want to pass forward in history items
        // Note: We limit this to just enough details to show basic history info, user can request full info on action if they want more info
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
        // Lookup extended information on the action_index
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
                // Handle sends by extracting the first send data
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
                    // Populate details object with fields we care about
                    details[name] = detail;
                }

            }
            data.details = details;
        }
        return actions;
    }        

    // Get list of blocks and a count of each transaction type for the given block_index
    async getBlocks(config){
        let sql     = config.data.sql;
        let offset  = config.data.offset;
        let data    = [];
        let total   = 0;
        let query   = '';
        let results = null;
        // Get count of total number of blocks
        query = `SELECT
                    count(*) as total
                FROM
                    blocks b1
                WHERE ` + sql.where.data;
        results = await this.doQuery(config, query);
        if(results && results.length)
            total = results[0].total;
        // Loop through the specified blocks
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
            // Collect all block_indexes and build a lookup map
            let blockIndexes = results.map(r => r.block_index);
            let blockMap = {};
            for(let row of results){
                blockMap[row.block_index] = {
                    block_index: row.block_index,
                    timestamp: row.block_time,
                    actions: {}
                };
            }
            // Build ONE batched UNION ALL query for all blocks at once
            let query2 = '';
            let blockArgs = [];
            let placeholders = blockIndexes.map(() => '?').join(',');
            for(let table of this.actionTables){
                if(query2 != '')
                    query2 += ' UNION ALL ';
                query2 += `SELECT
                            '` + table + `' as action,
                            b1.block_index,
                            count(*) as count
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
            // Preserve original result order
            data = results.map(r => blockMap[r.block_index]);
        }
        return [data, null, total];
    }

    // Get list of search results for a given
    async getSearch(config){
        // Define list of search types
        let searchTypes = ['address', 'broadcast', 'token', 'transaction'];
        let dataType    = config.data.type;
        let search      = '%' + this.util.escapeLike(config.data.search) + '%';
        let total       = 0;
        let sql  = config.data.sql;
        let data = {
            data: [],
            totals: {
                addresses:    0,
                broadcasts:   0,
                tokens:       0,
                transactions: 0
            },
        };
        // Build all COUNT queries and run them in parallel
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
        // If we detected some search results dump the actual data
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
                        LIMIT ` + sql.limit;
            if(dataType=='transaction')
                query = `SELECT 
                            t2.hash 
                        FROM
                            transactions t1 
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE 
                            LOWER(t2.hash) LIKE LOWER( ? )
                        ORDER BY t2.hash ASC
                        LIMIT ` + sql.limit;
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
                        LIMIT ` + sql.limit;
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
                        LIMIT ` + sql.limit;
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
        // Define empty edit object
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

    // Handle getting total amounts remaining for a given order
    async getOrderAmountsRemaining(config, action_index){
        // Placeholders for amount escrowed and amount matched
        let give_coin_id   = 0,
            give_tick_id   = 0,
            give_remaining = 0,
            get_coin_id    = 0,
            get_tick_id    = 0,
            get_remaining  = 0;
        // Get initial amounts from the orders table
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
        // Lookup amounts matched in order_matches
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
            // Loop through each order match and deduct amount from remaining
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

    // Batch fetch order info for multiple action_indexes at once
    async getOrderInfoBatch(config, action_indexes){
        if(!action_indexes || action_indexes.length === 0) return {};
        let orderMap = {};
        let placeholders = action_indexes.map(() => '?').join(',');

        // 1. Main order query (batch)
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

        // 2. Batch order edits
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

        // 3. Batch order amounts (initial amounts)
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

        // 4. Batch order matches (deductions)
        // Build WHERE for all action_indexes: any match where give or get side is one of our orders
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
                // Apply deductions to each relevant order
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

        // 5. Combine: prices + remaining amounts
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

    // Get the highest block_index in the blocks table
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
    // NOTE: this is NOT the coin node's chain tip — the explorer never talks to a
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
            let results = await this.doQuery(config, query, []);
            if (results && results.length && results[0].max_index !== null)
                return Number(results[0].max_index);
        } catch(e){
            // Decoder DB unreachable, missing, or no cross-DB grant — omit the tip.
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
        // can't be bound — restrict to a safe identifier charset before use.
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return 0;
        try {
            let query   = 'SELECT COUNT(*) as count FROM `' + dbName + '`.mempool_transactions';
            let results = await this.doQuery(config, query, []);
            if (results && results.length && results[0].count !== null)
                return Number(results[0].count);
        } catch(e){
            // Decoder DB unreachable, missing table, or no cross-DB grant — report 0.
            console.warn('getDecoderMempoolCount: mempool count unavailable for ' + config.coin + ': ' + (e && e.message ? e.message : e));
        }
        return 0;
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
        // (mainnet) — 'BTC' === 'BTC'. Testnet/regtest codes ('TBTC','RDOGE') differ.
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

    // Get the highest action_index in the actions table
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

    // Get new blocks since a given block_index
    async getBlocksSince(config, sinceBlockIndex, limit) {
        let query = `SELECT
                        b1.block_index,
                        b1.block_time,
                        t1.hash as block_hash,
                        t3.hash as contract_hash,
                        (SELECT COUNT(*) FROM transactions t WHERE t.block_index=b1.block_index) as tx_count,
                        (SELECT COUNT(*) FROM actions a
                            INNER JOIN transactions t ON t.tx_index=a.tx_index
                            WHERE t.block_index=b1.block_index) as action_count
                    FROM
                        blocks b1
                        LEFT JOIN index_transactions t1 ON (t1.id=b1.ledger_hash_id)
                        LEFT JOIN index_transactions t3 ON (t3.id=b1.contract_hash_id)
                    WHERE
                        b1.block_index > ?
                    ORDER BY b1.block_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlockIndex, limit]);
        return results || [];
    }

    // Get new actions since a given action_index
    async getActionsSince(config, sinceActionIndex, limit) {
        // NOTE: the generic `actions` table carries no status_id (status lives on
        // the per-ACTION-type tables, e.g. issues/sends/mints, joined as m.status_id
        // elsewhere) and no status column — so this feed reports status as NULL.
        // The earlier `s1.id=a1.status_id` join referenced a non-existent column and
        // made the whole query throw (ER_BAD_FIELD_ERROR), which silently killed the
        // WebSocket NEW_ACTION stream: the ChangeDetector advanced its action pointer
        // but getActionsSince returned [] every poll, so no NEW_ACTION ever fired.
        // Source is taken from actions.source_id (a1) — the action's true source,
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

    // Get address balances for WebSocket snapshot
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

    // Get token info for WebSocket snapshot
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

    // Get market info for WebSocket snapshot
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

    // Get dispenser info for WebSocket snapshot
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

    // Get COINPay obligation details for a given order_match action_index
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

    // Get the settlement_type for an order_match
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

    // Get list of CONTRACT actions
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

    // Get single CONTRACT by action_index
    async getContract(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
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
                        m.code,
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
        return [query, args, count];
    }

    // Get latest contract state keys for a contract
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

    // Get contract balances for a contract
    async getContractBalance(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_balances m
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.contract_index,
                        t3.tick,
                        m.amount
                    FROM
                        contract_balances m
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY t3.tick ASC
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Get list of CONTRACT EXECUTION actions
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

    // Get single CONTRACT EXECUTION by action_index
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

    // Get list of DEPOSIT actions
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

    // Get list of WITHDRAWAL actions
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

    // Get list of STAKE actions
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

    // Get list of active validators (stakes with status='valid')
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

    // Get list of PRICE actions (v0 validator COIN/FIAT snapshots + v1 user TOKEN/FIAT oracle)
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

    // Get list of PRICE round snapshots (materialized COIN/FIAT consensus rounds — keyed by id, no action_index)
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

    // Get list of DELEGATION actions
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

    // Get list of VALIDATOR REWARD records
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

    // Get list of CONTRACT STAKE actions (STAKE v3 — type ∈ {address, block, contract})
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

    // Get list of CONTRACT UNSTAKE actions (UNSTAKE v1 — type ∈ {address, block, contract})
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

    // Get list of SLASH events (xchain.contract.slash emissions — type ∈ {address, block, contract})
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

    // Get list of ATTEST actions from the consolidated `attests` table. Lists both
    // v0 (request) and v1 (response) rows; `version` + request/response status let
    // the UI tell them apart. type ∈ {address, block, contract}.
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
                        m.request_status,
                        m.response_status,
                        m.payload,
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
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Get new ATTEST rows since a given block_index — feeds the WebSocket
    // attestation channel (ChangeDetector). Returns request + response rows.
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

    // Look up a single ATTEST row by action_index — used by the WebSocket
    // ChangeDetector to enrich a new ATTEST action with its version + status
    // before broadcasting on the attestation channel.
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