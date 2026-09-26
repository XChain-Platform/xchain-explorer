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
 * xchain.js
 *
 * Custom javascript for xchain explorer
 */

// Setup short alias to localStorage
let ls = localStorage;

const formatLinkDefault = formatLink;
function formatLinkWithActionFallback(url=null, text=null, icon=false, btn=false){
    if(/\/action\/(null|undefined)$/.test(String(url)))
        return '-';
    return formatLinkDefault(url, text, icon, btn);
}
formatLink = formatLinkWithActionFallback;
// formatLinkHtml takes the same guard: formatLink reaches the page through it,
// and markup labels (a hash, a badge) point at /action/ targets too.
const formatLinkHtmlDefault = formatLinkHtml;
formatLinkHtml = function(url=null, text=null, icon=false, btn=false){
    if(/\/action\/(null|undefined)$/.test(String(url)))
        return '-';
    return formatLinkHtmlDefault(url, text, icon, btn);
};

// Define XC Namespace object to track various properties
XC = {

    // Flag to show debug information in console
    debug: true,

    // Flag to indicate if we were unable to detect coin and used default coin
    default: false,

    // List of supported chains
    chains: { 
        'BTC': 'Bitcoin', 
        'LTC': 'Litecoin', 
        'DOGE': 'Dogecoin'
    },

    // List of supported coin networks
    networks: {
        mainnet: '',
        testnet: 'T',
        regtest: 'R'
    },

    // List of supported actions
    actions: [
        'addresses',
        'airdrops',
        'batches',
        'broadcasts',
        'callbacks',
        'destroys',
        'dispensers',
        'dispenses',
        'dividends',
        'files',
        'issues',
        'links',
        'lists',
        'messages',
        'mints',
        'orders',
        'order_cancels',
        'order_edits',
        'order_matches',
        'sends',
        'sleeps',
        'swaps',
        'swap_cancels',
        'swap_edits',
        'swap_matches',
        'sweeps'
    ],

    // List of supported fee prefences
    fee_preferences: {
        1: 'Fee is destroyed, lowering supply',
        2: 'Fee is donated to XChain protocol development', // default
        3: 'Fee is donated to XChain community development'
    },

    // List of supported dispenser prefences (who may open a dispenser for this address)
    dispenser_preferences: {
        1: 'Owner only',
        2: 'Anyone'
    },

    // List of supported sleep types
    sleep_types: {
        1: 'Address',
        2: 'Token'
    },

    // List of lists types
    list_types: {
        1: 'Token',
        2: 'Address'
    },

    // List of list edit types
    list_edit_types: {
        0: 'Create',
        1: 'Add',
        2: 'Remove'
    },

    // Supported message encryption methods. Keys are the protocol's
    // ENCRYPTION_METHOD enum, 1=ECIES / 2=ECDH / 3=AES, and the map MUST start at
    // 1 with none omitted (xchain-documentation/protocol/actions/message.md).
    encryption_methods: {
        1: 'Elliptic-Curve Integrated Encryption Scheme (ECIES)',
        2: 'Elliptic-Curve Diffie–Hellman (ECDH)',
        3: 'Advanced Encryption Standard (AES)'
    },

    // Placeholder for current coin, network, query, and query type
    coin:    null,
    name:    null,
    network: null,
    query:   null,
    type:    null,

    // Placeholder for xchain-explorer status
    status:  null,

    // Default coin price to 0.00 (USD)
    coin_price: 0.00,
    
    // Placeholer object to track datatables info
    datatables: {},

    // Placeholder for a list of data panels 
    panels: [],

    // Placeholders to track if we found token information and display the correct sections
    tokenInfoFound:    false,
    someTokenInfoFound: false,

    // Placeholder for misc page components
    pageInfo: {
        title: null,
        description: null,
        canonical: null,
        robots: null,
        // set the default title
        defaultTitle: 'XChain Platform Explorer'
    }
}

// Function to handle initializing page 
function initPage(){
    // Initialize the XChain request params
    setXChainParams();

    // Get basic information on the xchain explorer configuration
    getExplorerStatusInfo();

    // Initialize the main menu
    initMainMenu();

    // Handle restoring the preferred viewing mode
    var mode = ls.getItem('view-theme') || 'light';
    updateTheme(mode);

    // Handle theme switching
    $('#btn-dark-mode').click(function(){   updateTheme('dark');    });
    $('#btn-light-mode').click(function(){  updateTheme('light');   });

    // Update the default page title to include the chain and network
    if(!XC.default)
        XC.pageInfo.defaultTitle += ' | ' + XC.name + ' (' + XC.network + ') blockchain';

    // Handle updating the page meta-tags
    updatePageInfo();

    // Handle updating search network to current network
    $('#coin-search').val(XC.coin);

    // Handle doing search when user clicks search button
    $('#button-search').click(function(){  $('#form-search').submit(); });

    // Set the copyright as the current year
    $('#copyright-year').text(new Date().getFullYear())

    // Setup collapsible headers and restore last known collapse state
    setupCollapsibleHeaders();
}

// Handle initializing the main menu to display info and menu items based on coin
function initMainMenu(){
    // Update any /{COIN}/ links to the correct coin
    $('#main-menu a').each(function(){
        let el  = $(this),
            url = el.attr('href').replace('{COIN}',XC.coin);
            el.attr('href',url);
    });
    // Update header if we actually detected a valid coin/network config
    if(XC.default==false){

        // Update Network icon to current network
        let icon = getNetworkIcon();
        $('#network-icon').removeClass('fa-database').addClass(icon);

        // Update header logo to link to main network landing page
        if(XC.status && !isNull(XC.status.available[XC.coin]))
            $('#header-logo').attr('href','/' + XC.coin);

        // Show the 'Data' dropdown
        $('#data-menu').removeClass('d-none');

        // Update search form to include COIN
        $("#form-search [name='coin']").val(XC.coin);
    }  
}


$(document).ready(function(){

    // Handle initializing the page
    initPage();

    // Mount whatever the composed page declared, now that initPage() has
    // resolved the coin/network context every component reads. components.js
    // does not mount itself for exactly this reason: it loads first, so its own
    // ready handler would fire while XC.coin was still null.
    if(typeof XCComponents !== 'undefined')
        XCComponents.mountManifest();

    // Display debug information
    if(XC.debug)
        showXChainParams();

});
