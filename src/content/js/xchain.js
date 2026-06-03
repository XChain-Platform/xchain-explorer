/*
 * xchain.js
 *
 * Custom javascript for xchain explorer
 */

// Setup short alias to localStorage
let ls = localStorage;

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

    // List of supported message encryption methods
    encryption_methods: {
        1: 'Elliptic-Curve Diffie–Hellman (ECDH)',
        2: 'Advanced Encryption Standard (AES)'
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

// Function to handle setting current COIN and QUERY values
function setXChainParams(coin){
    // Strip any HTML content from the pathname and split it up into its various parts
    let path = String(stripHtml(window.location.pathname)).split('/');
    // Set the coin based on passed coin or path
    if(isNull(coin)){
        let query = new URLSearchParams(window.location.search);
        let qcoin  = query.get('coin');
        coin = (!isNull(qcoin)) ? qcoin : path[1];
    }
    // Try to set XC.coin (default to BTC)
    XC.coin = getXChainParam(coin,'coin');
    if(isNull(XC.coin)){
        XC.default = true;
        XC.coin    = 'BTC';
    }
    // Set the remaining XChain Params (chain, name, network)
    XC.chain   = getXChainParam(XC.coin,'chain');
    XC.name    = getXChainParam(XC.coin,'name');
    XC.network = getXChainParam(XC.coin,'network');
    // Set query and query type to a valid value based on path
    let type  = String(path[2]).toLowerCase();
    let query = path[path.length-1];
    if(['block','address','token','action','transaction'].includes(type)){
        if((['block','action'].includes(type)  && isNumeric(query)) ||
           (type=='address' && isCryptoAddress(query)) ||
           (type=='token'   && typeof(query)=='string')){
            XC.type  = type;
            XC.query = query;
        }
        // Set type to either tx_index or tx_hash for transactions
        if(type=='transaction'){
            XC.query = query;
            XC.type  = (isNumeric(query)) ? 'tx_index' : 'tx_hash';
        }
    } else if(type=='market'){
        XC.type  = type;
        XC.query = path[3] + '/' + path[4];
    }
}

// Function to return XChain param data for a given coin
function getXChainParam(coin, type){
    let value = null;
    for(let chain in XC.chains){
        for(let network in XC.networks){
            let name = String(XC.networks[network] + chain).toUpperCase();;
            if(String(coin).toUpperCase()==name){
                if(type=='coin')
                    value = name;
                if(type=='chain')
                    value = chain;
                if(type=='network')
                    value = network;
                if(type=='name')
                    value = XC.chains[chain];
                break;
            }
        }
    }
    return value;
}


// Function to handle making a URL a url valid by ensuring it starts with http or https
function getValidUrl( url ){
    var re1 = /^http:\/\//,
        re2 = /^https:\/\//;
    if(!(re1.test(url)||re2.test(url)))
        url = 'http://' + url;
    return url;
}

// Function to handle converting from hex to a string
function hex2string(hexx) {
    var hex = hexx.toString();//force conversion
    var str = '';
    for (var i = 0; (i < hex.length && hex.substr(i, 2) !== '00'); i += 2)
        str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return str;
}

// Function to handle converting a base64 string to a hex
function base64ToHex(str) {
    const raw = atob(str);
    let result = '';
    for (let i = 0; i < raw.length; i++) {
        const hex = raw.charCodeAt(i).toString(16);
        result += (hex.length === 2 ? hex : '0' + hex);
    }
    return result;
}

// Handle hiding and showing collapse content and changing collapse icon
function toggleCollapseContent(id, init){
    let ls     = localStorage,
        el     = $('#' + id);
        name   = el.attr('data-bs-target').replace('#',''),
        icon   = el.find('.collapse-icon'),
        hide   = (icon.hasClass('fa-chevron-up')) ? true : false,
        cls    = (hide) ? 'fa-chevron-down' : 'fa-chevron-up',
        qrcode = $('.address_qrcode');
    if(init){
        if(ls.getItem(name + '-collapsed')=='true'){
            $('#' + name).removeClass('show');
            qrcode.hide();
            icon.removeClass('fa-chevron-up').addClass('fa-chevron-down');
        }
    } else {
        icon.removeClass('fa-chevron-up fa-chevron-down').addClass(cls);
        ls.setItem(name + '-collapsed', hide);
        if(hide){
            qrcode.hide();
        } else {
            qrcode.show();
        }
    }
}

// Simple function to change bootstrap theme
function updateTheme(mode){
    var ls   = localStorage,
        body = $('body');
    body.attr('data-bs-theme',mode);
    ls.setItem('view-theme',mode)
}

// Return nice display string for token amount
function formatAmount(amount=null){
    var str = String(amount).split('.');
    if(str[0].length>=4)
        str[0] = str[0].replace(/(\d)(?=(\d{3})+$)/g, '$1,');
    return str.join('.');
}

// Return nice display string for token locks
function formatLocks(locks=null){
    var lock = String(locks).split('|'),
        html = '';
    if(lock[0]==1) html += '<i class="fa fa-coin pe-1"         title="Max Supply"></i>';
    if(lock[1]==1) html += '<i class="fa fa-print pe-1"        title="Mint"></i>';
    if(lock[2]==1) html += '<i class="fa fa-bank pe-1"         title="Mint Supply"></i>';
    if(lock[3]==1) html += '<i class="fa fa-coins pe-1"        title="Max Mint"></i>';
    if(lock[4]==1) html += '<i class="fa fa-circle-info pe-1"  title="Description"></i>';
    if(lock[6]==1) html += '<i class="fa fa-snooze pe-1"       title="Sleep"></i>';
    if(lock[7]==1) html += '<i class="fa fa-recycle pe-1"      title="Callback"></i>';
    return html;
}

// Return path to the token icon
function getTokenIcon(token){
    let icon = '/icon/' + XC.coin + '/' + XC.network + '/' + token + '.png';
    return icon
}


// Return nice display string for links
function formatLink(url=null, text=null, icon=false, btn=false){
    // console.log('text=',text);
    var html = '',
        cls  = (btn) ? 'badge bg-success float-end text-decoration-none' : '';
        html += '<a href="' + url + '" class="' + cls + '">';
    if(icon && !isNull(icon))
        html += '<img src="' + getTokenIcon(icon) + '" class="icon-20 ms-1 me-1">';
    if(text)
        html += text;
    html += '</a>'
    return html;
}

// Return a truncated hex string (hash / pubkey / request_id) with a hover title
// showing the full value. Keeps long 64/128-hex identifiers readable in tables.
function formatHash(hash, len=16){
    if(isNull(hash)) return '';
    let str = String(hash);
    if(str.length <= len) return str;
    return '<span title="' + str + '">' + str.substring(0, len) + '…</span>';
}

// Return a nicely formatted amount with token links
function formatLinkAmount(url=null, text=null, icon=false, amount=false){
    let html = '';
    if(!isNull(icon))
        html += formatLink(url, null, icon);
    if(!isNull(amount))
        html += formatAmount(amount);
    if(!isNull(text))
        html += ' ' + formatLink(url, text);
    return html;
}

// Badge rendered in place of an amount cell when a row represents a
// token-ownership sale (ORDER/SWAP/DISPENSER with GIVE_OWNERSHIP=1 or
// GET_OWNERSHIP=1). The ownership record itself is the asset; there is
// no balance amount to display.
function ownershipBadge(){
    return '<span class="badge bg-warning text-dark" title="Token-ownership transfer">&#128081; Ownership</span>';
}

// Handle getting the network icon using the coin name and network
function getNetworkIcon(name=null, network=null){
    // Set defaults for name/network
    if(isNull(name))    name = XC.name;
    if(isNull(network)) network = XC.network;
    let icon = String('fa-xchain-' + name + '-' + network).toLowerCase();
    return icon;
}

// Return nice display string for timestamps
function formatLivestamp(timestamp=null){
    var html = '';
    html += '<span data-livestamp='  + timestamp + ' class="nowrap"></span>';
    return html;
}

// Build out nice links to view transactions in other explorers
function formatTransactionLink(tx){
    let html = tx;
    let coin = XC.coin;
    html += '<a href="/' + XC.coin + '/transaction/'                     + tx + '" target="_blank" title="XChain"       ><i class="ms-1 fa fa-lg icon-20 fa-xchain"></i></a>';
    if(coin=='BTC'){
        html += '<a href="https://mempool.space/tx/'                    + tx + '" target="_blank" title="Mempool.space"><i class="ms-1 fa fa-lg fa-mempool"></i></a>';
        html += '<a href="https://blockstream.info/tx/'                 + tx + '" target="_blank" title="Blockstream"  ><i class="ms-1 fa fa-lg fa-blockstream"></i></a>';
        html += '<a href="https://live.blockcypher.com/btc/tx/'         + tx + '" target="_blank" title="BlockCypher"  ><i class="ms-1 fa fa-lg fa-blockcypher"></i></a>';
        html += '<a href="https://blockchair.com/bitcoin/transaction/'  + tx + '" target="_blank" title="BlockChair"   ><i class="ms-1 fa fa-lg fa-blockchair"></i></a>';
        html += '<a href="https://chain.so/tx/BTC/'                     + tx + '" target="_blank" title="SoChain"      ><i class="ms-1 fa fa-lg fa-sochain"></i></a>';
    } else if(coin=='TBTC'){
        // Testnet 3 
        // html += '<a href="https://mempool.space/testnet3/tx/'           + tx + '" target="_blank" title="Mempool.space"><i class="ms-1 fa fa-lg fa-mempool"></i></a>';
        // html += '<a href="https://blockstream.info/testnet/tx/'         + tx + '" target="_blank" title="Blockstream"  ><i class="ms-1 fa fa-lg fa-blockstream"></i></a>';
        // html += '<a href="https://live.blockcypher.com/btc-testnet/tx/' + tx + '" target="_blank" title="BlockCypher"  ><i class="ms-1 fa fa-lg fa-blockcypher"></i></a>';
        // Testnet 4
        html += '<a href="https://mempool.space/testnet4/tx/'           + tx + '" target="_blank" title="Mempool.space"><i class="ms-1 fa fa-lg fa-mempool"></i></a>';
        html += '<a href="https://blockstream.info/testnet/tx/'         + tx + '" target="_blank" title="Blockstream"  ><i class="ms-1 fa fa-lg fa-blockstream"></i></a>';
        html += '<a href="https://chain.so/tx/BTCTEST/'                 + tx + '" target="_blank" title="SoChain"      ><i class="ms-1 fa fa-lg fa-sochain"></i></a>';
    } else if(coin=='LTC'){
        html += '<a href="https://live.blockcypher.com/ltc/tx/'         + tx + '" target="_blank" title="BlockCypher"  ><i class="ms-1 fa fa-lg fa-blockcypher"></i></a>';
        html += '<a href="https://blockchair.com/litecoin/transaction/' + tx + '" target="_blank" title="BlockChair"   ><i class="ms-1 fa fa-lg fa-blockchair"></i></a>';
        html += '<a href="https://litecoinspace.org/tx/'                + tx + '" target="_blank" title="LitecoinSpace"><i class="ms-1 fa fa-lg fa-litecoinspace"></i></a>';
        html += '<a href="https://chain.so/tx/LTC/'                     + tx + '" target="_blank" title="SoChain"      ><i class="ms-1 fa fa-lg fa-sochain"></i></a>';
    } else if(coin=='TLTC'){
        html += '<a href="https://litecoinspace.org/testnet/tx/'        + tx + '" target="_blank" title="LitecoinSpace"><i class="ms-1 fa fa-lg fa-litecoinspace"></i></a>';
        html += '<a href="https://chain.so/tx/LTCTEST/'                 + tx + '" target="_blank" title="SoChain"      ><i class="ms-1 fa fa-lg fa-sochain"></i></a>';
    } else if(coin=='DOGE'){
        html += '<a href="https://live.blockcypher.com/doge/tx/'        + tx + '" target="_blank" title="BlockCypher"  ><i class="ms-1 fa fa-lg fa-blockcypher"></i></a>';
        html += '<a href="https://blockchair.com/dogecoin/transaction/' + tx + '" target="_blank" title="BlockChair"   ><i class="ms-1 fa fa-lg fa-blockchair"></i></a>';
        html += '<a href="https://chain.so/tx/DOGE/'                    + tx + '" target="_blank" title="SoChain"      ><i class="ms-1 fa fa-lg fa-sochain"></i></a>';
    } else if(coin=='TDOGE'){
        html += '<a href="https://chain.so/tx/DOGETEST/'                + tx + '" target="_blank" title="SoChain"      ><i class="ms-1 fa fa-lg fa-sochain"></i></a>';
    }
    $('#tx-hash').html(html);
}

// Quick function to get a status from an object
function getTransactionStatus(rec, depth=1){
    if(rec.status) 
        return rec.status;
    else if(depth>=100)
        return null;
    return getTransactionStatus(rec[Object.keys(rec)[0]], (depth+1));
}

// Determine if value is null or undefined or empty
function isNull(value){
    return (value === null || value === undefined || value==='');
}


// Determine if a value is numeric
function isNumeric(value){
    return typeof value === 'bigint' || (!isNaN(parseFloat(value)) && isFinite(value));
}

// Handle doing VERY lose validation on an address
// TODO: Clean this up to actually verify crypto addresses using crypto library
function isCryptoAddress(address){
    let len = String(address).length;
    // Check P2PKH (26-35 chars)
    if(len>=26 && len<=35)
        return true;
    // Check Segwit (42 chars)
    if(len==42)
        return true;
    return false;
}

// Handle updating coin network information and passing it to callback function for processing
// NOTE: This information is cached in localStorage and updated every 5 minutes as
function getCoinNetworkInfo(callback, force){
    let name   = XC.coin + '-network-info',
        info   = ls.getItem(name),
        json   = (info) ? JSON.parse(info) : false;
        last   = (json && json.timestamp) ? json.timestamp : 0,
        ms     = 300000, // 5 minutes
        update = ((parseInt(last) + ms) <= Date.now()||force) ? true : false;
    // Skip request for network info if network is not currently supported by the explorer
    if(XC.status && isNull(XC.status.available[XC.coin]))
        return;
    // Set the coin price from the last known price
    if(json && json.coin && json.coin.price && json.coin.price.usd)
        XC.coin_price = json.coin.price.usd;
    // Define callback function to handle processing data once we have it
    let cb = function(json){
        if(json){
            // Set the current USD price for COIN
            XC.coin_price = json.coin.price.usd;
            // Handle processing the callback if we have one
            if(typeof callback=='function')
                callback(json);
        }
    }
    // Do not update if we already have a pending request
    if(XC.pendingNetworkInfoRequest)
        update = false;
    if(update){
        // Set flag to indicate we have a pending request to prevent duplicate requests
        XC.pendingNetworkInfoRequest = true;
        if(XC.debug)
            console.log('Updating network information...');
        // Request updated network information and store the response in localStorage
        loadApiData(XC.coin, 'network', null, null, function(json){
            XC.pendingNetworkInfoRequest = false;
            json.timestamp = Date.now();
            ls.setItem(name,JSON.stringify(json));
            cb(json);
        });
    } else {
        // If we have a pending Network request, try again in 1000ms
        if(XC.pendingNetworkInfoRequest){
            setTimeout(function(){
                getCoinNetworkInfo(callback);
            }, 1000);
        } else {
            cb(json);
        }
    }
}

// Handle updating xchain-explorer configuration information and passing it to callback function for processing
// NOTE: This information is cached in localStorage and updated every 5 minutes
function getExplorerStatusInfo(callback, force){
    let name   = 'xchain-explorer-status-info',
        info   = ls.getItem(name),
        json   = (info) ? JSON.parse(info) : false;
        last   = (json && json.timestamp) ? json.timestamp : 0,
        ms     = 300000, // 5 minutes
        update = ((parseInt(last) + ms) <= Date.now()||force) ? true : false;
    // Set the coin price from the last known price
    if(json)
        XC.status = json;
    // Define callback function to handle processing data once we have it
    let cb = function(json){
        if(json){
            // Update the xchain-explorer status
            XC.status = json;
            // Get basic information on the COIN network
            getCoinNetworkInfo();
            // Handle processing the callback if we have one
            if(typeof callback=='function')
                callback(json);
        }
    }
    // Do not update if we already have a pending request
    if(XC.pendingStatusInfoRequest)
        update = false;
    if(update){
        // Set flag to indicate we have a pending request to prevent duplicate requests
        XC.pendingStatusInfoRequest = true;
        if(XC.debug)
            console.log('Updating status information...');
        // Request updated status information and store the response in localStorage
        loadApiData(XC.coin, 'status', null, null, function(json){
            XC.pendingStatusInfoRequest = false;
            json.timestamp = Date.now();
            ls.setItem(name,JSON.stringify(json));
            cb(json);
        });
    } else {
        // If we have a pending Network request, try again in 1000ms
        if(XC.pendingStatusInfoRequest){
            setTimeout(function(){
                getExplorerStatusInfo(callback);
            }, 1000);
        } else {
            cb(json);
        }
    }
}


// Handle setting up listeners on action dropdowns to load content when clicked 
function setupActionListeners(){
    for(let action of XC.panels){
        $('#tab-dropdown-' + action).click(function(){
            let load = true;
            // Hide all tab panels and only show the active one
            $('.tab-pane').removeClass('active show');
            $('#tab-pane-' + action).addClass('active show');
            // Update datatable header to show correct icon and text for the data
            var icon = $(this).find('i').attr('class'),
                text = $(this).text();
            // Skip loading data in certain cases (like actions where all data already exists in the API call)
            if(['action','tx_hash','tx_index'].includes(XC.type)){
                load = false;
                if(action=='info'){
                    icon = 'fa fa-info-circle';
                    text = 'Action Details';
                }
            }
            $('#datatable-header-icon').removeClass().addClass(icon);
            $('#datatable-header-text').text(text);
            // Handle initilizing the datatable for this action
            if(!XC.datatables[action] && load){
                XC.datatables[action] = {};
                if(XC.debug)
                    console.log('loading ' + action + ' data...');
                // Set flag to indicate the tab has been loaded already
                let query  = (isNull(XC.query)) ? null : XC.query,
                    type   = (isNull(XC.type)) ? null : XC.type;
                // Set history to recent type if typ eis not already set
                if(action=='history' && isNull(type))
                    type   = 'recent';
                // Load data for the given action into the datatable
                loadDatatablesData(XC.coin, action, query, type);
            }
        });
    }
    // Handle setting up listeners on chart dropdowns 
    if(!isNull(XC.charts)){
        for(let chart of XC.charts){
            $('#chart-dropdown-' + chart).click(function(){
                loadMarketChart(chart);
            });
        }
    }
}

// Handle setting up collapsible headers and restoring the last known state
function setupCollapsibleHeaders(){
    // Detect header collapse clicks and change icon
    $('.collapse-header').click(function(){ toggleCollapseContent($(this).attr('id')); });
    // Restore collapsed header states
    $('.collapse-header').each(function(){ toggleCollapseContent($(this).attr('id'), true); });
}

/******************************************************************
 * Basic Calculator (BC) math functions
 ******************************************************************/

// Handle converting a string number to an integer or float
function bcnum(num){
    if(String(num).indexOf('.')!=-1)
        return parseFloat(num);
    else
        return parseInt(num);
}

// Handle returning a number to a given decimal point precision
function bcformat(num, decimals){
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return math.format(bcnum(num),{notation: 'fixed', precision: d});
}

// Handle subtracting 2 big numbers
function bcsub(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return bcnum(math.format(math.subtract(math.bignumber(a),math.bignumber(b)),{notation: 'fixed', precision: d}));
}

// Handle adding 2 big numbers
function bcadd(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return bcnum(math.format(math.add(math.bignumber(a),math.bignumber(b)),{notation: 'fixed', precision: d}));
}

// Handle multiplying 2 big numbers
function bcmul(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return bcnum(math.format(math.multiply(math.bignumber(a),math.bignumber(b)),{notation: 'fixed', precision: d}));
}

// Handle dividing 2 big numbers
function bcdiv(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return bcnum(math.format(math.divide(math.bignumber(a),math.bignumber(b)),{notation: 'fixed', precision: d}));
}

// Handle initializing datatables with static data (pre-populated)
function initStaticDatatable(tableId, autoWidth=true){
    // Set number of records per page to display
    var sm   = localStorage,
        rec  = sm.getItem('records_per_page');
        page = (rec) ? parseInt(rec) : 10;
    // Detect any 'per page' changes and save to localStorage
    $('#' + tableId).on( 'length.dt', function ( e, settings, length ){
        sm.setItem('records_per_page',length);
    });
    // Initialized the datatable
    $('#' + tableId).dataTable({
        lengthMenu: [[10,20,30,40,50,60,70,80,90,100],[10,20,30,40,50,60,70,80,90,100]],
        pageLength: page,
        dom: '<"search-options text-center border-bottom p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>><"search-results"t><"search-options text-center border-bottom-0 p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>>',
        pagingType: "full",
        serverSide: false,
        searching: false,
        ordering: true,
        processing: true,
        autoWidth: autoWidth,
        language: {
            lengthMenu: "_MENU_ per page",
            zeroRecords: "No records found",
            info: "_TOTAL_ results",
            infoEmpty: "No records available",
            paginate: {
                first: "<i class='fa fa-chevron-left'></i><i class='fa fa-chevron-left'></i>",
                previous: "<i class='fa fa-chevron-left'></i><span id='" + tableId + "-paginate-info'></span>",
                next: "<i class='fa fa-chevron-right'></i>",
                last: "<i class='fa fa-chevron-right'></i><i class='fa fa-chevron-right'></i>"
            }
        },
        fnDrawCallback: function(o){
            var total  = o.fnRecordsTotal(),
                length = o._iDisplayLength,
                stop   = o._iDisplayStart + length,
                page   = stop / length,
                pages  = total / length;
            if(pages > parseInt(pages))
                pages = parseInt(pages) + 1;
            // Add 'Page X of Y' in between previous/next buttons
            var page_status = $('#' + tableId + '_wrapper .page-status');
            if(page_status.length==0){
                $('#' + tableId + '_wrapper .paginate_button.previous').after('<span class="page-status">page status here</span>');
                page_status = $('#' + tableId + '_wrapper .page-status');
            }
            page_status.text('Page ' + numeral(page).format('0,0') + ' of ' + numeral(pages).format('0,0'));
        }
    });
}

// Handle getting a quick summary of action details
function getActionDetails(action, info){
    let html = '';
    let coin = XC.coin; // TODO: update when XChain adds cross-network support
    if(action=='ADDRESS'){
        let pref = (info.fee_preference==1) ? 'Destroy' : 'Donate';
        let memo = (info.require_memo==1) ? 'True' : 'False';
        let disp = (info.dispenser_preference) ? XC.dispenser_preferences[info.dispenser_preference] : 'Not set';
        html += 'Fee Preference: ' + pref + '; Require Memo: ' + memo + '; Dispenser Preference: ' + disp;
    }
    if(action=='AIRDROP'){
        html += info.amount + formatLink('/' + coin + '/token/' + info.tick, info.tick, info.tick) + ' to ';
        html += 'List ' + formatLink('/' + coin + '/token/' + info.list_action_index, info.list_action_index);
    }
    if(action=='BROADCAST'){
        let percent = bcmul(info.fee, 100, 2);
        // info.message / info.value are BROADCAST free text (on-chain,
        // attacker-controlled) and this html is injected via .html() — escape them.
        if(info.action_format==0){
            html += escapeHtml(info.message);
        } else if(info.action_format==1){
            html += '<b>Oracle:</b> ' + escapeHtml(info.message) + ' = ' + formatAmount(info.value) + ' <b>Fee:</b> ' + percent + '%';;
        } else if(info.action_format==2){
            html += '<b>Feed:</b> ' + escapeHtml(info.message) + ' <b>Fee:</b> ' + percent + '%';
        } else if(info.action_format==3){
            html += '<b>Feed Results:</b> ' + formatLink('/' + coin + '/action/' + info.broadcast_action_index, info.broadcast_action_index) + ' <b>Result:</b> ' + escapeHtml(String(info.value));
        }
    }
    if(action=='CALLBACK'){
        html += formatLink('/' + coin + '/token/' + info.tick, info.tick, info.tick) + ' for ' ;
        html += formatLinkAmount('/' + coin + '/token/' + info.callback_tick, info.callback_tick, info.callback_tick, info.callback_amount);
    }
    if(action=='DIVIDEND'){
        html += formatLinkAmount('/' + coin + '/token/' + info.dividend_tick, info.dividend_tick, info.dividend_tick, info.amount) + ' per ';
        html += formatLinkAmount('/' + coin + '/token/' + info.tick, info.tick, info.tick, 1)
    }
    if(['DISPENSER', 'DISPENSE', 'DISPENSER_CLOSE', 'DISPENSER_CANCEL', 'DISPENSER_EXPIRE', 'DISPENSER_EDIT',
        'SWAP', 'SWAP_MATCH', 'SWAP_CANCEL', 'SWAP_EXPIRE', 'SWAP_EDIT',
        'ORDER', 'ORDER_MATCH', 'ORDER_CANCEL', 'ORDER_EXPIRE', 'ORDER_EDIT'].includes(action)){
        html  = formatLinkAmount('/' + coin + '/token/' + info.give_tick, info.give_tick, info.give_tick, info.give_amount) + ' for ';
        if(isNull(info.get_tick)){
            let cls = getNetworkIcon();
            html += ' <i class="fa ' + cls + '"></i> ' + formatAmount(info.get_amount) + ' ' + coin ;
        } else {
            html  += formatLinkAmount('/' + coin + '/token/' + info.get_tick, info.get_tick, info.get_tick, info.get_amount);
        }
    }
    if(action=='FILE')
        html = info.type + ' - ' + info.name + ' - ' + info.title;
    if(action=='ISSUE')
        html = formatLink('/' + coin + '/token/' + info.tick, info.tick, info.tick);
    if(action=='LINK'){
        html += info.coin1 + ' action ' + formatLink('/' + info.coin1 + '/token/' + info.coin1_action_index, info.coin1_action_index) + ' to ';
        html += info.coin2 + ' action ' + formatLink('/' + info.coin2 + '/token/' + info.coin2_action_index, info.coin2_action_index);
    }
    if(action=='LIST'){
        let action3 = (info.edit) ? (info.edit==1) ? 'Add to' : 'Remove from' : 'Create'; 
        let type2   = (info.type==2) ? 'Token' : 'Address';
        html = action3 + ' ' + type2 + ' List';
    }
    if(action=='MESSAGE'){
        if([1,2].includes(info.encryption_method)){
            html = 'Encryption key exchange with ' + formatLink('/' + coin + '/address/' + info.destination, info.destination);
        } else if(info.plaintext_message){
            html = info.plaintext_message;
        } else {
            html = 'Encrypted message to ' + formatLink('/' + coin + '/address/' + info.destination, info.destination);
        }
    }
    if(action=='MINT')
        html = formatLinkAmount('/' + coin + '/token/' + info.tick, info.tick, info.tick, info.amount);
    if(action=='SEND'){
        html += formatLinkAmount('/' + coin + '/token/' + info.tick, info.tick, info.tick, info.amount) + ' to ';
        html += formatLink('/' + coin + '/address/' + info.destination, info.destination);
    }
    if(action=='SWEEP'){
        html += formatLink('/' + coin + '/address/' + info.source, info.source) + ' to ';
        html += formatLink('/' + coin + '/address/' + info.destination, info.destination);
    }
    if(action=='SLEEP'){
        if(info.type==1)
            html = 'Address';
        if(info.type==2)
            html = formatLink('/' + coin + '/token/' + info.tick, info.tick, info.tick);
        html += ' until block ' + formatAmount(info.resume_block);
    }
    return html;
}

/**********************************************************************
 * Handle loading data into a datatables table from the explorer API endpoints
 * 
 * Params :
 * - coin   - COIN name (BTC, LTC, DOGE, etc)
 * - action - Action name (address, credit, debit)
 * - query  - Query info (can be null in most cases)
 * - type   - Query type (address, block, token)
 * 
 * Examples :
 * - Load all `address` actions
 *   loadDatatablesData('BTC', 'address', null, null);
 * 
 * - Load `address` actions for a given address
 *   loadDatatablesData('BTC', 'address', '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev', 'address');
 * 
 * - Load `address` actions for a given block
 *   loadDatatablesData('BTC', 'address', '862623', 'block');
 *********************************************************************/
function loadDatatablesData(coin, action, query, type){
    // Handle initializing datatable object for this action
    if(!XC.datatables[action])
        XC.datatables[action] = {}
    if(!XC.datatables[action].last_start)
        XC.datatables[action].last_start = 0;
    // Setup short alias for tracking action specific datatable info
    let track = XC.datatables[action];
    // Set the name of the datatable to load data into
    let tableId = 'datatable-' + action;
    // Handle searches a bit differently
    if(type=='search'){
        type   = action;
        action = 'search';
    }
    // Automatically convert token searches on token page to subtoken
    if(type=='token' && action=='token')
        type = 'subtoken';
    // Set the explorer API endpoint name based on the action
    let endpoint = null;
    if(['history','search'].includes(action)){
        endpoint = action;
    } else if(['address','batch'].includes(action)){
        endpoint = action + 'es';
    } else if(action=='market-history'){
        endpoint = 'market';
        type     = 'history';
    } else {
        endpoint = action + 's';       
    }
    // Set the explorer API url
    let url = '/' + coin + '/explorer/' + endpoint;
    if(query || action=='history' || action=='block')
        url += '/' + query;
    if(type)
        url += '/' + type;
    // Set number of records per page to display
    var sm   = localStorage,
        rec  = sm.getItem('records_per_page');
        page = (rec) ? parseInt(rec) : 10;
    // Detect any 'per page' changes and save to localStorage
    $('#' + tableId).on( 'length.dt', function ( e, settings, length ){
        sm.setItem('records_per_page',length);
    });
    // Load data into the datatable
    $('#' + tableId).dataTable({
        ajax: {
            url: url,
            data: function(data){
                // Pass action and offset with request
                var action = null,
                    offset = null;
                if(data.start==0){
                    action = 'first';
                } else if(data.start > (track['last_start'] + data.length)){
                    action = 'last';
                } else if(data.start >= track['last_start']){
                    action = 'next';
                    offset = track['offset_last'];
                } else {
                    action = 'prev';
                    offset = track['offset_first'];
                }
                // Pass action and offset forward
                data.action = action;
                data.offset = offset;
                // pass total back to server (used to quickly calculate how many records to display on 'last' page)
                data.total =  track['total'];
                if(type=='subtoken')
                    data.sortorder = 'ASC';
                // Cleanup the request so we only send what we need
                delete data.columns;
                delete data.order;
                delete data.search;
                delete data.draw;
            }
        },
        lengthMenu: [[10,20,30,40,50,60,70,80,90,100],[10,20,30,40,50,60,70,80,90,100]],
        pageLength: page,
        dom: '<"search-options text-center border-bottom p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>><"search-results"t><"search-options text-center border-bottom-0 p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>>',
        pagingType: "full",
        serverSide: true,
        searching: false,
        ordering: false,
        processing: true,
        autoWidth: false,
        language: {
            lengthMenu: "_MENU_ per page",
            zeroRecords: "No records found",
            info: "_TOTAL_ results",
            // info: "Displaying _START_ - _END_ of _TOTAL_",
            infoEmpty: "No records available",
            paginate: {
                first: "<i class='fa fa-chevron-left'></i><i class='fa fa-chevron-left'></i>",
                previous: "<i class='fa fa-chevron-left'></i><span id='" + tableId + "-paginate-info'></span>",
                next: "<i class='fa fa-chevron-right'></i>",
                last: "<i class='fa fa-chevron-right'></i><i class='fa fa-chevron-right'></i>"
            }
        },
        fnDrawCallback: function(o){
            var total  = o._iRecordsTotal,
                length = o._iDisplayLength,
                stop   = o._iDisplayStart + length,
                page   = stop / length,
                pages  = total / length;
            if(pages > parseInt(pages))
                pages = parseInt(pages) + 1;
            // Add 'Page X of Y' in between previous/next buttons
            var page_status = $('#' + tableId + '_wrapper .page-status');
            if(page_status.length==0){
                $('#' + tableId + '_wrapper .paginate_button.previous').after('<span class="page-status">page status here</span>');
                page_status = $('#' + tableId + '_wrapper .page-status');
            }
            page_status.text('Page ' + numeral(page).format('0,0') + ' of ' + numeral(pages).format('0,0'));
            // Track first and last shown action_index (used for offset tracking)
            if(o.json.data && o.json.data.length){
                var first = o.json.data[0],
                    last  = o.json.data[o.json.data.length-1];
                track['offset_first'] = first[first.length-1];
                track['offset_last']  = last[last.length-1];
            } else {
                track['offset_first'] = 0;
                track['offset_last']  = 0;
            }
            // Save the start so we can determine direction when user clicks (prev/next)
            track['last_start'] = o._iDisplayStart;
            // Save total, so we can pass back in API requests (used to calculate how many records to display on 'last' page)
            track['total'] = o.json.recordsTotal;
            // Handle hiding fields with unnecessary info (address / token)
            if(['address','token'].includes(type)){
                // Set the index for the field to hide
                let ids = [];
                if(type=='address') 
                    ids.push(3);
                if(type=='token'){
                    if(action=='sleep')
                        ids.push(5);
                    else 
                        ids.push(4);
                }
                $('[id^="datatable-"]').each(function(){
                    let el  = $(this);
                    let table = String(el.attr('id')).replace('datatable-','');
                    if(table==action){
                        let hide = true;
                        if(type=='address' && ['balance','token', 'dispense', 'sweep'].includes(table))
                            hide = false;
                        if(type=='token' && ['holder','dispense','dispenser'].includes(table))
                            hide = false;
                        if(table=='history')
                            hide = false;
                        if(table=='market')
                            hide = false;
                        if(hide){
                            let tr = el.find('tr');
                            for(let idx of ids){
                                tr.find('th:eq(' + idx + ')').hide();
                                tr.find('td:eq(' + idx + ')').hide();
                            }
                        }
                    }
                });
            }
        },
        createdRow: function(row, data, idx){
            // Parse the row data into the standard fields
            let action_index = data[data.length-1];
            let status       = data[data.length-2];
            let count        = data[0];
            let block_index  = data[1];
            let block_index2 = false;
            let timestamp    = data[2];
            let source       = data[3];
            let destination  = false;
            let token        = false;
            let token2       = false;
            let amount       = false;
            let amount2      = false;
            let amount3      = false;
            let coin_index   = false;
            let coin2        = false;
            let coin2_index2 = false;
            let message      = false;
            let value        = false;
            let fee          = false;
            let locks        = false;
            let memo         = false;
            let edit         = false;
            let type2        = false;
            let txt          = '';
            let html         = '';
            // Define the various numeral formats used
            let fmtInteger   = '0,0';
            let fmtCurrency  = '0,0.00';
            let fmtCoin      = '0,0.00000000';
            // Define the link to the action_index
            let action_link  = formatLink('/' + coin + '/action/' + action_index, 'view', null, true);
            let block_link   = formatLink('/' + coin + '/block/' + block_index, numeral(block_index).format('0,0'));
            let source_link  = formatLink('/' + coin + '/address/' + source, source);
            // Set row to display to red or green based on status
            if(!['balance','credit','debit','token','block','fee','holder','search','market','market-history','slash_event'].includes(action)){
                var cls = (status==1) ? 'bg-green' : 'bg-red';
                // For escrow, green=credit, red=debit
                if(action=='escrow')
                    cls = (String(data[5]).substring(0,1)=='-') ? 'bg-red' : 'bg-green';
                $(row).addClass(cls);
            }
            // Display the first few fields
            $('td', row).eq(0).html(numeral(count).format('0,0'));
            $('td', row).eq(1).html(block_link);
            $('td', row).eq(2).html(formatLivestamp(timestamp));
            $('td', row).eq(3).html(source_link);
            // Address
            if(action=='address'){
                txt = (data[4]==1) ? 'Destroy' : 'Donate';
                $('td', row).eq(4).html(txt);
                txt = (data[5]==1) ? 'True' : 'False';
                $('td', row).eq(5).html(txt);
                $('td', row).eq(6).html(action_link);
            }
            // Airdrop
            if(action=='airdrop'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Balance
            if(action=='balance'){
                token   = data[1];
                amount  = data[2];
                percent = data[3];
                value   = data[4];
                $('td', row).eq(1).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(2).html(formatAmount(amount));
                $('td', row).eq(3).html(numeral(percent).format(fmtCoin) + '%');
                html  = numeral(value).format(fmtCoin) + ' ' + XC.coin;
                html += ' <span class="badge text-bg-info text-white">$' + numeral(bcmul(value, XC.coin_price, 8)).format('0,0.00') + '</span>';
                $('td', row).eq(4).html(html);
                $('td', row).eq(5).html(formatLink('/' + coin + '/token/' + token, 'view', null, true));
            }
            // Batch
            if(action=='batch'){
                $('td', row).eq(4).html(action_link);
            }
            // Blocks
            if(action=='block'){
                block_index = data[0];
                timestamp   = data[1];
                let actions = String(data[2]).split('|');
                $('td', row).eq(0).html(formatLink('/' + coin + '/block/' + block_index, numeral(block_index).format('0,0')));
                $('td', row).eq(1).html(formatLivestamp(timestamp));
                $('td', row).eq(3).html(formatLink('/' + coin + '/block/' + block_index, 'view', null, true));
                actions.forEach(function(val, idx){
                    if(val>0){
                        var num  = numeral(val).format('0,0'),
                            icon = '';
                            name = XC.actions[idx];
                        if(name=='addresses')     icon='fa-gears';  
                        if(name=='airdrops')      icon='fa-parachute-box';  
                        if(name=='batches')       icon='fa-layer-group';  
                        if(name=='broadcasts')    icon='fa-bullhorn';  
                        if(name=='callbacks')     icon='fa-recycle';  
                        if(name=='destroys')      icon='fa-trash';  
                        if(name=='dispensers')    icon='fa-arrows-h';  
                        if(name=='dispenses')     icon='fa-hand-holding-heart';
                        if(name=='dividends')     icon='fa-sitemap';  
                        if(name=='files')         icon='fa-file';  
                        if(name=='issues')        icon='fa-bank';  
                        if(name=='links')         icon='fa-link';  
                        if(name=='lists')         icon='fa-list';  
                        if(name=='messages')      icon='fa-message';  
                        if(name=='mints')         icon='fa-print';  
                        if(name=='orders')        icon='fa-book';  
                        if(name=='order_cancels') icon='fa-book';  
                        if(name=='order_edits')   icon='fa-book';  
                        if(name=='order_matches') icon='fa-book';  
                        if(name=='sends')         icon='fa-send';  
                        if(name=='sleeps')        icon='fa-snooze';  
                        if(name=='swaps')         icon='fa-exchange';  
                        if(name=='swap_cancels')  icon='fa-exchange';  
                        if(name=='swap_edits')    icon='fa-exchange';  
                        if(name=='swap_matches')  icon='fa-exchange';  
                        if(name=='sweeps')        icon='fa-truck';  
                        html += '<a title="' + num + ' ' + name + '">' + num + ' <i class="fa ' + icon + ' me-3"></i></a>';
                    }
                });
                if(html=='')
                    html = 'No transactions found';
                $('td', row).eq(2).html(html);
            }
            // Broadcast
            if(action=='broadcast'){
                message = data[4];
                value   = data[5];
                fee     = data[6];
                $('td', row).eq(4).text(message);
                var fmt = (String(value).indexOf('.')==-1) ? fmtInteger : fmtCoin;
                $('td', row).eq(5).html(numeral(value).format(fmt));
                $('td', row).eq(6).html(fee);
                $('td', row).eq(7).html(action_link);
            }
            // Callback
            if(action=='callback'){
                token  = data[4];
                token2 = data[5];
                amount = data[6];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).html(formatLink('/' + coin + '/token/' + token2, token2, token2));
                $('td', row).eq(6).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Credit
            if(action=='credit'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Debit
            if(action=='debit'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Destroy  
            if(action=='destroy'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(action_link);
            }
            // Dispenser
            if(action=='dispenser'){
                give_coin   = data[4];
                give_token  = data[5];
                give_amount = data[6];
                get_coin   = data[7];
                get_token  = data[8];
                get_amount = data[9];
                give_ownership = data[12];
                if(give_ownership == 1){
                    $('td', row).eq(4).html(formatLink('/' + give_coin + '/token/' + give_token, give_token, give_token) + ' ' + ownershipBadge());
                } else {
                    $('td', row).eq(4).html(formatLinkAmount('/' + give_coin + '/token/' + give_token, give_token, give_token, give_amount));
                }
                if(isNull(get_token)){
                    html += ' <i class="fa ' + getNetworkIcon() + '"></i> ' + get_amount + ' ' + get_coin ;
                } else {
                    html = formatLinkAmount('/' + get_coin + '/token/' + get_token, get_token, get_token, get_amount)
                }
                $('td', row).eq(5).html(html);
                $('td', row).eq(6).html(formatLink('/' + coin + '/dispenser/' + action_index, 'view', null, true));
            }
            // Dispense
            if(action=='dispense'){
                give_coin   = data[4];
                give_token  = data[5];
                give_amount = data[6];
                get_coin   = data[7];
                get_token  = data[8];
                get_amount = data[9];
                $('td', row).eq(4).html(formatLinkAmount('/' + give_coin + '/token/' + give_token, give_token, give_token, give_amount));
                if(isNull(get_token)){
                    html += ' <i class="fa ' + getNetworkIcon() + '"></i> ' + get_amount + ' ' + get_coin ;
                } else {
                    html = formatLinkAmount('/' + get_coin + '/token/' + get_token, get_token, get_token, get_amount)
                }
                $('td', row).eq(5).html(html);
                $('td', row).eq(6).html(action_link);

            } 
            // Dividend
            if(action=='dividend'){
                token  = data[4];
                token2 = data[5];
                amount = data[6];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).html(formatLink('/' + coin + '/token/' + token2, token2, token2));
                $('td', row).eq(6).html(formatAmount(data[6]));
                $('td', row).eq(7).html(action_link);
            }
            // Escrow
            if(action=='escrow'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Fee
            if(action=='fee'){
                token  = data[4];
                amount = data[5];
                type2  = data[6];
                // Fee payment method
                txt  = (type2==1) ? 'Destroy' : 'Donate';
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).html(numeral(amount).format(fmtCoin));
                $('td', row).eq(6).text(txt);
                $('td', row).eq(8).html(action_link);
            }
            // File
            if(action=='file'){
                // Token-gated FILE: flag it with a lock badge on the Name cell (the
                // file renderer is shared across pages with different column counts,
                // so we annotate an existing cell rather than add a column).
                let gate = data[7];
                if(!isNull(gate))
                    $('td', row).eq(4).append(' <span class="badge text-bg-warning" title="Gated by ' + escapeHtml(gate) + '"><i class="fa fa-lock"></i></span>');
                $('td', row).eq(7).html(action_link);
            }
            // Holder
            if(action=='holder'){
                address = data[1];
                amount  = data[2];
                percent = data[3];
                value   = data[4];
                $('td', row).eq(1).html(formatLink('/' + coin + '/address/' + address, address));
                $('td', row).eq(2).html(formatAmount(amount));
                $('td', row).eq(3).html(numeral(percent).format(fmtCoin) + '%');
                html  = numeral(value).format(fmtCoin) + ' ' + XC.coin;
                html += ' <span class="badge text-bg-info text-white">$' + numeral(value * XC.coin_price).format(fmtCurrency) + '</span>';
                $('td', row).eq(4).html(html);
                $('td', row).eq(5).html(formatLink('/' + coin + '/address/' + address, 'view', null, true));
            }
            // Issue
            if(action=='issue'){
                amount  = data[5];
                amount2 = data[6];
                locks   = data[7];
                $('td', row).eq(5).text(formatAmount(amount));
                $('td', row).eq(6).text(formatAmount(amount2));
                $('td', row).eq(7).html(formatLocks(locks));
                $('td', row).eq(8).html(action_link);
            }
            // Link
            if(action=='link'){
                coin1       = data[4];
                coin1_index = data[5];
                coin2       = data[6];
                coin2_index = data[7];
                memo        = data[8];
                $('td', row).eq(4).html(formatLink('/' + coin1 + '/action/' + coin1_index, coin1 + '-' + coin1_index));
                $('td', row).eq(5).html(formatLink('/' + coin2 + '/action/' + coin2_index, coin2 + '-' + coin2_index));
                $('td', row).eq(6).text(memo);
                $('td', row).eq(7).html(action_link);
            }
            // List
            if(action=='list'){
                type2 = data[4];
                edit = data[5];
                // List Type
                txt  = '';
                if(type2==1) txt='Token';
                if(type2==2) txt='Address';
                $('td', row).eq(4).text(txt);
                // Edit Type
                txt = 'Create';
                if(edit==1) txt='Add';
                if(edit==2) txt='Remove';
                $('td', row).eq(5).text(txt);
                $('td', row).eq(6).html(action_link);
            }
            // Markets
            if(action=='market'){
                let tick1  = data[1],
                    tick2  = data[2],
                    market = tick1 + '/' + tick2,
                    price  = data[3],
                    ask    = data[4],
                    bid    = data[5],
                    volume = data[6],
                    change = data[7];
                    html   = '<img src="' + getTokenIcon(tick1) + '" class="icon-20">' + 
                             '<img src="' + getTokenIcon(tick2) + '" class="icon-20 ms-1 me-1">' + 
                             tick1 + ' / ' + tick2;
                $('td', row).eq(1).html(formatLink('/' + coin + '/market/' + market, html));
                $('td', row).eq(2).html(formatAmount(price));
                $('td', row).eq(3).html(formatAmount(ask));
                $('td', row).eq(4).html(formatAmount(bid));
                $('td', row).eq(5).html(formatAmount(volume));
                var cls = (change && change.indexOf('-')==-1) ? 'text-success' : 'text-danger';
                $('td', row).eq(6).addClass(cls).html(formatAmount(change));
                $('td', row).eq(7).html(formatLink('/' + coin + '/market/' + market, 'view', null, true));
            }
            // Message
            if(action=='message'){
                destination = data[4];
                $('td', row).eq(4).html(formatLink('/' + coin + '/address/' + destination, destination));
                $('td', row).eq(7).html(action_link);
            }
            // Mint
            if(action=='mint'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(action_link);
            }
            // Order
            if(action=='order'){
                token   = data[4];
                amount  = data[5];
                token2  = data[6];
                amount2 = data[7];
                give_ownership = data[10];
                get_ownership  = data[11];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).html((give_ownership == 1) ? ownershipBadge() : formatAmount(amount));
                $('td', row).eq(6).html(formatLink('/' + coin + '/token/' + token2, token2, token2));
                $('td', row).eq(7).html((get_ownership == 1) ? ownershipBadge() : formatAmount(amount2));
                $('td', row).eq(8).html(action_link);
            }
            // Send
            if(action=='send'){
                token       = data[4];
                amount      = data[5];
                destination = data[6];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(formatLink('/' + coin + '/address/' + destination, destination));
                $('td', row).eq(7).html(action_link);
            }
            // Sleep
            if(action=='sleep'){
                type2        = data[4];
                token        = data[5];
                block_index2 = data[6];
                // Sleep Type
                txt  = '';
                if(type2==1) txt='Address';
                if(type2==2) txt='Token';
                $('td', row).eq(4).text(txt);
                if(token!='')
                    $('td', row).eq(5).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(6).html(formatLink('/' + coin + '/block/' + block_index2, numeral(block_index2).format(fmtInteger)));
                $('td', row).eq(7).html(action_link);
            }
            // Swap
            if(action=='swap'){
                token   = data[4];
                amount  = data[5];
                token2  = data[6];
                amount2 = data[7];
                give_ownership = data[10];
                get_ownership  = data[11];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).html((give_ownership == 1) ? ownershipBadge() : formatAmount(amount));
                $('td', row).eq(6).html(formatLink('/' + coin + '/token/' + token2, token2, token2));
                $('td', row).eq(7).html((get_ownership == 1) ? ownershipBadge() : formatAmount(amount2));
                $('td', row).eq(8).html(action_link);
            }
            // Sweep
            if(action=='sweep'){
                destination = data[4];
                $('td', row).eq(4).html(formatLink('/' + coin + '/address/' + destination, destination));
                txt = (data[5]==1) ? 'True' : 'False';
                $('td', row).eq(5).text(txt);
                txt = (data[6]==1) ? 'True' : 'False';
                $('td', row).eq(6).text(txt);
                txt = (data[7]==1) ? 'True' : 'False';
                $('td', row).eq(7).text(txt);
                txt = (data[8]==1) ? 'True' : 'False';
                $('td', row).eq(8).text(txt);
                txt = (data[9]==1) ? 'True' : 'False';
                $('td', row).eq(9).text(txt);
                $('td', row).eq(10).html(action_link);
            }
            // Tokens
            if(action=='token'){
                token   = data[3];
                amount  = data[4];
                amount2 = data[5];
                amount3 = data[6];
                locks   = data[7];
                $('td', row).eq(3).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(4).text(formatAmount(amount));
                $('td', row).eq(5).text(formatAmount(amount2));
                $('td', row).eq(6).text(formatAmount(amount3));
                $('td', row).eq(7).html(formatLocks(locks));
                $('td', row).eq(8).html(formatLink('/' + coin + '/token/' + token, 'view', null, true));
            }
            // History
            if(action=='history'){
                let action2 = data[3];
                let info    = data[4];
                $('td', row).eq(3).html(action2);
                let html = getActionDetails(action2, info);
                $('td', row).eq(4).html(html);
                $('td', row).eq(5).html(action_link);
            }
            // Market History
            if(action=='market-history'){
                let type   = data[3]
                    price  = bcformat(data[4],8),
                    amount = bcformat(data[5],8),
                    total  = bcformat(bcmul(price, amount),8);
                $('td', row).eq(3).html(type);
                $('td', row).eq(4).html(formatAmount(price));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(formatAmount(total));
                $('td', row).eq(7).html(action_link);
            }
            // Search
            if(action=='search'){
                if(type=='address'){
                    let address = data[1];
                    $('td', row).eq(1).html(formatLink('/' + coin + '/address/' + address, highlightSearchTerm(XC.query, address)));
                    $('td', row).eq(2).html(formatLink('/' + coin + '/address/' + address, 'view', null, true));
                }
                if(type=='broadcast'){
                    let message = data[1];
                    let memo    = data[2];
                    $('td', row).eq(1).html(highlightSearchTerm(XC.query, message));
                    $('td', row).eq(2).html(highlightSearchTerm(XC.query, memo));
                    $('td', row).eq(3).html(formatLink('/' + coin + '/action/' + data[3], 'view', null, true));
                }
                if(type=='token'){
                    let token       = data[1];
                    let description = data[2];
                    $('td', row).eq(1).html(formatLink('/' + coin + '/token/' + token, highlightSearchTerm(XC.query, token), token));
                    $('td', row).eq(2).html(highlightSearchTerm(XC.query, description));
                    $('td', row).eq(3).html(formatLink('/' + coin + '/token/' + token, 'view', null, true));
                }
                if(type=='transaction'){
                    let transaction = data[1];
                    $('td', row).eq(1).html(formatLink('/' + coin + '/transaction/' + transaction, highlightSearchTerm(XC.query, transaction)));
                    $('td', row).eq(2).html(formatLink('/' + coin + '/transaction/' + transaction, 'view', null, true));
                }
            }
            // Contract (DEPLOY list)
            if(action=='contract'){
                let code_hash = data[4];
                let api       = data[5];
                let cooldown  = data[6];
                $('td', row).eq(4).html(formatHash(code_hash));
                $('td', row).eq(5).text(api);
                $('td', row).eq(6).html(isNull(cooldown) ? 'No' : ('<span class="badge text-bg-info text-white">Stakeable</span> ' + numeral(cooldown).format(fmtInteger) + ' blk'));
                $('td', row).eq(7).html(formatLink('/' + coin + '/contract/' + action_index, 'view', null, true));
            }
            // Execution (EXECUTE list)
            if(action=='execution'){
                let contract_index = data[3];
                let caller         = data[4];
                let method         = data[5];
                let gas            = data[6];
                $('td', row).eq(3).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(4).html(formatLink('/' + coin + '/address/' + caller, caller));
                $('td', row).eq(5).text(method);
                $('td', row).eq(6).html(numeral(gas).format(fmtInteger));
                $('td', row).eq(7).html(formatLink('/' + coin + '/execution/' + action_index, 'view', null, true));
            }
            // Deposit / Withdrawal (contract custody)
            if(action=='deposit' || action=='withdrawal'){
                let contract_index = data[4];
                token  = data[5];
                amount = data[6];
                $('td', row).eq(4).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(5).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(6).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Validator / capability stake
            if(action=='validator'){
                let pubkey  = data[4];
                let version = data[5];
                amount      = data[6];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).text('v' + version);
                $('td', row).eq(6).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Contract-targeted stake (STAKE v3)
            if(action=='contract_stake'){
                let pubkey         = data[4];
                let contract_index = data[5];
                token  = data[6];
                amount = data[7];
                let version = data[8];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(6).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(7).html(formatAmount(amount));
                $('td', row).eq(8).html(action_link);
            }
            // Contract-targeted unstake (UNSTAKE v1)
            if(action=='contract_unstake'){
                let pubkey         = data[4];
                let contract_index = data[5];
                token  = data[6];
                amount = data[7];
                let cooldown_end = data[8];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(6).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(7).html(formatAmount(amount));
                $('td', row).eq(8).html(formatLink('/' + coin + '/block/' + cooldown_end, numeral(cooldown_end).format(fmtInteger)));
                $('td', row).eq(9).html(action_link);
            }
            // Slash event (xchain.contract.slash emission — no own action_index; links to the EXECUTE)
            if(action=='slash_event'){
                let pubkey         = data[3];
                let contract_index = data[4];
                token       = data[5];
                amount      = data[6];
                destination = data[7];
                let execution_index = data[8];
                $('td', row).eq(3).html(formatHash(pubkey));
                $('td', row).eq(4).html(formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(5).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(6).html(formatAmount(amount));
                $('td', row).eq(7).html(formatLink('/' + coin + '/address/' + destination, destination));
                $('td', row).eq(8).html(formatLink('/' + coin + '/action/' + execution_index, 'view', null, true));
            }
            // Attestation (ATTEST v0 request / v1 response from the `attests` table)
            if(action=='attestation'){
                let version         = data[4];
                let provider        = data[5];
                let request_id      = data[6];
                let request_status  = data[7];
                let response_status = data[8];
                $('td', row).eq(4).html((version == 0) ? '<span class="badge text-bg-secondary">Request</span>' : '<span class="badge text-bg-primary">Response</span>');
                $('td', row).eq(5).text(provider);
                $('td', row).eq(6).html(formatLink('/' + coin + '/action/' + action_index, formatHash(request_id)));
                $('td', row).eq(7).text((version == 0) ? request_status : response_status);
                $('td', row).eq(8).html(action_link);
            }
        }
    });
}

/**********************************************************************
 * Handle loading data directly from the API endpoints
 * 
 * Params :
 * - coin     - COIN name (BTC, LTC, DOGE, etc)
 * - action   - Action name (address, credit, debit)
 * - query    - Query info (can be null in most cases)
 * - type     - Query type (address, block, token)
 * - callback - Callback function to process the response
 * 
 * Examples :
 * - Load all `address` actions
 *   loadApiData('BTC', 'block', '862623', null);
 * 
 * - Load `address` actions for a given address
 *   loadDApiData('BTC', 'address', '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev', 'address');
 * 
 * - Load `address` actions for a given block
 *   loadDApiData('BTC', 'address', '862623', 'block');
 *********************************************************************/
function loadApiData(coin, action, query, type, callback){
    // Set the API endpoint name based on the action
    let endpoint = null;
    if(['history','block','network','token','action','status','transaction','market'].includes(action) || (action=='address' && type==null)){
        endpoint = action;
    } else if(['address','batch'].includes(action)){
        endpoint = action + 'es';
    } else {
        endpoint = action + 's';        
    }
    // Set the explorer API url
    let url = '/' + coin + '/api/' + endpoint;
    if(query || action=='history' || action=='block')
        url += '/' + query;
    if(type)
        url += '/' + type;
    if(XC.debug)
        console.log('Requesting API data from endpoint ' + url);
    // Make request to get the API data and return to the callback function
    $.getJSON(url, function(o){
        if(o.error){
            console.log('caught error=',o.error);
        } else {
            if(typeof callback==='function')
                callback(o);
        }
    });
}

// Handle converting null values in an object to empty strings 
function null2string(obj){
    if(obj === null)
        return '';
    if(typeof obj === 'object' && !Array.isArray(obj)){
        const newObj = {};
        for(const key in obj){
          if(Object.prototype.hasOwnProperty.call(obj, key))
            newObj[key] = null2string(obj[key]);
        }
        return newObj;
    }
    if(Array.isArray(obj))
        return obj.map(item => null2string(item));
    return obj;
}

// Handle displaying transaction details
function showTransactionDetails(){
    // Setup short alias to action info object
    let o = (XC.actionInfo) ? XC.actionInfo : XC.transactionInfo;
    // Update page with basic transaction details
    let source        = (o.source)       ? formatLink('/' + XC.coin + '/address/' + o.source, o.source) : '-';
    let tx_index      = (o.tx_index)     ? formatLink('/' + XC.coin + '/transaction/' + o.tx_index, formatAmount(o.tx_index)) : '-';
    let block_index   = (o.block_index)  ? formatLink('/' + XC.coin + '/block/' + o.block_index, formatAmount(o.block_index)) : '-';
    let action_index  = (o.action_index) ? formatLink('/' + XC.coin + '/action/' + o.action_index, formatAmount(o.action_index)) : '-';
    let action_format = (isNumeric(o.action_format)) ? o.action_format : '-';
    let action        = (o.action) ? o.action : '-';
    let status        = (o.status) ? o.status : '-';
    let tx_data       = (o.tx_data) ? o.tx_data : '-';
    $('#tx-index').html(tx_index);
    $('#block').html(block_index);
    $('#action-command').text(action);
    $('#action-format').text(action_format);
    $('#action-index').html(action_index);
    $('#action-status').text(status);    
    $('#source').html(source);
    $('#tx-data').text(tx_data);
    $('#timestamp').html(formatLivestamp(o.timestamp) + ' (' + moment.unix(o.timestamp).utcOffset(0).format() + ' GMT)');
    // Add links to block explorers next to transaction hash
    if(o.tx_hash){
        formatTransactionLink(o.tx_hash);
    } else {
       $('#tx-hash').text('-');
    }
    // Load the actions table data
    showActionDatatable('actions',o.actions);
}

// Handle displaying action details
function showActionDetails(){
    // Setup short alias to action info object
    let o = XC.actionInfo;
    // Update page with transaction details
    showTransactionDetails();
    // Display the specific actions for this tranaction
    // TODO: Cleanup this code once all actions are working (reduce to just call on show{ACTION}Details(o))
    var found = false;
    if(o.action=='ADDRESS'){          found = true;  showAddressDetails(o);         }
    if(o.action=='AIRDROP'){          found = true;  showAirdropDetails(o);         }
    if(o.action=='BATCH'){            found = true;  showBatchDetails(o);           }
    if(o.action=='BROADCAST'){        found = true;  showBroadcastDetails(o);       }
    if(o.action=='CALLBACK'){         found = true;  showCallbackDetails(o);        }
    if(o.action=='DESTROY'){          found = true;  showDestroyDetails(o);         }
    if(o.action=='DISPENSER'){        found = true;  showDispenserDetails(o);       }
    if(o.action=='DISPENSER_CANCEL'){ found = true;  showDispenserCancelDetails(o); }
    if(o.action=='DISPENSER_CLOSE'){  found = true;  showDispenserCloseDetails(o);  }
    if(o.action=='DISPENSER_EDIT'){   found = true;  showDispenserEditDetails(o);   }
    if(o.action=='DISPENSER_EXPIRE'){ found = true;  showDispenserExpireDetails(o); }
    if(o.action=='DISPENSE'){         found = true;  showDispenseDetails(o);        }
    if(o.action=='DIVIDEND'){         found = true;  showDividendDetails(o);        }
    if(o.action=='FILE'){             found = true;  showFileDetails(o);            }
    if(o.action=='ISSUE'){            found = true;  showIssueDetails(o);           }
    if(o.action=='LINK'){             found = true;  showLinkDetails(o);            }
    if(o.action=='LIST'){             found = true;  showListDetails(o);            }
    if(o.action=='MESSAGE'){          found = true;  showMessageDetails(o);         }
    if(o.action=='MINT'){             found = true;  showMintDetails(o);            }
    if(o.action=='ORDER'){            found = true;  showOrderDetails(o);           }
    if(o.action=='ORDER_CANCEL'){     found = true;  showOrderCancelDetails(o);     }
    if(o.action=='ORDER_EDIT'){       found = true;  showOrderEditDetails(o);       }
    if(o.action=='ORDER_EXPIRE'){     found = true;  showOrderExpireDetails(o);     }
    if(o.action=='ORDER_MATCH'){      found = true;  showOrderMatchDetails(o);      }
    if(o.action=='SEND'){             found = true;  showSendDetails(o);            }
    if(o.action=='SLEEP'){            found = true;  showSleepDetails(o);           }
    if(o.action=='SWAP'){             found = true;  showSwapDetails(o);            }
    if(o.action=='SWAP_CANCEL'){      found = true;  showSwapCancelDetails(o);      }
    if(o.action=='SWAP_EDIT'){        found = true;  showSwapEditDetails(o);        }
    if(o.action=='SWAP_EXPIRE'){      found = true;  showSwapExpireDetails(o);      }
    if(o.action=='SWAP_MATCH'){       found = true;  showSwapMatchDetails(o);       }
    if(o.action=='SWEEP'){            found = true;  showSweepDetails(o);           }
    if(o.action=='ATTEST'){           found = true;  showAttestDetails(o);          }
    if(o.action=='STAKE'){            found = true;  showStakeDetails(o);           }
    if(o.action=='UNSTAKE'){          found = true;  showUnstakeDetails(o);         }
    if(o.action=='DELEGATE'){         found = true;  showDelegateDetails(o);        }
    if(o.action=='COLLECT'){          found = true;  showCollectDetails(o);         }
    if(o.action=='DEPLOY'){           found = true;  showDeployDetails(o);          }
    if(o.action=='EXECUTE'){          found = true;  showExecuteDetails(o);         }
    if(o.action=='DEPOSIT'){          found = true;  showDepositDetails(o);         }
    if(o.action=='WITHDRAW'){         found = true;  showWithdrawDetails(o);        }
    // Load the action table data for credits/debits/escrow/fees
    showActionDatatable('credit',o.credits);
    showActionDatatable('debit', o.debits);
    showActionDatatable('escrow',o.escrows);
    // Display any fees for the action
    showActionFeeDetails(o.fee);
    // Display the correct ACTION section and hide the 'No information available' message
    if(found){
        let name  = String(o.action).replaceAll('_','-').toLowerCase();
        $('#info-' + name).removeClass('d-none');
        $('#additionalInfoNotAvailable').hide();
    }
}

// Display ADDRESS action information
function showAddressDetails(data){
    let preference   = (data.fee_preference) ? (' - ' + XC.fee_preferences[data.fee_preference]) : '';
    let require_memo = (data.require_memo==1) ? 'true' : 'false';
    let dispenser    = (data.dispenser_preference) ? XC.dispenser_preferences[data.dispenser_preference] : 'Not set';
    $('#info-address .address-fee-preference').text(data.fee_preference + preference);
    $('#info-address .address-require-memo').text(require_memo);
    $('#info-address .address-dispenser-preference').text(dispenser);
    $('#info-address .address-memo').text(data.memo);
}

// Display AIRDROP action information
function showAirdropDetails(data){
    $('#info-airdrop .airdrop-list').html(formatLink('/' + XC.coin + '/action/' + data.list_action_index, formatAmount(data.list_action_index)));
    $('#info-airdrop .airdrop-token').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    $('#info-airdrop .airdrop-amount').html(formatAmount(data.amount));
    $('#info-airdrop .airdrop-memo').text(data.memo);
}

// Display BATCH action information
function showBatchDetails(data){
    showActionDatatable('batch',data.actions);
}

// Display BROADCAST action information
function showBroadcastDetails(data){
    let percent = (isNumeric(data.fee)) ? (' <span class="badge text-bg-info text-white">' + bcmul(data.fee, 100, 2) + '%</span>') : '';
    $('#info-broadcast .broadcast-message').text(data.message);
    $('#info-broadcast .broadcast-value').text(formatAmount(data.value));
    $('#info-broadcast .broadcast-fee').html(data.fee + percent);
    $('#info-broadcast .broadcast-memo').text(data.memo);
}

// Display CALLBACK action information
function showCallbackDetails(data){
    $('#info-callback .callback-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    $('#info-callback .callback-callback-tick').html(formatLink('/' + XC.coin + '/token/' + data.callback_tick, data.callback_tick, data.callback_tick));
    $('#info-callback .callback-amount').html(formatAmount(data.callback_amount));
    $('#info-callback .callback-memo').text(data.memo);
}

// Display DIVIDEND action information
function showDividendDetails(data){
    $('#info-dividend .dividend-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    $('#info-dividend .dividend-dividend-tick').html(formatLink('/' + XC.coin + '/token/' + data.dividend_tick, data.dividend_tick, data.dividend_tick));
    $('#info-dividend .dividend-amount').html(formatAmount(data.amount));
    $('#info-dividend .dividend-memo').text(data.memo);
}

// Display DESTROY action information
function showDestroyDetails(data){
    $('#info-destroy .destroy-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    $('#info-destroy .destroy-amount').html(formatAmount(data.amount));
    $('#info-destroy .destroy-memo').text(data.memo);
}

// Display DISPENSER action information
function showDispenserDetails(data){
    let isOwnershipDispenser = (Number(data.give_ownership || 0) == 1);
    $('#info-dispenser .dispenser-give-coin').text(data.give_coin);
    $('#info-dispenser .dispenser-give-tick').html(
        formatLink('/' + data.give_coin + '/token/' + data.give_tick, data.give_tick, data.give_tick)
        + (isOwnershipDispenser ? ' ' + ownershipBadge() : '')
    );
    $('#info-dispenser .dispenser-give-amount').html(isOwnershipDispenser ? ownershipBadge() : formatAmount(data.give_amount));
    $('#info-dispenser .dispenser-give-escrow').html(isOwnershipDispenser ? ownershipBadge() : formatAmount(data.give_escrow));
    $('#info-dispenser .dispenser-get-coin').text(data.get_coin);
    $('#info-dispenser .dispenser-get-tick').html(formatLink('/' + data.get_coin + '/token/' + data.get_tick, data.get_tick, data.get_tick));
    $('#info-dispenser .dispenser-get-amount').html(formatAmount(data.get_amount));
    $('#info-dispenser .dispenser-get-address').html(formatLink('/' + data.get_coin  + '/address/' + data.get_address, data.get_address));
    if(data.expiration)
        $('#info-dispenser .dispenser-expiration').html(data.expiration + ' - ' + formatLivestamp(data.expiration) + ' (' + moment.unix(data.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-dispenser .dispenser-allow-list').html(formatLink('/' + XC.coin + '/action/' + data.allow_list, formatAmount(data.allow_list)));
    $('#info-dispenser .dispenser-block-list').html(formatLink('/' + XC.coin + '/action/' + data.block_list, formatAmount(data.block_list)));
    $('#info-dispenser .dispenser-memo').text(data.memo);
    // Dispenser Status Details
    $('#info-dispenser .dispenser-state-get-remaining').html(formatAmount(data.state.get_remaining));
    $('#info-dispenser .dispenser-state-give-remaining').html(formatAmount(data.state.give_remaining));
    if(data.state.expiration)
        $('#info-dispenser .dispenser-state-expiration').html(data.state.expiration + ' - ' + formatLivestamp(data.state.expiration) + ' (' + moment.unix(data.state.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-dispenser .dispenser-state-allow-list').html(formatLink('/' + XC.coin + '/action/' + data.state.allow_list, formatAmount(data.state.allow_list)));
    $('#info-dispenser .dispenser-state-block-list').html(formatLink('/' + XC.coin + '/action/' + data.state.block_list, formatAmount(data.state.block_list)));
    $('#info-dispenser .dispenser-state').text(data.state.status);
}

// Display DISPENSER_CANCEL action information
function showDispenserCancelDetails(data){
    $('#info-dispenser-cancel .dispenser-cancel-action-index').html(formatLink('/' + XC.coin + '/action/' + data.dispenser_action_index, formatAmount(data.dispenser_action_index)));
    $('#info-dispenser-cancel .dispenser-cancel-memo').text(data.memo);
}

// Display DISPENSER_CLOSE action information
function showDispenserCloseDetails(data){
    $('#info-dispenser-close .dispenser-close-action-index').html(formatLink('/' + XC.coin + '/action/' + data.dispenser_action_index, formatAmount(data.dispenser_action_index)));
}

// Display DISPENSER_EDIT action information
function showDispenserEditDetails(data){
    $('#info-dispenser-edit .dispenser-edit-action-index').html(formatLink('/' + XC.coin + '/action/' + data.dispenser_action_index, formatAmount(data.dispenser_action_index)));
    $('#info-dispenser-edit .dispenser-edit-give-escrow').html(formatAmount(data.give_escrow));
    if(!isNull(data.expiration))
        $('#info-dispenser-edit .dispenser-edit-expiration').html(data.expiration + ' - ' + formatLivestamp(data.expiration) + ' (' + moment.unix(data.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-dispenser-edit .dispenser-edit-allow-list').html(formatLink('/' + XC.coin + '/action/' + data.allow_list, formatAmount(data.allow_list)));
    $('#info-dispenser-edit .dispenser-edit-block-list').html(formatLink('/' + XC.coin + '/action/' + data.block_list, formatAmount(data.block_list)));
    $('#info-dispenser-edit .dispenser-edit-memo').text(data.memo);
}

// Display DISPENSER_EXPIRE action information
function showDispenserExpireDetails(data){
    $('#info-dispenser-expire .dispenser-expire-action-index').html(formatLink('/' + XC.coin + '/action/' + data.dispenser_action_index, formatAmount(data.dispenser_action_index)));
}

// Display DISPENSE action information
function showDispenseDetails(data){
    $('#info-dispense .dispense-give-coin').text(data.give_coin);
    $('#info-dispense .dispense-give-tick').html(formatLink('/' + data.give_coin + '/token/' + data.give_tick, data.give_tick, data.give_tick));
    $('#info-dispense .dispense-give-amount').html(formatAmount(data.give_amount));
    $('#info-dispense .dispense-get-coin').text(data.get_coin);
    $('#info-dispense .dispense-get-tick').html(formatLink('/' + data.get_coin + '/token/' + data.get_tick, data.get_tick, data.get_tick));
    $('#info-dispense .dispense-get-amount').html(formatAmount(data.get_amount));
    $('#info-dispense .dispense-source').html(formatLink('/' + data.get_coin  + '/address/' + data.source, data.source));
    $('#info-dispense .dispense-destination').html(formatLink('/' + data.get_coin  + '/address/' + data.destination, data.destination));
}

// Display FILE action information
function showFileDetails(data){
    $('#info-file .file-name').text(data.name);
    $('#info-file .file-title').text(data.title);
    $('#info-file .file-type').text(data.type);
    $('#info-file .file-memo').text(data.memo);
    // Token-gated FILE: show the gate token, encryption method and key hash, plus
    // a link to the raw (still-encrypted) ciphertext endpoint. Holders decrypt
    // client-side after receiving the key via an ECIES MESSAGE.
    if(!isNull(data.gate_ticker)){
        let method = (data.encryption_method == 1) ? 'AES-256-GCM' : data.encryption_method;
        $('#info-file .file-gate-ticker').html(formatLink('/' + XC.coin + '/token/' + data.gate_ticker, data.gate_ticker, data.gate_ticker));
        $('#info-file .file-encryption').text(method);
        $('#info-file .file-key-hash').html(formatHash(data.key_hash, 24));
        $('#info-file .file-raw').html(formatLink('/' + XC.coin + '/api/file/' + data.action_index + '/raw', 'download ciphertext'));
        $('#info-file .file-gated-row').removeClass('d-none');
    } else {
        $('#info-file .file-gated-row').addClass('d-none');
    }
}

// Display ATTEST action information (v0 request / v1 response — `attests` table)
function showAttestDetails(data){
    let isResponse = (Number(data.version) === 1);
    $('#info-attest .attest-type').html(isResponse ? '<span class="badge text-bg-primary">Response (v' + data.version + ')</span>' : '<span class="badge text-bg-secondary">Request (v' + data.version + ')</span>');
    $('#info-attest .attest-request-id').html(formatHash(data.request_id, 32));
    $('#info-attest .attest-provider').text(data.provider_id);
    if(!isNull(data.contract_index))
        $('#info-attest .attest-contract').html(formatLink('/' + XC.coin + '/contract/' + data.contract_index, data.contract_index));
    // Request-side fields
    $('#info-attest .attest-request-fields').toggleClass('d-none', isResponse);
    if(!isResponse){
        $('#info-attest .attest-fee-payer').html(isNull(data.fee_payer) ? '-' : formatLink('/' + XC.coin + '/address/' + data.fee_payer, data.fee_payer));
        $('#info-attest .attest-callback').text(data.callback_method);
        $('#info-attest .attest-redundancy').text(data.redundancy);
        $('#info-attest .attest-deadline').html(isNull(data.deadline_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.deadline_block, numeral(data.deadline_block).format('0,0')));
        $('#info-attest .attest-request-status').text(data.request_status);
    }
    // Response-side fields
    $('#info-attest .attest-response-fields').toggleClass('d-none', !isResponse);
    if(isResponse){
        $('#info-attest .attest-response-status').text(data.response_status);
        $('#info-attest .attest-response-hash').html(formatHash(data.response_hash, 32));
        $('#info-attest .attest-meta').text(isNull(data.meta) ? '-' : data.meta);
        let sigs = Array.isArray(data.signatures) ? data.signatures : [];
        $('#info-attest .attest-sig-count').text(sigs.length);
        let html = sigs.length ? sigs.map(s => formatHash(s.pubkey, 24)).join('<br>') : '-';
        $('#info-attest .attest-signatures').html(html);
        if(!isNull(data.callback_execute_action_index))
            $('#info-attest .attest-callback-execute').html(formatLink('/' + XC.coin + '/action/' + data.callback_execute_action_index, data.callback_execute_action_index));
    }
}

// Display STAKE action information (capability v1/v2 or contract-targeted v3)
function showStakeDetails(data){
    let isContract = !isNull(data.target_contract_index);
    $('#info-stake .stake-version').text('v' + data.version);
    $('#info-stake .stake-pubkey').html(formatHash(data.signing_pubkey, 24));
    $('#info-stake .stake-amount').html(formatAmount(data.amount));
    $('#info-stake .stake-contract-row').toggleClass('d-none', !isContract);
    if(isContract){
        $('#info-stake .stake-contract').html(formatLink('/' + XC.coin + '/contract/' + data.target_contract_index, data.target_contract_index));
        $('#info-stake .stake-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    }
    if(!isNull(data.activation_block))
        $('#info-stake .stake-activation').html(formatLink('/' + XC.coin + '/block/' + data.activation_block, numeral(data.activation_block).format('0,0')));
    $('#info-stake .stake-deactivation').html(isNull(data.deactivation_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.deactivation_block, numeral(data.deactivation_block).format('0,0')));
}

// Display UNSTAKE action information (capability v0 or contract-targeted v1)
function showUnstakeDetails(data){
    let isContract = !isNull(data.target_contract_index);
    $('#info-unstake .unstake-pubkey').html(formatHash(data.signing_pubkey, 24));
    $('#info-unstake .unstake-amount').html(formatAmount(data.amount));
    $('#info-unstake .unstake-cooldown').html(isNull(data.cooldown_end_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.cooldown_end_block, numeral(data.cooldown_end_block).format('0,0')));
    $('#info-unstake .unstake-contract-row').toggleClass('d-none', !isContract);
    if(isContract){
        $('#info-unstake .unstake-contract').html(formatLink('/' + XC.coin + '/contract/' + data.target_contract_index, data.target_contract_index));
        $('#info-unstake .unstake-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    }
}

// Display DELEGATE action information (capability v0/v2 or contract-targeted v1/v3)
function showDelegateDetails(data){
    let isContract = !isNull(data.target_contract_index);
    $('#info-delegate .delegate-pubkey').html(formatHash(data.signing_pubkey, 24));
    $('#info-delegate .delegate-contract-row').toggleClass('d-none', !isContract);
    if(isContract){
        $('#info-delegate .delegate-contract').html(formatLink('/' + XC.coin + '/contract/' + data.target_contract_index, data.target_contract_index));
        $('#info-delegate .delegate-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    }
    if(!isNull(data.activation_block))
        $('#info-delegate .delegate-activation').html(formatLink('/' + XC.coin + '/block/' + data.activation_block, numeral(data.activation_block).format('0,0')));
    $('#info-delegate .delegate-deactivation').html(isNull(data.deactivation_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.deactivation_block, numeral(data.deactivation_block).format('0,0')));
}

// Display COLLECT action information (validator reward claim)
function showCollectDetails(data){
    $('#info-collect .collect-amount').html(formatAmount(data.amount));
}

// Display DEPLOY action information (contract; v1 surfaces staking metadata)
function showDeployDetails(data){
    $('#info-deploy .deploy-contract').html(formatLink('/' + XC.coin + '/contract/' + data.action_index, data.action_index));
    $('#info-deploy .deploy-code-hash').html(formatHash(data.code_hash, 32));
    $('#info-deploy .deploy-api-version').text(data.api_version);
    let stakeable = !isNull(data.cooldown_blocks);
    $('#info-deploy .deploy-stakeable').html(stakeable ? '<span class="badge text-bg-info text-white">Stakeable</span>' : 'No');
    $('#info-deploy .deploy-staking-row').toggleClass('d-none', !stakeable);
    if(stakeable){
        $('#info-deploy .deploy-cooldown').text(numeral(data.cooldown_blocks).format('0,0') + ' blocks');
        $('#info-deploy .deploy-slash').html(isNull(data.slash_destination) ? 'BURN' : formatLink('/' + XC.coin + '/address/' + data.slash_destination, data.slash_destination));
    }
}

// Display EXECUTE action information (contract method call)
function showExecuteDetails(data){
    $('#info-execute .execute-contract').html(formatLink('/' + XC.coin + '/contract/' + data.contract_index, data.contract_index));
    $('#info-execute .execute-caller').html(formatLink('/' + XC.coin + '/address/' + data.caller, data.caller));
    $('#info-execute .execute-method').text(data.method_name);
    $('#info-execute .execute-gas').text(numeral(data.gas_used).format('0,0') + ' / ' + numeral(data.gas_limit).format('0,0'));
    $('#info-execute .execute-emitted').text(data.emitted_count);
    $('#info-execute .execute-error').text(isNull(data.error_message) ? '-' : data.error_message);
}

// Display DEPOSIT / WITHDRAW action information (contract custody)
function showDepositDetails(data){  showCustodyDetails('deposit', data);  }
function showWithdrawDetails(data){ showCustodyDetails('withdraw', data); }
function showCustodyDetails(kind, data){
    $('#info-' + kind + ' .' + kind + '-contract').html(formatLink('/' + XC.coin + '/contract/' + data.contract_index, data.contract_index));
    $('#info-' + kind + ' .' + kind + '-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    $('#info-' + kind + ' .' + kind + '-amount').html(formatAmount(data.amount));
}

// Display ISSUE action information
function showIssueDetails(data){
    $('#info-issue .issue-transfer').html(formatLink('/' + XC.coin + '/address/' + data.transfer, data.transfer));
    $('#info-issue .issue-ticker').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    $('#info-issue .issue-decimals').text(data.decimals);
    $('#info-issue .issue-max-supply').text(formatAmount(data.max_supply));
    $('#info-issue .issue-max-mint').text(formatAmount(data.max_mint));
    $('#info-issue .issue-mint-supply').text(formatAmount(data.mint_supply));
    $('#info-issue .issue-transfer-supply').html(formatLink('/' + XC.coin + '/address/' + data.transfer_supply, data.transfer_supply));
    $('#info-issue .issue-callback-block').text(data.callback_block);
    $('#info-issue .issue-callback-tick').text(data.callback_tick);
    $('#info-issue .issue-callback-amount').text(formatAmount(data.callback_amount));
    $('#info-issue .issue-description').text(data.description);
    $('#info-issue .issue-allow-list').html(formatLink('/' + XC.coin + '/action/' + data.allow_list, formatAmount(data.allow_list)));
    $('#info-issue .issue-block-list').html(formatLink('/' + XC.coin + '/action/' + data.block_list, formatAmount(data.block_list)));
    $('#info-issue .issue-memo').text(data.memo);
    $('#info-issue .issue-mint-address-max').text(formatAmount(data.mint_address_max));
    $('#info-issue .issue-mint-start-block').text(formatAmount(data.mint_start_block));
    $('#info-issue .issue-mint-stop-block').text(formatAmount(data.mint_stop_block));
    $('#info-issue .issue-lock-max-supply').text(data.lock_max_supply);
    $('#info-issue .issue-lock-mint').text(data.lock_mint);
    $('#info-issue .issue-lock-mint-supply').text(data.lock_mint_supply);
    $('#info-issue .issue-lock-description').text(data.lock_description);
    $('#info-issue .issue-lock-sleep').text(data.lock_sleep);
    $('#info-issue .issue-lock-callback').text(data.lock_callback);    
}

// Display LINK action information
function showLinkDetails(data){
    $('#info-link .link-coin1').text(data.coin1);
    $('#info-link .link-coin1-action-index').html(formatLink('/' + data.coin1 + '/action/' + data.coin1_action_index, formatAmount(data.coin1_action_index)));
    $('#info-link .link-coin2').text(data.coin2);
    $('#info-link .link-coin2-action-index').html(formatLink('/' + data.coin2 + '/action/' + data.coin2_action_index, formatAmount(data.coin2_action_index)));
    $('#info-link .link-memo').text(data.memo);
}

// Display LIST action information
function showListDetails(data){
    if(!data.edit)
        data.edit = 0;
    let list_type = XC.list_types[data.type];
    let type = (data.type) ? (data.type + ' - ' + list_type) : '';
    let edit = (isNumeric(data.edit)) ? (data.edit + ' - ' + XC.list_edit_types[data.edit]) : '';
    $('#info-list .list-type').text(type);
    $('#info-list .list-edit-type').text(edit);
    $('#info-list .list-action-index').html(formatLink('/' + XC.coin + '/action/' + data.list_action_index, formatAmount(data.list_action_index)));
    // Add header columns
    $('#datatable-list-items thead').html('<tr><th class="record" width="155">#</th><th>' + list_type + '</th></tr>');
    $('#datatable-list-edits thead').html('<tr><th class="record" width="155">#</th><th>' + list_type + '</th><th>Status</th></tr>');
    showActionDatatable('list-edits', data.edits, list_type, false);
    showActionDatatable('list-items', data.list,  list_type, false);

}

// Display MESSAGE action information
function showMessageDetails(data){
    let encryption_method = (XC.encryption_methods[data.encryption_method]) ? (data.encryption_method + ' - ' + XC.encryption_methods[data.encryption_method]) : '';
    $('#info-message .message-method').text(encryption_method);
    $('#info-message .message-key').text(data.encryption_key);
    $('#info-message .message-plaintext').text(data.plaintext_message);
    $('#info-message .message-encrypted').text(data.encrypted_message);
    $('#info-message .message-destination').html(formatLink('/' + XC.coin + '/address/' + data.destination, data.destination));
}

// Display MINT action information
function showMintDetails(data){
    $('#info-mint .mint-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    $('#info-mint .mint-amount').html(formatAmount(data.amount));
    $('#info-mint .mint-destination').html(formatLink('/' + XC.coin + '/address/' + data.destination, data.destination));
    $('#info-mint .mint-memo').text(data.memo);
}

// Display ORDER action information
function showOrderDetails(data){
    let isOwnershipGive = (Number(data.give_ownership || 0) == 1);
    let isOwnershipGet  = (Number(data.get_ownership  || 0) == 1);
    $('#info-order .order-give-coin').text(data.give_coin);
    $('#info-order .order-give-tick').html(
        formatLink('/' + data.give_coin + '/token/' + data.give_tick, data.give_tick, data.give_tick)
        + (isOwnershipGive ? ' ' + ownershipBadge() : '')
    );
    $('#info-order .order-give-amount').html(isOwnershipGive ? ownershipBadge() : formatAmount(data.give_amount));
    $('#info-order .order-get-coin').text(data.get_coin);
    $('#info-order .order-get-tick').html(
        formatLink('/' + data.get_coin + '/token/' + data.get_tick, data.get_tick, data.get_tick)
        + (isOwnershipGet ? ' ' + ownershipBadge() : '')
    );
    $('#info-order .order-get-amount').html(isOwnershipGet ? ownershipBadge() : formatAmount(data.get_amount));
    $('#info-order .order-get-address').html(formatLink('/' + data.get_coin  + '/address/' + data.get_address, data.get_address));
    if(data.expiration)
        $('#info-order .order-expiration').html(data.expiration + ' - ' + formatLivestamp(data.expiration) + ' (' + moment.unix(data.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-order .order-allow-list').html(formatLink('/' + XC.coin + '/action/' + data.allow_list, formatAmount(data.allow_list)));
    $('#info-order .order-block-list').html(formatLink('/' + XC.coin + '/action/' + data.block_list, formatAmount(data.block_list)));
    $('#info-order .order-memo').text(data.memo);
    // Order Status Details
    $('#info-order .order-state-get-remaining').html(isOwnershipGet  ? ownershipBadge() : formatAmount(data.state.get_remaining));
    $('#info-order .order-state-give-remaining').html(isOwnershipGive ? ownershipBadge() : formatAmount(data.state.give_remaining));
    if(data.state.expiration)
        $('#info-order .order-state-expiration').html(data.state.expiration + ' - ' + formatLivestamp(data.state.expiration) + ' (' + moment.unix(data.state.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-order .order-state-allow-list').html(formatLink('/' + XC.coin + '/action/' + data.state.allow_list, formatAmount(data.state.allow_list)));
    $('#info-order .order-state-block-list').html(formatLink('/' + XC.coin + '/action/' + data.state.block_list, formatAmount(data.state.block_list)));
    $('#info-order .order-state').text(data.state.status);
}

// Display ORDER_CANCEL action information
function showOrderCancelDetails(data){
    $('#info-order-cancel .order-cancel-action-index').html(formatLink('/' + XC.coin + '/action/' + data.order_action_index, formatAmount(data.order_action_index)));
    $('#info-order-cancel .order-cancel-memo').text(data.memo);
}

// Display ORDER_EDIT action information
function showOrderEditDetails(data){
    $('#info-order-edit .order-edit-action-index').html(formatLink('/' + XC.coin + '/action/' + data.order_action_index, formatAmount(data.order_action_index)));
    if(!isNull(data.expiration))
        $('#info-order-edit .order-edit-expiration').html(data.expiration + ' - ' + formatLivestamp(data.expiration) + ' (' + moment.unix(data.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-order-edit .order-edit-allow-list').html(formatLink('/' + XC.coin + '/action/' + data.allow_list, formatAmount(data.allow_list)));
    $('#info-order-edit .order-edit-block-list').html(formatLink('/' + XC.coin + '/action/' + data.block_list, formatAmount(data.block_list)));
    $('#info-order-edit .order-edit-memo').text(data.memo);
}

// Display ORDER_EXPIRE action information
function showOrderExpireDetails(data){
    $('#info-order-expire .order-expire-action-index').html(formatLink('/' + XC.coin + '/action/' + data.order_action_index, formatAmount(data.order_action_index)));
}

// Display ORDER_MATCH action information
function showOrderMatchDetails(data){
    $('#info-order-match .order-match-give-action-index').html(formatLink('/' + data.give_coin + '/action/' + data.give_action_index, formatAmount(data.give_action_index)));
    $('#info-order-match .order-match-get-action-index').html(formatLink('/'  + data.get_coin + '/action/'  + data.get_action_index,  formatAmount(data.get_action_index)));
    $('#info-order-match .order-match-give-coin').text(data.give_coin);
    $('#info-order-match .order-match-give-tick').html(formatLink('/' + data.give_coin + '/token/' + data.give_tick, data.give_tick,  data.give_tick));
    $('#info-order-match .order-match-give-amount').text(data.give_amount);
    $('#info-order-match .order-match-get-coin').text(data.get_coin);
    $('#info-order-match .order-match-get-tick').html(formatLink('/' + data.get_coin + '/token/' + data.get_tick, data.get_tick,  data.get_tick));
    $('#info-order-match .order-match-get-amount').text(data.get_amount);
}

// Display SEND action information
function showSendDetails(data){
    showActionDatatable('send',data.sends);
}

// Display SLEEP action information
function showSleepDetails(data){
    let sleep_type = data.type + ' - Sleep ' + XC.sleep_types[data.type];
    $('#info-sleep .sleep-type').text(sleep_type);
    $('#info-sleep .sleep-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    $('#info-sleep .sleep-resume-block').html(formatLink('/' + XC.coin + '/block/' + data.resume_block, formatAmount(data.resume_block)));
    $('#info-sleep .sleep-memo').text(data.memo);
}

// Display SWAP action information
function showSwapDetails(data){
    let isOwnershipGive = (Number(data.give_ownership || 0) == 1);
    let isOwnershipGet  = (Number(data.get_ownership  || 0) == 1);
    $('#info-swap .swap-give-coin').text(data.give_coin);
    $('#info-swap .swap-give-tick').html(
        formatLink('/' + data.give_coin + '/token/' + data.give_tick, data.give_tick, data.give_tick)
        + (isOwnershipGive ? ' ' + ownershipBadge() : '')
    );
    $('#info-swap .swap-give-amount').html(isOwnershipGive ? ownershipBadge() : formatAmount(data.give_amount));
    $('#info-swap .swap-get-coin').text(data.get_coin);
    $('#info-swap .swap-get-tick').html(
        formatLink('/' + data.get_coin + '/token/' + data.get_tick, data.get_tick, data.get_tick)
        + (isOwnershipGet ? ' ' + ownershipBadge() : '')
    );
    $('#info-swap .swap-get-amount').html(isOwnershipGet ? ownershipBadge() : formatAmount(data.get_amount));
    $('#info-swap .swap-get-address').html(formatLink('/' + data.get_coin  + '/address/' + data.get_address, data.get_address));
    if(!isNull(data.expiration))
        $('#info-swap .swap-expiration').html(data.expiration + ' - ' + formatLivestamp(data.expiration) + ' (' + moment.unix(data.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-swap .swap-allow-list').html(formatLink('/' + XC.coin + '/action/' + data.allow_list, formatAmount(data.allow_list)));
    $('#info-swap .swap-block-list').html(formatLink('/' + XC.coin + '/action/' + data.block_list, formatAmount(data.block_list)));
    $('#info-swap .swap-memo').text(data.memo);
    // Swap Status Details
    $('#info-swap .swap-state-get-remaining').html(isOwnershipGet  ? ownershipBadge() : formatAmount(data.state.get_remaining));
    $('#info-swap .swap-state-give-remaining').html(isOwnershipGive ? ownershipBadge() : formatAmount(data.state.give_remaining));
    if(data.state.expiration)
        $('#info-swap .swap-state-expiration').html(data.state.expiration + ' - ' + formatLivestamp(data.state.expiration) + ' (' + moment.unix(data.state.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-swap .swap-state-allow-list').html(formatLink('/' + XC.coin + '/action/' + data.state.allow_list, formatAmount(data.state.allow_list)));
    $('#info-swap .swap-state-block-list').html(formatLink('/' + XC.coin + '/action/' + data.state.block_list, formatAmount(data.state.block_list)));
    $('#info-swap .swap-state').text(data.state.status);
}

// Display SWAP_CANCEL action information
function showSwapCancelDetails(data){
    $('#info-swap-cancel .swap-cancel-action-index').html(formatLink('/' + XC.coin + '/action/' + data.swap_action_index, formatAmount(data.swap_action_index)));
    $('#info-swap-cancel .swap-cancel-memo').text(data.memo);
}

// Display SWAP_EDIT action information
function showSwapEditDetails(data){
    $('#info-swap-edit .swap-edit-action-index').html(formatLink('/' + XC.coin + '/action/' + data.swap_action_index, formatAmount(data.swap_action_index)));
    if(!isNull(data.expiration))
        $('#info-swap-edit .swap-edit-expiration').html(data.expiration + ' - ' + formatLivestamp(data.expiration) + ' (' + moment.unix(data.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-swap-edit .swap-edit-allow-list').html(formatLink('/' + XC.coin + '/action/' + data.allow_list, formatAmount(data.allow_list)));
    $('#info-swap-edit .swap-edit-block-list').html(formatLink('/' + XC.coin + '/action/' + data.block_list, formatAmount(data.block_list)));
    $('#info-swap-edit .swap-edit-memo').text(data.memo);
}

// Display SWAP_EXPIRE action information
function showSwapExpireDetails(data){
    $('#info-swap-expire .swap-expire-action-index').html(formatLink('/' + XC.coin + '/action/' + data.swap_action_index, formatAmount(data.swap_action_index)));
}


// Display SWAP_MATCH action information
function showSwapMatchDetails(data){
    $('#info-swap-match .swap-match-give-action-index').html(formatLink('/' + data.give_coin + '/action/' + data.give_action_index, formatAmount(data.give_action_index)));
    $('#info-swap-match .swap-match-get-action-index').html(formatLink('/'  + data.get_coin + '/action/'  + data.get_action_index,  formatAmount(data.get_action_index)));
    $('#info-swap-match .swap-match-give-coin').text(data.give_coin);
    $('#info-swap-match .swap-match-give-tick').html(formatLink('/' + data.give_coin + '/token/' + data.give_tick, data.give_tick,  data.give_tick));
    $('#info-swap-match .swap-match-give-amount').text(data.give_amount);
    $('#info-swap-match .swap-match-get-coin').text(data.get_coin);
    $('#info-swap-match .swap-match-get-tick').html(formatLink('/' + data.get_coin + '/token/' + data.get_tick, data.get_tick,  data.get_tick));
    $('#info-swap-match .swap-match-get-amount').text(data.get_amount);
}

// Display SWEEP action information
function showSweepDetails(data){
    $('#info-sweep .sweep-balances').html(data.balances);
    $('#info-sweep .sweep-ownerships').html(data.ownerships);
    $('#info-sweep .sweep-orders').html(data.orders);
    $('#info-sweep .sweep-swaps').html(data.swaps);
    $('#info-sweep .sweep-dispensers').html(data.dispensers);
    $('#info-sweep .sweep-destination').html(formatLink('/' + XC.coin + '/address/' + data.destination, data.destination));
    $('#info-sweep .sweep-memo').text(data.memo);
}

// Display FEE details
function showActionFeeDetails(data){
    if(data){
        let method = (data.method) ? (' - ' + XC.fee_preferences[data.method]) : '';
        let tick   = (data.tick!='') ? data.tick : false;
        $('#info-fee .fee-tick').html(formatLink('/' + XC.coin + '/token/' + tick, tick, tick));
        $('#info-fee .fee-amount').html(formatAmount(data.amount));
        $('#info-fee .fee-method').html(data.method + method);
        $('#info-fee .fee-destination').html(formatLink('/' + XC.coin + '/address/' + data.destination, data.destination));
    }
}

// Display action datatables
function showActionDatatable(type, data, dataType=null, autoWidth=true, ){
    var id   = 'datatable-' + type,
        body = $('#' + id + ' tbody'),
        html = '';
    if(data && data.length>=1){
        // Loop through data and add to the datatables before initialization
        data.forEach(function(info, idx){
            var cls = (info.status=='valid') ? 'bg-green' : 'bg-red';
            if(['actions','batch'].includes(type)){
                let details = (info.details) ? info.details : info;
                html += '<tr class="' + cls + '">'
                html += '    <td>' + (idx+1) + '</td>';
                html += '    <td>' + formatLink('/' + XC.coin + '/action/' + info.action_index, formatAmount(info.action_index)) + '</td>';
                html += '    <td>' + info.action + '</td>';
                html += '    <td>' + getActionDetails(info.action, details) + '</td>';
                html += '    <td>' + info.status + '</td>';
                html += '    <td>' + formatLink('/' + XC.coin + '/action/' + info.action_index, 'view', null, true) + '</td>';
                html += '</tr>';
            } else if(type=='list-items'){
                html += '<tr>'
                html += '    <td>' + (idx+1) + '</td>';
                if(dataType=='Address')
                    html += '    <td>' + formatLink('/' + XC.coin + '/address/' + info, info) + '</td>';
                if(dataType=='Token')
                    html += '    <td>' + formatLink('/' + XC.coin + '/token/' + info, info) + '</td>';
                html += '</tr>';
            } else if(type=='list-edits'){
                html += '<tr class="' + cls + '">'
                html += '    <td>' + (idx+1) + '</td>';
                if(dataType=='Address')
                    html += '    <td>' + formatLink('/' + XC.coin + '/address/' + info.address, info.address) + '</td>';
                if(dataType=='Token')
                    html += '    <td>' + formatLink('/' + XC.coin + '/token/' + info.tick, info.tick) + '</td>';
                html += '    <td>' + info.status + '</td>';
                html += '</tr>';
            // } else if(type=='actions'){
            //     html += '<tr class="' + cls + '">'
            //     html += '    <td>' + (idx+1) + '</td>';
            //     html += '    <td>' + info.action + '</td>';
            //     html += '    <td>' + getActionDetails(info.action, info) + '</td>';
            //     html += '    <td>' + info.status + '</td>';
            //     html += '    <td>' + formatLink('/' + XC.coin + '/action/' + info.action_index, 'view', null, true) + '</td>';
            //     html += '</tr>';
            } else if(type=='send'){
                html += '<tr class="' + cls + '">'
                html += '    <td>' + (idx+1) + '</td>';
                html += '    <td>' + formatLink('/' + XC.coin + '/address/' + info.destination, info.destination) + '</td>';
                html += '    <td>' + formatLink('/' + XC.coin + '/token/' + info.tick, info.tick, info.tick) + '</td>';
                html += '    <td>' + formatAmount(info.amount) + '</td>';
                html += '    <td>' + info.status + '</td>';
                html += '</tr>';
            } else {
                html += '<tr>'
                html += '    <td>' + (idx+1) + '</td>';
                html += '    <td>' + formatLink('/' + XC.coin + '/address/' + info.address, info.address) + '</td>';
                html += '    <td>' + formatLink('/' + XC.coin + '/token/' + info.tick, info.tick, info.tick) + '</td>';
                html += '    <td>' + formatAmount(info.amount) + '</td>';
                html += '</tr>';
            }
        });
        body.html(html);
    }
    initStaticDatatable(id, autoWidth);
}

// Display lock status text and icon
function showLockStatus(locked){
    var icon = (locked) ? 'fa-lock' : 'fa-lock-open',
        text = (locked) ? 'Locked' : 'Unlocked',
        html = '<i class="fa pe-1 ' + icon + '"></i>' + text;
    return html;
}

// Function to remove HTML content from string
// Escape user-controlled text for safe insertion via jQuery .html() / innerHTML.
// The canonical five-entity replacement. Apply to ANY on-chain free-text field
// (description, memo, message, token names) before it reaches an HTML sink —
// those values are attacker-controlled and the indexer stores them verbatim.
function escapeHtml(s){
    if(s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function(c){
        return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
}

function stripHtml(html){
    // Parse INERTLY. DOMParser('text/html') builds a document whose scripts do
    // not run and whose resource handlers (img/onerror, svg/onload) do not fire,
    // so hostile markup can't execute while we pull out plain text. The previous
    // version assigned user input to a live element's .innerHTML, which fires
    // onerror/onload during the assignment — itself an XSS execution sink.
    try {
        var doc = new DOMParser().parseFromString(String(html), 'text/html');
        return doc.body.textContent || '';
    } catch(e) {
        return String(html).replace(/<[^>]*>/g, '');
    }
}

// Handle getting record type from array
function getArrayItemByType(arr, type){
    rec = false;
    arr.forEach(function(item){
        if(item.type==type && !isNull(item))
            rec = item
    });
    return rec;
}

// Handle loading remote image icon. Sets the IMG src directly so any
// image URL works (ipfs gateway, arweave, imgur, etc.) — the previous
// /relay-based path only worked for .json/.png/arweave.net URLs and
// silently no-op'd on everything else. The IMG's error handler in
// token.html falls back to default.png if the URL fails to load.
function displayTokenIcon(image){
    if(image)
        $('#tokenIcon').attr('src', image);
}

// Simple function to resize iframe height to fit content
function resizeIframe(id){
    var el   = $(id),
        body = el.contents().find('body');
    el.height(body.height() + 16);
}

// Handle updating a table row with data removing the row
function updateTokenTableRow(id=null, value=false, html=false){
    if(id){
        var el = $(id);
        if(el){
            // Update element with value if we have one
            if(value && !isNull(value)){
                if(html){
                    el.html(html);
                } else {
                    el.text(value);
                }
                // Set flags to indicate if we found token info
                XC.tokenInfoFound     = true;
                XC.someTokenInfoFound  = true;
            } else {
                el.parent().remove();
            }
        }
    }
}

// Handle updating a token section to display and reset token info found flag
function updateTokenSection(id){
    if(XC.tokenInfoFound){
        let el = $(id);
        if(el){
            el.show();
        }
        // Reset the token info found flag for the next section
        XC.tokenInfoFound = false;
    }
}

// Handle displaying token content (images, audio, video, etc)
function showTokenContent(json){
    // Convert any legacy formated JSON to the new XChain Token Information Standard (TIS)
    json = legacyJsonToXChainTIS(json);

    // Cache JSON so we can easily reference it again when needed
    cachedJson = json;

    // Create short alias to json object
    let o = json;

    // Placeholders to indicate if there is audio/video/image/title content
    var audio = false,
        video = false,
        image = false,
        title = false;

    // Basic Token Information
    var main  = getArrayItemByType(o.categories, 'main'),
        sub   = getArrayItemByType(o.categories, 'sub'),
        other = getArrayItemByType(o.categories, 'other');
    updateTokenTableRow('#tokenName', o.name);
    // o.website is on-chain token metadata (attacker-controlled). Escape both the
    // href and the visible text so a value like `x" onmouseover="…` or
    // `"><img src=x onerror=…>` cannot break out of the attribute / tag.
    updateTokenTableRow('#tokenWebsite', o.website, '<a href="' + escapeHtml(getValidUrl(o.website)) + '" target="_blank">' + escapeHtml(o.website) + '</a>');
    updateTokenTableRow('#pgpSignature', o.pgpsig);
    updateTokenTableRow('#tokenCategory', main.data);
    updateTokenTableRow('#tokenSubCategory', sub.data);
    updateTokenTableRow('#tokenCategoryOther', other.data);
    updateTokenTableRow('#tokenExtendedDescription', o.description);
    updateTokenSection('#additionalTokenInfo');

    // Owner Information
    updateTokenTableRow('#ownerName', o.owner.name);
    updateTokenTableRow('#ownerTitle', o.owner.title);
    updateTokenTableRow('#ownerOrganization', o.owner.organization);
    updateTokenSection('#ownerInfo');

    // Contacts)
    if(o.contacts.length){
        var table = $('#contactInfo table tbody');
        table.empty();
        o.contacts.slice(0,10).forEach(function(item){
            // item.type/item.data are on-chain token metadata (attacker-controlled);
            // escape both before they reach the .append() HTML sink.
            var type = item.type.toLowerCase(),
                t    = escapeHtml(item.type),
                d    = escapeHtml(item.data),
                html = '<tr><th>' + t + '</th><td>' + d + '</td></tr>';
            if(type=='email')
                html = '<tr><th>' + t + '</th><td><a href="mailto:'+ d + '">' + d + '</a></td></tr>'
            if(type=='phone'||type=='fax')
                html = '<tr><th>' + t + '</th><td><a href="tel:'+ d + '">' + d + '</a></td></tr>'
            if(type=='url')
                html = '<tr><th>' + t + '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + d + '</a></td></tr>'
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#contactInfo');
    }

    // Social Media
    if(o.social.length){
        var table = $('#socialInfo table tbody');
        table.empty();
        o.social.slice(0,10).forEach(function(item){
            // On-chain fields — escape type, href and link text.
            let html = '<tr><th>' + escapeHtml(item.type) + '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#socialInfo');
    }

    // Images
    if(o.images.length){
        var table = $('#imagesInfo table tbody');
        table.empty();
        o.images.slice(0,10).forEach(function(item){
            if(item.data.substring(0,4)=='data')
                return;
            // On-chain fields — escape type, size, href and link text.
            let html = '<tr><th>' + escapeHtml(item.type);
            if(item.size)
                html += ' (' + escapeHtml(String(item.size)) + ')';
            html += '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#imagesInfo');
        // Extract image from images array
        var large    = getArrayItemByType(o.images, 'large'),
            standard = getArrayItemByType(o.images, 'standard'),
            first    = o.images[0].data;
        image = (large) ? large.data : (standard) ? standard.data : first.data;
        title = (large) ? large.name : (standard) ? standard.name : first.name;
    }

    // Audio
    if(o.audio.length){
        var table = $('#audioInfo table tbody');
        table.empty();
        o.audio.slice(0,10).forEach(function(item){
            let html = '<tr><th>' + escapeHtml(item.type) + '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#audioInfo');
        // Extract audio from audio array
        var m4a   = getArrayItemByType(o.audio, 'm4a'),
            mp3   = getArrayItemByType(o.audio, 'mp3'),
            wav   = getArrayItemByType(o.audio, 'wav'),
            first = o.audio[0].data;
        audio = (m4a) ? m4a.data : (mp3) ? mp3.data : (wav) ? wav.data : first.data;
        if(!title)
            title = (m4a) ? m4a.name : (mp3) ? mp3.name : (wav) ? wav.name : first.name;

    }

    // Video
    if(o.video.length){
        var table = $('#videoInfo table tbody');
        table.empty();
        o.video.slice(0,10).forEach(function(item){
            let html = '<tr><th>' + escapeHtml(item.type) + '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#videoInfo');
        // Extract video from videos array
        var mp4   = getArrayItemByType(o.video, 'mp4'),
            mov   = getArrayItemByType(o.video, 'mov'),
            wmv   = getArrayItemByType(o.video, 'wmv'),
            first = o.video[0].data;
        video = (mp4) ? mp4.data : (mov) ? mov.data : (wmv) ? wmv.data : first.data;
        if(!title)
            title = (mp4) ? mp4.name : (mov) ? mov.name : (wmv) ? wmv.name : first.name;
    }

    // Files
    if(o.files.length){
        var table = $('#fileInfo table tbody');
        table.empty();
        o.files.slice(0,10).forEach(function(item){
            let html = '<tr><th>' + escapeHtml(item.type) + '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#fileInfo');
    }

    // DNS
    if(o.dns.length){
        var table = $('#dnsInfo table tbody');
        table.empty();
        table.append('<tr><th>Type</th><th>Host</th><th>Value</th></tr>')
        o.dns.slice(0,10).forEach(function(item){
            // On-chain DNS record fields — escape all three.
            var html = '<tr><td>' + escapeHtml(item.type) + '</td><td>' + escapeHtml(item.host) + '</td><td>' + escapeHtml(item.value) + '</td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#dnsInfo');
    }

    // Token Icon
    var icon = false;
    if(o.images.length){
        // First try to find 64x64 icon
        o.images.forEach(function(item){
            if(!icon && item.type=='icon' && item.size=='64x64')
                icon = item.data;
        });
        // Failover to try to find 48x48 icon
        o.images.forEach(function(item){
            if(!icon && item.type=='icon' && item.size=='48x48')
                icon = item.data;
        });
        // If we couldn't find an icon, use the first icon in the list
        o.images.forEach(function(item){
            if(!icon && item.type=='icon')
                icon = item.data;
        });
    }
    // Use legacy "image" param if we couldn't find icon in the CIP25 images array
    if(!icon && o.image)
        icon = o.image;
    // Handle displaying token icon image
    if(icon)
        displayTokenIcon(icon);

    // Setup short alias to token description
    var desc = $('#token-description').text();

    // If we do not already have any audio/video/image content defined, check if this is one of the TIS defined formats
    // https://github.com/XChain-platform/xchain-documentation/blob/master/Token_Information_Standard.md#supported-token-description-formats
    if(!audio && !video && !image){
        // Cleanup description a bit to remove leading/trailing spaces and some funky characters
        desc = desc.trim().replace('\u001e','');
        if(/^(imgur|youtube|soundcloud)/i.test(desc)){
            // service/info;title format parsing
            var [url, title, xtra] = desc.split(';'),
                [service, code]    = url.split('/'),
                title              = (xtra) ? title + ';' + xtra: title,
                service            = service.toLowerCase();
            // Cleanup some bad formats
            if(service=='imgur.com')
                service = 'imgur';
            // Handle decoding some common characters
            if(title)
                title = title.replace('&#39;',"'");
            if(service=='imgur')
                image = 'https://i.imgur.com/' + code;
            if(service=='youtube')
                video = 'https://www.youtube.com/embed/' + code;
            if(service=='soundcloud')
                audio = 'https://api.soundcloud.com/tracks/' + code;
            if(XC.debug)
                console.log('service, code, title', service, code, title);
        }
    }

    // Handle processing descriptions that include urls
    if(!audio && !video && !image){
        if(/http/.test(desc) || /i\.imgur\.com/.test(desc)){
            var [url, qs] = desc.split('?'), // Ignore any querystring data
                arr = url.split('.'),
                url = desc,
                ext = arr[arr.length-1].toLowerCase();
            if(url.indexOf('http')==-1)
                url = 'http://' + url;
            // Handle images
            var images = ['gif','jpg','jpeg','gif','png'],
                audios = ['m4a','mp3','wav'],
                videos = ['mp4','mov','wmv'];
            if(images.indexOf(ext)!=-1)
                image = url;
            if(audios.indexOf(ext)!=-1)
                audio = url;
            if(videos.indexOf(ext)!=-1)
                video = url;
        }
    }        

    // If we have a title, display it
    title = (title) ? String(title).replace('&#39;',"'") : null;
    updateTokenTableRow('#artwork-title', title);
    updateTokenSection('#artwork-information');


    // If we have any image/audio/video content, display it
    if(image||audio||video){
        if(image){
            $('#artwork-header').show();
            var el = $('#artwork-image');
            el.attr('src',image);
            el.show();
        }
        if(video){
            $('#video-header').show();
            var el  = $('#video-wrapper'),
                arr = video.split('.'),
                ext = arr[arr.length-1].toLowerCase();
            if(/youtube/.test(video)){
                el   = $('#video-wrapper-youtube'),
                html = '<iframe src="' + escapeHtml(video) + '" frameborder="0" allowfullscreen class="embedded-video"></iframe>';
            } else {
                var type = '';
                if(ext=='mp4') type = 'video/mp4';
                if(ext=='wmv') type = 'video/x-ms-asf';
                if(ext=='mov') type = 'video/quicktime'
                // `video` is an on-chain media URL (attacker-controlled) — escape it so it
                // cannot break out of the src attribute. `type` is a fixed constant above.
                html = '<video draggable="false" controls playsinline="" autoplay="" loop="" class="img-fluid img-responsive" width="100%" style="max-width:400px"><source type="' + type+ '" src="' + escapeHtml(video) + '"></video>';
            }
            el.html(html).show()
        }
        if(audio){
            $('#audio-header').show();
            var el = $('#audio-wrapper');
            if(/soundcloud/.test(audio)){
                el = $('#audio-wrapper-soundcloud');
                html = '<iframe src="https://w.soundcloud.com/player/?url=' + escapeHtml(audio) + '" frameborder="0" allowfullscreen class="soundcloud-audio"></iframe>';
            } else {
                // `audio` is an on-chain media URL (attacker-controlled) — escape it.
                html = '<audio src="' + escapeHtml(audio) + '" autoplay="true" controls loop preload></audio>';
            }
            el.html(html).show();
        }
        // Display the 'Digital Artwork' sections
        XC.tokenInfoFound = true;
        XC.someTokenInfoFound = true;
        updateTokenSection('#digitalArtInfo');
    }

    // Display any custom HTML content (with a warning before loading)
    if(o.html && !isNull(o.html)){
        XC.someTokenInfoFound = true;
        $('#custom-content-header').show();
        $('#custom-content-wrapper').show();
        // Handle loading custom content when the use clicks the "Load Content" button
        $('#loadCustomContentButton').click(function(){
            $('#customContentWarning').hide();
            var el   = $('#customContentViewer');
                body = el.contents().find('body');
            body.html(cachedJson.html);
            el.show();
            // Cheezy hack to resize the content as it loads
            setTimeout(function(){ resizeIframe(); }, 100);
            setTimeout(function(){ resizeIframe(); }, 250);
            setTimeout(function(){ resizeIframe(); }, 500);
            setTimeout(function(){ resizeIframe(); }, 1000);
            setTimeout(function(){ resizeIframe(); }, 2000);
        });
        // Setup a listener for iframe resizes so we can recalculate the dimensions
        var iframeWin = document.getElementById('customContentViewer').contentWindow;
        $(iframeWin).on('resize', function(){ resizeIframe('#customContentViewer'); });
    }

    // Hide the "No additional information is available" section
    if(XC.someTokenInfoFound)
        $('#additionalInfoNotAvailable').hide();
}

// Handle displaying token details
function showTokenInfo(){
    // Setup short alias to token info object
    let o = XC.tokenInfo;

    // Setup short alias for token description
    var desc  = o.info.description;

    // Define the various numeral formats to use
    let fmtCoin  = '0,0.00000000',
        fmtFiat  = '0,0.00';

    // Basic Token Information
    $('.xchain-tick').text(o.info.tick);
    $('#supply').text(formatAmount(o.supply.current));
    $('#max-supply').text(formatAmount(o.supply.max));
    $('#max-mint').text(formatAmount(o.mints.max));
    $('#owner').html(formatLink('/' + XC.coin + '/address/' + o.info.owner, o.info.owner));
    $('#token-description').text(desc);

    // Marketcap and Pricing Information
    $('.xchain-coin').text(o.info.coin);
    $('#market-price-coin').text(numeral(o.market.price).format(fmtCoin));
    $('#market-price-fiat').text(numeral(bcmul(o.market.price, XC.coin_price, 2)).format(fmtFiat));
    $('#market-floor-coin').text(numeral(o.market.floor).format(fmtCoin));
    $('#market-floor-fiat').text(numeral(bcmul(o.market.floor, XC.coin_price, 2)).format(fmtFiat));
    var mcap = bcmul(o.market.price, o.supply.current, 8);
    $('#market-marketcap-coin').text(numeral(mcap).format(fmtCoin));
    $('#market-marketcap-fiat').text(numeral(bcmul(mcap, XC.coin_price, 2)).format(fmtFiat));

    // Callback Token Information
    if(!isNull(o.callback.tick)){
        $('#callback-tick').html(formatLink('/' + XC.coin + '/token/' + o.callback.tick, o.callback.tick));
        $('#callback-block').html(formatLink('/' + XC.coin + '/block/' + o.callback.block, numeral(o.callback.block).format('0,0')));
        if(o.callback.amount){
            $('#callback-amount').text(formatAmount(o.callback.amount));
            $('#callback-price-coin').text(numeral(bcmul(o.callback.amount, o.callback.price, 8)).format(fmtCoin));
        }
    }

    // Locks 
    $('#lock-max-supply').html(showLockStatus(o.locks.max_supply));
    $('#lock-max-mint').html(showLockStatus(o.locks.max_mint));
    $('#lock-mint').html(showLockStatus(o.locks.mint));
    $('#lock-mint-supply').html(showLockStatus(o.locks.mint_supply));
    $('#lock-description').html(showLockStatus(o.locks.description));
    $('#lock-sleep').html(showLockStatus(o.locks.sleep));
    $('#lock-callback').html(showLockStatus(o.locks.callback));    

    // RegExp for pattern matching in description
    let json    = /^(.*).json/i,
        http    = /^http:\/\//,
        https   = /^https:\/\//,
        ord     = /^ord:/i,
        ipfs    = /^ipfs:/i,
        ar      = /^ar:/i,
        arweave = /^https?:\/\/arweave\.net\//i;

    // Rescue arweave URLs that used the legacy "/x.json" trick (gateway no longer accepts random suffixes)
    if(typeof desc === 'string')
        desc = desc.replace(/^(https?:\/\/arweave\.net\/[^\/?#]+)\/x\.json$/i, '$1');

    // If the file starts with http and end with JSON, then assume it is valid url and link it
    if(json.test(desc)||http.test(desc)||https.test(desc)){
        // arr[0]/arr[1] are user-controlled description text. Escape both the
        // href (against attribute breakout) and the visible text (against tag
        // injection); getValidUrl already constrains the scheme.
        var arr  = desc.split(';'),
            html = '<a href="' + escapeHtml(getValidUrl(arr[0])) + '" target="_blank">' + escapeHtml(arr[0]) + '</a>';
        if(arr[1])
            html += ';' + escapeHtml(arr[1]);
        $('#token-description').html(html);
    }

    // Set the full url to get JSON content
    let jsonUrl = false;
    if(json.test(desc) || ipfs.test(desc) || ord.test(desc) || ar.test(desc) || arweave.test(desc)){
        if(ipfs.test(desc)){
            jsonUrl = 'https://ipfs.io/ipfs/' + String(desc).replace(ipfs,'');
        } else if(ord.test(desc)){
            var hash = String(desc).replace(ord,'');
            if(hash.length!=64)
                hash = base64ToHex(hash);
            jsonUrl = 'https://inscription-decoder.vercel.app/api/image?type=json&tx=' + hash;
        } else if(ar.test(desc)){
            jsonUrl = 'https://arweave.net/' + String(desc).replace(ar,'');
        } else if(arweave.test(desc)){
            jsonUrl = desc;
        } else {
            jsonUrl = 'https://' + arr[0].replace('https://','').replace('http://','');
        }
    }

    // Handle trying to load any JSON content and show the token content
    if(jsonUrl){
        if(XC.debug)
            console.log('Attempting to get JSON...');
        // Try to make a request for the JSON directly (might fail due to missing CORS headers)
        $.getJSON( jsonUrl, function(o){ 
            showTokenContent(o);
        }).fail(function(){
            if(XC.debug)
                console.log('failed to get JSON... retrying using xchain-explorer relay')
            // Try to request the JSON through the xchain relay
            $.getJSON( '/relay?url=' + jsonUrl, function(o){ 
                showTokenContent(o);
            });
        }); 
    } else {
        showTokenContent();
    }
}


// Handle converting any legacy JSON to use the XChain Token Information Standard standard
// https://github.com/XChain-platform/xchain-documentation/blob/master/Token_Information_Standard.md
function legacyJsonToXChainTIS(o){
    var json = {},
        ipfs = /^ipfs:\/\//i,
        ar   = /^ar:/i,
        o    = (o) ? o : {};
    // Map a top-level "icon" field (a common typo for "image" in community
    // JSONs) onto image so the rest of the pipeline picks it up.
    if(o.icon)
        o.image = o.icon;
    // Replace any ipfs:// urls with the URL provided by Shaban of Spells of Genesis
    if(ipfs.test(o.image))
        o.image = 'https://ipfsc.crystalsuite.com/' + String(o.image).replace(ipfs,'');
    // Replace any ar: urls with the arweave.net gateway
    if(ar.test(o.image))
        o.image = 'https://arweave.net/' + String(o.image).replace(ar,'');
    // Pass basic token info fields forward
    ['token','description','image','website','pgpsig','name'].forEach(function(name){ if(o[name]) json[name]=o[name]; });
    // Owner fields
    json.owner = {};
    if(o.owner)
        ['name','title','organization'].forEach(function(name){ if(o.owner[name]) json.owner[name]=o.owner[name]; });
    // Contacts Data
    json.contacts = (typeof o.contacts === 'object') ? o.contacts : [];
    if(o.contact_address_line_1)
        json.contacts.push({ type: 'address', data: o.contact_address_line_1 + ' ' + o.contact_address_line_2 + ', ' +  o.contact_city + ', ' +  o.contact_state_province + ' ' +  o.contact_postal_code + ' ' + o.contact_country });
    if(o.contact_email1)
        json.contacts.push({ type: 'email', data: o.contact_email1 });
    if(o.contact_email2)
        json.contacts.push({ type: 'email', data: o.contact_email2 });
    if(o.contact_phone)
        json.contacts.push({ type: 'phone', data: o.contact_phone });
    if(o.contact_fax)
        json.contacts.push({ type: 'fax', data: o.contact_fax });
    if(o.website_alternate1)
        json.contacts.push({ type: 'url', data: o.website_alternate1 });
    if(o.website_alternate2)
        json.contacts.push({ type: 'url', data: o.website_alternate2 });
    // Category Data
    json.categories = (typeof o.categories === 'object') ? o.categories : [];
    if(o.category)
        json.categories.push({ type: 'main', data: o.category });
    if(o.subcategory)
        json.categories.push({ type: 'sub', data: o.subcategory });
    if(o.category_custom)
        json.categories.push({ type: 'other', data: o.category_custom });
    // Social Media
    json.social = (typeof o.social === 'object') ? o.social : [];
    if(o.website_social_facebook)
        json.social.push({ type: 'facebook', data: o.website_social_facebook });
    if(o.website_social_github)
        json.social.push({ type: 'github', data: o.website_social_github });
    if(o.website_social_twitter)
        json.social.push({ type: 'twitter', data: o.website_social_twitter });
    if(o.website_social_reddit)
        json.social.push({ type: 'reddit', data: o.website_social_reddit });
    if(o.website_social_linkedin)
        json.social.push({ type: 'linkedin', data: o.website_social_linkedin });
    // Images
    json.images = (typeof o.images === 'object') ? o.images : [];
    // Add 'image' to images array if it does not already exist
    if(o.image){
        var found = false;
        json.images.forEach(function(item){
            if(item.data==o.image)
                found = true;
        });
        if(!found)
            json.images.push({ type: 'icon', data: o.image });
    }
    if(o.image_large)
        json.images.push({ type: 'large', name: o.image_title, data: o.image_large });
    if(o.image_large_hd)
        json.images.push({ type: 'hires', name: o.image_title, data: o.image_large_hd });
    // Loop through images and rewrite any ipfs:// or ar: URLs to gateway URLs
    json.images.forEach(function(item){
        if(ipfs.test(item.data))
            item.data = 'https://ipfsc.crystalsuite.com/' + String(item.data).replace(ipfs,'');
        if(ar.test(item.data))
            item.data = 'https://arweave.net/' + String(item.data).replace(ar,'');
    });
    // Audio
    json.audio = (typeof o.audio === 'object') ? o.audio : [];
    if(o.audio!='' && typeof o.audio === 'string')
        json.audio.push({ type: o.audio.slice(-3), data: o.audio });
    // Video
    json.video = (typeof o.video === 'object') ? o.video : [];
    if(o.video!='' && typeof o.video === 'string')
        json.video.push({ type: o.video.slice(-3), data: o.video });
    // Files
    json.files = (typeof o.files === 'object') ? o.files : [];
    // DNS
    json.dns = (typeof o.dns === 'object') ? o.dns : [];
    // Handle trying to extact image/video/audio data from the html description
    var urls   = String(o.description).match(/(((https?:\/\/)|(www\.))[^\s]+)/g),
        images = ['gif','jpg','jpeg','gif','png'],
        audios = ['m4a','mp3','wav'],
        videos = ['mp4','mov','wmv'];
    // Loop through any extracted urls and try to detect the content type and add to the appropriate array
    if(urls){
        urls.forEach(function(str){
            var [url, qs] = String(str).split('?'),
                url   = url.replace('"',''),
                arr   = url.split('.'),
                ext   = arr[arr.length-1].toLowerCase(),
                found = false;
            // Extract images
            if(images.indexOf(ext)!=-1 && json.images){
                json.images.forEach(function(item){
                    if(item.data==url)
                        found = true;
                });
                if(!found){
                    var type = (/hires/.test(url)!=-1) ? 'hires' : 'standard';
                    json.images.push({ type: type, data: url });
                }
            }
            // Extract video
            if(videos.indexOf(ext)!=-1 && json.videos){
                json.videos.forEach(function(item){
                    if(item.data==url)
                        found = true;
                });
                if(!found)
                    json.videos.push({ type: ext, data: url });
            }
            // Extract audio
            if(audios.indexOf(ext)!=-1 && json.audio){
                json.audio.forEach(function(item){
                    if(item.data==url)
                        found = true;
                });
                if(!found)
                    json.audio.push({ type: ext, data: url });
            }
        });
    }
    // Pass forward the HTML tag if it exists
    if(o.html)
        json.html = o.html;
    // Token descriptions are untrusted on-chain free text and must NEVER be
    // rendered as HTML. The old code did the opposite: it un-escaped the value
    // and, on a denylist hit (<script/<iframe/onload), promoted the raw markup
    // into json.html — which is injected via .html() at the token-detail body —
    // a denylist is trivially bypassed (<img onerror>, <svg onload>, …). Reduce
    // to plain text via the inert stripHtml; the render path then treats it as
    // text. (Rich/HTML descriptions, if ever wanted, need a real sanitizer.)
    if(json.description){
        json.description = stripHtml(String(json.description)).trim();
    }
    if(XC.debug){
        console.log('--- Begin JSON ---');
        console.log(JSON.stringify(json));
        console.log('--- End JSON ---');

    }
    return json;
}

// Determine if a given network is supported in this xchain-explorer instance
function isNetworkSupported(coin, callback){
    getExplorerStatusInfo(function(o){
        let supported = false;
        if(o && o.supported && o.supported[coin])
            supported = true;
        if(typeof callback === 'function')
            callback(supported);
    });
}

// Determine if a given network is available in this xchain-explorer instance
function isNetworkAvailable(coin, callback){
    getExplorerStatusInfo(function(o){
        let supported = false;
        if(o && o.available && o.available[coin])
            supported = true;
        if(typeof callback === 'function')
            callback(supported);
    });
}

// Handle wrapping search terms in a span to highlight the term
function highlightSearchTerm(term, text){
    // This result is inserted via .html() on the list pages, and `text` is
    // untrusted on-chain content (memo / message / description). Escape it
    // first so the only markup we introduce is the highlight <span>. Without
    // this, a token memo/description of "<img src=x onerror=…>" is stored XSS.
    text = escapeHtml(String(text));
    term = escapeHtml(String(term));
    if(!term) return text;
    // Escape regex metacharacters so a crafted search term can't form an invalid
    // or catastrophic-backtracking (ReDoS) pattern; match within the escaped text.
    let safe  = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let regex = new RegExp(safe, 'gi');
    return text.replace(regex, function(match){
        return '<span class="highlight-search-term">' + match + '</span>';
    });
}

// Handle update the search network on the search page
function setSearchNetwork(coin){
    $('#search-form li a').each(function(){
        var el = $(this);
        if(el.data('coin')==coin){
            let html = el.html();
            $('#search-coin').val(coin);
            $('#search-coin-dropdown').html(html);
        }
    });
    // Handle displaying `Network not available` message
    isNetworkAvailable(coin, function(supported){
        var el = $('#networkNotSupported');
        if(supported){
            el.hide();
        } else {
            el.show();
        }
    });
}

// Populate the search networks dropdown on the search page
function populateSearchNetworks(type='supported'){
    let o       = XC.status,
        data    = (type=='available') ? o.available : o.supported,
        mainnet = '',
        testnet = '',
        regtest = '';
    // Loop through networks and generate menu items
    for(let coin in data){
        let info    = String(data[coin]).replace(')','').split('(');
        let chain   = String(info[0]).trim();
        let network = String(info[1]).toLowerCase();
        let iconCls = getNetworkIcon(chain, network);
        let item    = '<li><a class="dropdown-item" data-coin="' + coin + '" title="' + chain + '" ><span class="wrapicon-25"><i class="fa ' + iconCls + '" ></i></span>' + chain + '</a></li>';
        if(network=='mainnet') mainnet += item;
        if(network=='testnet') testnet += item;
        if(network=='regtest') regtest += item;
    }
    // Create the final menu with headers and menu items
    let menu = '';
    if(!isNull(mainnet)) menu += '<li><h6 class="dropdown-header">Mainnet</h6></li>' + mainnet;
    if(!isNull(testnet)) menu += '<li><h6 class="dropdown-header">Testnet</h6></li>' + testnet;
    if(!isNull(regtest)) menu += '<li><h6 class="dropdown-header">Regtest</h6></li>' + regtest;
    // Update the search coin networks dropdown with the new menu
    $('#search-coin-dropdown-menu').html(menu);
}

// Handle updating the page info (title, description, canonical, robots)
function updatePageInfo(){
    var info = XC.pageInfo;
    // Update page title
    let title = XC.pageInfo.defaultTitle;
    if(!isNull(info.title))
        title = info.title + ' | ' + XC.pageInfo.defaultTitle;
    $('html head title').text(title);
    // Update page description
    if(!isNull(info.description))
        $('meta[name="description"]').attr('content',info.description);
    // Generate and update the Canonical URL 
    let win  = window.location,
        host = win.protocol + '//' + win.host,
        path = (!isNull(info.canonical)) ? info.canonical : win.pathname,
        url  = host + path;
    $('link[rel="canonical"]').attr('src', url);
    // Update robots tag
    if(!isNull(info.robots))
        $('meta[name="robots"]').attr('content',info.robots);
}

// Define the basic chart elements config common to all charts
XC.CHART_CONFIG = {
    chart: {
        borderColor: '#DFD7CA',
        borderWidth: 0,
    },
    exporting: {
        enabled: true,
        buttons: {
            contextButton: {
                align: 'right',
                y: -5,
                x: 2
            }                
        }
    },
    title: {
        text: ''
    },
    // Remove padding from dropdown menus
    navigation: {
        menuStyle: {
            padding: "0px 0px"
        }
    },
    plotOptions: {
        line: {
            marker: {
                enabled: false
            }
        },
        series: {
            marker: {
                enabled: false
            }
        }
    },
    xAxis: {
        events: {
            // Detect when user changes zoom level and save preference
            setExtremes: function(e){
                if(typeof(e.rangeSelectorButton)!== 'undefined'){
                    var btn = e.rangeSelectorButton,
                        idx = null,
                        c   = btn.count,
                        t   = btn.type,
                        ls  = localStorage;
                    if(t=='hour') idx = 0;
                    if(t=='day')  idx = 1;
                    if(t=='week') idx = 2;
                    if(t=='month' && c==1) idx = 3;
                    if(t=='month' && c==3) idx = 4;
                    if(t=='month' && c==6) idx = 5;
                    if(t=='year'  && c==1) idx = 6;
                    if(t=='ytd') idx = 7;
                    if(t=='all') idx = 8;
                    ls.setItem('marketChartZoom',idx);
                }
            }
        }
    },
    rangeSelector: {
        selected: 3,
        y: -5,
        // Bump 'Zoom' buttons over to alow room for buttons
        buttonPosition: {
            x: 15
        },
        inputPosition: {
            x: 13
        },
        buttons: [{
            type: 'hour',
            count: 24,
            text: '1d'
        },{
            type: 'day',
            count: 2,
            text: '2d'
        }, {
            type: 'week',
            count: 1,
            text: '1w'
        }, {
            type: 'month',
            count: 1,
            text: '1m'
        }, {
            type: 'month',
            count: 3,
            text: '3m'
        }, {
            type: 'month',
            count: 6,
            text: '6m'
        }, {
            type: 'year',
            count: 1,
            text: '1y'
        }, {
            type: 'ytd',
            text: 'YTD'
        }, {
            type: 'all',
            text: 'All'
        }]
    },
    lang: {
        noData: "No Trades Found"
    },
    noData: {
        style: {
            fontWeight: 'bold',
            fontSize: '15px',
            color: '#303030'
        }
    }
};

// Handle updating/displaying market information
function loadMarket(market){
    updateMarketBasics(market);
    updateMarketOrders(market, 1, true);
    updateMarketHistory(market, 1, true);
}

// Handle loading a market chart and uplading the title and icon
function loadMarketChart(chart){
    // Hide all tab panels and only show the active one
    $('.tab-pane').removeClass('active show');
    $('#tab-pane-charts').addClass('active show');
    let el = $('#chart-dropdown-' + chart);
    // Update datatable header to show correct icon and text for the data
    var icon = el.find('i').attr('class'),
        text = 'Charts - ' + el.text();
    $('#datatable-header-icon').removeClass().addClass(icon);
    $('#datatable-header-text').text(text);
    // Handle loading the correct chart
    $('#market-chart-container').load('/charts/' + chart + '.html');
    if(['line','candlestick'].includes(chart))
        ls.setItem('marketChart',chart);
}

// Request market data and update the header with this information
function updateMarketBasics(market){
    loadApiData(XC.coin, 'market', market, null, function(o){
        if(o){
            // Update page with token names
            $('.tick1-name').text(o.tick1);
            $('.tick2-name').text(o.tick2);
            // Update Market information header
            $('#tokenIconLink1').attr('href','/' + XC.coin + '/token/' + o.tick1);
            $('#tokenIconLink2').attr('href','/' + XC.coin + '/token/' + o.tick2);
            $('#tokenIcon1').attr('src', getTokenIcon(o.tick1));
            $('#tokenIcon2').attr('src', getTokenIcon(o.tick2));
            $('#tokenLink1').attr('href', '/' + XC.coin + '/token/' + o.tick1);
            $('#tokenLink2').attr('href', '/' + XC.coin + '/token/' + o.tick2);
            $('#market-swap-button').attr('href', '/' + XC.coin + '/market/' + o.tick2 + '/' + o.tick1);
            // Update Price information header
            $('#tick1-price').text(formatAmount(bcformat(o.tick1_price,8)));
            $('#tick1-24h-high').text(formatAmount(bcformat(o.tick1_24hr_high,8)));
            $('#tick1-24h-low').text(formatAmount(bcformat(o.tick1_24hr_low,8)));
            $('#tick1-24h-price').text(formatAmount(bcformat(o.tick1_24hr_price,8)));
            $('#tick1-24h-change').text(formatAmount(bcformat(o.tick1_24hr_change,8)));
            $('#tick1-24h-volume').text(formatAmount(bcformat(o.tick1_24hr_volume,8)));
        }
    });
}

// Request market orderbook data and populating the buy/sell order tabs
function updateMarketOrders(market, page, full, count=0 ){
    loadApiData(XC.coin, 'market', market, 'orderbook?page=' + page, function(o){
        if(o){
            // Store the orderbook data in a global variable
            XC.CHART_DATA.orderbook = o;
            var asks_total1 = 0,
                asks_total2 = 0,
                bids_total1 = 0,
                bids_total2 = 0;
            // Calculate amount and sums for asks
            $.each(o.asks, function(idx, data){
                data[2] = bcmul(data[0],data[1]);
                data[3] = bcadd(asks_total1, data[2]);
                data[4] = bcadd(asks_total2, data[1]);
                asks_total1  = data[3];
                asks_total2  = data[4];
            });
            // Calculate amount and sums for bids
            $.each(o.bids, function(idx, data){
                data[2] = bcmul(data[0],data[1]);
                data[3] = bcadd(bids_total1, data[2]);
                data[4] = bcadd(bids_total2, data[1]);
                bids_total1  = data[3];
                bids_total2  = data[4];
            });
            // Define config for orderbook datatables
            let config = {
                dom:            't',
                sortable:       false,
                searching:      false,
                ordering:       false,
                scrollCollapse: false,
                paging:         false,
                createdRow: function( row, data, idx ){
                    $('td', row).eq(0).text(formatAmount(bcformat(data[0],8)));
                    $('td', row).eq(1).text(formatAmount(bcformat(data[1],8)));
                    $('td', row).eq(2).text(formatAmount(bcformat(data[2],8)));
                    $('td', row).eq(3).text(formatAmount(bcformat(data[3],8)));
                    $('td', row).eq(4).text(formatAmount(bcformat(data[4],8)));
                }
            };
            // Initialize the sell orders table
            $('#datatable-sells').DataTable(Object.assign({}, config, {
                data: o.asks,
                language: {
                    emptyTable: "No sell orders found"
                }
            }));
            // Initialize the buy orders table
            $('#datatable-buys').DataTable(Object.assign({}, config, {
                data: o.bids,
                language: {
                    emptyTable: "No buy orders found"
                }
            }));
        }
    });
}

// Request market history data and save to XC.CHART_DATA
function updateMarketHistory(market, page=1, full=false, count=0){
    // Reset any stored chart data
    if(full && page==1)
        XC.RAW_CHART_DATA = [];
    // Load a page worth of market history data
    loadApiData(XC.coin, 'market', market, 'history?page=' + page, function(o){
        if(o.data){
            // Extract just the raw data to display in the chart
            o.data.forEach(function(data){
                XC.RAW_CHART_DATA.push([data.timestamp, data.price, data.amount]);
            });
            count = bcadd(count, o.data.length);
        }
        // If a full update was requested, keep updating
        if(full && count < o.total){
            updateMarketHistory(market, page+1, true, count);
            return;
        }
        // Break raw data up into useful arrays 
        var data    = XC.RAW_CHART_DATA,
            trades  = [], // Time / Price
            ohlc    = [], // Time / Open / High / Low / Close
            volume  = [], // Timestamp / Volume (trades)
            volume2 = [], // Timestamp / Volume (ohlc)
            tstamp  = 0,
            open    = 0,
            high    = 0,
            low     = 0,
            close   = 0,
            vol     = 0;
        // Sort the data by date oldest to newest
        data.sort(function(a,b){
            if(a[0] < b[0]) return -1;
            if(a[0] > b[0]) return 1;
            return 0;            
        });
        // Split data into price and volume arrays
        // Multiply timestamp by 1000 to convert to milliseconds
        $.each(data,function(idx, item){
            trades.push([item[0] * 1000,item[1]]);  // Time / Price
            volume.push([item[0] * 1000,item[2]]);  // Time / Volume
        });
        // Split data into ohlc and volume arrays
        $.each(data,function(idx, item){
            if(item[0]==tstamp){
                close  = item[1];
                if(item[1]>high) high = item[1];
                if(item[1]<low)  low  = item[1];
                vol = parseFloat(vol) + parseFloat(item[2]);
            } else {
                // Add data to the arrays
                if(tstamp){
                    var ms = tstamp * 1000; // Multiply timestamp by 1000 to convert to milliseconds
                    ohlc.push([ms, open, high, low, close]);
                    volume2.push([ms, vol]);
                }
                // Update stats
                tstamp = item[0];
                open   = close;
                high   = item[1];
                low    = item[1];
                close  = item[1];
                vol    = item[2];
            }
        });
        // Save the processed chart data for easy reference
        XC.CHART_DATA.trades = {
            trades: trades,
            volume: volume
        }
        XC.CHART_DATA.ohlc = {
            ohlc: ohlc,
            volume: volume2
        };
        // If we have an updateChart() function defined, run it to update the chart with the new data
        if(typeof updateChart === 'function')
            updateChart();
    });
}

// Handle showing the various XChain parameters
function showXChainParams(){
    console.log('XC.chain=',XC.chain);
    console.log('XC.name=',XC.name);
    console.log('XC.network=',XC.network);
    console.log('XC.type=',XC.type);
    console.log('XC.query=',XC.query);
    console.log('XC.coin_price', XC.coin_price);
}

$(document).ready(function(){

    // Handle initializing the page 
    initPage();

    // Display debug information
    if(XC.debug)
        showXChainParams();

});