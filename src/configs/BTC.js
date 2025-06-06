/*********************************************************************
 * XChain COIN Configuration - Bitcoin (BTC) 
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
            name : 'Bitcoin',
            tick : 'BTC',
            site : 'https://bitcoin.org'
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