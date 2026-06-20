/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * 
 * XChain Explorer - COIN Configuration - Bitcoin (BTC) 
 * 
 * This config file contains COIN specific configuration information
 * 
 ********************************************************************/

module.exports = {

    getConfig: function(network){

        let config  = {};
        let address = {};

        config['chain'] = {
            name : 'Bitcoin',
            tick : 'BTC',
            site : 'https://bitcoin.org'
        };

        switch(network){
            case 'mainnet':
                address['burn']      = "1XChainBurnAddressXXXXXXXXXbRsd2N"; // Coin BURN address
                address['gas']       = "1XChain3M4uRwcHqt4XuhVBUQ8cL4qQsA"; // Coin GAS address
                address['protocol']  = "1Donate1GERVKPW6GFQcnGeTa8dgL6Abyp"; // Protocol Donation address
                address['community'] = "1Donate2LkbBrsanwCVRPWZCXAqQcvcqGz"; // Community Donation address
                address['explorer']  = "1Donate3GBGSZzzrS9U9gUgURYKscAE6Yn"; // Explorer Donation address
                break;
            case 'testnet':
                address['burn']      = "mxchainburnaddressXXXXXXXXXXa8EAfp"; // Coin BURN address
                address['gas']       = "mgassdEpzH2AuKGK9W5FZh8drWYKrpXk6D"; // Coin GAS address
                address['protocol']  = "mfztXKX1HeVdCQf6pDCZFEzo5i5wYNHAM6"; // Protocol Donation address
                address['community'] = "myBbbZ4t7BPoyNcT4sHtFwZDuiyYGDXLQM"; // Community Donation address
                address['explorer']  = "n1jbLKMrhvFae7NwTj37ZtkN4uPy29o9aM"; // Explorer Donation address
                break;
            case 'regtest':
                address['burn']      = "mxchainburnaddressXXXXXXXXXXa8EAfp"; // Coin BURN address
                address['gas']       = "mgash6jYSKAR3Q5HPpDgNX2BYr18q9N6GQ"; // Coin GAS address
                address['protocol']  = "muYHF9MMnK6Nmd5zx7EBtqEYZdaf2Xy8JX"; // Protocol Donation address
                address['community'] = "mkQd27aJSqsQ666z1Q4MLFmd3Ybqzy3TNw"; // Community Donation address
                address['explorer']  = "mrDH7rA2ZmGoh4Qx5guhDBJbZotUd6XyVH"; // Explorer Donation address
                break;
        }
        config['address'] = address;

        return config;
    }
}