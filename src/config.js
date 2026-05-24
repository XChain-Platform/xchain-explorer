/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Explorer - Configuration
 * 
 * This config file contains explorer specific configuration data
 * 
 * COIN specific configuration data is loaded from configs/<COIN>.js
 *
 ********************************************************************/

// Load required libraries
const fs                    = require('fs');
const path                  = require('path');
const util                  = require('./utility.js');
const xchainHubConnector    = require('./XChainHubConnector')

// Define the API config 
const API_HOST       = '127.0.0.1';
const API_USER       = false;
const API_PASS       = false;
const API_PORT_HTTP  = 8080;
const API_PORT_HTTPS = 8081;

//interval to update the config
const UPDATE_CONFIG_INTERVAL = 60000 //one minute seems ok because adding new coin/network nodes won't occur so often

// Define SSL Configuration (SSL_DIR env var overrides the default src/ssl/ path).
// SSL files are untracked (see .gitignore *.pem); when absent we run HTTP-only
// so dev/regtest stacks come up without operator-provided certs.
const SSL_DIR  = process.env.SSL_DIR || path.join(__dirname, "ssl");
let API_SSL = null;
try {
    API_SSL = {
        key:  fs.readFileSync(path.join(SSL_DIR, "private.pem")),
        cert: fs.readFileSync(path.join(SSL_DIR, "cert.pem")),
        ca:   fs.readFileSync(path.join(SSL_DIR, "ca.pem"))
    };
} catch (err) {
    console.log("SSL files not found in " + SSL_DIR + " — HTTPS server will not start");
}

//This will hold the connection with the xchain-hub if a url and port are provided
let hubConnector = null;
//This will hold the last config string value obtained
let lastObtainedConfigValue = null;
//This will hold the last config created from the last obtained value
let configCache = null;
//Emisor for config changed event
const configChangedEmisor = new EventTarget();

module.exports = {

    startSync: function(endpoints){
        // Bare `getConfig` is not in lexical scope here — it lives on
        // module.exports. Arrow + `this` keeps the binding so the
        // scheduled tick actually refreshes the cache.
        setInterval(() => this.getConfig(endpoints, false), UPDATE_CONFIG_INTERVAL); //cache=false to replace the current cache
    },

    // Handle returning the current indexer configuration
    // endpoints: array of URL strings or legacy (url, port) pair
    getConfig: async function(endpoints=null, cache=true){
        if (cache && configCache){
            return configCache
        } else {
            // Define explorer and COIN config objects
            let config     = {};
            let coinConfig = {};
            // Define list of COINs supported in XChain Platform (BTC, LTC, DOGE, etc)
            config['COIN_NETWORKS'] = {
                BTC:  'Bitcoin',
                LTC:  'Litecoin',
                DOGE: 'Dogecoin'
            };

            // Define list of acceptable coin Prefixes (T=Testnet, R=Regtest)
            config['COIN_PREFIXES'] = {
                'mainnet': '',
                'testnet': 'T',
                'regtest': 'R'
            };

            let coinNetworksKeys = Object.keys(config['COIN_NETWORKS'])
            
            
            // Create instance of the utility class
            const configUtil = new util();
            let jsonConfig = null

            //If endpoints are provided, connect to the xchain-hub
            if (endpoints){
                if (!hubConnector){
                    hubConnector = new xchainHubConnector(endpoints)
                }
                
                jsonConfig = await hubConnector.getAllConfig()

                // Compare by JSON content, not reference. getAllConfig returns
                // a fresh object every call, so the prior `!=` check fired on
                // every refresh — triggering downstream pool rebuilds 60×/hour
                // even when the hub returned identical config. Stringify lets
                // unchanged content short-circuit out via the else branch.
                const fetchedStr = JSON.stringify(jsonConfig)
                if (fetchedStr !== lastObtainedConfigValue){
                    lastObtainedConfigValue = fetchedStr
                    
                    let newJsonConfig = []
                    for (let nextCoin in jsonConfig){
                        let nextCoinLabel = coinNetworksKeys.find(key => config['COIN_NETWORKS'][key].toLowerCase() == nextCoin)
                        
                        for (let nextNetwork in jsonConfig[nextCoin]){
                            let coinNetworkJson = {"coin":nextCoinLabel, "network":nextNetwork}
                        
                            for (let nextService in jsonConfig[nextCoin][nextNetwork]){
                                coinNetworkJson[nextService] = jsonConfig[nextCoin][nextNetwork][nextService]
                            }
                            newJsonConfig.push(coinNetworkJson)
                        }
                    }
                    
                    jsonConfig = {"configs":newJsonConfig}
                    this.triggerConfigChanged();
                } else {
                    return configCache
                }
            } else {
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
                jsonConfig = (fileConfig) ? fileConfig : nodeConfig;
            }
            
            // Bail out if we dont have a valid config to use
            if(configUtil.isNull(jsonConfig))
                configUtil.throwError('No valid configuration information detected');

            // Define list of COIN networks supported in XChain Platform (BTC, tBTC, rBTC, etc)
            config['COIN_SUPPORTED'] = {};
            for(let coin in config['COIN_NETWORKS']){
                for(let network in config['COIN_PREFIXES']){
                    let prefix = config['COIN_PREFIXES'][network],
                        code   = prefix + coin,
                        name   = config['COIN_NETWORKS'][coin] + ' (' + network + ')';
                    config['COIN_SUPPORTED'][code] = name;
                }
            }

            // Define list of COIN networks available in this explorer instance
            config['COIN_AVAILABLE'] = {};

            /************************************************************** 
             * Indexer Configs
             * 
             * Set any configs from the indexer that we need in the explorer
             * TODO: See if we can clean this up by passing indexer config to explorer
             *************************************************************/
            config['DISPENSER_LIST_DELAY'] = 3600;

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

            // Pass forward optional icon-downloader settings (see IconDownloader.js)
            if(jsonConfig.iconDownload)
                config['iconDownload'] = jsonConfig.iconDownload;

            // Loop through all coins and networks in the json config and load up the coin/network specific data
            for(let info of jsonConfig.configs ){

                // Define COIN specific configuration file
                let coinFile   = path.join(__dirname, 'configs', info.coin + '.js');

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

                // Define NETWORK information object.
                // Hub config flattens services keyed as 'xchain-indexer' /
                // 'xchain-decoder'; legacy config.json uses 'indexer' /
                // 'decoder' directly. Accept either so both paths work.
                if(!config[info.coin][info.network]){
                    config[info.coin][info.network] = {
                        database: {
                            indexer: info['xchain-indexer'] || info.indexer,
                            decoder: info['xchain-decoder'] || info.decoder
                        },
                        address: coinConfig.address
                    };
                }

                let prefix = config['COIN_PREFIXES'][info.network],
                    code   = prefix + info.coin,
                    name   = info.coin + ' (' + info.network + ')';
                config['COIN_AVAILABLE'][code] = name;

            }
            
            configCache = config
            return config;
        }
    },
    
    //Adds a listener to the config change event
    onConfigChanged: function(callback){
      configChangedEmisor.addEventListener("changed", callback);
    },

    //Triggers the config changed event
    triggerConfigChanged: function(){
      const event = new CustomEvent("changed");
      configChangedEmisor.dispatchEvent(event);
    }
}