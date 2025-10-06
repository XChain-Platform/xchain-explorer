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

    // List of supported coins
    coins: { 
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

    // Placeholder for current coin, network, query, and query type
    coin:    null,
    name:    null,
    network: null,
    query:   null,
    type:    null,

    // Default coin price to 0.00 (USD)
    coin_price: 0.00,
    
    // Placeholer object to track datatables info
    datatables: {},

    // Placeholder for a list of data panels 
    panels: []

}

// Function to handle initializing page 
function initPage(){
    // Initialize the XChain request params
    setXChainParams();

    // Get basic information on the COIN network
    getCoinNetworkInfo();

    // Initialize the main menu
    initMainMenu();

    // Handle restoring the preferred viewing mode
    var mode = ls.getItem('view-theme') || 'light';
    updateTheme(mode);

    // Handle theme switching
    $('#btn-dark-mode').click(function(){   updateTheme('dark');    });
    $('#btn-light-mode').click(function(){  updateTheme('light');   });

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
        let icon = 'fa-xchain-' + XC.name + '-' + XC.network;
        $('#network-icon').removeClass('fa-database').addClass(icon.toLowerCase());

        // Update header logo to link to main network landing page
        $('#header-logo').attr('href','/' + XC.coin);

        // Show the 'Data' and 'API' dropdowns
        $('#data-menu').removeClass('d-none');
        $('#api-menu').removeClass('d-none');

        // Update search form to include COIN
        $("#form-search [name='coin']").val(XC.coin);
    }  
}

// Function to handle setting current COIN and QUERY values
function setXChainParams(){
    let path = String(window.location.pathname).split('/');
    // Loop through possible coins and networks and set valid coin and network values
    for(let coin in XC.coins){
        if(XC.coin==null){
            for(let network in XC.networks){
                let name = String(XC.networks[network] + coin).toUpperCase();;
                if(String(path[1]).toUpperCase()==name){
                    XC.coin = name;
                    XC.name = XC.coins[coin];
                    XC.network = network;
                    break;
                }
            }
        }
    }
    // Default to BTC Mainnet
    if(isNull(XC.coin)){
        XC.default = true;
        XC.coin    = 'BTC';
        XC.name    = XC.coins[XC.coin];
        XC.network = 'mainnet';
    }
    // Set query and query type to a valid value
    let type  = String(path[2]).toLowerCase();
    let query = path[path.length-1];
    if(['block','address','token','action'].includes(type)){
        let valid = false;
        if((['block','action'].includes(type)  && isNumeric(query)) ||
           (type=='address' && isCryptoAddress(query)) ||
           (type=='token'   && typeof(query)=='string')){
            XC.type  = type;
            XC.query = query;
        }

    }
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
    if(lock[5]==1) html += '<i class="fa fa-bomb pe-1"         title="Rug"></i>';
    if(lock[6]==1) html += '<i class="fa fa-snooze pe-1"       title="Sleep"></i>';
    if(lock[7]==1) html += '<i class="fa fa-recycle pe-1"      title="Callback"></i>';
    return html;
}

