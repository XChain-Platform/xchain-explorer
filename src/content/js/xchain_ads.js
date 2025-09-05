/*
 * ads.js
 *
 * Javascript to handle displaying ads on the site
 */


// Define array of sponsored text links which will be displayed on the site
var links = [{
    // CoinDaddy - Asset Registration Service
    icon: 'coindaddy-icon-20.png',
    link: 'https://www.coindaddy.io/services/asset-registration-service',
    text: '<b>CoinDaddy</b> enables you to <a class="text-link">register Counterparty tokens</a> for just $5/per registration and avoid the hassle of getting XCP from an exchange!',
},{
    // CoinDaddy - Asset Enhancement Service
    icon: 'coindaddy-icon-20.png',
    link: 'https://www.coindaddy.io/services/asset-enhancement-service',
    text: '<b>CoinDaddy</b> offers a service to <a class="text-link">enhance your token</a> with an image, links to your websites, and additional information for just $5/year!',
},{
    // CoinDaddy - Asset Transfer/Escrow Service
    icon: 'coindaddy-icon-20.png',
    link: 'https://www.coindaddy.io/services/asset-transfer-escrow-service',
    text: '<b>CoinDaddy</b> allows you to <a class="text-link">list your token ownership for sale</a>, get email alerts when a purchase offer is received, and negoiate anonymously!',
},{
    // Counterparty - General Donations
    icon: 'counterparty-icon-20.png',
    link: 'https://xchain.io/tx/1656210',
    text: '<b>Counterparty</b> is a <a class="text-link">community funded project</a> that progresses solely through the generous time and monetary donations of others.',
},{
    // MafiaWars - General info
    icon: 'mafiawars-icon-20.png',
    link: 'https://mafiawars.io',
    text: '<a href="https://mafiawars.io" target="_blank" class="text-link"><b>MafiaWars.io</b></a> - Become a mafia boss in one of the five crime families and get rewarded with <a href="/asset/MAFIACASH" class="text-link">MAFIACASH</a> each month just for playing the game!',
},{
    // FreeWallet - General info
    icon: 'freewallet-icon-20.png',
    link: 'https://freewallet.io',
    text: '<b>FreeWallet</b> is a free open-source wallet for Counterparty which runs on Windows, Macintosh, Linux, as well as all iOS and Android devices!',
},{
    // RarePepeWallet - General info
    icon: 'rarepepewallet-icon-20.png',
    link: 'https://rarepepewallet.com',
    text: 'You here for some of the dankest OG Bitcoin NFTs? Head over to <a class="text-link">Rare Pepe Wallet</a> to start building your rare pepe collection today!',
},{
    // Counterparty - XChain Donations
    icon: 'xchain-icon-20.png',
    link: 'https://xchain.io/tx/1656234',
    text: 'Enjoy using this website to view your NFTs and assets? Please consider <a class="text-link">donating</a> to help cover the operating costs of running this block explorer.',
},{
    // BOBDOBBS dispenser (J-Dog)
    icon: 'bobdobbs-20.png',
    link: 'https://xchain.io/tx/1609838',
    text: 'Looking for a super dank and limited rare pepe card? Check out this <a class="text-link">BOBDOBBS</a> card! Only 23 exist and one is available now for just 5 BTC!',
},{
    // Advertising on xchain.io
    icon: 'xchain-icon-20.png',
    link: 'https://xchain.io/advertise',
    text: 'Want to advertise your card or dispenser here? Take a look at our <a class="text-link">advertising page</a> and get in contact with us to start advertising today!',
},{
//     // Token.art NFT wallet 
//     icon: 'token-art-icon-20.png',
//     link: 'https://token.art/',
//     text: 'All your NFTs in one place! Use <a class="text-link">token.art</a> to view and showcase your Counterparty and Dogeparty NFTs on mobile and web. No wallet auth needed.'
// },{
//     // Pepe Flags (Jan-Feb)
//     icon: 'pepeflags-20.png',
//     link: 'https://pepeflags.art/',
//     text: 'Get your Pepe The Frog US State flag from the PepeFlags.Art project today!'
// },{
    // Modern Relics
    icon: 'modernrelics-icon-20.png',
    link: 'https://modernrelics.io/',
    text: 'Looking for the dankest 2014 assets on Counterparty and Dogeparty? Artists and collectors visit <a class="text-link">Modern Relics</a> today and discover what\'s new!'
},{
    // Rude Relics
    icon: 'ruderelics-icon-20.png',
    link: 'https://ruderelics.io/',
    text: 'Looking for the rudest 2014 assets on Counterparty and Dogeparty? Artists and collectors visit <a class="text-link">Rude Relics</a> today and discover what\'s new!'
}];


""

