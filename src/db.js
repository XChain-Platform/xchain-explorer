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
        var connection = null;
        while(connection == null){        
            try {
                connection = await this.pools[config.coin].pool.getConnection();
                // console.log("Connected to database!");
            } catch (e){
                console.log("Can't connect to mariadb. Trying again...");
                // console.log('e=',e);
                connection = null;
                await this.util.sleep(1000);
            }
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
        // If query is an object, it is data, so just pass it forward
        if(typeof query === 'object'){
            data = query;
        } else {
            // Default args to the search string if specific search args object was not given (null)
            if(!args || typeof args !== 'object')
                args = [config.data.search];
            // Run the database query to get the data
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
        // Handle API queries
        if(config.type=='api'){
            let q     = (data.query) ? data.query : false;
            let max   = this.getMaxMethodResults(data.method);
            let page  = (q && q.page  && this.util.isInteger(Number(q.page)))  ? q.page  : 1;
            let limit = (q && q.limit && this.util.isInteger(Number(q.limit))) ? q.limit : max;
            // Set SQL query limit to page * limit
            limit = limit * page;
            // Standardize sort order to either ASC, DESC (default to descending)
            config.data.order = (q && q.sortorder && ['asc','desc'].includes(q.sortorder)) ? String(q.sortorder).toUpperCase() : 'DESC';
            // Get the SQL query and list of arguments
            if(typeof this[data.method] === 'function')
                [query, args, count] = await this[data.method](config, limit);
        }
        // Handle Explorer queries
        if(config.type=='explorer'){
            // coming soon
        }
        return [query, args, count];
    }

    // Handle getting a database connection and running a query and returning the results
    async doQuery(config, query, args){
        // Get a database connection from the connection pool
        let db    = await this.getConnection(config);
        let data  = false; 
        // Run the database query
        try {
            data = await db.query(query, args);
        } catch (error) {
            this.util.logError('Error running query:', error);
        }
        return data;
        await this.releaseConnection();
    }


    /******************************************************************
     * General database functions
     *****************************************************************/

    // Method to determine the maximum results to return for each method
    getMaxMethodResults(method){
        // Define array of methods and the max results for each method
        let methods = {
            getBalances: 100,
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
     * /{COIN}/api/dispensers/{QUERY}/{TYPE}      getDispensers    block, address, token
     * /{COIN}/api/dispenses/{QUERY}/{TYPE}       getDispenses     block, address, token
     * /{COIN}/api/files/{QUERY}/{TYPE}           getFiles         block, address
     * /{COIN}/api/issues/{QUERY}/{TYPE}          getIssues        block, address, token
     * /{COIN}/api/links/{QUERY}/{TYPE}           getLinks         block, address
     * /{COIN}/api/lists/{QUERY}/{TYPE}           getLists         block, address
     * /{COIN}/api/messages/{QUERY}/{TYPE}        getMessages      block, address, token, source, destination
     * /{COIN}/api/mints/{QUERY}/{TYPE}           getMints         block, address, token, source, destination
     * /{COIN}/api/orders/{QUERY}/{TYPE}          getOrders        block, address, token
     * /{COIN}/api/order_matches/{QUERY}/{TYPE}   getOrderMatches  block 
     * /{COIN}/api/sends/{QUERY}/{TYPE}           getSends         block, address, token, source, destination
     * /{COIN}/api/sleeps/{QUERY}/{TYPE}          getSleeps        block, address, token
     * /{COIN}/api/swaps/{QUERY}/{TYPE}           getSwaps         block, address, token
     * /{COIN}/api/swap_matches/{QUERY}/{TYPE}    getSwapMatches   block 
     ******************************************************************/

    // Get list of ADDRESS actions
    async getAddresses(config, limit){
        let type = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address')
            where = 'a3.address=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        addresses a1
                        INNER JOIN actions            a2 ON (a2.action_index=a1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where;
        let query = `SELECT
                        a1.action_index,
                        a3.address as source,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY a1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of AIRDROP actions
    async getAirdrops(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address')
            where = 'a3.address=?';
        if(type=='token')
            where = 't3.tick=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        airdrops a1
                        INNER JOIN actions            a2 ON (a2.action_index=a1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=a1.tick_id)
                    WHERE ` + where;
        let query = `SELECT
                        a1.action_index,
                        a3.address as source,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=a1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=a1.tick_id)
                    WHERE ` + where + `
                    ORDER BY a1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of BATCH actions
    async getBatches(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b2.block_index=?';
        if(type=='address')
            where = 'a3.address=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        batches b1
                        INNER JOIN actions            a2 ON (a2.action_index=b1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a2.tx_index)
                        INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                        INNER JOIN index_addresses    a3 ON (a3.id=b1.source_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where;
        let query = `SELECT
                        b1.action_index,
                        a3.address as source,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=b1.source_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY b1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of BROADCAST actions
    async getBroadcasts(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b2.block_index=?';
        if(type=='address')
            where = 'a2.address=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        broadcasts b1
                        INNER JOIN actions            a1 ON (a1.action_index=b1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b2 ON (b2.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=b1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=b1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where;
        let query = `SELECT
                        b1.action_index,
                        b1.message,
                        b1.value,
                        b1.fee,
                        b1.broadcast_action_index,
                        a2.address as source,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=b1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=b1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY b1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of CALLBACK actions
    async getCallbacks(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address')
            where = 'a2.address=?';
        if(type=='token')
            where = 't3.tick=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        callbacks c1
                        INNER JOIN actions            a1 ON (a1.action_index=c1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=c1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=c1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=c1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=c1.tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=c1.callback_tick_id)
                    WHERE ` + where;
        let query = `SELECT
                        c1.action_index,
                        a2.address as source,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=c1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=c1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=c1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=c1.tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=c1.callback_tick_id)
                    WHERE ` + where + `
                    ORDER BY c1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of DESTROY actions
    async getDestroys(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address')
            where = 'a2.address=?';
        if(type=='token')
            where = 't3.tick=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        destroys d1
                        INNER JOIN actions            a1 ON (a1.action_index=d1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=d1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=d1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=d1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=d1.tick_id)
                    WHERE ` + where;
        let query = `SELECT
                        d1.action_index,
                        a2.address as source,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=d1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=d1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=d1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=d1.tick_id)
                    WHERE ` + where + `
                    ORDER BY d1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of DISPENSER actions
    async getDispensers(config, limit){
        // TODO
    }

    // Get list of DISPENSE actions
    async getDispense(config, limit){
        // TODO
    }

    // Get list of FILE actions
    async getFiles(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address')
            where = 'a2.address=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        files f1
                        INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=f1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                    WHERE ` + where;
        let query = `SELECT
                        f1.action_index,
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
                        files f1
                        INNER JOIN actions            a1 ON (a1.action_index=f1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=f1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=f1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=f1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_mime_types   t3 ON (t3.id=f1.type_id)
                    WHERE ` + where + `
                    ORDER BY f1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }    

    // Get list of ISSUE actions
    async getIssues(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address')
            where = 'a2.address=?';
        if(type=='token')
            where = 't3.tick=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        issues i1
                        INNER JOIN actions            a1 ON (a1.action_index=i1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=i1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=i1.transfer_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=i1.transfer_supply_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=i1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=i1.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=i1.callback_tick_id)
                    WHERE ` + where;
        let query = `SELECT
                        i1.action_index,
                        t3.tick,
                        i1.max_supply,
                        i1.max_mint,
                        i1.decimals,
                        i1.description,
                        i1.mint_supply,
                        a3.address as transfer,
                        a4.address as transfer_supply,
                        i1.lock_max_supply,
                        i1.lock_mint,
                        i1.lock_mint_supply,
                        i1.lock_max_mint,
                        i1.lock_description,
                        i1.lock_rug,
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
                        a2.address as source,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=i1.source_id)
                        LEFT  JOIN index_addresses    a3 ON (a3.id=i1.transfer_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=i1.transfer_supply_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=i1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=i1.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=i1.callback_tick_id)
                    WHERE ` + where + `
                    ORDER BY i1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of LINK actions
    async getLinks(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address')
            where = 'a2.address=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        links l1
                        INNER JOIN actions            a1 ON (a1.action_index=l1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=l1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=l1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=l1.coin_id)
                    WHERE ` + where;
        let query = `SELECT
                        l1.action_index,
                        l1.link_action_index,
                        c1.coin,
                        l1.coin_action_index,
                        a2.address as source,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=l1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=l1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=l1.coin_id)
                    WHERE ` + where + `
                    ORDER BY l1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }    

    // Get list of LIST actions
    async getLists(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address')
            where = 'a2.address=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        lists l1
                        INNER JOIN actions            a1 ON (a1.action_index=l1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=l1.source_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where;
        let query = `SELECT
                        l1.action_index,
                        l1.type,
                        l1.edit,
                        l1.list_action_index,
                        a2.address as source,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=l1.source_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY l1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of MESSAGE actions
    async getMessages(config, limit){
        let type  = config.data.type;
        let args  = [config.data.search];
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address'){
            where = '(a2.address=? OR a3.address=?)';
            args.push(config.data.search);
        }
        if(type=='source')
            where = 'a2.address=?';
        if(type=='destination')
            where = 'a3.address=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        messages m1
                        INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=m1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m1.destination_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where;
        let query = `SELECT
                        m1.action_index,
                        a2.address as source,
                        a3.address as destination,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=m1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m1.destination_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY m1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, args, count];
    }

    // Get list of MINT actions
    async getMints(config, limit){
        let type  = config.data.type;
        let args  = [config.data.search];
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address'){
            where = '(a2.address=? OR a3.address=?)';
            args.push(config.data.search);
        }
        if(type=='source')
            where = 'a2.address=?';
        if(type=='destination')
            where = 'a3.address=?';
        if(type=='token')
            where = 't3.tick=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        mints m1
                        INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=m1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m1.destination_id)
                        INNER JOIN index_memos        m2 ON (m2.id=m1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m1.tick_id)
                    WHERE ` + where;
        let query = `SELECT
                        m1.action_index,
                        a2.address as source,
                        a3.address as destination,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=m1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=m1.destination_id)
                        INNER JOIN index_memos        m2 ON (m2.id=m1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m1.tick_id)
                    WHERE ` + where + `
                    ORDER BY m1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, args, count];
    }

    // Get list of ORDER actions
    async getOrders(config, limit){
        let type  = config.data.type;
        let args  = [config.data.search];
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address'){
            where = '(a2.address=? OR a3.address=?)';
            args.push(config.data.search);
        }
        if(type=='token'){
            where = '(t3.tick=? OR t4.tick=?)';
            args.push(config.data.search);
        }
        let count = `SELECT
                        count(*) as total
                    FROM
                        orders o1
                        INNER JOIN actions            a1 ON (a1.action_index=o1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=o1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=o1.get_address_id)
                        INNER JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                    WHERE ` + where;
        let query = `SELECT
                        o1.action_index,
                        c1.coin as give_coin,
                        t3.tick as give_tick,
                        o1.give_amount,
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        o1.get_amount,
                        a2.address as source,
                        a3.address as get_address,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=o1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=o1.get_address_id)
                        INNER JOIN index_memos        m2 ON (m2.id=o1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=o1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=o1.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=o1.get_coin_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=o1.give_tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=o1.get_tick_id)
                    WHERE ` + where + `
                    ORDER BY o1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, args, count];
    }

    // Get list of ORDER_MATCH actions
    async getOrderMatches(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        order_matches m1
                        INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                    WHERE ` + where;
        let query = `SELECT
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
                        INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                    WHERE ` + where + `
                    ORDER BY m1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of SEND actions
    async getSends(config, limit){
        let type  = config.data.type;
        let args  = [config.data.search];
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address'){
            where = '(a2.address=? OR a3.address=?)';
            args.push(config.data.search);
        }
        if(type=='source')
            where = 'a2.address=?';
        if(type=='destination')
            where = 'a3.address=?';
        if(type=='token')
            where = 't3.tick=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        sends s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=s1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=s1.destination_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=s1.tick_id)
                    WHERE ` + where;
        let query = `SELECT
                        s1.action_index,
                        a2.address as source,
                        a3.address as destination,
                        t3.tick,
                        s1.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s2.status
                    FROM
                        sends s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=s1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=s1.destination_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=s1.tick_id)
                    WHERE ` + where + `
                    ORDER BY s1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, args, count];
    } 

    // Get list of SLEEP actions
    async getSleeps(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address')
            where = 'a2.address=?';
        if(type=='token')
            where = 't3.tick=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        sleeps s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=s1.source_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT JOIN index_tickers       t3 ON (t3.id=s1.tick_id)
                    WHERE ` + where;
        let query = `SELECT
                        s1.action_index,
                        s1.type,
                        a2.address as source,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=s1.source_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT JOIN index_tickers       t3 ON (t3.id=s1.tick_id)
                    WHERE ` + where + `
                    ORDER BY s1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    } 

    // Get list of SWAP actions
    async getSwaps(config, limit){
        let type  = config.data.type;
        let args  = [config.data.search];
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address'){
            where = '(a2.address=? OR a3.address=?)';
            args.push(config.data.search);
        }
        if(type=='token'){
            where = '(t3.tick=? OR t4.tick=?)';
            args.push(config.data.search);
        }
        let count = `SELECT
                        count(*) as total
                    FROM
                        swaps s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=s1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=s1.get_address_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                    WHERE ` + where;
        let query = `SELECT
                        s1.action_index,
                        c1.coin as give_coin,
                        t3.tick as give_tick,
                        s1.give_amount,
                        c2.coin as get_coin,
                        t4.tick as get_tick,
                        s1.get_amount,
                        a2.address as source,
                        a3.address as get_address,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=s1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=s1.get_address_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=s1.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=s1.get_coin_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=s1.give_tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=s1.get_tick_id)
                    WHERE ` + where + `
                    ORDER BY s1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, args, count];
    }

    // Get list of SWAP_MATCH actions
    async getSwapMatches(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        swap_matches m1
                        INNER JOIN actions            a1 ON (a1.action_index=m1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                    WHERE ` + where;
        let query = `SELECT
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
                        INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=m1.give_coin_id)
                        INNER JOIN index_coins        c2 ON (c2.id=m1.get_coin_id)
                    WHERE ` + where + `
                    ORDER BY m1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of SWEEP actions
    async getSweeps(config, limit){
        let type  = config.data.type;
        let args  = [config.data.search];
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address'){
            where = '(a2.address=? OR a3.address=?)';
            args.push(config.data.search);
        }
        if(type=='source')
            where = 'a2.address=?';
        if(type=='destination')
            where = 'a3.address=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        sweeps s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_addresses    a2 ON (a2.id=s1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=s1.destination_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where;
        let query = `SELECT
                        s1.action_index,
                        a2.address as source,
                        a3.address as destination,
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
                        INNER JOIN index_addresses    a2 ON (a2.id=s1.source_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=s1.destination_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY s1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, args, count];
    } 

    /******************************************************************
     * XChain API Misc Endpoints
     * 
     * Endpoints                           Method Name      Query Types
     * -----------------------------------------------------------------
     * /{COIN}/api/action/{QUERY}           getAction       action_index
     * /{COIN}/api/balances/{QUERY}/{TYPE}  getBalances     address
     * /{COIN}/api/credits/{QUERY}/{TYPE}   getCredits      block, address
     * /{COIN}/api/debits/{QUERY}/{TYPE}    getDebits       block, address
     * /{COIN}/api/escrows/{QUERY}/{TYPE}   getEscrows      block, address
     * /{COIN}/api/history/{QUERY}/{TYPE}   getHistory      address,
     * /{COIN}/api/holders/{QUERY}/{TYPE}   getHolders      token,
     * /{COIN}/api/mempool/{QUERY}/{TYPE}   getMempool      address, token,
     * /{COIN}/api/network                  getNetwork
     * /{COIN}/api/token/{QUERY}            getToken        token
     * /{COIN}/api/tx/{QUERY}               getTransaction  tx_hash
     ******************************************************************/

    // Get information on a given action_index
    async getAction(config){
        let data = await this.getActionData(config, config.data.search);
        return [data];
    }

    // Get list of address balances
    async getBalances(config, limit){
        // Balance queries are always by address
        let where = 'a2.address=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        balances b1
                        INNER JOIN index_tickers   t1 ON (t1.id=b1.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=b1.address_id)
                    WHERE ` + where;
        let query = `SELECT
                        t1.tick,
                        b1.amount
                    FROM
                        balances b1
                        INNER JOIN index_tickers   t1 ON (t1.id=b1.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=b1.address_id)
                    WHERE ` + where + `
                    ORDER BY t1.tick ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of credits
    async getCredits(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address')
            where = 'a2.address=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        credits c1
                        INNER JOIN actions            a1 ON (a1.action_index=c1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_tickers      t2 ON (t2.id=c1.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=c1.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    LIMIT ` + limit;
        let query = `SELECT
                        c1.action_index,
                        t1.tx_index,
                        a2.address,
                        t2.tick,
                        c1.amount,
                        a3.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t3.hash as tx_hash
                    FROM
                        credits c1
                        INNER JOIN actions            a1 ON (a1.action_index=c1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_tickers      t2 ON (t2.id=c1.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=c1.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY c1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of debits
    async getDebits(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address')
            where = 'a2.address=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        debits d1
                        INNER JOIN actions            a1 ON (a1.action_index=d1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_tickers      t2 ON (t2.id=d1.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=d1.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    LIMIT ` + limit;
        let query = `SELECT
                        d1.action_index,
                        t1.tx_index,
                        a2.address,
                        t2.tick,
                        d1.amount,
                        a3.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t3.hash as tx_hash
                    FROM
                        debits d1
                        INNER JOIN actions            a1 ON (a1.action_index=d1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_tickers      t2 ON (t2.id=d1.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=d1.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY d1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of escrows
    async getEscrows(config, limit){
        let type  = config.data.type;
        let where = ``;
        if(type=='block')
            where = 'b1.block_index=?';
        if(type=='address')
            where = 'a2.address=?';
        let count = `SELECT
                        count(*) as total
                    FROM
                        escrows e1
                        INNER JOIN actions            a1 ON (a1.action_index=e1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_tickers      t2 ON (t2.id=e1.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=e1.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    LIMIT ` + limit;
        let query = `SELECT
                        e1.action_index,
                        t1.tx_index,
                        a2.address,
                        t2.tick,
                        e1.amount,
                        a3.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t3.hash as tx_hash
                    FROM
                        escrows e1
                        INNER JOIN actions            a1 ON (a1.action_index=e1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_tickers      t2 ON (t2.id=e1.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=e1.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY e1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get information on a given action_index
    async getHistory(config, limit){
        // TODO
    }

    // Get list of holders of a token
    async getHolders(config, limit){
        let where = ``;
        let count = `SELECT
                        count(*) as total
                    FROM
                        escrows e1
                        INNER JOIN actions            a1 ON (a1.action_index=e1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_tickers      t2 ON (t2.id=e1.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=e1.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    LIMIT ` + limit;
        let query = `SELECT
                        e1.action_index,
                        t1.tx_index,
                        a2.address,
                        t2.tick,
                        e1.amount,
                        a3.action,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t3.hash as tx_hash
                    FROM
                        escrows e1
                        INNER JOIN actions            a1 ON (a1.action_index=e1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_tickers      t2 ON (t2.id=e1.tick_id)
                        INNER JOIN index_addresses    a2 ON (a2.id=e1.address_id)
                        INNER JOIN index_actions      a3 ON (a3.id=a1.action_id)
                        INNER JOIN index_transactions t3 ON (t3.id=t1.tx_hash_id)
                    WHERE ` + where + `
                    ORDER BY e1.action_index ` + config.data.order + `
                    LIMIT ` + limit;
        return [query, null, count];
    }

    // Get list of mempool transactions
    async getMempool(config, limit){
        // TODO
    }

    // Get network information
    async getNetwork(config, limit){
        // TODO
    }

    // Get token information
    async getToken(config, limit){
        // TODO
    }

    /******************************************************************
     * Commonly used functions 
     *****************************************************************/

    // Get information for a given action_index, this includes looking up any related data
    async getActionData(config, action_index){
        console.log('getActionData action_index=',action_index);
        // Placeholders for data, queries, and arguments
        let action = null;
        let data   = null;
        let query1 = null;
        let query2 = null;
        let query3 = null;
        let query4 = null;
        let args1  = [action_index];
        let args2  = null;
        let args3  = null;
        let args4  = null;
        // Lookup the ACTION based on the action_index
        let sql    = `SELECT 
                        a2.action
                    FROM
                        actions a1
                        INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
                    WHERE
                        a1.action_index=?`;
        let results = await this.doQuery(config, sql, args1);
        if(results && results.length)
            action = results[0].action;
        // ADDRESS action
        if(action=='ADDRESS'){
            query1 = `SELECT
                        a3.action,
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
                        INNER JOIN index_addresses    a4 ON (a4.id=a1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        a1.action_index=?
                    LIMIT 1`;
        }
        // AIRDROP action
        if(action=='AIRDROP'){
            query1 = `SELECT
                        a3.action,
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
                        INNER JOIN index_addresses    a4 ON (a4.id=a1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=a1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=a1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=a1.tick_id)
                    WHERE 
                        a1.action_index=?
                    LIMIT 1`;
            // Credits
            query2 = `SELECT
                        a2.address,
                        t2.tick,
                        c1.amount
                    FROM
                        credits c1
                        INNER JOIN index_tickers      t1 ON (t1.id=c1.tick_id)
                        INNER JOIN index_addresses    a1 ON (a1.id=c1.address_id)
                    WHERE 
                        c1.action_index=? AND
                        c1.amount=?
                    ORDER BY 
                        a2.address ASC`;
        }
        // BATCH action
        if(action=='BATCH'){
            query1 = `SELECT
                        a3.action,
                        b1.action_index,
                        a2.tx_index,
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
                        INNER JOIN index_addresses    a4 ON (a4.id=b1.source_id)
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
        if(action=='BROADCAST'){
            query1 = `SELECT
                        a2.action,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=b1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=b1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=b1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        b1.action_index=?
                    LIMIT 1`;
        }
        // CALLBACK action
        if(action=='CALLBACK'){
            query1 = `SELECT
                        a2.action,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=c1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=c1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=c1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=c1.tick_id)
                        INNER JOIN index_tickers      t4 ON (t4.id=c1.callback_tick_id)
                    WHERE 
                        c1.action_index=?
                    LIMIT 1`;
            // Credits
            query2 = `SELECT
                        a1.address,
                        t1.tick,
                        c1.amount
                    FROM
                        credits c1
                        INNER JOIN index_tickers   t1 ON (t1.id=c1.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=c1.address_id)
                    WHERE 
                        c1.action_index=? AND 
                        t1.tick=?
                    ORDER BY
                        c1.amount DESC`;
            // Debits
            query3 = `SELECT
                        a1.address,
                        t1.tick,
                        d1.amount
                    FROM
                        debits d1
                        INNER JOIN index_tickers   t1 ON (t1.id=d1.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=d1.address_id)
                    WHERE 
                        d1.action_index=? AND 
                        t1.tick=?
                    ORDER BY
                        d1.amount DESC`;
        }
        // DESTROY action
        if(action=='DESTROY'){
            query1 = `SELECT
                        a2.action,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=d1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=d1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=d1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=d1.tick_id)
                    WHERE 
                        d1.action_index=?
                    LIMIT 1`;
        }
        // DISPENSER action
        if(action=='DISPENSER'){
            // TODO
        }
        // DISPENSE action
        if(action=='DISPENSE'){
            // TODO
        }
        // FILE action
        if(action=='FILE'){
            query1 = `SELECT
                        a2.action,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=f1.source_id)
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
        if(action=='ISSUE'){
            query1 = `SELECT
                        a2.action,
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
                        i1.lock_rug,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=i1.source_id)
                        LEFT  JOIN index_addresses    a4 ON (a4.id=i1.transfer_id)
                        LEFT  JOIN index_addresses    a5 ON (a5.id=i1.transfer_supply_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=i1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=i1.tick_id)
                        LEFT  JOIN index_tickers      t4 ON (t4.id=i1.callback_tick_id)
                    WHERE 
                        i1.action_index=?
                    LIMIT 1`;
            // Credits
            query2 = `SELECT
                        a1.address,
                        t1.tick,
                        c1.amount
                    FROM
                        credits c1
                        INNER JOIN index_tickers   t1 ON (t1.id=c1.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=c1.address_id)
                    WHERE 
                        c1.action_index=? AND 
                        t1.tick=?
                    ORDER BY
                        c1.amount DESC`;
            // Debits
            query3 = `SELECT
                        a1.address,
                        t1.tick,
                        d1.amount
                    FROM
                        debits d1
                        INNER JOIN index_tickers   t1 ON (t1.id=d1.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=d1.address_id)
                    WHERE 
                        d1.action_index=? AND 
                        t1.tick=?
                    ORDER BY
                        d1.amount DESC`;
        }
        // LINK action
        if(action=='LINK'){
            query1 = `SELECT
                        a2.action,
                        l1.action_index,
                        l1.link_action_index,
                        c1.coin,
                        l1.coin_action_index,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=l1.source_id)
                        INNER JOIN index_memos        m1 ON (m1.id=l1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=l1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_coins        c1 ON (c1.id=l1.coin_id)
                    WHERE 
                        l1.action_index=?
                    LIMIT 1`;
        }
        // LIST action
        if(action=='LIST'){
            query1 = `SELECT
                        a2.action,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=l1.source_id)
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
        if(action=='MESSAGE'){
            query1 = `SELECT
                        a2.action,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=m1.source_id)
                        INNER JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        m1.action_index=?
                    LIMIT 1`;
        }
        // MINT action
        if(action=='MINT'){
            query1 = `SELECT
                        a2.action,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=m1.source_id)
                        INNER JOIN index_addresses    a4 ON (a4.id=m1.destination_id)
                        INNER JOIN index_memos        m2 ON (m2.id=m1.memo_id)
                        INNER JOIN index_statuses     s1 ON (s1.id=m1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=m1.tick_id)
                    WHERE 
                        m1.action_index=?
                    LIMIT 1`;
            // Credits
            query2 = `SELECT
                        a1.address,
                        t1.tick,
                        c1.amount
                    FROM
                        credits c1
                        INNER JOIN index_tickers   t1 ON (t1.id=c1.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=c1.address_id)
                    WHERE 
                        c1.action_index=? AND 
                        t1.tick=?
                    ORDER BY
                        c1.amount DESC`;
            // Debits
            query3 = `SELECT
                        a1.address,
                        t1.tick,
                        d1.amount
                    FROM
                        debits d1
                        INNER JOIN index_tickers   t1 ON (t1.id=d1.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=d1.address_id)
                    WHERE 
                        d1.action_index=? AND 
                        t1.tick=?
                    ORDER BY
                        d1.amount DESC`;
        }
        // ORDER action
        if(action=='ORDER'){
            query1 = `SELECT
                        a2.action,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=o1.source_id)
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
            // Debits
            query2 = `SELECT
                        a1.address,
                        t1.tick,
                        d1.amount
                    FROM
                        debits d1
                        INNER JOIN index_tickers   t1 ON (t1.id=d1.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=d1.address_id)
                    WHERE 
                        d1.action_index=? AND 
                        t1.tick=?
                    ORDER BY
                        d1.amount DESC`;
            // Escrows
            query3 = `SELECT
                        a1.address,
                        t1.tick,
                        e1.amount
                    FROM
                        escrows e1
                        INNER JOIN index_tickers   t1 ON (t1.id=e1.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=e1.address_id)
                    WHERE 
                        e1.action_index=? AND 
                        t1.tick=?
                    ORDER BY
                        e1.amount DESC`;
        }
        // ORDER_MATCH action
        if(action=='ORDER_MATCH'){
            query1 = `SELECT
                        a2.action,
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
            // Credits
            query2 = `SELECT
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
            // Escrows
            query3 = `SELECT
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
        }
        // SEND action
        if(action=='SEND'){
            query1 = `SELECT
                        a2.action,
                        s1.action_index,
                        a3.address as source,
                        a4.address as destination,
                        t3.tick,
                        s1.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        m2.memo,
                        s2.status
                    FROM
                        sends s1
                        INNER JOIN actions            a1 ON (a1.action_index=s1.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        INNER JOIN index_actions      a2 ON (a2.id=a1.action_id)
                        INNER JOIN index_addresses    a3 ON (a3.id=s1.source_id)
                        INNER JOIN index_addresses    a4 ON (a4.id=s1.destination_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        INNER JOIN index_tickers      t3 ON (t3.id=s1.tick_id)
                    WHERE 
                        s1.action_index=?
                    LIMIT 1`;
            // Credits
            query2 = `SELECT
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
            // Debits
            query3 = `SELECT
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
        }
        // SLEEP action
        if(action=='SLEEP'){
            query1 = `SELECT
                        a2.action,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=s1.source_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT JOIN index_tickers       t3 ON (t3.id=s1.tick_id)
                    WHERE 
                        s1.action_index=?
                    LIMIT 1`;
        }
        // SWAP action
        if(action=='SWAP'){
            // TODO
        }
        // SWAP_MATCH action
        if(action=='SWAP_MATCH'){
            // TODO
        }
        // SWEEP
        if(action=='SWEEP'){
            query1 = `SELECT
                        a2.action,
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
                        INNER JOIN index_addresses    a3 ON (a3.id=s1.source_id)
                        INNER JOIN index_addresses    a4 ON (a4.id=s1.destination_id)
                        INNER JOIN index_memos        m2 ON (m2.id=s1.memo_id)
                        INNER JOIN index_statuses     s2 ON (s2.id=s1.status_id)
                        INNER JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE 
                        s1.action_index=?
                    LIMIT 1`;
            // Credits
            query2 = `SELECT
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
            // Debits
            query3 = `SELECT
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
            // Issues
            // TODO: Update query once each sweep issue is its own action_index
            query4 = `SELECT
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
        // Run the SQL query to get the information on the action_index
        if(query1){
            results = await this.doQuery(config, query1, args1);
            if(results && results.length)
            data = results[0];
        } else {
            console.log('Query not yet written');
        }

        // If we have a secondary query defined, run it and apply the data to the correct place in the data object
        if(query2){
            // Set correct arguments for the query
            if(action=='AIRDROP')     args2 = [action_index, data.amount];
            if(action=='BATCH')       args2 = [action_index, data.tx_index];
            if(action=='CALLBACK')    args2 = [action_index, data.callback_tick];
            if(action=='ISSUE')       args2 = [action_index, data.tick];
            if(action=='LIST')        args2 = [action_index];
            if(action=='MINT')        args2 = [action_index, data.tick];
            if(action=='ORDER')       args2 = [action_index];
            if(action=='ORDER_MATCH') args2 = [action_index];
            if(action=='SEND')        args2 = [action_index];
            if(action=='SWEEP')       args2 = [action_index];
            results = await this.doQuery(config, query2, args2);
            if(results && results.length){
                // Insert the data at the correct place in the data object
                if(action=='AIRDROP')     data.credits = results;
                if(action=='CALLBACK')    data.credits = results;
                if(action=='ISSUE')       data.credits = results;
                if(action=='MINT')        data.credits = results;
                if(action=='ORDER')       data.debits  = results;
                if(action=='ORDER_MATCH') data.credits = results;
                if(action=='SEND')        data.credits = results;
                if(action=='SWEEP')       data.credits = results;
                // Loop through action_indexes and add to actions array
                if(action=='BATCH'){
                    let actions = [];
                    for(let row of results){
                        let info = await this.getActionData(config, Number(row.action_index));
                        actions.push(info);
                    }
                    data.actions = actions;
                }
                // Handle populating the list based off the list TYPE field
                if(action=='LIST'){
                    let list = [];
                    for(let row of results){
                        if(data.type==1) list.push(row.tick);
                        if(data.type==2) list.push(row.address);
                    }
                    data.list = list.sort();
                }
            }
        }

        // If we have a third query defined, run it and apply the data to the correct place in the data object
        if(query3){
            // Set correct arguments for the query
            if(action=='CALLBACK')    args3 = [action_index, data.tick];
            if(action=='ISSUE')       args3 = [action_index, data.tick];
            if(action=='LIST')        args3 = [action_index];
            if(action=='MINT')        args3 = [action_index, data.tick];
            if(action=='ORDER')       args3 = [action_index, data.give_tick];
            if(action=='ORDER_MATCH') args3 = [action_index];
            if(action=='SEND')        args3 = [action_index];
            if(action=='SWEEP')       args3 = [action_index];
            results = await this.doQuery(config, query3, args3);
            if(results && results.length){
                // Insert the data at the correct place in the data object
                if(action=='CALLBACK')    data.debits  = results;
                if(action=='ISSUE')       data.debits  = results;
                if(action=='MINT')        data.debits  = results;
                if(action=='ORDER')       data.escrows = results;
                if(action=='ORDER_MATCH') data.escrows = results;
                if(action=='SEND')        data.debits = results;
                if(action=='SWEEP')       data.debits = results;
                // Handle populating the list edits based off the list TYPE field
                if(action=='LIST'){
                    let edits = [];
                    for(let row of results){
                        if(data.type==1) edits.push({ tick: row.tick, status: row.status });
                        if(data.type==2) edits.push({ address: row.address, status: row.status });
                    }
                    data.edits = edits.sort();
                }

            }
        }

        // If we have a fourth query defined, run it and apply the data to the correct place in the data object
        if(query4){
            if(action=='SWEEP') args4 = [action_index];
            results = await this.doQuery(config, query4, args4);
            if(results && results.length){
                if(action=='SWEEP') data.issues = results;
            }            
        }

        // Include any fee associated with this action_index
        let fee = await this.getActionFeeData(config, action_index);
        if(fee)
            data.fee = fee;
        return data;
    }

    // Get fee information for a given action_index
    async getActionFeeData(config, action_index){
        let fee   = null;
        let args  = [action_index];
        let query = `SELECT
                        a1.address as source,
                        a2.address as destination,
                        t1.tick,
                        f1.amount,
                        f1.method
                    FROM
                        fees f1
                        INNER JOIN index_tickers   t1 ON (t1.id=f1.tick_id)
                        INNER JOIN index_addresses a1 ON (a1.id=f1.source_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=f1.destination_id)
                    WHERE 
                        f1.action_index=?`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length)
            fee = results[0];
        return fee;
    }

    /******************************************************************
     *
     * Explorer API  Endpoints
     * 
     *****************************************************************/

}

module.exports = Database