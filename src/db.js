/* XChain Explorer Database Connector */

const mariadb = require('mariadb');

class Database {

    // Handle constructing a class instance
    constructor(explorer){
        // Setup alias to explorer configuration
        this.config = explorer.config

        // Create instance of the utility class
        this.util   = explorer.util;
    }

    // Handle initializing the database connection pool
    setupConnectionPool(){
        // Database connection information
        this.host   = host;
        this.port   = port;
        this.dbName = dbName;
        this.user   = user;
        this.pass   = pass;

        // Database connection parameters
        this.connectionParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port
        };

        // Database pool connection parameters
        this.connectionPoolParams = {
            host:     this.host,
            user:     this.user,
            password: this.pass,
            database: this.dbName,
            port:     this.port,
            // Connection options
            connectionLimit:  5,
            //connectTimeout: 0,
            insertIdAsNumber: true
        };

        // Setup pool of connections
        this.pool = mariadb.createPool(this.connectionPoolParams);
        this.transactionConnection = null;
    }
}

module.exports = Database