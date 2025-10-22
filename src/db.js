/* XChain Explorer Database Connector */

const mariadb = require('mariadb');

class Database {

    // Handle constructing a class instance
    constructor(explorer){

        // Setup alias to explorer configuration
        this.config = explorer.config

        // Setup alias to utility class instance
        this.util   = explorer.util;

        // Setup the connection pools
        this.setupConnectionPools();

        // Placeholder for transaction connection
        this.transactionConnection = null;

        // Define list of action tables to pull action_indexes from
        this.actionTables = [
            'addresses',
            'airdrops',
            'batches',
            'broadcasts',
            'callbacks',
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
            'sends',
            'sleeps',
            'swaps',
            'swap_cancels',
            'swap_edits',
            'swap_matches',
            'sweeps'
        ];

    }

    /******************************************************************
     * Database Connection Pool Functions
     *****************************************************************/

    // Handle initializing the database connection pool
    setupConnectionPools(){
        // Placeholder for connection pools
        this.pools = {};
        // Define list of acceptable networks
        let networks = ['mainnet', 'testnet', 'regtest'];
        // Loop through config and setup pools based on if user/pass/host are different
        for(let coin in this.config){
            let info = this.config[coin];
            if(info.mainnet || info.testnet || info.regtest){
                for(let net in info){
                    if(networks.includes(net) && !this.util.isNull(info[net].database) && !this.util.isNull(info[net].database.indexer)){
                        let pool = false;
                        let cfg  = info[net].database.indexer;
                        // Make the key equal the the config.COINS value (BTC, TBTC, RBTC, etc) for easy matching
                        let key  = coin;
                        if(net=='testnet') key = 'T' + coin;
                        if(net=='regtest') key = 'R' + coin;
                        // Database connection information
                        this.pools[key] = {
                            config: {
                                host:     cfg.host,
                                port:     cfg.port,
                                user:     cfg.user,
                                password: cfg.pass,
                                database: cfg.name,
                                // Connection options
                                connectionLimit:  5,
                                //connectTimeout: 0,
                                insertIdAsNumber: true
                            }
                        };
                        // Loop through all existing pools and if all connection details match except for the database name, share the pool
                        for(let key in this.pools){
                            let data = this.pools[key];
                            if( cfg.host==data.config.host &&
                                cfg.port==data.config.port && 
                                cfg.user==data.config.user && 
                                cfg.pass==data.config.password &&
                                !this.util.isNull(data.pool) )
                                pool = data.pool;
                        }
                        // Setup new pool of connections
                        if(!pool)
                            pool = mariadb.createPool(this.pools[key].config);

                        // Save the pool connection under the COIN-NETWORK key for easy reference
                        this.pools[key].pool = pool;
                    }
                }
            }
        }
        // console.log('pools=',this.pools);
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
        if(pool){
            while(connection == null){        
                try {
                    connection = await pool.getConnection();
                    // console.log("Connected to database!");
                } catch (e){
                    // console.log('e=',e);
                    connection = null;
                    // Retry getting a connection again after a brief delay
                    if(retryCount <= maxRetrys){
                        retryCount++;
                        console.log("Can't connect to database. Trying again (attempt " + retryCount + ")...");
                        await this.util.sleep(1000);
                    } else {
                        console.log('Failed to get database connection error=',e)
                        break;
                    }
                }
            }
        } else {
            console.log("Unable to get database connection pool for :", config.coin);
        }
        this.transactionConnection = connection;
        return connection;
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
            if(!args || typeof args !== 'object')
                args = [config.data.search];
            // Run the database query to get the data
            if(query!='')
                data = await this.doQuery(config, query, args);
            // If we have a count query, run it to get total count of records
            if(count){
                let rows = await this.doQuery(config, count, args);
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
        // Handle determining record sort order based on request method
        let default_order = (['getBalances'].includes(data.method)) ? 'ASC' : 'DESC';
        let order         = (q && q.sortorder && ['ASC','DESC'].includes(String(q.sortorder).toUpperCase())) ? String(q.sortorder).toUpperCase() : default_order;
        // Handle API queries
        if(config.type=='api'){
            // Set SQL query limit to page * limit
            let page  = (q && q.page  && this.util.isInteger(Number(q.page)))  ? q.page  : 1;
            limit = limit * page;
        }
        // Handle Explorer queries
        if(config.type=='explorer'){
            let offset = (q.offset) ? q.offset : false;
            let start  = (q.start) ? q.start : 0;
            let length = (q.length) ? q.length : 10;
            let action = (q.action) ? q.action : false;
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
            config.data.sql.where.offset = await this.getQueryOffsetSql(config);
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
        if(!this.util.isNull(query)){
            // Get a database connection from the connection pool
            let db    = await this.getConnection(config);
            if(db){
                // Run the database query
                try {
                    result = await db.query(query, args);
                } catch (error){
                    console.log('SQL Query Error: ', error);
                    // this.util.logError('Error running query:', error);
                }
            } else {
                console.log('Unable to get database connection to run SQL query');
            }
            await this.releaseConnection();
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
            sql  = `m.address_id IS NOT NULL`;
        if(['getBlocks','getBlock'].includes(method))
            sql  = `b1.block_index IS NOT NULL`;
        if(method=='getTransaction')
            sql  = `m.tx_index IS NOT NULL`;
        // getHistory uses the mappings_actions table to pull data
        if(method=='getHistory'){
            if(type=='address')
                sql += ' AND m.type_id=2 AND m.id=?';
            if(type=='token')
                sql += ' AND m.type_id=1 AND m.id=?';
            if(type=='block')
                sql += ' AND b1.block_index=?';
        } else if(!['getBlocks'].includes(method)){
            // Handle queries for specific types of data types 
            if(type=='address'){
                if(['getMessages','getMints','getOrders','getSends','getSweeps','getDispensers','getDispenses'].includes(method)){
                    sql += ' AND (a2.address=? OR a3.address=?)';
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
        let start  = (offset && !this.util.isNull(offset.start) && this.util.isNumeric(offset.start)) ? offset.start : false;
        let stop   = (offset && !this.util.isNull(offset.stop) && this.util.isNumeric(offset.stop)) ? offset.stop : false;
        let sql    = '';
        // Unset stop offset in case of getBlocks
        if(method=='getBlocks')
            stop = false;
        if(action && start){
            // Set field name to use for offset
            let field = 'm.action_index';
            if(method=='getBlocks')
                field = 'b1.block_index';
            if(method=='getTokens')
                field = 'm.id';
            // Build out the Offset SQL using the correct field name and start/stop values
            if(action=='prev'){
                sql = ` AND ` + field + ` > ` + start;
                if(stop)
                    sql += ` AND ` + field + ` < ` + stop;
            } else if(action=='last'){
                sql = ` AND ` + field + ` <= ` + start;
            } else {
                sql = ` AND ` + field + ` < ` + start;
                if(stop)
                    sql += ` AND ` + field + ` > ` + stop;
            }
        }
        return sql;
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
        let where  = '';
        let limit  = 1;
        let order  = 'DESC';
        // Bail out in certain instances
        if(['getBalances','getHolders','getTransaction','getSearch'].includes(method))
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
            // Build out where SQL 
            if(type=='address'){
                if(['getMessages','getMints','getSends','getSweeps'].includes(method)){
                    where = ` AND (t1.source_id=` + id + ` OR m.destination_id=` + id + `)`;
                } else if(['getTokens'].includes(method)){
                    where = ` AND m.owner_id=` + id;
                } else if(['getCredits','getDebits','getEscrows'].includes(method)){
                    where = ` AND m.address_id=` + id;
                } else if(['getHistory'].includes(method)){
                    where = ` AND m.type_id=2 AND m.id=` + id;
                } else {
                    where = ` AND t1.source_id=` + id;
                }
            } else if(type=='block' && !this.util.isNull(config.data.search)){
                where = ` AND b1.block_index=` + config.data.search;
            } else if(type=='token'){
                if(['getOrders','getSwaps'].includes(method)){
                    where = ` AND (m.get_tick_id=` + id + ` OR m.give_tick_id=` + id + `)`;
                } else if(['getDispensers','getDispenses'].includes(method)){
                    where = ` AND m.get_tick_id=` + id;
                } else if(['getHistory','getFiles'].includes(method)){
                    where = ` AND m.type_id=1 AND m.id=` + id;
                } else {
                    where = ` AND m.tick_id=` + id;
                }
            } 
        }
        // Translate method into table for use in SQL queries
        table = String(method).toLowerCase().replace('get','');
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
                            b1.block_index as offset
                        FROM
                            blocks b1
                        WHERE 
                            b1.block_index IS NOT NULL
                            ` + where + `
                        ORDER BY b1.block_index ` + order + ` 
                        LIMIT ` + limit;
            } else if(method=='getTokens'){
                sql = `SELECT 
                            m.id as offset
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
                            m.action_index as offset
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
                            m.action_index as offset
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
                            m.action_index as offset
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
            rows = await this.doQuery(config, sql);
            if(rows.length>0){
                for(let row of rows){
                    offset1 = Number(row.offset);
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
                // If we have offset value and action, use it to speed up SQL query by pulling less data
                if(action && offset1){
                    if(action=='prev'){
                        where += ' AND m.action_index > ' + offset1;
                    } else {
                        where += ' AND m.action_index < ' + offset1;
                    }
                }
                // Build out SQL to get stop offset
                if(method=='getHistory'){
                    sql = `SELECT 
                            m.action_index as offset
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
                            m.action_index as offset
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
                            m.action_index as offset
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
                rows = await this.doQuery(config, sql);
                // Only set the stop offset number if we have more data to show
                if(rows.length>0 && rows.length == limit){
                    for(let row of rows)
                        offset2 = Number(row.offset);
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
     * Endpoints                                  Method Name      Types
     * -----------------------------------------------------------------
     * /{COIN}/api/addresses/{QUERY}/{TYPE}       getAddresses     block, address
     * /{COIN}/api/airdrops/{QUERY}/{TYPE}        getAirdrops      block, address, token
     * /{COIN}/api/batches/{QUERY}/{TYPE}         getBatches       block, address
     * /{COIN}/api/broadcasts/{QUERY}/{TYPE}      getBroadcasts    block, address
     * /{COIN}/api/callbacks/{QUERY}/{TYPE}       getCallbacks     block, address, token
     * /{COIN}/api/destroys/{QUERY}/{TYPE}        getDestroys      block, address, token
     * /{COIN}/api/dispensers/{QUERY}/{TYPE}      getDispensers    block, address, token, source, destination
     * /{COIN}/api/dispenses/{QUERY}/{TYPE}       getDispenses     block, address, token, source, destination
     * /{COIN}/api/fees/{QUERY}/{TYPE}            getFees          block, address, token, source, destination
     * /{COIN}/api/files/{QUERY}/{TYPE}           getFiles         block, address, token
     * /{COIN}/api/issues/{QUERY}/{TYPE}          getIssues        block, address, token
     * /{COIN}/api/links/{QUERY}/{TYPE}           getLinks         block, address
     * /{COIN}/api/lists/{QUERY}/{TYPE}           getLists         block, address
     * /{COIN}/api/messages/{QUERY}/{TYPE}        getMessages      block, address, token, source, destination
     * /{COIN}/api/mints/{QUERY}/{TYPE}           getMints         block, address, token, source, destination
     * /{COIN}/api/orders/{QUERY}/{TYPE}          getOrders        block, address, token
     * /{COIN}/api/order_cancels/{QUERY}/{TYPE}   getOrderCancels  block, address
     * /{COIN}/api/order_edits/{QUERY}/{TYPE}     getOrderEdits    block, address
     * /{COIN}/api/order_matches/{QUERY}/{TYPE}   getOrderMatches  block 
     * /{COIN}/api/sends/{QUERY}/{TYPE}           getSends         block, address, token, source, destination
     * /{COIN}/api/sleeps/{QUERY}/{TYPE}          getSleeps        block, address, token
     * /{COIN}/api/swaps/{QUERY}/{TYPE}           getSwaps         block, address, token
     * /{COIN}/api/swap_cancels/{QUERY}/{TYPE}    getSwapCancels   block, address
     * /{COIN}/api/swap_edits/{QUERY}/{TYPE}      getSwapEdits     block, address
     * /{COIN}/api/swap_matches/{QUERY}/{TYPE}    getSwapMatches   block 
     * /{COIN}/api/sweeps/{QUERY}/{TYPE}          getSweeps        block, address
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a3.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        m.fee_preference,
                        m.require_memo,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=m.callback_tick_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=m.callback_tick_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
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
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        m.get_amount,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Get list of DISPENSE actions
    // TODO: Circle back and update this SQL to pull all fields once dispenses are implemented in indexer
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
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
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
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=m.dividend_tick_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=m.dividend_tick_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id) 
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
                        t1.tx_index
                    FROM
                        fees m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id) 
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
                            INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                            INNER JOIN index_tickers      t4 on (t4.id=m.id)
                            INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                            s1.status
                        FROM
                            mappings_files m
                            INNER JOIN files              f1 ON (f1.action_index=m.action_index)
                            INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                            INNER JOIN index_tickers      t4 on (t4.id=m.id)
                            INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                            INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_mime_types   t3 ON (t3.id=m.type_id)
                            INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                            s1.status
                        FROM
                            files m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_mime_types   t3 ON (t3.id=m.type_id)
                            INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.transfer_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=m.transfer_supply_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.callback_tick_id)
                        INNER JOIN index_actions      a5 ON (a5.id=a1.action_id)
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
                        s1.status
                    FROM
                        issues m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=m.transfer_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=m.transfer_supply_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=m.callback_tick_id)
                        INNER JOIN index_actions      a5 ON (a5.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.coin1_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.coin2_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.coin1_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.coin2_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
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
                        s1.status
                    FROM
                        messages m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        INNER JOIN index_memos        m2 ON (m2.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        c1.coin as give_coin,
                        t3.tick as give_tick,
                        m.give_amount,
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        m.get_amount,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
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
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT JOIN index_tickers       t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT JOIN index_tickers       t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        c1.coin as give_coin,
                        t3.tick as give_tick,
                        m.give_amount,
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        m.get_amount,
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
                        swaps m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.get_address_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.give_tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=m.get_tick_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
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
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
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
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m.get_coin_id)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
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
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format, 
                        a2.address as source,
                        a3.address as destination,
                        m.balances,
                        m.ownerships,
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
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=t1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m.destination_id)
                        INNER JOIN index_memos        m1 ON (m1.id=m.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    } 

    // Get list of tokens
    async getTokens(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let count = `SELECT
                        count(*) as total
                    FROM
                        tokens m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=m.owner_id)
                        INNER JOIN index_tickers      t2 ON (t2.id=m.tick_id)
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
                        INNER JOIN index_addresses    a2 ON (a2.id=m.owner_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
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
                        INNER JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                        INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
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
                        INNER JOIN index_tickers   t1 ON (t1.id=m.tick_id)
                        INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
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
                        t1.hash as credits_hash,
                        t2.hash as debits_hash,
                        t3.hash as actions_hash
                    FROM
                        blocks b1
                        INNER JOIN index_transactions t1 ON (t1.id=b1.credits_hash_id)
                        INNER JOIN index_transactions t2 ON (t2.id=b1.debits_hash_id)
                        INNER JOIN index_transactions t3 ON (t3.id=b1.actions_hash_id)
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
                        INNER JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
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
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
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
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
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
                        INNER JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
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
                        INNER JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
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
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_tickers      t2 ON (t2.id=m.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=m.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
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
                        INNER JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
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
                        INNER JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                        INNER JOIN index_addresses a2 ON (a2.id=m.address_id)
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
    // TODO: Update to pull this data from xchain-hub which is updated periodically instead of 
    async getNetwork(config){
        let data = {
            // Placeholder for action counts totals[action] = count;
            totals : {},
            // Placeholder for network information
            network: {
                block : 123456,
                unconfirmed: 5,
            },
            // Network fee information
            fee: {
                low: 1,
                medium: 2,
                high: 3
            },
            // Coin information (price, etc)
            coin: {
                name: 'Bitcoin',
                symbol: 'BTC',
                price: {
                    btc: '1.00000000',
                    usd: '115400.00'
                }
            },
            // XChain information (price, etc)
            xchain: {
                name: 'XChain',
                symbol: 'XCHAIN',
                price: {
                    btc: '0.00010000',
                    usd: '11.54'
                }
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
        let data  = {
            supported: this.config['COIN_SUPPORTED'],
            available: this.config['COIN_AVAILABLE']
        };
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
                        INNER JOIN index_tickers      t2 ON (t2.id=t1.tick_id)
                        INNER JOIN index_addresses    a1 ON (a1.id=t1.owner_id)
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
                        INNER JOIN index_transactions t1 ON (t1.id=m.tx_hash_id)
                        INNER JOIN index_addresses    a1 ON (a1.id=m.source_id)
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
                            INNER JOIN index_actions a1 ON (a1.id=m.action_id)
                        WHERE 
                            m.tx_index=?`;
            results = await this.doQuery(config, query, args);
            if(results && results.length){
                for(let row of results){
                    data.actions.push(row);
                }
            }
        }
        // Get summary data for actions
        data.actions = await this.getActionSummaryData(config, data.actions);
        return [data]
    }


    /******************************************************************
     * Commonly used functions 
     *****************************************************************/

    // Get information for a given action_index, this includes looking up any related data
    async getActionData(config, action_index){
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
                            INNER JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
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
                            INNER JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=a1.tick_id)
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
                            INNER JOIN index_actions      a3 ON (a3.id=a2.action_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=t1.source_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
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
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=b1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
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
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=c1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=c1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=c1.tick_id)
                            INNER JOIN index_tickers      t4 ON (t4.id=c1.callback_tick_id)
                        WHERE 
                            c1.action_index=?
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
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=d1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=d1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=d1.tick_id)
                        WHERE 
                            d1.action_index=?
                        LIMIT 1`;
            }
            // DISPENSER action
            if(type=='DISPENSER'){
                // TODO
            }
            // DISPENSE action
            if(type=='DISPENSE'){
                // TODO
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
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
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
                            s1.status
                        FROM
                            issues i1
                            INNER JOIN actions            a1 ON (a1.action_index=i1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            LEFT  JOIN index_addresses    a4 ON (a4.id=i1.transfer_id)
                            LEFT  JOIN index_addresses    a5 ON (a5.id=i1.transfer_supply_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=i1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=i1.tick_id)
                            LEFT  JOIN index_tickers      t4 ON (t4.id=i1.callback_tick_id)
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
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_memos        m1 ON (m1.id=l1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=l1.coin1_id)
                            INNER JOIN index_coins        c2 ON (c2.id=l1.coin2_id)
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
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
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
                            INNER JOIN index_statuses  s1 ON (s1.id=l1.status_id)
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
                            s1.status
                        FROM
                            messages m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
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
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                            INNER JOIN index_memos        m2 ON (m2.id=m1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=m1.tick_id)
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
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            o1.get_amount,
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
                            s1.status
                        FROM
                            orders o1
                            INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=o1.get_address_id)
                            INNER JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                            INNER JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                        WHERE 
                            o1.action_index=?
                        LIMIT 1`;
            }
            // ORDER_CANCEL action
            if(type=='ORDER_CANCEL'){
                query = `SELECT
                        a2.action,
                        a1.action_format,
                        o1.action_index,
                        o1.order_action_index,
                        a3.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s1.status
                    FROM
                        order_cancels o1
                        INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                        INNER JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        o1.action_index=?
                    LIMIT 1`;
            }
            // ORDER_EDIT action
            if(type=='ORDER_EDIT'){
                query = `SELECT
                        a2.action,
                        a1.action_format,
                        o1.action_index,
                        o1.order_action_index,
                        a3.address as source,
                        o1.expiration,
                        o1.allow_list,
                        o1.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s1.status
                    FROM
                        order_edits o1
                        INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                        INNER JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        o1.action_index=?
                    LIMIT 1`;
            }
            // ORDER_MATCH action
            if(type=='ORDER_MATCH'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m1.action_index,
                            c1.coin as give_coin,
                            m1.give_action_index,
                            c2.coin as get_coin,
                            m1.get_action_index,
                            b1.block_index,
                            b1.block_time as timestamp,
                            s1.status
                        FROM
                            order_matches m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
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
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
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
                            INNER JOIN index_addresses    a1 ON (a1.id=s1.destination_id)
                            INNER JOIN index_memos        m1 ON (m1.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_tickers      t1 ON (t1.id=s1.tick_id)
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
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
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
                            c2.coin as get_coin,
                            t4.tick as get_tick,
                            s1.get_amount,
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
                            s2.status
                        FROM
                            swaps s1
                            INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=s1.get_address_id)
                            INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                            INNER JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                            INNER JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                        WHERE 
                            s1.action_index=?
                        LIMIT 1`;
            }
            // SWAP_CANCEL action
            if(type=='SWAP_CANCEL'){
                query = `SELECT
                        a2.action,
                        a1.action_format,
                        s1.action_index,
                        s1.swap_action_index,
                        a3.address as source,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s2.status
                    FROM
                        swap_cancels s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        s1.action_index=?
                    LIMIT 1`;
            }
            // SWAP_EDIT action
            if(type=='SWAP_EDIT'){
                query = `SELECT
                        a2.action,
                        a1.action_format,
                        s1.action_index,
                        s1.swap_action_index,
                        a3.address as source,
                        s1.expiration,
                        s1.allow_list,
                        s1.block_list,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s2.status
                    FROM
                        swap_edits s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        s1.action_index=?
                    LIMIT 1`;
            }
            // SWAP_MATCH action
            if(type=='SWAP_MATCH'){
                query = `SELECT
                            a2.action,
                            a1.action_format,
                            m1.action_index,
                            c1.coin as give_coin,
                            m1.give_action_index,
                            c2.coin as get_coin,
                            m1.get_action_index,
                            b1.block_index,
                            b1.block_time as timestamp,
                            s1.status
                        FROM
                            swap_matches m1
                            INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                            INNER JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
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
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                            INNER JOIN index_addresses    a4 ON (a4.id=s1.destination_id)
                            INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                            INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
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
                            INNER JOIN index_tickers   t1 ON (t1.id=i1.tick_id)
                            INNER JOIN index_addresses a1 ON (a1.id=i1.transfer_id)
                        WHERE 
                            i1.action_index=?
                        ORDER BY
                            t1.tick ASC`;
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
                            INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                            INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                            INNER JOIN index_addresses    a3 ON (a3.id=t1.source_id)
                        WHERE 
                            a1.action_index=?
                        LIMIT 1`;
            }
            // Run the SQL query to get the information on the action_index
            if(query){
                results = await this.doQuery(config, query, args);
                if(results && results.length)
                    data = Object.assign({}, data, results[0]);
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
                }
            }
            // If we have a third query defined, run it and apply the data to the correct place in the data object
            if(query3){
                // Set correct arguments for the query
                let args3 = [action_index];
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
                            INNER JOIN index_tickers   t1 ON (t1.id=c1.tick_id)
                            INNER JOIN index_addresses a1 ON (a1.id=c1.address_id)
                        WHERE 
                            c1.action_index=?
                        ORDER BY
                            c1.amount DESC`;
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
                            INNER JOIN index_tickers   t1 ON (t1.id=d1.tick_id)
                            INNER JOIN index_addresses a1 ON (a1.id=d1.address_id)
                        WHERE 
                            d1.action_index=?
                        ORDER BY
                            d1.amount DESC`;
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
                            INNER JOIN index_tickers   t1 ON (t1.id=e1.tick_id)
                            INNER JOIN index_addresses a1 ON (a1.id=e1.address_id)
                        WHERE 
                            e1.action_index=?
                        ORDER BY
                            e1.amount DESC`;
                results = await this.doQuery(config, query, args);
                if(results && results.length)
                    data.escrows = results;
            }
            // Include any fee associated with this action_index
            let fee = await this.getActionFeeData(config, action_index);
            if(fee)
                data.fee = fee;
            // Include any related action_indexes
            // let related = await this.getRelatedActions(config, action_index);
            // if(related)
            //     data.related_actions = related;
        }
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
                        f1.method
                    FROM
                        fees f1
                        INNER JOIN actions         a1 ON (a1.action_index=f1.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN index_tickers   t2 ON (t2.id=f1.tick_id)
                        INNER JOIN index_addresses a2 ON (a2.id=t1.source_id)
                        LEFT  JOIN index_addresses a3 ON (a3.id=f1.destination_id)
                    WHERE 
                        f1.action_index=?`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            fee = results[0];
        return fee;
    }

    // Get address id for a given address
    async getAddressId(config, address){
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
        return id;
    }

    // Get tick id for a given token
    async getTickId(config, tick){
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
                        INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
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
        let type    = await this.getActionType(config, action_index);
        let actions = [{ foo: 'bar' }];
        if(type){

        }
        // Lookup the related actions based on the action_index
        // let args = [action_index];
        // let sql  = `SELECT 
        //                 a2.action
        //             FROM
        //                 actions a1
        //                 INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
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
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where;
            results = await this.doQuery(config, count, args);
            if(results && results.length)
                total = this.util.bcadd(total, results[0].count, 0);
        }
        // If we have offset value and action, use it to speed up SQL query by pulling less data
        if(action && start){
            if(action=='prev'){
                where += ' AND m.action_index > ' + start;
                // where += ' AND m.action_index < ' + this.util.bcadd(start,this.util.bcadd(limit,1));
            } else {
                where += ' AND m.action_index < ' + start;
                // where += ' AND m.action_index > ' + this.util.bcsub(start,this.util.bcadd(limit,1));
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
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
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
            'coin', 'tick',  'amount', 'destination', 'type', 'edit', 'expiration', 'allow_list', 'block_list',  // Common fields
            'fee_preference', 'require_memo',                                                                    // Addresses
            'message',                                                                                           // Broadcasts
            'callback_tick', 'callback_amount',                                                                  // Callbacks
            'dividend_tick',                                                                                     // Dividends
            'name', 'title',                                                                                     // Files
            'link_action_index', 'coin_action_index',                                                            // Links
            'list_action_index',                                                                                 // Lists
            'encryption_method', 'plaintext_message',                                                            // Messages
            'give_tick', 'get_tick', 'give_amount', 'get_amount',                                                // Orders, Swaps, Dispensers
            'order_action_index',                                                                                // Order_Cancels, Order_Edits
            'swap_action_index',                                                                                 // Swap_Cancels, Swap_Edits
            'resume_block',                                                                                      // Sleep
            'balances', 'ownerships'                                                                             // Sweeps
        ];
        // Lookup extended information on the action_index
        for(let data of actions){
            let info = await this.getActionData(config, data.action_index);
            data.status = info.status;
            let details = false;
            for(let name of detailFields){
                if(info[name]){
                    // If details object does not exist yet, create it
                    if(!details)
                        details = {};
                    // Populate details object with fields we care about
                    details[name] = info[name];
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
            for(let row of results){
                let info = {
                    block_index: row.block_index,
                    timestamp: row.block_time,
                    actions: {}
                };
                let block_index = row.block_index;
                let query2 = '';
                // Loop through action tables and get a count for each block
                for(let table of this.actionTables){
                    if(query2!='')
                        query2 += ' UNION ALL ';
                    query2 += `SELECT
                                '` + table + `' as action,
                                count(*) as count
                            FROM
                                ` + table + ` m
                                INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                                INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                                INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                            WHERE 
                                b1.block_index=` + block_index;
                }                
                let results2 = await this.doQuery(config, query2);
                if(results2 && results2.length){
                    for(let data of results2){
                        info.actions[data.action] = data.count;
                    }
                }
                data.push(info);
            }
        }
        return [data, null, total];
    }

    // Get list of search results for a given
    async getSearch(config){
        // Define list of search types
        let searchTypes = ['address', 'broadcast', 'token', 'transaction'];
        let dataType    = config.data.type;
        let search      = '%' + config.data.search + '%';
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
        // Get counts of each search type 
        for(let type of searchTypes){
            let query  = false;
            let args  = [search];
            if(['broadcast','token'].includes(type))
                args.push(search);
            if(type=='address')
                query = `SELECT COUNT(*) AS count FROM index_addresses WHERE LOWER(address) LIKE LOWER( ? )`;
            if(type=='transaction')
                query = `SELECT COUNT(*) AS count FROM index_transactions WHERE LOWER(hash) LIKE LOWER( ? )`;
            if(type=='broadcast'){
                query = `SELECT 
                            COUNT(*) AS count 
                        FROM 
                            broadcasts b
                            INNER JOIN index_memos m ON (m.id=b.memo_id)
                        WHERE 
                            LOWER(b.message) LIKE LOWER( ? ) OR
                            LOWER(m.memo)    LIKE LOWER( ? )`;
            }
            if(type=='token'){
                query = `SELECT 
                            COUNT(*) AS count 
                        FROM 
                            tokens t1
                            INNER JOIN index_tickers t2 ON (t2.id=t1.tick_id)
                        WHERE 
                            LOWER(t2.tick)        LIKE LOWER( ? ) OR
                            LOWER(t1.description) LIKE LOWER( ? )`;
            }
            if(query){
                let results = await this.doQuery(config, query, args);
                if(results && results.length){
                    let count = Number(results[0].count);
                    if(type=='address')
                        data.totals.addresses = count;
                    if(type=='broadcast')
                        data.totals.broadcasts = count;
                    if(type=='token')
                        data.totals.tokens = count;
                    if(type=='transaction')
                        data.totals.transactions = count;
                    if(type==dataType)
                        total = count;
                }
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
                            hash 
                        FROM 
                            index_transactions 
                        WHERE 
                            LOWER(hash) LIKE LOWER( ? )
                        ORDER BY hash ASC
                        LIMIT ` + sql.limit;
            if(dataType=='broadcast')
                query = `SELECT 
                            b.message,
                            m.memo,
                            b.action_index,
                            s.status
                        FROM 
                            broadcasts b
                            INNER JOIN index_memos    m ON (m.id=b.memo_id)
                            INNER JOIN index_statuses s ON (s.id=b.status_id)
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
                            INNER JOIN index_tickers t2 ON (t2.id=t1.tick_id)
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
}

module.exports = Database