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
        // Get a database connection from the connection pool
        let db = await this.getConnection(config);
        // Get database query based on config object
        let [count, query] = await this.getQuery(config);
        // Set database arguments based on config object search data
        let args = [config.data.search];
        // Placeholder for total count of records and actual data
        let total = 0; 
        let data  = []; 
        // Run the database count query
        try {
            let results = await db.query(count, args);
            total = results[0].total;
        } catch (error) {
            this.util.logError('Error running sql count query:', error);
        }
        // Run the database query to get the data
        if(total > 0){
            try {
                data = await db.query(query, args);
            } catch (error) {
                this.util.logError('Error running sql query:', error);
            }
        }
        return [total, data];
        await this.releaseConnection();
    }

    // Handle getting a SQL query given a explorer config object
    async getQuery(config){
        let count = ''; // Placeholder for sql query for total count
        let query = ''; // Placeholder for sql query for data
        let data  = config.data;
        // Handle API queries
        if(config.type=='api'){
            let max   = this.getMaxMethodResults(data.method);
            let page  = (data.query.page  && this.util.isInteger(Number(data.query.page)))  ? data.query.page  : 1;
            let limit = (data.query.limit && this.util.isInteger(Number(data.query.limit))) ? data.query.limit : max;
            // Set SQL query limit to page * limit
            limit = limit * page;
            // Get the SQL query and list of arguments
            if(typeof this[data.method] === 'function')
                [count, query] = this[data.method](config.data.type, limit);
        }
        // Handle Explorer queries
        if(config.type=='explorer'){
            // coming soon
        }
        return [count, query];
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
     * API SQL Query Methods
     *****************************************************************/

    // Supported Endpoints                   [Method, Supported Query Type(s)]
    // '/{COIN}/api/addresses/{QUERY}'     : ['getAddresses',    ['block', 'address']],
    // '/{COIN}/api/airdrops/{QUERY}'      : ['getAirdrops',     ['block', 'address', 'token']],
    // '/{COIN}/api/batches/{QUERY}'       : ['getBatches',      ['block', 'address']],
    // '/{COIN}/api/broadcasts/{QUERY}'    : ['getBroadcasts',   ['block', 'address']],
    // '/{COIN}/api/callbacks/{QUERY}'     : ['getCallbacks',    ['block', 'address', 'token']],
    // '/{COIN}/api/destroys/{QUERY}'      : ['getDestroys',     ['block', 'address', 'token']],
    // '/{COIN}/api/dispensers/{QUERY}'    : ['getDispensers',   ['block', 'address', 'token']],
    // '/{COIN}/api/dispenses/{QUERY}'     : ['getDispenses',    ['block', 'address', 'token']],
    // '/{COIN}/api/files/{QUERY}'         : ['getFiles',        ['block', 'address']],
    // '/{COIN}/api/issues/{QUERY}'        : ['getIssues',       ['block', 'address', 'token']],
    // '/{COIN}/api/links/{QUERY}'         : ['getLinks',        ['block', 'address']],
    // '/{COIN}/api/lists/{QUERY}'         : ['getLists',        ['block', 'address']],
    // '/{COIN}/api/messages/{QUERY}'      : ['getMessages',     ['block', 'address']],
    // '/{COIN}/api/mints/{QUERY}'         : ['getMints',        ['block', 'address', 'token']],
    // '/{COIN}/api/orders/{QUERY}'        : ['getOrders',       ['block', 'address', 'token']],
    // '/{COIN}/api/order_matches/{QUERY}' : ['getOrderMatches', ['block', 'address', 'token']],
    // '/{COIN}/api/sends/{QUERY}'         : ['getSends',        ['block', 'address', 'token']],
    // '/{COIN}/api/sleeps/{QUERY}'        : ['getSleeps',       ['block', 'address', 'token']],
    // '/{COIN}/api/swaps/{QUERY}'         : ['getSwaps',        ['block', 'address', 'token']],
    // '/{COIN}/api/swap_matches/{QUERY}'  : ['getSwapMatches',  ['block', 'address', 'token']],
    // '/{COIN}/api/sweeps/{QUERY}'        : ['getSweeps',       ['block', 'address']],
    // // Misc API Endpoints
    // '/{COIN}/api/action/{QUERY}'        : ['getAction',       'action_index'],
    // '/{COIN}/api/balances/{QUERY}'      : ['getBalances',     'address'],
    // '/{COIN}/api/credits/{QUERY}'       : ['getCredits',      ['block', 'address', 'token']],
    // '/{COIN}/api/debits/{QUERY}'        : ['getDebits',       ['block', 'address', 'token']], 
    // '/{COIN}/api/escrows/{QUERY}'       : ['getEscrows',      ['block', 'address', 'token']],
    // '/{COIN}/api/history/{QUERY}'       : ['getHistory',      'address'],
    // '/{COIN}/api/holders/{QUERY}'       : ['getHolders',      'token'],
    // '/{COIN}/api/mempool/{QUERY}'       : ['getMempool',      ['address', 'token']],
    // '/{COIN}/api/network'               : ['getNetworkInfo'],
    // '/{COIN}/api/tx/{QUERY}'            : ['getTransaction',  'tx_hash']


    // Get list of ADDRESS actions
    getAddresses(type, limit){
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
                    LIMIT ` + limit;
        return [count, query];
    }

    // Get list of AIRDROP actions
    getAirdrops(type, limit){
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
                    LIMIT ` + limit;
        return [count, query];
    }

    // Get list of BATCH actions
    // TODO : Consider adding a list of action_indexes related to the batch in the future
    getBatches(type, limit){
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
                    LIMIT ` + limit;
        return [count, query];
    }

    // Get list of address balances
    getBalances(type, limit){
        let count = `SELECT
                        count(*) as total
                    FROM
                        balances b
                        INNER JOIN index_tickers   t ON (t.id=b.tick_id)
                        INNER JOIN index_addresses a ON (a.id=b.address_id)
                    WHERE
                        a.address=?`;
        let query = `SELECT
                        t.tick,
                        b.amount
                    FROM
                        balances b
                        INNER JOIN index_tickers   t ON (t.id=b.tick_id)
                        INNER JOIN index_addresses a ON (a.id=b.address_id)
                    WHERE
                        a.address=?
                    ORDER BY t.tick ASC
                    LIMIT ` + limit;
        return [count, query];
    }

    // Get list of BROADCAST actions
    getBroadcasts(type, limit){
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
                    LIMIT ` + limit;
        return [count, query];
    }

    // Get list of CALLBACK actions
    getCallbacks(type, limit){
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
                    LIMIT ` + limit;
        return [count, query];
    }

    // Get list of DESTROY actions
    getDestroys(type, limit){
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
                    LIMIT ` + limit;
        return [count, query];
    }

    // Get list of DISPENSER actions
    getDispensers(type, limit){
        // TODO
    }

    // Get list of DISPENSE actions
    getDispense(type, limit){
        // TODO
    }

    // Get list of FILE actions
    getFiles(type, limit){
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
                    LIMIT ` + limit;
        return [count, query];
    }    

}

module.exports = Database