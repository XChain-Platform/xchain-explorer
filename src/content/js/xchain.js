/*
 * xchain.js
 *
 * Custom javascript for xchain explorer
 */

// Define XC Namespace object to track various properties
XC = {

    // Placeholder for COIN 
    coin: null,

    // Placeholer objet to track datatables info
    datatables: {},

    // Define list of XChain actions
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
    ]

}

// Function to handle displaying an address (including multi-sig addresses)
function getDisplayAddress(address, full){
    var html = '',
        full = (full) ? true : false,
        arr  = address.split('_');
    if(arr.length>1){
        html = '<a href="/address/' + address + '">Multisig Address</a> (' + arr[0] + '-of-' + arr[arr.length-1] + ')';
        // Handle displaying full address info
        if(full){
            arr.forEach(function(addr, idx){
                if(idx>0 && idx<(arr.length-1)){
                    html += '<br/><a href="/address/' + addr + '">' + addr +'</a>';
                }
            });
        }
    } else {
        html += '<a href="/address/' + address + '">' + address +'</a>';
    }
    return html;
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

// General function to setup collapsible tabs
function setupAutoCollapseTabs(){
    // Automatically collapse any tabs to only display what we can fit on screen nicely
    autoCollapseTabs();
    // // Make sure only one tab is active at a time (fixes issue where multiple items in the 'More' menu can appear as active)
    // $('#data-tabs').on('click', '.dropdown-menu', $.debounce(100,function(e){ 
    //     var tab = $(e.target).closest('li').attr('data-toggle');
    //     if(tab)
    //         $('#tab-' + tab).click();
    // }));
    // Define placeholders
    var lastWidth  = 0,
        lastHeight = 0;
    // Unbind the event to prevent duplicate listeners
    $(window).unbind('resize');
    // Detect any window resizes and resize datatables to fit 
    $(window).resize($.debounce(10,function(e){
        var win    = $(window),
            height = win.height(),
            width  = win.width();
        // Fit max amount of tabs on screen (horizontally)
        if(width!=lastWidth)
            autoCollapseTabs();
        lastWidth  = width;
        lastHeight = height;
    }));
}

// Handle automatically collapsing/expanding tabs to the 'More' menu item
function autoCollapseTabs(rerun=false){
    var tabs  = $('#data-tabs'),
        more  = $('#data-tabs-more'),
        last  = $('#data-last-tab'),
        max   = tabs.width(),
        width = last.width(),
        ready = (document.readyState=='complete') ? true : false,
        space = (ready) ? 0 : 20, // Calculate extra space for icons if document is not ready yet
        menu  = [];
    // Loop through menu items, show what we can, put rest in menu array
    tabs.find('li.nav-item').each(function(idx, item){
        var tab = $(item),
            w   = tab.width() + space;
        width += w;
        if(width <= max){
            tab.show();
        } else if(item.id!='data-last-tab'){
            tab.hide();
            menu.push(String(tab.children()[0].id).replace('tab-',''));
        }
    });
    // Populate the 'More' dropdown menu items from the tabs list
    if(more.children().length==0){
        var html = '';
        tabs.find('li.nav-item').each(function(idx, item){
            if(item.id!='data-last-tab'){
                var el   = $(item),
                    arr  = el.find('i.fa').attr("class").split(/\s+/),
                    icon = arr[arr.length-1],
                    text = String(item.innerText).trim(),
                    name = String(el.children()[0].id).replace('tab-','');
                html += '<li id="tab-more-' + name + '" data-toggle="' + name + '"><a class="dropdown-item" href="#"><span class="wrapicon-25"><i class="fa fa-lg ' + icon + '"></i></span>' + text + '</a></li>';
            }
        });
        more.html(html);
    }
    // Update dropdown list to hide/display correct items
    more.children().each(function(idx,item){
        var el   = $(item);
            name = item.id.replace('tab-more-',''),
            show = (menu.indexOf(name)!=-1) ? true : false;
        if(show)
            el.show();
        else
            el.hide();
    });
    // Handle hiding/showing the 'More' menu
    if(menu.length==0)
        last.hide();
    else
        last.show();
    // If the document is not fully ready, re-run the collapse tabs code after a brief delay
    if(!ready)
        setTimeout(function(){ autoCollapseTabs() }, 500);
    // If the tab bar is taller than 50 pixels, we are too tall, re-run the logic
    // if(tabs.height()>50 && !rerun)
    //     autoCollapseTabs(true);
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
    var testnet = (location.hostname.indexOf('testnet')!=-1) ? true : false,
        html    = tx;
    if(testnet){
        html += '<a href="https://testnet.xchain.io/tx/'                + tx + '" target="_blank" title="XChain"       ><i class="ms-1 fa fa-lg fa-xchain"></i></a>';
        html += '<a href="https://blockstream.info/testnet/tx/'         + tx + '" target="_blank" title="Blockstream"  ><i class="ms-1 fa fa-lg fa-blockstream"></i></a>';
    } else {
        html += '<a href="https://xchain.io/tx/'                        + tx + '" target="_blank" title="XChain"       ><i class="ms-1 fa fa-lg fa-xchain"></i></a>';
        html += '<a href="https://mempool.space/tx/'                    + tx + '" target="_blank" title="Mempool.space"><i class="ms-1 fa fa-lg fa-mempool"></i></a>';
        html += '<a href="https://blockstream.info/tx/'                 + tx + '" target="_blank" title="Blockstream"  ><i class="ms-1 fa fa-lg fa-blockstream"></i></a>';
        html += '<a href="https://live.blockcypher.com/btc/tx/'         + tx + '" target="_blank" title="BlockCypher"  ><i class="ms-1 fa fa-lg fa-blockcypher"></i></a>';
        html += '<a href="https://blockchair.com/bitcoin/transaction/'  + tx + '" target="_blank" title="BlockChair"   ><i class="ms-1 fa fa-lg fa-blockchair"></i></a>';
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

/**********************************************************************
 * Handle loading data into a datatables table from the explorer API endpoints
 * 
 * Params :
 * - coin   - COIN name (BTC, LTC, DOGE, etc)
 * - action - Action name (address, credit, debit)
 * - query  - Query info (can be null in most cases)
 * - type   - Query type (address, block, token)
 * - track  - Tracking info (offset, direction, etc)
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
    if(!XC.datatables[action]){
        XC.datatables[action] = {
            last_start: 0
        }
    }

    // Setup short alias for tracking action specific datatable info
    let track = XC.datatables[action];

    // Set the name of the datatable to load data into
    let tableId = 'datatable-' + action;

    // Set the explorer API endpoint name based on the action
    let endpoint = action + 's';
    if(['address','batch'].includes(action)){
        endpoint = action + 'es';
    } else if (action=='history'){
        endpoint = action;
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
        pageLength: page,
        dom: '<"search-options text-center border-bottom p-1"<"float-start d-none d-md-inline"l>p<"float-end d-none d-md-inline"i>><"search-results"t>',
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
            let txt          = false;
            let edit         = false;

            // Define the link to the action_index
            let action_link  = formatLink('/' + coin + '/action/' + action_index, 'view', null, true);
            let block_link   = formatLink('/' + coin + '/block/' + block_index, numeral(block_index).format('0,0'));
            let source_link  = formatLink('/' + coin + '/address/' + source, source);

            // Set row to display to red or green based on status
            if(!['balance','token','block'].includes(action)){
                var cls = (status==1) ? 'bg-green' : 'bg-red';
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
            // Batch
            if(action=='batch'){
                $('td', row).eq(4).html(action_link);
            }
            // Blocks
            if(action=='block'){
                block_index = data[0];
                timestamp   = data[1];
                let actions = String(data[2]).split('|');
                var html    = '';
                $('td', row).eq(0).html(formatLink('/' + coin + '/block/' + block_index, numeral(block_index).format('0,0')));
                $('td', row).eq(1).html(formatLivestamp(timestamp));
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
                var fmt = (String(value).indexOf('.')==-1) ? '0,0' : '0,0.00000000';
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
                // TODO
            }
            // Debit
            if(action=='debit'){
                // TODO
            }
            // Destroy  
            if(action=='destroy'){
                token  = data[4];
                amount = data[5];
                if(type=='token'){
                    $('td', row).eq(4).html(formatAmount(amount));
                    $('td', row).eq(5).html(action_link);
                } else {
                    $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
                    $('td', row).eq(5).html(formatAmount(amount));
                    $('td', row).eq(6).html(action_link);
                }
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
                // TODO
            }
            // File
            if(action=='file'){
                $('td', row).eq(7).html(action_link);
            }
            // Holder
            if(action=='holder'){
                // TODO
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
                coin_index  = data[4];
                coin2       = data[5];
                coin2_index = data[6];
                memo        = data[7];
                $('td', row).eq(4).html(formatLink('/' + coin + '/action/' + coin_index, coin_index));
                $('td', row).eq(5).html(formatLink('/' + coin2 + '/action/' + coin2_index, coin2_index));
                $('td', row).eq(6).text(memo);
                $('td', row).eq(7).html(action_link);
            }
            // List
            if(action=='list'){
                type = data[4];
                edit = data[5];
                // List Type
                txt  = '';
                if(type==1) txt='Token';
                if(type==2) txt='Address';
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
                type         = data[4];
                token        = data[5];
                block_index2 = data[6];
                // Sleep Type
                txt  = '';
                if(type==1) txt='Address';
                if(type==2) txt='Token';
                $('td', row).eq(4).text(txt);
                if(token!='')
                    $('td', row).eq(5).html(formatLink('/' + coin + '/token/' + token, token, token + '.png'));
                $('td', row).eq(6).html(formatLink('/' + coin + '/block/' + block_index2, numeral(block_index2).format('0,0')));
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

$(document).ready(function(){

    XC.coin = 'BTC';

    // Handle restoring the preferred viewing mode
    var ls   = localStorage,
        mode = ls.getItem('view-theme') || 'light';
    updateTheme(mode);

    // Handle theme switching
    $('#btn-dark-mode').click(function(){   updateTheme('dark');    });
    $('#btn-light-mode').click(function(){  updateTheme('light');   });

    // Handle doing search when user clicks search button
    $('#button-search').click(function(){ 
        console.log('test');
        $('#form-search').submit();
    });

    // Set the copyright as the current year
    $('#copyright-year').text(new Date().getFullYear())

});