// Return nice display string for links
function formatLink(url=null, text=null, icon=false, btn=false){
    // console.log('text=',text);
    var html = '',
        cls  = (btn) ? 'badge bg-success float-end text-decoration-none' : '';
        html += '<a href="' + url + '" class="' + cls + '">';
    if(icon)
        html += '<img src="/images/icons/default.png" class="icon-20 ms-1 me-1">';
        // html += '<img src="/images/icons/' + icon + '" class="icon-20 float-start me-1">';
    if(text)
        html += text;
    html += '</a>'
    return html;
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
    html += '<a href="/' + XC.coin + '/tx/'                              + tx + '" target="_blank" title="XChain"       ><i class="ms-1 fa fa-lg icon-20 fa-xchain"></i></a>';
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
        html += '<a href="https://litecoinspace.org/testnet/tx/'        + tx + '" target="_blank" title="LitecoinSpace"><i class="ms-1 fa fa-lg fa-litecoinspace"></i></a>';
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

// Handle setting up listeners on action dropdowns to load content when clicked 
function setupActionListeners(){
    for(let action of XC.panels){
        $('#tab-dropdown-' + action).click(function(){
            // Hide all tab panels and only show the active one
            $('.tab-pane').removeClass('active show');
            $('#tab-pane-' + action).addClass('active show');
            // Update datatable header to show correct icon and text for the data
            var icon = $(this).find('i').attr('class'),
                text = $(this).text();
            $('#datatable-header-icon').removeClass().addClass(icon);
            $('#datatable-header-text').text(text);
            let load = true;
            // Skip loading data in certain cases (like actions where all data already exists in the API call)
            if(XC.type=='action')
                load = false;
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
    let d = (!sNull(decimals)) ? parseInt(decimals) : 0;
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
    // Set the explorer API endpoint name based on the action
    let endpoint = null;
    if(action=='history'){
        endpoint = action;
    } else if(['address','batch'].includes(action)){
        endpoint = action + 'es';
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
            // Add 'Page X of Y' in between previous/next buttons
            // $('.paginate_button.previous').after('&nbsp;&nbsp;Page ' + numeral(page).format('0,0') + ' of ' + numeral(pages).format('0,0') + '&nbsp;&nbsp;');
            // $('#' + tableId + "-paginate-info").text('Page ' + numeral(page).format('0,0') + ' of ' + numeral(pages).format('0,0'));
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
                        if(type=='address' && ['balance','token'].includes(table))
                            hide = false;
                        if(type=='token' && ['holder'].includes(table))
                            hide = false;
                        if(table=='history')
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
            if(!['balance','credit','debit','token','block','fee','holder'].includes(action)){
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
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Balance
            if(action=='balance'){
                token   = data[1];
                amount  = data[2];
                percent = data[3];
                value   = data[4];
                $('td', row).eq(1).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
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
                        if(name=='dispenses')     icon='fa-btc';  
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
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
                $('td', row).eq(5).html(formatLink('/' + coin + '/token/' + token2, token2, token2 + '.png'));
                $('td', row).eq(6).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Credit
            if(action=='credit'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Debit
            if(action=='debit'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(7).html(action_link);
            }
            // Destroy  
            if(action=='destroy'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(action_link);
            }
            // Dispenser
            if(action=='dispenser'){
                // TODO
            }
            // Dispense
            if(action=='dispense'){
                // TODO
            } 
            // Dividend
            if(action=='dividend'){
                token  = data[4];
                token2 = data[5];
                amount = data[6];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
                $('td', row).eq(5).html(formatLink('/' + coin + '/token/' + token2, token2, token2 + '.png'));
                $('td', row).eq(6).html(formatAmount(data[6]));
                $('td', row).eq(7).html(action_link);
            }
            // Escrow
            if(action=='escrow'){
                token  = data[4];
                amount = data[5];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
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
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
                $('td', row).eq(5).html(numeral(amount).format(fmtCoin));
                $('td', row).eq(6).text(txt);
                $('td', row).eq(8).html(action_link);
            }
            // File
            if(action=='file'){
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
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(action_link);
            }
            // Order
            if(action=='order'){
                token   = data[4];
                amount  = data[5];
                token2  = data[6];
                amount2 = data[7];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(formatLink('/' + coin + '/token/' + token2, token2, token2 + '.png'));
                $('td', row).eq(7).html(formatAmount(amount2));
                $('td', row).eq(8).html(action_link);
            }
            // Send
            if(action=='send'){
                token       = data[4];
                amount      = data[5];
                destination = data[6];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
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
                    $('td', row).eq(5).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
                $('td', row).eq(6).html(formatLink('/' + coin + '/block/' + block_index2, numeral(block_index2).format(fmtInteger)));
                $('td', row).eq(7).html(action_link);
            }
            // Swap
            if(action=='swap'){
                token   = data[4];
                amount  = data[5];
                token2  = data[6];
                amount2 = data[7];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(formatLink('/' + coin + '/token/' + token2, token2, token2 + '.png'));
                $('td', row).eq(7).html(formatAmount(amount2));
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
                $('td', row).eq(7).html(action_link);
            }
            // Tokens
            if(action=='token'){
                token   = data[3];
                amount  = data[4];
                amount2 = data[5];
                amount3 = data[6];
                locks   = data[7];
                $('td', row).eq(3).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
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
                let html = '';
                if(action2=='ADDRESS'){
                    let pref = (info.fee_preference==1) ? 'Destroy' : 'Donate';
                    let memo = (info.require_memo==1) ? 'True' : 'False';
                    html += 'Fee Preference: ' + pref + '; Require Memo: ' + memo ;
                }
                if(action2=='AIRDROP'){
                    html += info.amount + formatLink('/' + coin + '/token/' + info.tick, info.tick, info.tick + '.png') + ' to ';
                    html += 'List ' + formatLink('/' + coin + '/token/' + info.list_action_index, info.list_action_index);
                }
                if(action2=='BROADCAST')
                    html = info.message;
                if(action2=='CALLBACK'){
                    html += formatLink('/' + coin + '/token/' + info.tick, info.tick, info.tick + '.png') + ' for ' ;
                    html += info.callback_amount  + formatLink('/' + coin + '/token/' + info.callback_tick, info.callback_tick, info.callback_tick + '.png');
                }
                if(action2=='FILE')
                    html = info.type + ' - ' + info.name + ' - ' + info.title;
                if(action2=='ISSUE')
                    html = formatLink('/' + coin + '/token/' + info.tick, info.tick, info.tick + '.png');
                if(action2=='LINK'){
                    html += coin + ' action ' + formatLink('/' + coin + '/token/' + info.link_action_index, info.link_action_index) + ' to ';
                    html += info.coin + ' action ' + formatLink('/' + info.coin + '/token/' + info.coin_action_index, info.coin_action_index);
                }
                if(action2=='LIST'){
                    let action3 = (info.edit) ? (info.edit==1) ? 'Add to' : 'Remove from' : 'Create'; 
                    let type2   = (info.type==2) ? 'Token' : 'Address';
                    html = action3 + ' ' + type2 + ' List';
                }
                if(action2=='MESSAGE'){
                    if([1,2].includes(info.encryption_method)){
                        html = 'Encryption key exchange with ' + formatLink('/' + coin + '/address/' + info.destination, info.destination);
                    } else if(info.plaintext_message){
                        html = info.plaintext_message;
                    } else {
                        html = 'Encrypted message to ' + formatLink('/' + coin + '/address/' + info.destination, info.destination);
                    }
                }
                if(action2=='MINT')
                    html = info.amount + formatLink('/' + coin + '/token/' + info.tick, info.tick, info.tick + '.png');
                if(['ORDER','SWAP'].includes(action2)){
                    html += info.give_amount + formatLink('/' + coin + '/token/' + info.give_tick, info.give_tick, info.give_tick + '.png') + ' for ' ;
                    html += info.get_amount  + formatLink('/' + coin + '/token/' + info.get_tick, info.get_tick, info.get_tick + '.png');
                }
                if(action2=='SWAP_CANCEL')
                    html += 'Cancel swap ' + formatLink('/' + coin + '/address/' + info.swap_action_index, formatAmount(info.swap_action_index));
                if(action2=='SWAP_EDIT')
                    html += 'Edit swap ' + formatLink('/' + coin + '/address/' + info.swap_action_index, formatAmount(info.swap_action_index));
                if(action2=='SEND'){
                    html += info.amount + formatLink('/' + coin + '/token/' + info.tick, info.tick, info.tick + '.png') + ' to ';
                    html +=formatLink('/' + coin + '/address/' + info.destination, info.destination);
                }
                if(action2=='SLEEP'){
                    if(info.type==1)
                        html = 'Address';
                    if(info.type==2)
                        html = formatLink('/' + coin + '/token/' + info.tick, info.tick, info.tick + '.png');
                    html += ' until block ' + formatAmount(info.resume_block);
                }
                $('td', row).eq(4).html(html);
                $('td', row).eq(5).html(action_link);
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
 *   loadDatatablesData('BTC', 'address', '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev', 'address');
 * 
 * - Load `address` actions for a given block
 *   loadDatatablesData('BTC', 'address', '862623', 'block');
 *********************************************************************/
function loadApiData(coin, action, query, type, callback){
    // Set the API endpoint name based on the action
    let endpoint = null;
    if(['history','block','network','token','action'].includes(action) || (action=='address' && type==null)){
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

$(document).ready(function(){

    // Handle initializing the page 
    initPage();

    // Display debug information
    if(XC.debug){
        console.log('XC.coin=',XC.coin);
        console.log('XC.name=',XC.name);
        console.log('XC.network=',XC.network);
        console.log('XC.type=',XC.type);
        console.log('XC.query=',XC.query);
        console.log('XC.coin_price', XC.coin_price);
    }

});