// Old ads archived for historical purposes
var old_ads = [{
//     // CoinDaddy - Public Development Servers
//     icon: 'coindaddy-icon-20.png',
//     link: 'https://www.coindaddy.io/public-development-servers',
//     text: '<b>CoinDaddy</b> operates <a class="text-link">public counterparty development servers</a> at no cost to the community to help developers get started using Counterparty!',
// },{
//     // Xchain - XCHAINPEPE
//     icon: 'xchain-icon-20.png',
//     link: 'https://xchain.io/asset/XCHAINPEPE',
//     text: '<b>XChain</b> is selling a special <a class="text-link">XCHAINPEPE card with hidden features</a>! All purchases go directly to help cover development and hosting costs.',
// },{
// },{
//     // Folding Coin - Distributions - Paid Ad (monthly)
//     icon: 'fldc-icon-20.png',
//     link: 'https://mergedfolding.net/',
//     text: 'Want to Airdrop a token? Reach out to gamers? Sponsor cancer research? Merged Folding distribution is open to anyone to distribute tokens!',
// },{
//     // Folding Coin - Distributions - Paid Ad (monthly)
//     icon: 'fldc-icon-20.png',
//     link: 'https://mergedfolding.net/',
//     text: 'Want to Airdrop a token? Reach out to gamers? Sponsor cancer research? Merged Folding distribution is open to anyone to distribute tokens!',
// },{
//     // Scarab Experiment - Paid Ad until 8/1/2018
//     icon: 'scarab-icon-20.jpg',
//     link: 'http://thescarabexperiment.org/',
//     text: '<b>SCARAB</b> is the the world’s first cryptocurrency AS art and crypto-based artist collective, SUBMIT ART to join!',
// },{
//     // Billfodl Ad #1 - Run until Feb 1, 2022
//     icon: 'billfodl-logo-20.png',
//     link: 'https://privacypros.io/products/the-billfodl/?afmc=ul&utm_campaign=ul&utm_source=leaddyno&utm_medium=affiliate',
//     text: 'The Billfodl backs up all of your counterparty assets in solid steel. Keep all your Pepes safe from fire, flood, and everything else!',
// },{
//     // Billfodl Ad #2 - Run until Feb 1, 2022
//     icon: 'billfodl-logo-20.png',
//     link: 'https://privacypros.io/products/the-billfodl/?afmc=uj&utm_campaign=uj&utm_source=leaddyno&utm_medium=affiliate',
//     text: 'Keep your counterparty assets safe from fire and flood! Grab a Billfodl, and back up your NFT seed phrase in solid steel. ',
// },{
//     // Blockfi referral link - Credit Card
//     icon: 'blockfi-icon-20.jpg',
//     link: 'https://blockfi.com/?ref=0c07801a',
//     text: 'Get a Blockfi Credit Card and get <a class="text-link">1.5% back in bitcoin on every purchase</a> and 3.5% for your first 3 months!',
// },{
//     // Blockfi referral link - Interest Account
//     icon: 'blockfi-icon-20.jpg',
//     link: 'https://blockfi.com/?ref=0c07801a',
//     text: 'Want to increase your BTC holdings? Deposit BTC in a Blockfi Interest Account and earn <a class="text-link">up to 4.5% APY</a> on deposited BTC funds!',
// },{
//     // XCPinata - Run until Feb 1, 2022
//     icon: 'xcpinata-20.png',
//     link: 'https://www.xcpinata.com/',
//     text: 'XCPinata is a historic asset art project with surprise airdrops for hodlers - collect art history!',
// },{
//     // Looneys Assets
//     icon: 'looney-20x20.png',
//     link: 'https://xchain.io/tx/2183119',
//     text: 'Buy <a class="text-link">LOON</a> for 0.05BTC and automatically receive all 9 of the earliest Looney\'s assets! 20% of proceeds go to Counterparty development.'
}];

// Handle picking a random sponsored link to display
function getSponsoredLink(list){
    var link = 'Unable to load a sponsored link';
    if(list && list.length!=0){
        item  = list[Math.floor(Math.random() * list.length)];
        link  = '<a href="' + item.link + '" target="_blank"><img src="/img/' + item.icon + '" class="icon-20"></a>'
        link += item.text.replace('<a ','<a href="' + item.link + '" target="_blank" ');
        link += '<a href="' + item.link + '" target="_blank" class="btn btn-xs btn-success pull-right"><i class="fa fa-xs fa-info-circle"></i> more info</a><div class="clear"></div>';
    }
    return link;
}


// Wait until everything is loaded before we start 
$(document).ready(function(){

    // Handle loading an sponsored link ad
    $('.xchain-sponsored-link').html('Sponsored Link: ' + getSponsoredLink(links));

    // Handle displaying all sponsored links if we detect a div with class 'all-sponsored-links'
    if($('.xchain-all-sponsored-links').length){
        var html = '';
        links.forEach(function(item){
            link  = '<div class="xchain-sponsored-link"><div class="clear">Sponsored Link: ';
            link += '<a href="' + item.link + '" target="_blank"><img src="/img/' + item.icon + '" class="icon-20"></a>'
            link += item.text.replace('<a ','<a href="' + item.link + '" target="_blank" ');
            link += '<a href="' + item.link + '" target="_blank" class="btn btn-xs btn-success pull-right"><i class="fa fa-xs fa-info-circle"></i> more info</a>';
            link += '</div></div>'
            html += link;
        });
        $('.xchain-all-sponsored-links').html(html);
    }

});