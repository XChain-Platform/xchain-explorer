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
 * XChain Explorer - COIN Configuration - Dogecoin (DOGE) 
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
            name : 'Dogecoin',
            tick : 'DOGE',
            site : 'https://dogecoin.com'
        };

        // Set network specific addresses
        switch(network){
            case 'mainnet':
                address['burn']      = "DChainBurnAddressXXXXXXXXXXXawc9pt"; // Coin BURN address
                address['gas']       = "DGasfpttCnTijuuoAdiJ9sXJjG7vQ5pMkW"; // Coin GAS address 
                address['protocol']  = "DDonate1RBcwGnCRNnVtwuCmQyWW1Gn25f"; // Protocol Donation address
                address['community'] = "DDonate2o3Sg4phybp92oFpkmv8S9ZhGSV"; // Community Donation address
                address['explorer']  = "DDonate3FCoUgi1bxW5r9c2p75uKTLw9qE"; // Explorer Donation address
                break;
            case 'testnet':
                address['burn']      = "nchainburnaddressXXXXXXXXXXXYKgF7W"; // Coin BURN address
                address['gas']       = "ngasn6zHFzJ72zpk3DBKmXhD2XtszujSDW"; // Coin GAS address 
                address['protocol']  = "ndonate1dE87UXUFf4gjyhPg7hfQRJXVXr"; // Protocol Donation address
                address['community'] = "ndonate2wev8vKDgvd1DHhtJtvkRbn2usJ"; // Community Donation address
                address['explorer']  = "ndonate3xHD56SnmmSxbjX7UMSPfN7XmVA"; // Explorer Donation address
                break;
            case 'regtest':
                address['burn']      = "mvs8WdppEhzQLxfcYwrr1eoKA2nUFi55ff"; // Coin BURN address
                address['gas']       = "mgasDTdKu5DsbW97qSRnE8raAuYpKMfmhg"; // Coin GAS address 
                address['protocol']  = "mzdg8wGxgP3Jk45FuZPspumCL3Ruup37ob"; // Protocol Donation address
                address['community'] = "mmXU8RU7q3BUsyT66rtw1H6P7B2ZZd9c5Y"; // Community Donation address
                address['explorer']  = "n1AvTJLLSA1NHamHd5KFj9mRn6BEcwnVbf"; // Explorer Donation address
                break;
        }
        config['address'] = address;
        
        return config;
    }
}