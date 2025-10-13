/*********************************************************************
 * XChain Explorer Configuration
 * 
 * This config file contains explorer specific configuration data
 * 
 * COIN specific configuration data is loaded from configs/<COIN>.js
 *
 ********************************************************************/

const fs   = require('fs');
const path = require('path');
const util = require('./util.js');

// Define the API config 
const API_HOST       = '127.0.0.1';
const API_USER       = false;
const API_PASS       = false;
const API_PORT_HTTP  = 8080;
const API_PORT_HTTPS = 8081;

// Define SSL Configuration
const API_SSL  = {
    key:  fs.readFileSync(path.join(__dirname, "ssl", "private.pem")),
    cert: fs.readFileSync(path.join(__dirname, "ssl", "cert.pem")),
    ca:   fs.readFileSync(path.join(__dirname, "ssl", "ca.pem"))
};

module.exports = {

    // Handle returning the current indexer configuration
    getConfig: function(){

        // Create instance of the utility class
        const configUtil = new util();

        // Parse in the node config from the environmental variables 
        // TODO: Verify this works once Javier has the code written into xchain-node or xchain-hub
        const nodeConfig = process.env.NODE_CONFIG;

        // Parse in the file config file (if it exists)
        let fileConfig = false;
        try {
            fileConfig = require('./config.json');
        } catch (error){
            console.log('caught error :' + error);
        }

        // Determine the config to used (file then node)
        const jsonConfig = (fileConfig) ? fileConfig : nodeConfig;

        // Bail out if we dont have a valid config to use
        if(configUtil.isNull(jsonConfig))
            configUtil.throwError('No valid configuration information detected');

        // Define explorer and COIN config objects
        let config     = {};
        let coinConfig = {};

        // Define list of COINs supported in XChain Platform (BTC, LTC, DOGE, etc)
        config['COIN_NETWORKS'] = ['BTC','LTC','DOGE'];

        // Define list of acceptable coin Prefixes (T=Testnet, R=Regtest)
        config['COIN_PREFIXES'] = {
            'mainnet': '',
            'testnet': 'T',
            'regtest': 'R'
        };

        // Define list of COIN networks supported in XChain Platform (BTC, tBTC, rBTC, etc)
        config['COIN_SUPPORTED'] = [];
        for(let coin of config['COIN_NETWORKS']){
            for(let network in config['COIN_PREFIXES']){
                config['COIN_SUPPORTED'].push(config['COIN_PREFIXES'][network] + coin);
            }
        }

        // Define list of COIN networks available in this explorer instance
        config['COIN_AVAILABLE'] = [];

        // Pass forward explorer API information
        config['API'] = {
            host: API_HOST,
            user: API_USER,
            pass: API_PASS,
            ssl:  API_SSL,
            port: {
                http:  API_PORT_HTTP,
                https: API_PORT_HTTPS
            }
        }

        // Loop through all coins and networks in the json config and load up the coin/network specific data
        for(let info of jsonConfig.configs ){

            // Define COIN specific configuration file
            let coinFile   = '/XChainExplorer/src/configs/' + info.coin + '.js';

            // Load COIN specific configuration file, or throw error
            if(fs.existsSync(coinFile)){
                let cfg    = require(coinFile);
                coinConfig = cfg.getConfig(info.network);
            } else {
                let error = 'Missing COIN config file : ' + coinFile;
                throw new Error(error);
            }

            // Define COIN information object
            if(!config[info.coin]){
                config[info.coin] = {
                    chain: coinConfig.chain
                };
            }

            // Define NETWORK information object
            if(!config[info.coin][info.network]){
                config[info.coin][info.network] = {
                    database: {
                        indexer: info.indexer,
                        decoder: info.decoder
                    },
                    address: coinConfig.address
                };
            }

            // Add COIN and NETWORK to list of supported coins to be used as explorer prefixes
            config['COIN_AVAILABLE'].push(config['COIN_PREFIXES'][info.network] + info.coin);
        }
            
        return config;
    },

}