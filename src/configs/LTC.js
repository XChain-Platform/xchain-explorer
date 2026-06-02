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
                address['burn']      = "LXChainBurnAddressXXXXXXXXXXSkrYkJ"; // Coin BURN address
                address['gas']       = "LXChainCN6yjHVqqS9tYzYVYZ8CCZcSx72"; // Coin GAS address 
                address['protocol']  = "Ldonate18tNZcVThKm5MX33EjvhaanJ6Mg"; // Protocol Donation address
                address['community'] = "Ldonate2io846q2e7q8dUArh3TNnaq9ENb"; // Community Donation address
                address['explorer']  = "Ldonate3FfyqbYQAYxo3qjFLcu28oUdAfn"; // Explorer Donation address
                break;
            case 'testnet':
                address['burn']      = "mxchainburnaddressXXXXXXXXXXa8EAfp"; // Coin BURN address
                address['gas']       = "mgashLN9oSvj2CUJYKWdNxh6VkamPg1Ges"; // Coin GAS address 
                address['protocol']  = "mybp5CceJvVV5tNCCiF7oBiZWko2fNkmnT"; // Protocol Donation address
                address['community'] = "muKEjejjXQvLY7Lp7Ecpn29gM2TCb5BLTF"; // Community Donation address
                address['explorer']  = "mzCXcxcECbY5aNSXsfWjzKQN1YwoefEcG8"; // Explorer Donation address
                break;
            case 'regtest':
                address['burn']      = "mxchainburnaddressXXXXXXXXXXa8EAfp"; // Coin BURN address
                address['gas']       = "mgas5QYE38Bg34hwEjFKaE7Gs536FARue4"; // Coin GAS address 
                address['protocol']  = "mgNY2ZXbnNEkRT5ZRF8yGamivrSX2QH97h"; // Protocol Donation address
                address['community'] = "n2DLJPppXUi8jC6fLiSkthZi2sc9UKiZHd"; // Community Donation address
                address['explorer']  = "myL7sZGPEG3LhFXn7RFCZ321r8bxgmgDBz"; // Explorer Donation address
                break;
        }
        config['address'] = address;

        return config;
    }
}