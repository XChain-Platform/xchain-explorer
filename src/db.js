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
                // Store the database name for easy reference in SQL queries
                connection.database = this.pools[config.coin].config.database;
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
        let [query, args] = await this.getQuery(db.database, config);
        // Run the database query
        try {
            const data = await db.query(query, args);
            return data;
        } catch (error) {
            this.util.logError('Error running sql query:', error);
            return false;
        }
        await this.releaseConnection();
    }

    // Handle getting a SQL query given a explorer config object
    async getQuery(database, config){
        let query = ''; // Placeholder for sql query
        let args  = []; // Placeholder for sql query arguments
        let data  = config.data;
        // Handle API queries
        if(config.type=='api'){
            let max   = this.getMaxMethodResults(data.method);
            let page  = (data.query.page  && this.util.isInteger(data.query.page))  ? data.query.page  : 1;
            let limit = (data.query.limit && this.util.isInteger(data.query.limit)) ? data.query.limit : max;
            // Set SQL query limit to page * limit
            limit     = limit * page;
            // Get the SQL query and list of arguments
            if(typeof this[data.method] === 'function')
                [query, args] = this[data.method](database, data.search, config.type, limit);
        }
        // Handle Explorer queries
        if(config.type=='explorer'){
            // coming soon
        }
        return [query, args];
    }

    /******************************************************************
     * General database functions
     *****************************************************************/

    // Method to determine the maximum results to return for each method
    getMaxMethodResults(method){
        // Define array of methods and the max results for each method
        let methods = {
            foo : 1000,
        }
        // Use defined method max or default max of 100
        let max = (this.util.isInteger(methods[method])) ? methods[method] : 100;
        return max;
    }

    /******************************************************************
     * API SQL Query Methods
     *****************************************************************/

    getBalances(database, search, type, limit){
        let query = `SELECT
                        *
                    FROM
                        ` + database + `.balances b
                    WHERE
                        b.address_id=?
                    LIMIT ` + limit;
        let args  = [2];
        return [query, args];
    }

}

module.exports = Database