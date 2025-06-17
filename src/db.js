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
        let db    = await this.getConnection(config);
        // Get database query and arguments based on config object
        let [count, query, args] = await this.getQuery(config);
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
        let args  = []; // Placeholder for sql query arguments
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
                [count, query, args] = this[data.method](data.search, config.type, limit);
        }
        // Handle Explorer queries
        if(config.type=='explorer'){
            // coming soon
        }
        return [count, query, args];
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

    getBalances(search, type, limit){
        let count = `SELECT
                        count(*) as total
                    FROM
                        balances b
                        INNER JOIN index_tickers   t ON (t.id=b.tick_id)
                        INNER JOIN index_addresses a ON (a.id=b.address_id)
                    WHERE
                        a.address=?`;
        let query = `SELECT
                        a.address,
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
        // Balance searches are always by address, so hardcode args to search
        let args  = [search];
        return [count, query, args];
    }

}

module.exports = Database