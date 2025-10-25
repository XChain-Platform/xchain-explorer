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
 * XChain Explorer - COIN Configuration - Litecoin (LTC) 
 * 
 * This config file contains COIN specific configuration information
 * 
 ********************************************************************/

module.exports = {

    // Handle returning the coin configuration
    getConfig: function(network){

        // Define config objects
        let config  = {};
        let address = {};

        // Blockchain Information
        config['chain'] = {
            name : 'Litecoin',
            tick : 'LTC',
            site : 'https://litecoin.org'
        };

        // Set network specific addresses
        switch(network){
            case 'mainnet':
                address['burn']      = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Coin BURN address
                address['gas']       = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Coin GAS address 
                address['protocol']  = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Donation address
                address['community'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Donation address
                address['explorer']  = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Explorer Donation address
                break;
            case 'testnet':
                address['burn']      = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Coin BURN address
                address['gas']       = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Coin GAS address 
                address['protocol']  = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Donation address
                address['community'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Donation address
                address['explorer']  = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Explorer Donation address
                break;
            case 'regtest':
                address['burn']      = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Coin BURN address
                address['gas']       = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Coin GAS address 
                address['protocol']  = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Protocol Donation address
                address['community'] = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Community Donation address
                address['explorer']  = "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"; // Explorer Donation address
                break;
        }
        config['address'] = address;

        return config;
    }
}