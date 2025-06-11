/*********************************************************************
 * XChain Explorer Configuration
 * 
 * This config file contains explorer specific configuration data
 * 
 * COIN specific configuration data is loaded from configs/<COIN>.js
 *
 ********************************************************************/

const fs   = require('fs');
const util = require('./util.js');

// Define the port that the explorer will run on
const API_HOST = '127.0.0.1';
const API_PORT = 8080;
const API_USER = false;
const API_PASS = false;

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
        let coinConfig = {}

        // Pass forward explorer API information
        config['API'] = {
            host: API_HOST,
            port: API_PORT,
            user: API_USER,
            pass: API_PASS
        }

        // Define list of acceptable COIN networks
        config['COINS'] = ['BTC', 'LTC', 'DOGE'];

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

        }

        return config;
    },

}