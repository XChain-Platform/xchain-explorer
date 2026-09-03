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
    // A detail page whose type is absent here gets XC.query = null and then requests
    // its own API route with a literal 'null' segment, rendering as "not found" rather
    // than failing visibly, so every new detail route has to be added in BOTH lists.
    if(['block','address','token','action','transaction','contract','execution','checkpoint','validator','xcall','attestation','poll','anchor','bet_feed','oracle','dispenser'].includes(type)){
        // bet_feed is keyed by the creating action_index (db.getBetFeedInfo binds it to
        // m.action_index), so it belongs in the numeric branch; oracle is keyed by the
        // operator ADDRESS (db.getOracleStats binds it to a2.address, and db's id lookup
        // resolves type 'oracle' through index_addresses exactly like 'address').
        if((['block','action','contract','execution','checkpoint','poll','anchor','attestation','bet_feed'].includes(type) && isNumeric(query)) ||
           // dispenser joins these two rather than the numeric branch: a dispenser
           // page is keyed by the dispenser's operating GET_ADDRESS (the address
           // buyers pay), which is how both the dispensers and dispenses feeds
           // scope themselves with type 'address'.
           (['address','oracle','dispenser'].includes(type) && isCryptoAddress(query)) ||
           // A validator resolves by signing pubkey OR by staking address, and an xcall by
           // its 64-hex call_id, so neither can use the numeric check above.
           (['validator','xcall'].includes(type) && typeof(query)=='string' && query.length) ||
           (type=='token'   && typeof(query)=='string')){
            XC.type  = type;
            XC.query = query;
        }
        // Set type to either tx_index or tx_hash for transactions
        if(type=='transaction'){
            XC.query = query;
            // Disambiguate on SHAPE, not on numeric-ness. isNumeric() is true for any
            // run of decimal digits and never checks length, so a 64-hex hash whose
            // characters all happen to be 0-9 was read as a transaction INDEX: the page
            // then rendered a real, unrelated transaction under the URL of a hash that
            // does not exist, silently attributing one transaction's data to another
            // identifier. A 64-hex string is a hash unconditionally; only shorter
            // numeric input can be an index.
            XC.type  = (/^[0-9a-f]{64}$/i.test(String(query))) ? 'tx_hash'
                     : (isNumeric(query))                      ? 'tx_index'
                     :                                           'tx_hash';
        }
    } else if(type=='market'){
        XC.type  = type;
        // A market URL may omit its counter-tick (/{COIN}/market/{TICK}). Blind
        // concatenation stringified the missing segment as the literal
        // "undefined", which then flowed into the page title and an API request
        // for a nonexistent 'undefined' ticker. Keep the single tick here; the
        // market page resolves the counter via resolveMarketPair before use.
        XC.query = isNull(path[4]) ? path[3] : path[3] + '/' + path[4];
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
        re2 = /^https:\/\//,
        // Same-origin absolute path (e.g. a resolved TIS data_ref raw-FILE URL).
        // The second char must not be / or \ so protocol-relative //host URLs
        // can't slip through as "relative".
        rel = /^\/[^\/\\]/;
    if(rel.test(url))
        return url;
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
    // An absent amount is not a number to format, it is nothing to show. Without
    // this, String(null) is "null", whose length clears the >=4 test, the digit
    // regex matches nothing, and the literal word "null" is returned and rendered
    // into the cell (measured on /RDOGE/issues: Max Supply and Max Mint, both
    // nullable columns, showed "null" on 8 rows each). Guarded on isNull, so 0 is
    // untouched (isNull(0) is false) and '' already returned '' by the old path.
    if(isNull(amount))
        return '';
    var str = String(amount).split('.');
    if(str[0].length>=4)
        str[0] = str[0].replace(/(\d)(?=(\d{3})+$)/g, '$1,');
    return str.join('.');
}

// Return nice display string for token locks. Field order MUST match the
// 7-element pipe-string XChainExplorer.js builds for getIssues/getTokens/
// getProjectTokens rows: max_supply|mint|mint_supply|max_mint|description|
// sleep|callback.
function formatLocks(locks=null){
    var lock = String(locks).split('|'),
        html = '';
    if(lock[0]==1) html += '<i class="fa fa-coins pe-1"         title="Max Supply"></i>';
    if(lock[1]==1) html += '<i class="fa fa-print pe-1"        title="Mint"></i>';
    if(lock[2]==1) html += '<i class="fa fa-bank pe-1"         title="Mint Supply"></i>';
    if(lock[3]==1) html += '<i class="fa fa-coins pe-1"        title="Max Mint"></i>';
    if(lock[4]==1) html += '<i class="fa fa-circle-info pe-1"  title="Description"></i>';
    if(lock[5]==1) html += '<i class="fa fa-bed pe-1"       title="Sleep"></i>';
    if(lock[6]==1) html += '<i class="fa fa-recycle pe-1"      title="Callback"></i>';
    return html;
}

// Canonical NFT-pattern classification (NFT_Standard.md#classification-rule-for-clients):
// a token follows the NFT pattern when DECIMALS=0 AND LOCK_MAX_SUPPLY=1.
// Mirrors sdk.nft.isNft; keep the two in sync.
function isNftToken(decimals, lockMaxSupply){
    return Number(decimals)===0 && Number(lockMaxSupply)===1;
}

// Return path to the token icon
function getTokenIcon(token){
    let icon = '/icon/' + XC.coin + '/' + XC.network + '/' + token + '.png';
    return icon
}


// Return nice display string for links
function formatLink(url=null, text=null, icon=false, btn=false){
    var html = '',
        cls  = (btn) ? 'badge bg-success float-end text-decoration-none' : '';
    // A url whose last segment stringified a missing value is not a destination:
    // render the label alone rather than a dead link. ORDER/SWAP/DISPENSER use an
    // empty tick to mean the native coin, which built hrefs ending in /token/null.
    if(/\/(null|undefined)$/.test(String(url)))
        return (text) ? String(text) : '';
        html += '<a href="' + url + '" class="' + cls + '">';
    if(icon && !isNull(icon))
        html += '<img src="' + getTokenIcon(icon) + '" class="icon-20 ms-1 me-1">';
    if(text)
        html += text;
    html += '</a>'
    return html;
}

// Return a truncated hex string (hash / pubkey / request_id) with the full value as
// a hover title, keeping long 64/128-hex identifiers readable in tables.

// Hash-shaped fields are only hex on VALID rows: an INVALID-status ANCHOR persists
// its raw BLOCK_HASH verbatim, and this string reaches jQuery .html(). Escape both
// the truncated body and the title attribute (a no-op on real hex) so a poisoned
// field can never break out of the attribute or inject an element.
function formatHash(hash, len=16){
    if(isNull(hash)) return '';
    let str = String(hash);
    if(str.length <= len) return escapeHtml(str);
    return '<span title="' + escapeHtml(str) + '">' + escapeHtml(str.substring(0, len)) + '…</span>';
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

// Render one leg of a dispenser/order trade: an amount plus whatever it is
// denominated in. A NATIVE-coin leg carries no tick at all (the tick column is
// null), and handing that to formatLinkAmount builds a '/token/null' href -
// formatLink strips such a link now, but the cell would still be labelled with a
// token that does not exist. So an absent tick renders the coin name plainly, and
// a leg carrying neither renders a dash rather than an empty cell.
function formatCoinLegAmount(pageCoin, legCoin, legTick, amount){
    if(isNull(legTick)){
        let txt = isNull(amount) ? '' : formatAmount(amount);
        if(!isNull(legCoin))
            txt += (txt ? ' ' : '') + escapeHtml(String(legCoin));
        return (txt==='') ? '-' : txt;
    }
    let linkCoin = isNull(legCoin) ? pageCoin : legCoin;
    return formatLinkAmount('/' + linkCoin + '/token/' + legTick, legTick, legTick, amount);
}

// Render a DISPENSER / DISPENSE native-coin leg: network icon, amount, coin name.
// Escaped here, not per call site: both are on-chain fields bound for a .html() sink.
// NOT formatCoinLegAmount - that omits the icon and adds thousands separators.
function formatNativeCoinLeg(amount, coin){
    return ' <i class="fa ' + getNetworkIcon() + '"></i> ' + escapeHtml(amount) + ' ' + escapeHtml(coin);
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

// Build out nice links to view transactions in other explorers.
// SoChain (chain.so) was dropped from every network on 2026-08-29: it no longer
// serves transaction pages (bot challenge, then an application error), and on
// TDOGE it was the ONLY outbound link, so the row was guaranteed to be broken.
// TDOGE now carries no third-party link because no maintained Dogecoin-testnet
// explorer exists; the XChain link above still applies to every network.
function formatTransactionLink(tx){
    let html = tx;
    let coin = XC.coin;
    html += '<a href="/' + XC.coin + '/transaction/'                     + tx + '" target="_blank" title="XChain"       ><i class="ms-1 fa fa-lg icon-20 fa-xchain"></i></a>';
    if(coin=='BTC'){
        html += '<a href="https://mempool.space/tx/'                    + tx + '" target="_blank" title="Mempool.space"><i class="ms-1 fa fa-lg fa-mempool"></i></a>';
        html += '<a href="https://blockstream.info/tx/'                 + tx + '" target="_blank" title="Blockstream"  ><i class="ms-1 fa fa-lg fa-blockstream"></i></a>';
        html += '<a href="https://live.blockcypher.com/btc/tx/'         + tx + '" target="_blank" title="BlockCypher"  ><i class="ms-1 fa fa-lg fa-blockcypher"></i></a>';
        html += '<a href="https://blockchair.com/bitcoin/transaction/'  + tx + '" target="_blank" title="BlockChair"   ><i class="ms-1 fa fa-lg fa-blockchair"></i></a>';
    } else if(coin=='TBTC'){
        // Testnet 4 (BTC testnet3 has been retired)
        html += '<a href="https://mempool.space/testnet4/tx/'           + tx + '" target="_blank" title="Mempool.space"><i class="ms-1 fa fa-lg fa-mempool"></i></a>';
        html += '<a href="https://blockstream.info/testnet/tx/'         + tx + '" target="_blank" title="Blockstream"  ><i class="ms-1 fa fa-lg fa-blockstream"></i></a>';
    } else if(coin=='LTC'){
        html += '<a href="https://live.blockcypher.com/ltc/tx/'         + tx + '" target="_blank" title="BlockCypher"  ><i class="ms-1 fa fa-lg fa-blockcypher"></i></a>';
        html += '<a href="https://blockchair.com/litecoin/transaction/' + tx + '" target="_blank" title="BlockChair"   ><i class="ms-1 fa fa-lg fa-blockchair"></i></a>';
        html += '<a href="https://litecoinspace.org/tx/'                + tx + '" target="_blank" title="LitecoinSpace"><i class="ms-1 fa fa-lg fa-litecoinspace"></i></a>';
    } else if(coin=='TLTC'){
        html += '<a href="https://litecoinspace.org/testnet/tx/'        + tx + '" target="_blank" title="LitecoinSpace"><i class="ms-1 fa fa-lg fa-litecoinspace"></i></a>';
    } else if(coin=='DOGE'){
        html += '<a href="https://live.blockcypher.com/doge/tx/'        + tx + '" target="_blank" title="BlockCypher"  ><i class="ms-1 fa fa-lg fa-blockcypher"></i></a>';
        html += '<a href="https://blockchair.com/dogecoin/transaction/' + tx + '" target="_blank" title="BlockChair"   ><i class="ms-1 fa fa-lg fa-blockchair"></i></a>';
    }
    $('#tx-hash').html(html);
}

// DataTables' DEFAULT error mode is a native alert(), and a native alert is the
// worst possible channel for a feed failure. It blocks the render loop, it blocks
// every subsequent event on the page (so anything driving the browser goes dead
// mid-run), and once it is dismissed it leaves no record behind: the reader is
// left with a page that "just hung" and no way to learn why. That is exactly how
// a 503 on the search feed presented, and diagnosing it took a detour through
// curl because the page itself could say nothing.
//
// Route the same information somewhere it can actually be read instead: the
// console (durable, capturable, and greppable), plus a non-blocking message in
// the table's own body so a human sees that THIS table failed rather than
// wondering why it is empty. Nothing freezes and the rest of the page still
// renders, which is the behavior a partial outage should have.
if(typeof $ !== 'undefined' && $.fn && $.fn.dataTable){
    $.fn.dataTable.ext.errMode = function(settings, helpPage, message){
        var table = (settings && settings.nTable) ? settings.nTable : null;
        var id    = (table && table.id) ? table.id : 'unknown';
        // `ajax` is a string on some tables and a CONFIG OBJECT on others; printing
        // the object yields "[object Object]", which tells the reader nothing and
        // defeats the whole point of logging the source. Dig the url out either way.
        var ajax  = (settings && settings.ajax) ? settings.ajax : null;
        var url   = (settings && settings.sAjaxSource) ? settings.sAjaxSource
                  : (typeof ajax === 'string') ? ajax
                  : (ajax && typeof ajax === 'object' && ajax.url) ? ajax.url
                  : (typeof ajax === 'function') ? '(ajax is a function)'
                  : '(no ajax source)';
        // console.error, not console.log: this IS an error, and error-only console
        // filters are how these get noticed at all.
        console.error('[XChain] DataTables feed failed  table=' + id +
                      '  source=' + url + '  detail=' + message);
        if(table){
            var cols = $('thead th', table).length || 1;
            $('tbody', table).html(
                $('<tr>').append(
                    $('<td>').attr('colspan', cols)
                             .addClass('text-center text-danger')
                             // .text(), never .html(): `message` can carry server
                             // text and must never become markup.
                             .text('Could not load this data. See the browser console for details.')
                )
            );
        }
    };
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

// Make a value safe to hand to jQuery's .text(). jQuery (1.10.2, the build this
// app ships) does NOT treat an absent value as "no text": .text(null) stringifies
// it and writes the literal four characters "null" into the element, and
// .text(undefined) is read as the GETTER, so the element silently keeps whatever
// it already held. The /explorer feeds deliver real JS nulls for every column the
// indexer is allowed to leave NULL (a BROADCAST v3 carries no MESSAGE, a LINK
// carries no MEMO, and so on), so those values go through here and render as an
// empty cell, which is what "the action does not carry this field" looks like.
// Note .html() is NOT affected: jQuery empties the element for a null value.
function nullToBlank(value){
    return isNull(value) ? '' : value;
}

// Determine if a value is numeric
function isNumeric(value){
    return typeof value === 'bigint' || (!isNaN(parseFloat(value)) && isFinite(value));
}

// Per-chain base58 version bytes and bech32 HRPs (mirrors the indexer's
// validation params). DOGE has no segwit, so no HRP entries for it.
var ADDRESS_PARAMS = {
    BTC: {
        mainnet: { p2pkh: 0x00, p2sh: 0x05, hrp: 'bc'   },
        testnet: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'tb'   },
        regtest: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'bcrt' }
    },
    LTC: {
        mainnet: { p2pkh: 0x30, p2sh: 0x32, hrp: 'ltc'  },
        testnet: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'tltc' },
        regtest: { p2pkh: 0x6f, p2sh: 0xc4, hrp: 'rltc' }
    },
    DOGE: {
        mainnet: { p2pkh: 0x1e, p2sh: 0x16, hrp: null },
        testnet: { p2pkh: 0x71, p2sh: 0xc4, hrp: null },
        regtest: { p2pkh: 0x6f, p2sh: 0xc4, hrp: null }
    }
};

// Decode a base58 string to bytes, or false on a bad charset / implausible length
function base58DecodeAddress(address){
    let alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
        str      = String(address);
    if(str.length<26 || str.length>48)
        return false;
    let num = 0n;
    for(let char of str){
        let value = alphabet.indexOf(char);
        if(value==-1)
            return false;
        num = num * 58n + BigInt(value);
    }
    let hex = num.toString(16);
    if(hex.length % 2)
        hex = '0' + hex;
    let bytes = [];
    for(let i=0; i<hex.length; i+=2)
        bytes.push(parseInt(hex.substring(i,i+2),16));
    if(num==0n)
        bytes = [];
    // Restore leading zero bytes (leading '1' characters)
    let leading = 0;
    while(leading<str.length && str[leading]=='1')
        leading++;
    return new Array(leading).fill(0).concat(bytes);
}

// Decode a bech32/bech32m segwit address (BIP-173/BIP-350) and return
// { hrp, version } when the checksum and witness rules hold, or false
function bech32DecodeAddress(address){
    let charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l',
        str     = String(address);
    // Reject mixed case, then work in lowercase
    if(str!=str.toLowerCase() && str!=str.toUpperCase())
        return false;
    str = str.toLowerCase();
    if(str.length<8 || str.length>90)
        return false;
    let pos = str.lastIndexOf('1');
    if(pos<1 || pos+7>str.length)
        return false;
    let hrp  = str.substring(0,pos),
        data = [];
    for(let char of str.substring(pos+1)){
        let value = charset.indexOf(char);
        if(value==-1)
            return false;
        data.push(value);
    }
    // BIP-173 polymod checksum over expanded hrp + data
    let gen    = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3],
        chk    = 1,
        values = [];
    for(let i=0; i<hrp.length; i++)
        values.push(hrp.charCodeAt(i)>>5);
    values.push(0);
    for(let i=0; i<hrp.length; i++)
        values.push(hrp.charCodeAt(i)&31);
    values = values.concat(data);
    for(let value of values){
        let top = chk>>25;
        chk = ((chk&0x1ffffff)<<5)^value;
        for(let i=0; i<5; i++)
            if((top>>i)&1)
                chk ^= gen[i];
    }
    let version = data[0];
    if(version>16)
        return false;
    // Segwit v0 uses the bech32 constant (1), v1+ uses bech32m (BIP-350)
    if(chk!=(version==0 ? 1 : 0x2bc830a3))
        return false;
    // Witness program length rules (5-bit groups minus 6 checksum chars)
    let programBits = (data.length-7)*5,
        programLen  = Math.floor(programBits/8);
    if(programBits%8>=5)
        return false;
    if(programLen<2 || programLen>40)
        return false;
    if(version==0 && programLen!=20 && programLen!=32)
        return false;
    return { hrp: hrp, version: version };
}

// Validate an address for the current chain + network (any supported one when none
// is selected): base58 structure + version byte, and the full bech32/bech32m
// checksum. The base58check double-SHA256 is verified SERVER-side, there being no
// synchronous SHA-256 in the browser, so a typo here yields an empty lookup.
function isCryptoAddress(address, chain, network){
    if(isNull(address))
        return false;
    // Default to the chain/network currently selected in the explorer UI
    if(isNull(chain) && typeof XC!='undefined' && !isNull(XC.chain))
        chain = XC.chain;
    if(isNull(network) && typeof XC!='undefined' && !isNull(XC.network))
        network = XC.network;
    // Collect the candidate network params (all networks if none selected)
    let candidates = [];
    for(let c in ADDRESS_PARAMS){
        if(!isNull(chain) && c!=chain)
            continue;
        for(let n in ADDRESS_PARAMS[c]){
            if(!isNull(network) && n!=network)
                continue;
            candidates.push(ADDRESS_PARAMS[c][n]);
        }
    }
    let str = String(address);
    // Segwit address: full bech32/bech32m validation against a known HRP
    let decoded = bech32DecodeAddress(str);
    if(decoded){
        for(let params of candidates)
            if(params.hrp && decoded.hrp==params.hrp)
                return true;
        return false;
    }
    // Base58 address: structural validation + network version byte
    let bytes = base58DecodeAddress(str);
    if(!bytes || bytes.length!=25)
        return false;
    for(let params of candidates)
        if(bytes[0]==params.p2pkh || bytes[0]==params.p2sh)
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

// Coerce to a full-precision mathjs bignumber, NOT a JS double, matching the
// SDK/indexer canonical bcnum: neither this nor the bc* helpers below may re-funnel a
// result through parseFloat, which truncates past ~16 digits into scientific notation.
// Non-numeric, NaN and Infinity yield bignumber(0) rather than throwing.
function bcnum(num){
    let str = String(num).trim();
    if(str === 'NaN' || str === 'Infinity' || str === '-Infinity' || !isNumeric(num))
        return math.bignumber(0);
    return math.bignumber(str);
}

// Handle returning a number to a given decimal point precision
function bcformat(num, decimals){
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return math.format(bcnum(num),{notation: 'fixed', precision: d});
}

// Handle subtracting 2 big numbers (returns a fixed-notation string, full precision)
function bcsub(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return math.format(math.subtract(math.bignumber(a),math.bignumber(b)),{notation: 'fixed', precision: d});
}

// Handle adding 2 big numbers (returns a fixed-notation string, full precision)
function bcadd(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return math.format(math.add(math.bignumber(a),math.bignumber(b)),{notation: 'fixed', precision: d});
}

// Handle multiplying 2 big numbers (returns a fixed-notation string, full precision)
function bcmul(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return math.format(math.multiply(math.bignumber(a),math.bignumber(b)),{notation: 'fixed', precision: d});
}

// Handle dividing 2 big numbers (returns a fixed-notation string, full precision)
function bcdiv(numA, numB, decimals){
    let a = (!isNull(numA)) ? numA : 0;
    let b = (!isNull(numB)) ? numB : 0;
    let d = (!isNull(decimals)) ? parseInt(decimals) : 0;
    return math.format(math.divide(math.bignumber(a),math.bignumber(b)),{notation: 'fixed', precision: d});
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
        // v1 is a controller bind, not a preferences edit: summarizing one with the preference
        // defaults described an action it never took.
        if(info.action_format==1){
            let verb = (info.unbind==1) ? 'Unbind' : 'Bind';
            html += verb + ' ' + (info.action_class || '-');
            if(info.controller != null)
                html += ' ' + formatLink('/' + coin + '/action/' + info.controller, info.controller);
        } else {
            let pref = (info.fee_preference==1) ? 'Destroy' : 'Donate';
            let memo = (info.require_memo==1) ? 'True' : 'False';
            let disp = (info.dispenser_preference) ? XC.dispenser_preferences[info.dispenser_preference] : 'Not set';
            html += 'Fee Preference: ' + pref + '; Require Memo: ' + memo + '; Dispenser Preference: ' + disp;
        }
    }
    if(action=='AIRDROP'){
        html += info.amount + formatLink('/' + coin + '/token/' + info.tick, info.tick, info.tick) + ' to ';
        // Route the list reference as an ACTION, not a token: airdrops.list_action_index is the
        // index of the LIST action being paid out (indexer db.js createAirdrop), so a /token/ URL
        // searched for a token named after a number. showAirdropDetails already links
        // this same field through /action/.
        html += 'List ' + formatLink('/' + coin + '/action/' + info.list_action_index, info.list_action_index);
    }
    if(action=='BROADCAST'){
        // Read the broadcast's own fee fraction from its aliased column (broadcast_fee),
        // NOT info.fee: for a BATCH child `info` is a full getActionData result whose fee
        // slot is overwritten with the protocol-fee record, and bcmul on that object threw
        // and aborted the whole member-table render (same fix applied at the other call site).
        // FEE is an OPTIONAL wire field on BROADCAST v1/v2 (xchain-indexer broadcast.js: a
        // null FEE is not an error), so a feed broadcast without one stores NULL. Emitting
        // the label anyway printed a bare `Fee: %` with nothing in front of it. Build the
        // whole clause here so it disappears when there is no fee to state, rather than
        // guessing at 0% - a fee this action never declared.
        let percent = (isNumeric(info.broadcast_fee))
            ? ' <b>Fee:</b> ' + bcmul(info.broadcast_fee, 100, 2) + '%'
            : '';
        // info.message / info.value are BROADCAST free text (on-chain,
        // attacker-controlled) and this html is injected via .html(). Escape them.
        if(info.action_format==0){
            html += escapeHtml(info.message);
        } else if(info.action_format==1){
            html += '<b>Oracle:</b> ' + escapeHtml(info.message) + ' = ' + formatAmount(info.value) + percent;
        } else if(info.action_format==2){
            html += '<b>Feed:</b> ' + escapeHtml(info.message) + percent;
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
        // Namespace each leg by its OWN coin (give_coin/get_coin), never the broadcast
        // chain: a CROSS_CHAIN_DEX order/swap/dispenser puts give and get on different
        // networks, so the page coin would link a remote token into the wrong namespace
        // and label a remote native amount local. Fall back to it only where absent.
        let give_coin = info.give_coin || coin;
        let get_coin  = info.get_coin  || coin;
        html  = formatLinkAmount('/' + give_coin + '/token/' + info.give_tick, info.give_tick, info.give_tick, info.give_amount) + ' for ';
        if(isNull(info.get_tick)){
            let cls = getNetworkIcon();
            html += ' <i class="fa ' + cls + '"></i> ' + formatAmount(info.get_amount) + ' ' + get_coin ;
        } else {
            html  += formatLinkAmount('/' + get_coin + '/token/' + info.get_tick, info.get_tick, info.get_tick, info.get_amount);
        }
    }
    if(action=='FILE')
        html = info.type + ' - ' + info.name + ' - ' + info.title;
    if(action=='ISSUE')
        html = formatLink('/' + coin + '/token/' + info.tick, info.tick, info.tick);
    if(action=='LINK'){
        // Both link legs are ACTION indexes on their own chains (links.coin1_action_index /
        // coin2_action_index, indexer db.js createLink), not tickers, so /token/ opened a token
        // search for a number. showLinkDetails already uses /action/ for these two.
        html += info.coin1 + ' action ' + formatLink('/' + info.coin1 + '/action/' + info.coin1_action_index, info.coin1_action_index) + ' to ';
        html += info.coin2 + ' action ' + formatLink('/' + info.coin2 + '/action/' + info.coin2_action_index, info.coin2_action_index);
    }
    if(action=='LIST'){
        let action3 = (info.edit) ? (info.edit==1) ? 'Add to' : 'Remove from' : 'Create'; 
        // Read the type off the canonical XC.list_types map, never a second inline copy:
        // showListDetails consumes the map too, so this keeps one source of truth. An
        // invalid edit row can carry a null type, the parent lookup having failed while
        // the row persisted, so name that case rather than printing 'undefined'.
        let type2   = XC.list_types[info.type] || 'Unknown';
        html = action3 + ' ' + type2 + ' List';
    }
    if(action=='MESSAGE'){
        // Link the destination on ITS own chain: MESSAGE deliberately allows a destination on
        // another network (the indexer validates DESTINATION against COIN, not the broadcast
        // chain), and messages.coin is that destination network. Building the URL from the page
        // coin sent a BTC-addressed message broadcast on DOGE to /DOGE/address/...
        let dest_coin = info.coin || coin;
        // Summarize by RECORD FORMAT, not by encryption_method: formats 0 and 1 are the key
        // exchange, 2 is the encrypted message, 3 is plaintext (indexer actions/message.js
        // formats). A v2 record carries no method on the wire and the indexer stamps method 1
        // (ECIES) onto it, so keying off the method labelled every ordinary encrypted message
        // an 'Encryption key exchange'. A row missing action_format keeps the old
        // plaintext/encrypted fallback rather than defaulting into the key-exchange branch.
        if(!isNull(info.action_format) && [0,1].includes(Number(info.action_format))){
            html = 'Encryption key exchange with ' + formatLink('/' + dest_coin + '/address/' + info.destination, info.destination);
        } else if(info.plaintext_message){
            html = info.plaintext_message;
        } else {
            html = 'Encrypted message to ' + formatLink('/' + dest_coin + '/address/' + info.destination, info.destination);
        }
    }
    if(action=='MINT')
        html = formatLinkAmount('/' + coin + '/token/' + info.tick, info.tick, info.tick, info.amount);
    if(action=='SEND'){
        // A SEND detail payload keeps tick/amount/destination per destination under
        // sends[]; the summary producers flatten sends[0], but tolerate the nested
        // shape too so a raw payload never renders as ' to ' plus an empty link.
        let sends = (isNull(info.tick) && isNull(info.destination) && Array.isArray(info.sends)) ? info.sends : null;
        if(sends && sends.length > 1){
            let sameTick = sends.every((s) => s.tick == sends[0].tick);
            if(sameTick){
                let total = sends.reduce((sum, s) => bcadd(sum, s.amount), '0');
                html += formatLinkAmount('/' + coin + '/token/' + sends[0].tick, sends[0].tick, sends[0].tick, total) + ' to ';
            } else {
                html += 'Multiple tokens to ';
            }
            html += sends.length + ' recipients';
        } else {
            let send = (sends && sends.length === 1) ? sends[0] : info;
            html += formatLinkAmount('/' + coin + '/token/' + send.tick, send.tick, send.tick, send.amount) + ' to ';
            html += formatLink('/' + coin + '/address/' + send.destination, send.destination);
        }
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
    // Compact summaries for the staking / contract families. Field names
    // mirror each type's show*Details() renderer.
    if(action=='DESTROY')
        html = formatLinkAmount('/' + coin + '/token/' + info.tick, info.tick, info.tick, info.amount);
    if(action=='STAKE'){
        html = formatAmount(info.amount);
        html += isNull(info.target_contract_index)
            ? ' capability stake'
            : ' on contract ' + formatLink('/' + coin + '/contract/' + info.target_contract_index, info.target_contract_index);
    }
    if(action=='UNSTAKE'){
        html = formatAmount(info.amount);
        html += isNull(info.target_contract_index)
            ? ' capability unstake'
            : ' from contract ' + formatLink('/' + coin + '/contract/' + info.target_contract_index, info.target_contract_index);
        if(!isNull(info.cooldown_end_block))
            html += ', cooldown until block ' + formatAmount(info.cooldown_end_block);
    }
    if(action=='DELEGATE'){
        html = isNull(info.target_contract_index)
            ? 'Capability delegation'
            : 'Delegate to contract ' + formatLink('/' + coin + '/contract/' + info.target_contract_index, info.target_contract_index);
    }
    if(action=='COLLECT')
        html = 'Claim ' + formatAmount(info.amount) + ' validator reward';
    if(action=='SLASH')
        html = 'Slash ' + formatAmount(info.amount) + (isNull(info.capability) ? '' : ' (' + escapeHtml(String(info.capability)) + ')');
    if(action=='DEPLOY'){
        // DEPLOY v4 (action_format 4) is a chunk carrier, not a contract: no /contract/ link.
        if(Number(info.action_format) === 4){
            let idx = isNull(info.chunk_index) ? '?' : (Number(info.chunk_index) + 1);
            let total = isNull(info.total_chunks) ? '?' : info.total_chunks;
            html = 'Contract code chunk ' + idx + ' of ' + total;
        } else {
            html = 'Contract ' + formatLink('/' + coin + '/contract/' + info.action_index, info.action_index);
            if(!isNull(info.cooldown_blocks)) html += ' (stakeable)';
        }
    }
    if(action=='EXECUTE'){
        html = 'Call ' + escapeHtml(String(info.method_name || '')) + ' on contract ';
        html += formatLink('/' + coin + '/contract/' + info.contract_index, info.contract_index);
    }
    if(action=='DEPOSIT' || action=='WITHDRAW'){
        html = formatLinkAmount('/' + coin + '/token/' + info.tick, info.tick, info.tick, info.amount);
        html += (action=='DEPOSIT' ? ' into contract ' : ' out of contract ');
        html += formatLink('/' + coin + '/contract/' + info.contract_index, info.contract_index);
    }
    if(action=='VOTE')
        html = 'Vote' + (isNull(info.vote_kind) ? '' : ': ' + escapeHtml(String(info.vote_kind)));
    // Consensus actions. These reach the history feed on every network (and are the
    // ONLY actions on a chain that carries no user traffic yet), so the humanized
    // fallback below would leave a whole feed reading "Anchor / Anchor / Price".
    if(action=='ANCHOR'){
        // Which chain+network this checkpoint is FOR, then what it pins. chain/network
        // are indexer-written enum-ish columns; escaped because they still reach .html().
        let scope = [info.chain, info.network].filter((v) => !isNull(v)).map((v) => escapeHtml(String(v))).join(' ');
        html = (scope ? scope + ' ' : '') + 'checkpoint';
        if(!isNull(info.checkpoint_seq))
            html += ' #' + numeral(info.checkpoint_seq).format('0,0');
        // anchored_block_index is the height being checkpointed on info.chain, which is
        // NOT the page coin, so it is stated rather than linked (the /block/ route would
        // resolve it against the wrong network).
        if(!isNull(info.anchored_block_index))
            html += ' at block ' + numeral(info.anchored_block_index).format('0,0');
        // The archive-continuation variants carry no checkpoint of their own.
        if(!isNull(info.chunk_index) && !isNull(info.total_chunks))
            html += ' (chunk ' + (Number(info.chunk_index) + 1) + ' of ' + info.total_chunks + ')';
    }
    if(action=='PRICE'){
        if(!isNull(info.batch_first_round) && !isNull(info.batch_last_round)){
            // A validator batch: name the window, not a single round, and say how wide
            // each round is so the row shows the action carried real price data.
            let n = isNull(info.round_count) ? null : Number(info.round_count);
            html  = 'Rounds ' + numeral(info.batch_first_round).format('0,0') + '-' + numeral(info.batch_last_round).format('0,0');
            if(n !== null)
                html += ' (' + numeral(n).format('0,0') + ' round' + (n===1 ? '' : 's') + ')';
        } else if(!isNull(info.tick) || !isNull(info.fiat)){
            // A v1 user oracle: TOKEN/FIAT and the published value.
            html  = formatLink('/' + coin + '/token/' + info.tick, info.tick, info.tick);
            html += '/' + escapeHtml(nullToBlank(info.fiat)) + ' = ' + formatAmount(info.value);
        } else if(!isNull(info.round_number)){
            html = 'Round ' + numeral(info.round_number).format('0,0');
            if(!isNull(info.pair_count))
                html += ' (' + numeral(info.pair_count).format('0,0') + ' pairs)';
        }
    }
    // Never render a blank Details cell: any type without an explicit summary
    // above (BATCH, XCALL, XEXEC, CROSS_SETTLE, NODEPROOF, ATTEST, COINPAY,
    // ... and any FUTURE type) falls back to a humanized action name, so a new
    // action type can no longer silently summarize as empty while being fully
    // supported everywhere else.
    if(html === ''){
        let words = String(action).toLowerCase().split('_');
        html = words.map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(' ');
    }
    return html;
}

// Load an action's rows into its datatable from the explorer API; query/type
// narrow the results to one address/block/etc when given.
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
    // The Official Tokens tab loads the project's roster (Project_Registry.md)
    if(type=='token' && action=='project')
        type = 'roster';
    // Set the explorer API endpoint name based on the action
    let endpoint = null;
    if(['history','search'].includes(action)){
        endpoint = action;
    } else if(['address','batch','order_match','swap_match','cross_chain_match'].includes(action)){
        // These take '-es', not '-s'; the three *_match names would otherwise build
        // malformed endpoints ('cross_chain_matchs') whose ajax answers 404, which a
        // page renders as an empty table rather than as an error.
        endpoint = action + 'es';
    } else if(action=='market-history'){
        endpoint = 'market';
        type     = 'history';
    } else if(action=='validator_capability'){
        // action+'s' would give the malformed 'validator_capabilitys'; the hub table
        // (and its /explorer feed) is 'validator_capabilities'.
        endpoint = 'validator_capabilities';
    } else if(action=='consensus_state'){
        // consensus_state is a mass noun (no plural 's'); its /explorer feed keeps the
        // singular table name.
        endpoint = 'consensus_state';
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
                if(['subtoken','roster'].includes(type))
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
            if(!['balance','credit','debit','token','project','block','fee','holder','search','market','market-history','slash_event','capability_slash_event','oracle_price','reward','cross_chain_match','cross_chain_settlement','validator_capability','capability_snapshot','governance_proposal','governance_vote','peer','consensus_state','config','telemetry_ping','checkpoint','commitment','anchor_reward_attestation','reorg','slash_proposal','attest_validator_stat','price_snapshot','emission','coinpay_obligation','action'].includes(action)){
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
                // A null here means the action does not CARRY this field at all, not
                // that the field is set to the falsy option. An ADDRESS v1 (controller
                // bind/unbind) carries NONE of the v0 preferences, and the old
                // ternaries collapsed "absent" into "Donate"/"False", so every v1 row
                // displayed preferences it had never set. That is worse than rendering
                // nothing: it is plausible and wrong, so it cannot be spotted by eye.
                // Measured on RDOGE: actions 1157 and 1159 return fee_preference null
                // and require_memo null, and both rows read "Donate"/"False".
                $('td', row).eq(4).text(isNull(data[4]) ? '-' : ((data[4]==1) ? 'Destroy' : 'Donate'));
                $('td', row).eq(5).text(isNull(data[5]) ? '-' : ((data[5]==1) ? 'True'    : 'False'));
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
                        if(name=='sleeps')        icon='fa-bed';  
                        if(name=='swaps')         icon='fa-exchange';  
                        if(name=='swap_cancels')  icon='fa-exchange';  
                        if(name=='swap_edits')    icon='fa-exchange';  
                        if(name=='swap_matches')  icon='fa-exchange';  
                        if(name=='sweeps')        icon='fa-truck';
                        // name/num flow into an HTML attribute via .html() below; escape
                        // before it lands in markup so an attribute-breakout can't inject.
                        html += '<a title="' + escapeHtml(num) + ' ' + escapeHtml(name) + '">' + escapeHtml(num) + ' <i class="fa ' + icon + ' me-3"></i></a>';
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
                // broadcasts.message is nullable and BROADCAST v3 legitimately carries
                // no MESSAGE, so the cell must read empty rather than "null".
                $('td', row).eq(4).text(nullToBlank(message));
                var fmt = (String(value).indexOf('.')==-1) ? fmtInteger : fmtCoin;
                $('td', row).eq(5).html(numeral(value).format(fmt));
                $('td', row).eq(6).html(fee);
                $('td', row).eq(7).html(action_link);
            }
            // Price (PRICE oracle: v0 validator COIN/FIAT snapshot, v1 user TOKEN/FIAT oracle)
            if(action=='price'){
                let version = data[4];
                let pcoin   = data[5];
                token       = data[6];
                let fiat    = data[7];
                value       = data[8];
                fee         = data[9];
                $('td', row).eq(4).html(Number(version)===0 ? '<span class="badge text-bg-secondary">Validator (v0)</span>' : '<span class="badge text-bg-primary">User (v1)</span>');
                $('td', row).eq(5).text(isNull(pcoin) ? '-' : pcoin);
                $('td', row).eq(6).html(isNull(token) ? '-' : formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(7).text(isNull(fiat) ? '-' : fiat);
                $('td', row).eq(8).text(isNull(value) ? '-' : value);
                $('td', row).eq(9).text(isNull(fee) ? '-' : fee);
                $('td', row).eq(10).html(action_link);
            }
            // Controller binding (programmable-policy guard: bind/unbind event on a token or address)
            if(action=='controller'){
                let scope    = data[3];
                let subject  = data[4];
                let aclass   = data[5];
                let guard    = data[6];
                let isUnbind = data[7];
                let cdBlocks = data[8];
                let cdEnd    = data[9];
                // data[3] (scope) is not an address; override the generic source link cell
                $('td', row).eq(3).html(scope=='address'
                    ? '<span class="badge text-bg-info">Address</span>'
                    : '<span class="badge text-bg-secondary">Token</span>');
                $('td', row).eq(4).html(isNull(subject) ? '-' : (scope=='address'
                    ? formatLink('/' + coin + '/address/' + subject, subject)
                    : formatLink('/' + coin + '/token/' + subject, subject, subject)));
                $('td', row).eq(5).text(isNull(aclass) ? '-' : aclass);
                $('td', row).eq(6).html(isNull(guard) ? '-' : formatLink('/' + coin + '/contract/' + guard, guard));
                $('td', row).eq(7).html(Number(isUnbind)===1
                    ? '<span class="badge text-bg-warning">Unbind</span>'
                    : '<span class="badge text-bg-success">Bind</span>');
                $('td', row).eq(8).text(isNull(cdBlocks) ? '-' : numeral(cdBlocks).format('0,0'));
                $('td', row).eq(9).text(isNull(cdEnd) ? '-' : numeral(cdEnd).format('0,0'));
                $('td', row).eq(10).html(action_link);
            }
            // Deploy chunk (chunked DEPLOY v4 carrier: one base64 code slice of a contract source)
            if(action=='deploy_chunk'){
                let codeHash = data[4];
                let chunkIdx = data[5];
                let total    = data[6];
                $('td', row).eq(4).html(isNull(codeHash) ? '-' : '<span class="font-monospace" title="' + codeHash + '">' + String(codeHash).substring(0,16) + '…</span>');
                $('td', row).eq(5).text(isNull(chunkIdx) ? '-' : numeral(chunkIdx).format('0,0'));
                $('td', row).eq(6).text(isNull(total) ? '-' : numeral(total).format('0,0'));
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
                give_ownership = data[10];
                if(give_ownership == 1){
                    $('td', row).eq(4).html(formatLink('/' + give_coin + '/token/' + give_token, give_token, give_token) + ' ' + ownershipBadge());
                } else {
                    $('td', row).eq(4).html(formatLinkAmount('/' + give_coin + '/token/' + give_token, give_token, give_token, give_amount));
                }
                // Built as a LOCAL, never appended onto the shared `html` scratch variable:
                // see formatNativeCoinLeg for why that mattered.
                let getLeg = isNull(get_token)
                    ? formatNativeCoinLeg(get_amount, get_coin)
                    : formatLinkAmount('/' + get_coin + '/token/' + get_token, get_token, get_token, get_amount);
                $('td', row).eq(5).html(getLeg);
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
                // Local, not the shared `html` scratch variable: see formatNativeCoinLeg.
                let getLeg = isNull(get_token)
                    ? formatNativeCoinLeg(get_amount, get_coin)
                    : formatLinkAmount('/' + get_coin + '/token/' + get_token, get_token, get_token, get_amount);
                $('td', row).eq(5).html(getLeg);
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
                // data[8] = ownership-transfer destination; when set, this issue
                // moved the token's ownership record (the provenance trail for
                // NFT collections (NFT_Standard.md#collections))
                let transfer = data[8];
                if(!isNull(transfer))
                    $('td', row).eq(3).html(source_link + ' <i class="fa fa-arrow-right ps-1 pe-1" title="Token ownership transferred"></i> ' + formatLink('/' + coin + '/address/' + transfer, transfer));
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
                // memo reaches the feed through a LEFT JOIN on index_memos, so it is
                // null for the (common) LINK that carries no memo.
                $('td', row).eq(6).text(nullToBlank(memo));
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
                token       = data[4];
                amount      = data[5];
                destination = data[6];
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).html(formatAmount(amount));
                // Write the cell either way: a MINT's DESTINATION is optional, and
                // skipping it leaves the raw feed value DataTables rendered, which
                // for a null column is the word "null".
                $('td', row).eq(6).html(isNull(destination)
                    ? ''
                    : formatLink('/' + coin + '/address/' + destination, destination));
                $('td', row).eq(7).html(action_link);
            }
            // Order
            if(action=='order'){
                token   = data[4];
                amount  = data[5];
                token2  = data[6];
                amount2 = data[7];
                give_ownership = data[8];
                get_ownership  = data[9];
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
                give_ownership = data[8];
                get_ownership  = data[9];
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
                let tickHtml = formatLink('/' + coin + '/token/' + token, token, token);
                $('td', row).eq(3).html(tickHtml);
                $('td', row).eq(4).text(formatAmount(amount));
                $('td', row).eq(5).text(formatAmount(amount2));
                $('td', row).eq(6).text(formatAmount(amount3));
                $('td', row).eq(7).html(formatLocks(locks));
                $('td', row).eq(8).html(formatLink('/' + coin + '/token/' + token, 'view', null, true));
            }
            // Official Tokens (project roster; same row shape as Tokens)
            if(action=='project'){
                token   = data[3];
                amount  = data[4];
                amount2 = data[5];
                amount3 = data[6];
                locks   = data[7];
                let pTickHtml = formatLink('/' + coin + '/token/' + token, token, token);
                $('td', row).eq(3).html(pTickHtml);
                $('td', row).eq(4).text(formatAmount(amount));
                $('td', row).eq(5).text(formatAmount(amount2));
                $('td', row).eq(6).text(formatAmount(amount3));
                $('td', row).eq(7).html(formatLocks(locks));
                $('td', row).eq(8).html(formatLink('/' + coin + '/token/' + token, 'view', null, true));
            }
            // Raw action list: one row per action with its type name; no per-type
            // details on this feed (they live on the action page). No status column
            // on the actions table, so 'action' sits in the no-color list above.
            if(action=='action'){
                let action2 = data[4];
                $('td', row).eq(4).html('<span class="badge text-bg-info">' + escapeHtml(String(action2 || '-')) + '</span>');
                $('td', row).eq(5).html(action_link);
            }
            // Order match: each leg links the matched ORDER's action on its own coin
            // (the match row carries coins and action indexes, not ticks).
            if(action=='order_match'){
                let give_coin  = data[3];
                let give_index = data[4];
                let get_coin   = data[6];
                let get_index  = data[7];
                let settlement = data[9];
                $('td', row).eq(3).html(formatLink('/' + give_coin + '/action/' + give_index, give_coin + '-' + give_index));
                $('td', row).eq(4).html(formatAmount(data[5]));
                $('td', row).eq(5).html(formatLink('/' + get_coin + '/action/' + get_index, get_coin + '-' + get_index));
                $('td', row).eq(6).html(formatAmount(data[8]));
                $('td', row).eq(7).text(isNull(settlement) ? '-' : settlement);
                $('td', row).eq(8).html(action_link);
            }
            // Swap match: same two-leg rendering minus the amount and settlement
            // columns, which a swap match does not carry.
            if(action=='swap_match'){
                let give_coin  = data[3];
                let give_index = data[4];
                let get_coin   = data[5];
                let get_index  = data[6];
                $('td', row).eq(3).html(formatLink('/' + give_coin + '/action/' + give_index, give_coin + '-' + give_index));
                $('td', row).eq(4).html(formatLink('/' + get_coin + '/action/' + get_index, get_coin + '-' + get_index));
                $('td', row).eq(5).html(action_link);
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
                // contract_executions.method_name is nullable (an EXECUTE that names no
                // method still records a row, with its gas), so blank it rather than "null".
                $('td', row).eq(5).text(nullToBlank(method));
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
            // Validator / capability stake. eq(7)-eq(9) are the hub federation registry's
            // view of the SAME signing pubkey (addr / served chains / registration
            // status), folded onto the on-chain active set so one page covers both.

            // Registry strings are hub-supplied free text and render as TEXT, never
            // markup. A null status means no registry was reachable (unknown);
            // 'unregistered' means the registry answered and does not list this pubkey.
            if(action=='validator'){
                let pubkey     = data[4];
                let version    = data[5];
                amount         = data[6];
                let hub_addr   = data[7];
                let hub_chains = data[8];
                let hub_status = data[9];
                let reg_cls    = (hub_status=='active')     ? 'success'
                               : (hub_status=='suspended')  ? 'warning text-dark'
                               : (hub_status=='removed')    ? 'danger'
                               : (hub_status=='unregistered') ? 'secondary'
                               : 'light text-dark';
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).text('v' + version);
                $('td', row).eq(6).html(formatAmount(amount));
                $('td', row).eq(7).text(isNull(hub_addr) ? '-' : hub_addr);
                $('td', row).eq(8).text(isNull(hub_chains) ? '-' : hub_chains);
                $('td', row).eq(9).html($('<span>')
                    .addClass('badge text-bg-' + reg_cls)
                    .text(isNull(hub_status) ? 'unknown' : hub_status));
                $('td', row).eq(10).html(action_link);
            }
            // Raw stake list (all STAKE actions, any status; getStakes shaper, action_index last)
            if(action=='stake'){
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
            // Slash event (xchain.contract.slash emission; no own action_index; links to the EXECUTE)
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
                // Both attests.request_status and attests.response_status are nullable
                // ENUMs with no default; each row fills only the one for its version, and
                // an unresolved row leaves even that one NULL.
                $('td', row).eq(7).text(nullToBlank((version == 0) ? request_status : response_status));
                $('td', row).eq(8).html(action_link);
            }
            // VOTE poll (polls table; token-weighted governance, VOTE v0). eq(4) token,
            // eq(5) question, eq(6) lifecycle-status badge (open/finalized/failed_quorum),
            // eq(7) close block, eq(8) binding badge (a non-null callback contract means
            // the poll result fires a contract method, i.e. it can move real value).
            if(action=='poll'){
                token             = data[4];
                let question      = data[5];
                let poll_status   = data[6];
                let end_block     = data[7];
                let binding       = data[8];
                let pcls = (poll_status=='finalized') ? 'success' : (poll_status=='failed_quorum') ? 'danger' : 'warning text-dark';
                $('td', row).eq(4).html(isNull(token) ? '-' : formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).text(isNull(question) ? '-' : question);
                $('td', row).eq(6).html('<span class="badge text-bg-' + pcls + '">' + (poll_status || '-') + '</span>');
                $('td', row).eq(7).html(isNull(end_block) ? '-' : formatLink('/' + coin + '/block/' + end_block, numeral(end_block).format(fmtInteger)));
                $('td', row).eq(8).html(isNull(binding) ? '-' : formatLink('/' + coin + '/contract/' + binding, '<span class="badge text-bg-danger">Binding</span>', 'Binding poll: finalization calls contract ' + binding));
                $('td', row).eq(9).html(action_link);
            }
            // VOTE ballot (votes table; one row per voter choice, VOTE v1). eq(4) links the
            // poll it voted on, eq(5) the chosen option index, eq(6) the split-mode share.
            if(action=='vote'){
                let poll_index = data[4];
                let choice     = data[5];
                let share      = data[6];
                $('td', row).eq(4).html(isNull(poll_index) ? '-' : formatLink('/' + coin + '/action/' + poll_index, poll_index));
                $('td', row).eq(5).text(isNull(choice) ? '-' : choice);
                $('td', row).eq(6).text(isNull(share) ? '-' : share);
                $('td', row).eq(7).html(action_link);
            }
            // BET market (bet_feeds; BET format 0). eq(5) is the market LABEL, which is
            // attacker-controlled on-chain text, so it goes in with .text() and never
            // as markup. The status shown is the STORED feed status.
            if(action=='bet_feed'){
                token            = data[4];
                let label        = data[5];
                let feed_status  = data[6];
                let deadline     = data[7];
                let fcls = (feed_status=='resolved') ? 'success'
                         : (feed_status=='cancelled' || feed_status=='expired') ? 'danger'
                         : (feed_status=='resolved_void') ? 'secondary'
                         : (feed_status=='closed') ? 'warning text-dark' : 'primary';
                $('td', row).eq(4).html(isNull(token) ? '-' : formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).text(isNull(label) ? '-' : label);
                $('td', row).eq(6).html('<span class="badge text-bg-' + fcls + '">' + escapeHtml(String(feed_status || '-')) + '</span>');
                $('td', row).eq(7).html(isNull(deadline) ? '-' : formatLivestamp(deadline));
                // The view button targets the MARKET page, not the raw action page.
                $('td', row).eq(8).html(formatLink('/' + coin + '/bet_feed/' + data[9], '<i class="fa fa-eye"></i>', 'View market'));
            }
            // BET wager (bets; BET format 2). eq(4) links the market it was placed on.
            if(action=='bet'){
                let feed_index = data[4];
                let outcome    = data[5];
                token          = data[6];
                amount         = data[7];
                let bet_status = data[8];
                let bcls = (bet_status=='won') ? 'success' : (bet_status=='lost') ? 'danger'
                         : (bet_status=='refunded') ? 'secondary' : 'primary';
                $('td', row).eq(4).html(isNull(feed_index) ? '-' : formatLink('/' + coin + '/bet_feed/' + feed_index, feed_index));
                $('td', row).eq(5).text(isNull(outcome) ? '-' : outcome);
                $('td', row).eq(6).html(isNull(token) ? '-' : formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(7).html(formatAmount(amount));
                $('td', row).eq(8).html('<span class="badge text-bg-' + bcls + '">' + escapeHtml(String(bet_status || '-')) + '</span>');
                $('td', row).eq(9).html(action_link);
            }
            // XCALL (cross-chain call, source-chain request row). eq(3) overrides the
            // generic source-address link with the emitting contract.
            if(action=='xcall'){
                let contract_index        = data[3];
                let target_chain          = data[4];
                let target_contract_index = data[5];
                let method                = data[6];
                let request_status        = data[7];
                let cls = (request_status=='completed') ? 'success' : (request_status=='expired') ? 'danger' : (request_status=='pending') ? 'warning text-dark' : 'secondary';
                $('td', row).eq(3).html(isNull(contract_index) ? '-' : formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(4).text(isNull(target_chain) ? '-' : target_chain);
                $('td', row).eq(5).text(isNull(target_contract_index) ? '-' : target_contract_index);
                $('td', row).eq(6).text(isNull(method) ? '-' : method);
                $('td', row).eq(7).html('<span class="badge text-bg-' + cls + '">' + (request_status || '-') + '</span>');
                $('td', row).eq(8).html(action_link);
            }
            // Collect (validator reward claim; reward_claims)
            if(action=='collect'){
                amount = data[4];
                $('td', row).eq(4).html(formatAmount(amount));
                $('td', row).eq(5).html(action_link);
            }
            // Capability unstake (UNSTAKE v0; begins the global cooldown on a staked key)
            if(action=='unstake'){
                let pubkey       = data[4];
                amount           = data[5];
                let cooldown_end = data[6];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(formatLink('/' + coin + '/block/' + cooldown_end, numeral(cooldown_end).format(fmtInteger)));
                $('td', row).eq(7).html(action_link);
            }
            // Delegate key revocation (DELEGATE v2/v3; stake_key_revocations)
            if(action=='delegation_revocation'){
                let pubkey       = data[4];
                let deactivation = data[5];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).html(formatLink('/' + coin + '/block/' + deactivation, numeral(deactivation).format(fmtInteger)));
                $('td', row).eq(6).html(action_link);
            }
            // Capability equivocation slash (SLASH wire action; capability_slash_events). No row
            // color (no status); the view links to the SLASH action via slash_action_index.
            if(action=='capability_slash_event'){
                let pubkey             = data[3];
                let capability         = data[4];
                amount                 = data[5];
                let submitter          = data[6];
                let slash_action_index = data[7];
                $('td', row).eq(3).html(formatHash(pubkey));
                $('td', row).eq(4).html('<span class="badge text-bg-secondary">' + (capability || '-') + '</span>');
                $('td', row).eq(5).html(formatAmount(amount));
                $('td', row).eq(6).html(isNull(submitter) ? '-' : formatLink('/' + coin + '/address/' + submitter, submitter));
                $('td', row).eq(7).html(formatLink('/' + coin + '/action/' + slash_action_index, 'view', null, true));
            }
            // User token/fiat oracle row (PRICE v1; hub-mirrored, cross-chain). eq(1)/eq(2) override
            // the generic block/time columns (no local block on a mirror row).
            if(action=='oracle_price'){
                let block_time    = data[1];
                let source_chain  = data[2];
                let source_address = data[3];
                token             = data[4];
                let fiat          = data[5];
                value             = data[6];
                $('td', row).eq(1).html(formatLivestamp(block_time));
                $('td', row).eq(2).text(isNull(source_chain) ? '-' : source_chain);
                $('td', row).eq(3).html(isNull(source_address) ? '-' : formatLink('/' + coin + '/address/' + source_address, source_address));
                $('td', row).eq(4).html(formatLink('/' + coin + '/token/' + token, token, token));
                $('td', row).eq(5).text(isNull(fiat) ? '-' : fiat);
                $('td', row).eq(6).html(numeral(value).format(fmtCurrency));
            }
            // Anchor (DOGE state checkpoint). eq(3) overrides the generic source link with the chain.
            if(action=='anchor'){
                let chain          = data[3];
                let network        = data[4];
                let version        = data[5];
                let checkpoint_seq = data[6];
                let snapshot_block = data[7];
                let match_count    = data[8];
                $('td', row).eq(3).text(isNull(chain) ? '-' : chain);
                $('td', row).eq(4).text(isNull(network) ? '-' : network);
                $('td', row).eq(5).text('v' + version);
                $('td', row).eq(6).html(numeral(checkpoint_seq).format(fmtInteger));
                $('td', row).eq(7).html(isNull(snapshot_block) ? '-' : formatLink('/' + coin + '/block/' + snapshot_block, numeral(snapshot_block).format(fmtInteger)));
                $('td', row).eq(8).html(numeral(match_count).format(fmtInteger));
                $('td', row).eq(9).html(action_link);
            }
            // Validator reward (validator_rewards; id-keyed accrual ledger, no own action_index)
            if(action=='reward'){
                let pubkey      = data[4];
                let reward_type = data[5];
                amount          = data[6];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).html('<span class="badge text-bg-secondary">' + (reward_type || '-') + '</span>');
                $('td', row).eq(6).html(formatAmount(amount));
            }
            // Delegation (DELEGATE v0/v1/v2/v3 signing-key delegation)
            if(action=='delegation'){
                let pubkey = data[4];
                $('td', row).eq(4).html(formatHash(pubkey));
                $('td', row).eq(5).html(action_link);
            }
            // Full-node verification (NODEPROOF v0 possession-proof verdict). eq(3) overrides the
            // generic source link with the verified pubkey; eq(7) badges the pass/fail result.
            if(action=='full_node_verification'){
                let pubkey         = data[3];
                let staking_source = data[4];
                let epoch_height   = data[5];
                let target_height  = data[6];
                let passed         = data[8];
                $('td', row).eq(3).html(formatHash(pubkey));
                $('td', row).eq(4).html(isNull(staking_source) ? '-' : formatLink('/' + coin + '/address/' + staking_source, staking_source));
                $('td', row).eq(5).html(numeral(epoch_height).format(fmtInteger));
                $('td', row).eq(6).html(numeral(target_height).format(fmtInteger));
                $('td', row).eq(7).html('<span class="badge text-bg-' + (passed == 1 ? 'success' : 'danger') + '">' + (passed == 1 ? 'Pass' : 'Fail') + '</span>');
                $('td', row).eq(8).html(action_link);
            }
            // Cross-chain DEX match (hub-mirrored; id-keyed, no per-row view link). eq(1) keeps the
            // generic block link (snapshot_block); eq(2)/eq(3) override network/match_id.
            if(action=='cross_chain_match'){
                let network  = data[2];
                let match_id = data[3];
                let a_chain  = data[4];
                let a_tick   = data[5];
                let a_amount = data[6];
                let b_chain  = data[7];
                let b_tick   = data[8];
                let b_amount = data[9];
                let mstatus  = data[10];
                $('td', row).eq(2).text(isNull(network) ? '-' : network);
                $('td', row).eq(3).html(isNull(match_id) ? '-' : formatHash(match_id));
                $('td', row).eq(4).text(isNull(a_chain) ? '-' : a_chain);
                $('td', row).eq(5).html(isNull(a_tick) ? '-' : formatLink('/' + coin + '/token/' + a_tick, a_tick, a_tick));
                $('td', row).eq(6).html(formatAmount(a_amount));
                $('td', row).eq(7).text(isNull(b_chain) ? '-' : b_chain);
                $('td', row).eq(8).html(isNull(b_tick) ? '-' : formatLink('/' + coin + '/token/' + b_tick, b_tick, b_tick));
                $('td', row).eq(9).html(formatAmount(b_amount));
                $('td', row).eq(10).html('<span class="badge text-bg-secondary">' + (mstatus || '-') + '</span>');
            }
            // Cross-chain settlement leg (local action-chain row; view links the settlement action)
            if(action=='cross_chain_settlement'){
                let match_id           = data[3];
                let local_action_index = data[4];
                $('td', row).eq(3).html(isNull(match_id) ? '-' : formatHash(match_id));
                $('td', row).eq(4).html(isNull(local_action_index) ? '-' : formatLink('/' + coin + '/action/' + local_action_index, local_action_index));
                $('td', row).eq(5).html(action_link);
            }
            // Quorum-signed state checkpoint (hub-mirrored). No action row, so the last
            // column drills into the checkpoint detail page by height rather than into an
            // action, and signer_count is a plain count: the signature VERDICT costs an
            // Ed25519 pass per signer and is only computed when the detail page's Verify
            // control asks for it.
            if(action=='checkpoint'){
                let checkpoint_seq = data[3];
                let snapshot_block = data[4];
                let state_root     = data[5];
                let merkle_root    = data[6];
                let signer_count   = data[7];
                $('td', row).eq(3).text(isNull(checkpoint_seq) ? '-' : checkpoint_seq);
                $('td', row).eq(4).html(isNull(snapshot_block) ? '-' : formatLink('/' + coin + '/block/' + snapshot_block, numeral(snapshot_block).format(fmtInteger)));
                $('td', row).eq(5).html(isNull(state_root) ? '-' : formatHash(state_root));
                $('td', row).eq(6).html(isNull(merkle_root) ? '-' : formatHash(merkle_root));
                $('td', row).eq(7).text(isNull(signer_count) ? '-' : signer_count);
                $('td', row).eq(8).html(formatLink('/' + coin + '/checkpoint/' + block_index, 'view', null, true));
            }
            // Per-block SPV commitments (state_tree_roots) plus the covering checkpoint
            // and the ANCHOR that carried it. checkpoint_seq/anchor_action are null when
            // neither exists YET, the normal state near the tip, so both render as a
            // neutral badge rather than an error or a blank. Height is plain text, this
            // section always sitting on the block it describes.
            if(action=='commitment'){
                let height              = data[1];
                let balances_root       = data[2];
                let stakes_root         = data[3];
                let commit_state_root   = data[4];
                let merkle_root         = data[5];
                let contract_state_root = data[6];
                let checkpoint_seq      = data[7];
                let checkpoint_signers  = data[8];
                let anchor_action       = data[9];
                let anchor_version      = data[10];
                $('td', row).eq(1).text(numeral(height).format(fmtInteger));
                $('td', row).eq(2).html(formatHash(balances_root));
                $('td', row).eq(3).html(formatHash(stakes_root));
                $('td', row).eq(4).html(formatHash(commit_state_root));
                $('td', row).eq(5).html(formatHash(merkle_root));
                $('td', row).eq(6).html(isNull(contract_state_root) ? '<span class="text-muted">Not armed</span>' : formatHash(contract_state_root));
                $('td', row).eq(7).html(isNull(checkpoint_seq)
                    ? '<span class="badge text-bg-secondary">Not yet checkpointed</span>'
                    : 'Seq ' + numeral(checkpoint_seq).format(fmtInteger) + ' &middot; ' +
                      numeral(isNull(checkpoint_signers) ? 0 : checkpoint_signers).format(fmtInteger) + ' signers ' +
                      formatLink('/' + coin + '/checkpoint/' + height, 'view', null, true));
                $('td', row).eq(8).html(isNull(anchor_action)
                    ? '<span class="badge text-bg-secondary">Not yet anchored</span>'
                    : 'ANCHOR v' + numeral(anchor_version).format('0') + ' ' +
                      formatLink('/' + coin + '/action/' + anchor_action, 'view', null, true));
            }
            // Validator PBFT price round (hub-mirrored, id-keyed). reference_block names a
            // height on reference_chain, which is not necessarily this coin's chain, so it
            // stays plain text rather than becoming a local block link.
            if(action=='price_snapshot'){
                let block_timestamp = data[1];
                let reference_block = data[2];
                let reference_chain = data[3];
                let coin_pair       = data[4];
                let price           = data[5];
                let validators      = data[6];
                let round           = data[7];
                let round_status    = data[8];
                $('td', row).eq(1).html(formatLivestamp(block_timestamp));
                $('td', row).eq(2).text(isNull(reference_block) ? '-' : numeral(reference_block).format(fmtInteger));
                $('td', row).eq(3).text(isNull(reference_chain) ? '-' : reference_chain);
                $('td', row).eq(4).text(isNull(coin_pair) ? '-' : coin_pair);
                $('td', row).eq(5).text(isNull(price) ? '-' : numeral(price).format(fmtCurrency));
                $('td', row).eq(6).text(isNull(validators) ? '-' : validators);
                $('td', row).eq(7).text(isNull(round) ? '-' : round);
                $('td', row).eq(8).html('<span class="badge text-bg-secondary">' + (round_status || '-') + '</span>');
            }
            // Per-contract emission rollup. Execution and Child Action link to their own
            // action detail pages; Child Action is null for an internal emission (e.g.
            // SLASH) that moves ledger state without minting a new on-wire action.
            if(action=='emission'){
                let execution_index = data[3];
                let contract_index  = data[4];
                let position        = data[5];
                let emitted_action  = data[6];
                let child_action    = data[7];
                let emission_status = data[8];
                $('td', row).eq(3).html(isNull(execution_index) ? '-' : formatLink('/' + coin + '/action/' + execution_index, numeral(execution_index).format(fmtInteger)));
                $('td', row).eq(4).html(isNull(contract_index) ? '-' : formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(5).text(isNull(position) ? '-' : position);
                $('td', row).eq(6).html(isNull(emitted_action) ? '-' : '<span class="badge text-bg-secondary">' + escapeHtml(emitted_action) + '</span>');
                $('td', row).eq(7).html(isNull(child_action) ? '<span class="text-muted">internal</span>' : formatLink('/' + coin + '/action/' + child_action, numeral(child_action).format(fmtInteger)));
                $('td', row).eq(8).html('<span class="badge text-bg-' + (emission_status=='valid' ? 'success' : 'danger') + '">' + escapeHtml(emission_status || '-') + '</span>');
            }
            // Cross-chain reorg attestation (hub-owned, id-keyed). reorg_height is THIS
            // coin's own chain height (both transports scope to it), so it links to the
            // local block page. reorg_timestamp is stored in MILLISECONDS, unlike
            // price_snapshot's block_timestamp above, which is Unix seconds, so it is
            // divided down before formatLivestamp. The status word is renamed here to avoid
            // shadowing the positional `status` destructured at the top of createdRow.
            if(action=='reorg'){
                let reorg_timestamp = data[1];
                let reorg_height    = data[2];
                let reorg_id        = data[3];
                let affected_chains = data[4];
                let validator_count = data[5];
                let reorg_status    = data[6];
                let chains = [];
                try { chains = JSON.parse(affected_chains) || []; } catch(e){ chains = []; }
                $('td', row).eq(1).html(isNull(reorg_timestamp) ? '-' : formatLivestamp(Math.floor(reorg_timestamp / 1000)));
                $('td', row).eq(2).html(isNull(reorg_height) ? '-' : formatLink('/' + coin + '/block/' + reorg_height, numeral(reorg_height).format(fmtInteger)));
                $('td', row).eq(3).html(isNull(reorg_id) ? '-' : formatHash(reorg_id, 24));
                $('td', row).eq(4).text(chains.length ? chains.join(', ') : '-');
                $('td', row).eq(5).text(isNull(validator_count) ? '-' : validator_count);
                $('td', row).eq(6).html('<span class="badge text-bg-' + (reorg_status=='confirmed' ? 'success' : 'danger') + '">' + escapeHtml(reorg_status || '-') + '</span>');
            }
            // Federation slash proposal (hub-owned, id-keyed). These rows are EVIDENCE,
            // not enforcement, so 'pending' is badged NEUTRAL and labelled
            // 'unadjudicated': red on an unadjudicated accusation reads as a verdict.
            // 'rejected' means DISMISSED, the cleared state rather than a failure.

            // evidence_hash is the sha256 of the evidence the hub holds, never served
            // verbatim, and is shown so a holder of an evidence record can check it
            // matches. The status word is renamed to avoid shadowing the positional
            // `status` destructured at the top of createdRow.
            if(action=='slash_proposal'){
                let created_at       = data[1];
                let validator_pubkey = data[2];
                let offense_type     = data[3];
                let round_number     = data[4];
                let evidence_hash    = data[5];
                let slash_status     = data[6];
                let badges = { pending: 'secondary', approved: 'danger', rejected: 'success', expired: 'secondary' };
                let labels = { pending: 'pending (unadjudicated)', approved: 'approved (penalty applied)', rejected: 'rejected (dismissed)', expired: 'expired' };
                $('td', row).eq(1).html(isNull(created_at) ? '-' : formatLivestamp(created_at));
                $('td', row).eq(2).html(isNull(validator_pubkey) ? '-' : formatHash(validator_pubkey));
                $('td', row).eq(3).text(isNull(offense_type) ? '-' : String(offense_type).replace(/_/g, ' '));
                $('td', row).eq(4).html(isNull(round_number) ? '-' : numeral(round_number).format(fmtInteger));
                $('td', row).eq(5).html(isNull(evidence_hash) ? '-' : formatHash(evidence_hash, 24));
                $('td', row).eq(6).html('<span class="badge text-bg-' + (badges[slash_status] || 'secondary') + '">' +
                    escapeHtml(labels[slash_status] || slash_status || '-') + '</span>');
            }
            // Contract-targeted stake delegation. deactivation_block is null while the
            // delegation is live, which is the difference between a current delegation and
            // a historical one, so it renders as a dash rather than being hidden.
            if(action=='contract_delegation'){
                let signing_pubkey  = data[4];
                let contract_index  = data[5];
                let tick            = data[6];
                let activation      = data[7];
                let deactivation    = data[8];
                $('td', row).eq(4).html(isNull(signing_pubkey) ? '-' : formatHash(signing_pubkey));
                $('td', row).eq(5).html(isNull(contract_index) ? '-' : formatLink('/' + coin + '/contract/' + contract_index, contract_index));
                $('td', row).eq(6).html(isNull(tick) ? '-' : formatLink('/' + coin + '/token/' + tick, tick, tick));
                $('td', row).eq(7).text(isNull(activation) ? '-' : numeral(activation).format(fmtInteger));
                $('td', row).eq(8).text(isNull(deactivation) ? '-' : numeral(deactivation).format(fmtInteger));
                $('td', row).eq(9).html(action_link);
            }
            // VOTE v3 liquid-democracy delegation. The row is already the LIVE delegation
            // for its (tick, delegator): revoked and re-pointed rows are excluded
            // server-side, never here. The trailing view button opens the VOTE v3 action
            // detail, where the single-action join renders the delegation itself.
            if(action=='vote_delegation'){
                let tick      = data[3];
                let delegator = data[4];
                let delegate  = data[5];
                $('td', row).eq(3).html(isNull(tick) ? '-' : formatLink('/' + coin + '/token/' + tick, tick, tick));
                $('td', row).eq(4).html(isNull(delegator) ? '-' : formatLink('/' + coin + '/address/' + delegator, delegator));
                $('td', row).eq(5).html(isNull(delegate) ? '-' : formatLink('/' + coin + '/address/' + delegate, delegate));
                $('td', row).eq(6).html(action_link);
            }
            // COINPAY settlement record. txid/vout name the specific output that paid THIS
            // obligation, so one transaction legitimately appears on several rows.
            if(action=='coinpay'){
                let obligation = data[4];
                let paid       = data[5];
                let txid       = data[6];
                let vout       = data[7];
                $('td', row).eq(4).html(isNull(obligation) ? '-' : formatLink('/' + coin + '/action/' + obligation, obligation));
                $('td', row).eq(5).html(isNull(paid) ? '-' : formatAmount(paid));
                $('td', row).eq(6).html(isNull(txid) ? '-' : formatHash(txid));
                $('td', row).eq(7).text(isNull(vout) ? '-' : vout);
                $('td', row).eq(8).html(action_link);
            }
            // COINPAY obligation: who owes what native coin, expiring when. The row carries
            // the LATEST status for the obligation, and no block time of its own (an
            // ORDER_MATCH creates it, so eq(2) shows the payer instead of a timestamp).
            if(action=='coinpay_obligation'){
                let payer      = data[2];
                let payee      = data[3];
                let owed_coin  = data[4];
                let owed       = data[5];
                let expiration = data[6];
                let pay_status = data[7];
                $('td', row).eq(2).html(isNull(payer) ? '-' : formatLink('/' + coin + '/address/' + payer, payer));
                $('td', row).eq(3).html(isNull(payee) ? '-' : formatLink('/' + coin + '/address/' + payee, payee));
                $('td', row).eq(4).text(isNull(owed_coin) ? '-' : owed_coin);
                $('td', row).eq(5).html(isNull(owed) ? '-' : formatAmount(owed));
                // expiration is a Unix TIMESTAMP (coinpay_obligations.expiration is a
                // BIGINT of seconds), not a block height, so it must not be rendered as
                // a block link: on regtest the value is nine digits against a tip in the
                // thousands, and the link resolves to a block that cannot exist.
                $('td', row).eq(6).html(isNull(expiration) ? '-' : formatLivestamp(expiration));
                $('td', row).eq(7).html('<span class="badge text-bg-secondary">' + (pay_status || '-') + '</span>');
                $('td', row).eq(8).html(action_link);
            }
            // ORDER_EXPIRE / SWAP_EXPIRE / DISPENSER_EXPIRE: the protocol retiring an
            // unfilled order, an unfilled swap, or a dispenser that reached its expiration
            // height. All three carry the same shape - the expire action, plus a pointer at
            // the record it retired - so one branch renders the pointer for each.
            if(['order_expire','swap_expire','dispenser_expire'].includes(action)){
                let expired = data[4];
                $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
                $('td', row).eq(4).html(isNull(expired) ? '-' : formatLink('/' + coin + '/action/' + expired, expired));
                $('td', row).eq(5).html(action_link);
            }
            // DISPENSER_CLOSE: the owner retiring a dispenser and taking back its remaining
            // escrow. The give/get legs are the CLOSED dispenser's terms, and either leg may
            // be a native coin, which carries NO tick - linking one builds /token/null, so an
            // absent tick renders the coin name unlinked instead.
            if(action=='dispenser_close'){
                let dispenser = data[4];
                let reason    = data[11];
                give_coin   = data[5];
                give_token  = data[6];
                give_amount = data[7];
                get_coin    = data[8];
                get_token   = data[9];
                get_amount  = data[10];
                $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
                $('td', row).eq(4).html(isNull(dispenser) ? '-' : formatLink('/' + coin + '/action/' + dispenser, dispenser));
                $('td', row).eq(5).html(formatCoinLegAmount(coin, give_coin, give_token, give_amount));
                $('td', row).eq(6).html(formatCoinLegAmount(coin, get_coin, get_token, get_amount));
                // 'empty' (the dispenser drained itself) and 'cancelled' (the owner withdrew
                // it) are indistinguishable in every other column, so they carry different
                // badge colours: a reader must be able to tell them apart without reading.
                $('td', row).eq(7).html(isNull(reason)
                    ? '-'
                    : '<span class="badge text-bg-' + ((String(reason)=='cancelled') ? 'warning' : 'secondary') + '">' + escapeHtml(String(reason)) + '</span>');
                $('td', row).eq(8).html(action_link);
            }
            // ORDER_CANCEL / SWAP_CANCEL / DISPENSER_CANCEL: the owner pulling a live
            // record off the book. All three carry the same shape - the cancel action, a
            // pointer at the record it cancelled, and the memo explaining why - so one
            // branch renders all three.
            if(['order_cancel','swap_cancel','dispenser_cancel'].includes(action)){
                let cancelled = data[4];
                let why       = data[5];
                $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
                $('td', row).eq(4).html(isNull(cancelled) ? '-' : formatLink('/' + coin + '/action/' + cancelled, cancelled));
                // .text(), not .html(): a memo is arbitrary on-chain bytes.
                $('td', row).eq(5).text(isNull(why) ? '-' : String(why));
                $('td', row).eq(6).html(action_link);
            }
            // ORDER_EDIT / SWAP_EDIT: the owner amending a live record in place. The whole
            // point of the row is WHAT CHANGED, so expiration and the allow/block lists are
            // columns rather than detail-page-only fields. Each is nullable and a null means
            // "this edit left that setting alone", which renders as a dash - dropping the
            // column would hide the difference between an edit that cleared a list and one
            // that never touched it. allow_list/block_list are ACTION INDEXES pointing at a
            // LIST action, not inline lists, so they link like any other action pointer.
            if(['order_edit','swap_edit'].includes(action)){
                let edited     = data[4];
                let expiration = data[5];
                let allowList  = data[6];
                let blockList  = data[7];
                let why        = data[8];
                $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
                $('td', row).eq(4).html(isNull(edited) ? '-' : formatLink('/' + coin + '/action/' + edited, edited));
                // expiration is a Unix TIMESTAMP (seconds), the same field coinpay
                // obligations carry, not a block height.
                $('td', row).eq(5).html(isNull(expiration) ? '-' : formatLivestamp(expiration));
                $('td', row).eq(6).html(isNull(allowList) ? '-' : formatLink('/' + coin + '/action/' + allowList, allowList));
                $('td', row).eq(7).html(isNull(blockList) ? '-' : formatLink('/' + coin + '/action/' + blockList, blockList));
                $('td', row).eq(8).text(isNull(why) ? '-' : String(why));
                $('td', row).eq(9).html(action_link);
            }
            // DISPENSER_EDIT: as above, plus give_escrow - a refill is the most common
            // dispenser edit and moves ONLY the escrow, so that row carries a null
            // expiration and a real escrow amount. Both must render on their own.
            if(action=='dispenser_edit'){
                let edited     = data[4];
                let escrow     = data[5];
                let expiration = data[6];
                let allowList  = data[7];
                let blockList  = data[8];
                let why        = data[9];
                $('td', row).eq(3).html(isNull(source) ? '-' : source_link);
                $('td', row).eq(4).html(isNull(edited) ? '-' : formatLink('/' + coin + '/action/' + edited, edited));
                $('td', row).eq(5).text(isNull(escrow) ? '-' : formatAmount(escrow));
                $('td', row).eq(6).html(isNull(expiration) ? '-' : formatLivestamp(expiration));
                $('td', row).eq(7).html(isNull(allowList) ? '-' : formatLink('/' + coin + '/action/' + allowList, allowList));
                $('td', row).eq(8).html(isNull(blockList) ? '-' : formatLink('/' + coin + '/action/' + blockList, blockList));
                $('td', row).eq(9).text(isNull(why) ? '-' : String(why));
                $('td', row).eq(10).html(action_link);
            }
            // COINPAY_EXPIRE: an obligation nobody paid, closed out at its expiration. No
            // user transaction writes it, so it carries no source of its own and slot 3
            // holds the obligation it retired instead of an address.
            if(action=='coinpay_expire'){
                let obligation = data[3];
                $('td', row).eq(3).html(isNull(obligation) ? '-' : formatLink('/' + coin + '/action/' + obligation, obligation));
                $('td', row).eq(4).html(action_link);
            }
            // Per-validator per-capability qualification flags (hub-owned; id-keyed). qualified/
            // self_test_ok/enabled are 0/1 flags rendered as yes/no badges.
            if(action=='validator_capability'){
                let updated_at   = data[1];
                let pubkey       = data[2];
                let capability   = data[3];
                let qualified    = data[4];
                let self_test_ok = data[5];
                let enabled      = data[6];
                let qual_block   = data[7];
                let yesno = (v) => '<span class="badge text-bg-' + (v == 1 ? 'success' : 'secondary') + '">' + (v == 1 ? 'Yes' : 'No') + '</span>';
                $('td', row).eq(1).html(formatLivestamp(updated_at));
                $('td', row).eq(2).html(formatHash(pubkey));
                $('td', row).eq(3).html('<span class="badge text-bg-info">' + (capability || '-') + '</span>');
                $('td', row).eq(4).html(yesno(qualified));
                $('td', row).eq(5).html(yesno(self_test_ok));
                $('td', row).eq(6).html(yesno(enabled));
                $('td', row).eq(7).html(isNull(qual_block) ? '-' : formatLink('/' + coin + '/block/' + qual_block, numeral(qual_block).format(fmtInteger)));
            }
            // Capability snapshot (co-located checkpoint mirror; id-keyed): the HISTORICAL
            // electorate behind the qualification view above. amount is a stake weight, not
            // a token balance, so it is labelled rather than rendered as a bare number;
            // source is the staking source the weight groups under, and is the empty string
            // before stake-weighted-quorum activation, when only the qualifying count
            // mattered.
            if(action=='capability_snapshot'){
                let snapshot_block = data[2];
                let capability     = data[3];
                let signing_pubkey = data[4];
                let amount         = data[5];
                let source_key     = data[6];
                $('td', row).eq(1).html(formatLivestamp(data[1]));
                $('td', row).eq(2).html(isNull(snapshot_block) ? '-' : formatLink('/' + coin + '/block/' + snapshot_block, numeral(snapshot_block).format(fmtInteger)));
                $('td', row).eq(3).html('<span class="badge text-bg-info">' + escapeHtml(capability || '-') + '</span>');
                $('td', row).eq(4).html(isNull(signing_pubkey) ? '-' : formatHash(signing_pubkey));
                $('td', row).eq(5).html(isNull(amount) ? '-' : numeral(amount).format(fmtCoin) + ' stake weight');
                $('td', row).eq(6).text(isNull(source_key) || source_key === '' ? '-' : source_key);
            }
            // Per-validator per-provider ATTEST accountability counters (indexer-owned; no
            // action row, so no status badge and no action link - this sits in the no-color
            // list above). slashed_count and quality_score are Phase 4 columns that read 0
            // on every venue today (no producer yet), still surfaced so the column is ready
            // when one ships.
            if(action=='attest_validator_stat'){
                let pubkey     = data[1];
                let provider   = data[2];
                let fulfilled  = data[3];
                let missed     = data[4];
                let slashed    = data[5];
                let quality    = data[6];
                let lastBlock  = data[7];
                $('td', row).eq(1).html(formatHash(pubkey));
                $('td', row).eq(2).html('<span class="badge text-bg-info">' + escapeHtml(provider || '-') + '</span>');
                $('td', row).eq(3).text(isNull(fulfilled) ? '-' : numeral(fulfilled).format(fmtInteger));
                $('td', row).eq(4).html('<span class="badge text-bg-' + (Number(missed) > 0 ? 'warning' : 'secondary') + '">' + (isNull(missed) ? '-' : numeral(missed).format(fmtInteger)) + '</span>');
                $('td', row).eq(5).html('<span class="badge text-bg-' + (Number(slashed) > 0 ? 'danger' : 'secondary') + '">' + (isNull(slashed) ? '-' : numeral(slashed).format(fmtInteger)) + '</span>');
                let qClass = (Number(quality) >= 0.9) ? 'success' : (Number(quality) >= 0.5) ? 'warning' : 'danger';
                $('td', row).eq(6).html(isNull(quality) ? '-' : '<span class="badge text-bg-' + qClass + '">' + numeral(quality).format('0.0000') + '</span>');
                $('td', row).eq(7).html(isNull(lastBlock) ? '-' : formatLink('/' + coin + '/block/' + lastBlock, numeral(lastBlock).format(fmtInteger)));
            }
            // Governance parameter proposal (hub-owned; id-keyed). proposal_id links the votes view.
            if(action=='governance_proposal'){
                let proposal_id    = data[1];
                let parameter      = data[2];
                let current_value  = data[3];
                let proposed_value = data[4];
                let pstatus        = data[5];
                let voting_end     = data[6];
                let activation     = data[7];
                let proposer       = data[8];
                $('td', row).eq(1).html(isNull(proposal_id) ? '-' : formatLink('/' + coin + '/governance_votes/' + proposal_id + '/proposal', proposal_id));
                $('td', row).eq(2).text(isNull(parameter) ? '-' : parameter);
                $('td', row).eq(3).text(isNull(current_value) ? '-' : current_value);
                $('td', row).eq(4).text(isNull(proposed_value) ? '-' : proposed_value);
                $('td', row).eq(5).html('<span class="badge text-bg-secondary">' + (pstatus || '-') + '</span>');
                $('td', row).eq(6).html(formatLivestamp(voting_end));
                $('td', row).eq(7).html(isNull(activation) ? '-' : formatLink('/' + coin + '/block/' + activation, numeral(activation).format(fmtInteger)));
                $('td', row).eq(8).html(formatHash(proposer));
            }
            // Per-validator governance vote (hub-owned; id-keyed). approve=green, reject=red badge.
            if(action=='governance_vote'){
                let created_at  = data[1];
                let proposal_id = data[2];
                let voter       = data[3];
                let vote        = data[4];
                $('td', row).eq(1).html(formatLivestamp(created_at));
                $('td', row).eq(2).html(isNull(proposal_id) ? '-' : formatLink('/' + coin + '/governance_votes/' + proposal_id + '/proposal', proposal_id));
                $('td', row).eq(3).html(formatHash(voter));
                $('td', row).eq(4).html('<span class="badge text-bg-' + (vote == 'approve' ? 'success' : 'danger') + '">' + (vote || '-') + '</span>');
            }
            // Hub P2P peer roster (hub-owned; id-keyed). is_seed rendered as a badge.
            if(action=='peer'){
                let last_seen    = data[1];
                let addr         = data[2];
                let validator_id = data[3];
                let is_seed      = data[4];
                $('td', row).eq(1).html(isNull(last_seen) ? '-' : formatLivestamp(last_seen));
                $('td', row).eq(2).text(isNull(addr) ? '-' : addr);
                $('td', row).eq(3).html(isNull(validator_id) ? '-' : formatHash(validator_id));
                $('td', row).eq(4).html(is_seed == 1
                    ? '<span class="badge text-bg-primary">Seed</span>'
                    : '<span class="badge text-bg-secondary">Peer</span>');
            }
            // Hub consensus key/value state (hub-owned; id-keyed).
            if(action=='consensus_state'){
                let updated_at = data[1];
                let key_name   = data[2];
                let value      = data[3];
                $('td', row).eq(1).html(isNull(updated_at) ? '-' : formatLivestamp(updated_at));
                $('td', row).eq(2).html('<span class="badge text-bg-info">' + (isNull(key_name) ? '-' : key_name) + '</span>');
                $('td', row).eq(3).html(isNull(value) ? '-' : '<code>' + escapeHtml(String(value)) + '</code>');
            }
            // Hub config-oracle parameter store (hub-owned; id-keyed).
            if(action=='config'){
                let updated_at  = data[1];
                let coin_col    = data[2];
                let network_col = data[3];
                let module_col  = data[4];
                let param_name  = data[5];
                let param_value = data[6];
                $('td', row).eq(1).html(isNull(updated_at) ? '-' : formatLivestamp(updated_at));
                $('td', row).eq(2).text(isNull(coin_col) ? '-' : coin_col);
                $('td', row).eq(3).text(isNull(network_col) ? '-' : network_col);
                $('td', row).eq(4).html('<span class="badge text-bg-secondary">' + (isNull(module_col) ? '-' : module_col) + '</span>');
                $('td', row).eq(5).text(isNull(param_name) ? '-' : param_name);
                $('td', row).eq(6).html(isNull(param_value) ? '-' : '<code>' + escapeHtml(String(param_value)) + '</code>');
            }
            // Anonymous xchain-node telemetry ping (hub-owned; id-keyed).
            if(action=='telemetry_ping'){
                let created_at   = data[1];
                let event        = data[2];
                let node_version = data[3];
                let os_platform  = data[4];
                let arch         = data[5];
                let country      = data[6];
                let region       = data[7];
                $('td', row).eq(1).html(isNull(created_at) ? '-' : formatLivestamp(created_at));
                $('td', row).eq(2).html('<span class="badge text-bg-info">' + (isNull(event) ? '-' : event) + '</span>');
                $('td', row).eq(3).text(isNull(node_version) ? '-' : node_version);
                $('td', row).eq(4).text(isNull(os_platform) ? '-' : os_platform);
                $('td', row).eq(5).text(isNull(arch) ? '-' : arch);
                let loc = [country, region].filter(v => !isNull(v) && v !== '').join(' / ');
                $('td', row).eq(6).text(loc || '-');
            }
        }
    });
}

// Load an action's rows directly from the API and hand the response to callback;
// query/type narrow the results to one address/block/etc when given.
function loadApiData(coin, action, query, type, callback){
    // Set the API endpoint name based on the action
    let endpoint = null;
    if(['history','block','network','token','action','status','transaction','market','markets'].includes(action) || (action=='address' && type==null)){
        endpoint = action;
    } else if(['address','batch','order_match','swap_match','cross_chain_match'].includes(action)){
        // These take '-es', not '-s'; the three *_match names would otherwise build
        // malformed endpoints ('cross_chain_matchs') that answer 404.
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

// Rendered state for a proof widget that did not get a proof. Tone follows the
// reason: an unarmed height or a missing checkpoint is expected on a young chain
// and reads as information, a stale mirror or a rate-limit as a warning, and only
// an unexpected failure reads as an error.
function proofNotice(tone, text){
    return '<span class="badge text-bg-' + tone + '">' + escapeHtml(String(text)) + '</span>';
}

// Turn a proof route's refusal into something a reader can act on. The routes
// answer typed codes rather than prose, and each one means a specific, normal
// thing: 409 = the height is below the slot's arming boundary (or its block was
// never checkpointed), 404 = no signed checkpoint covers this height yet, 503 =
// the hub mirror is too stale to answer, 429 = the per-IP proof cap. Anything
// else falls through to the server's own message.
function proofRefusal(status, body){
    let code = (body && body.code) ? String(body.code) : '';
    let msg  = (body && body.error) ? String(body.error) : 'Proof unavailable';
    if(status==429)
        return ['warning', 'Too many proof requests, try again shortly'];
    if(status==503)
        return ['warning', 'Consensus data is stale on this node: ' + msg];
    if(status==409)
        return ['info', code=='ACTION_BLOCK_NOT_CHECKPOINTED'
            ? 'Not provable yet: this action\'s block has no signed checkpoint'
            : 'Not provable yet: ' + msg];
    if(status==404)
        return ['info', msg];
    return ['danger', msg];
}

// Shared fetch + render for the SPV proof widgets. Deliberately NOT built on
// loadApiData: that helper logs an error response and never calls back, and
// rendering the refusal is the whole point of a proof widget. `render` receives
// the parsed proof and returns the HTML for it; it is responsible for escaping
// anything that came from the server.
function loadProofWidget(url, target, render){
    let $el = $(target);
    if(!$el.length)
        return;
    $el.html('<span class="text-muted">Requesting proof...</span>');
    $.ajax({ url: url, dataType: 'json' })
        .done(function(o){
            try {
                $el.html(render(o));
            } catch(e){
                if(XC.debug)
                    console.log('proof render failed for ' + url, e);
                $el.html(proofNotice('danger', 'Could not render this proof'));
            }
        })
        .fail(function(xhr){
            let body = (xhr && xhr.responseJSON) ? xhr.responseJSON : {};
            let [tone, text] = proofRefusal(xhr ? xhr.status : 0, body);
            $el.html(proofNotice(tone, text));
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
    // A VM-emitted action never had a wire string of its own, so `tx_data` here is the
    // string of the EXECUTE that emitted it. Say so, and name the parent, rather than
    // letting "Transaction Data" imply this action was broadcast in that form.
    if(o.emitted_by && isNumeric(o.emitted_by.execution_index)){
        let parent   = formatLink('/' + XC.coin + '/action/' + o.emitted_by.execution_index, formatAmount(o.emitted_by.execution_index));
        let html     = 'EXECUTE ' + parent;
        if(isNumeric(o.emitted_by.contract_index))
            html += ' on contract ' + formatLink('/' + XC.coin + '/contract/' + o.emitted_by.contract_index, formatAmount(o.emitted_by.contract_index));
        if(isNumeric(o.emitted_by.position))
            html += ' (emission #' + numeral(Number(o.emitted_by.position) + 1).format('0,0') + ')';
        $('#emitted-by').html(html);
        $('#emitted-by-row').show();
        $('#tx-data-label').text('Transaction Data (emitting EXECUTE)');
    } else {
        $('#emitted-by-row').hide();
        $('#tx-data-label').text('Transaction Data');
    }
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
    if(o.action=='XCALL'){            found = true;  showXcallDetails(o);           }
    if(o.action=='XEXEC'){            found = true;  showXexecDetails(o);           }
    if(o.action=='CROSS_SETTLE'){     found = true;  showCrossSettleDetails(o);     }
    if(o.action=='VOTE'){             found = true;  showVoteDetails(o);            }
    if(o.action=='SLASH'){            found = true;  showSlashDetails(o);           }
    if(o.action=='COINPAY'){          found = true;  showCoinpayDetails(o);         }
    if(o.action=='COINPAY_EXPIRE'){   found = true;  showCoinpayExpireDetails(o);   }
    if(o.action=='ANCHOR'){           found = true;  showAnchorDetails(o);          }
    if(o.action=='PRICE'){            found = true;  showPriceDetails(o);           }
    if(o.action=='NODEPROOF'){        found = true;  showNodeproofDetails(o);       }
    if(o.action=='ROLLCALL'){         found = true;  showRollcallDetails(o);        }
    if(o.action=='BET'){              found = true;  showBetDetails(o);             }
    if(o.action=='BET_EXPIRE'){       found = true;  showBetExpireDetails(o);       }
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
    // ADDRESS has two unrelated subjects. v0 edits this address's preferences; v1 binds (or drops) a
    // guard contract over one action class of the account, and carries no preferences at all - showing
    // the preference rows for one rendered "Fee Preference: null" over the entire payload.
    if(data.action_format==1){
        // A REFUSED bind has no controller event to describe (the log is what consensus enforces), so
        // it shows neither row set: the page's own Status and Data fields carry the reason and the
        // attempted wire values.
        if(data.action_class != null){
            let unbind = (data.unbind==1);
            let target = (data.controller != null)
                ? formatLink('/' + XC.coin + '/action/' + data.controller, data.controller)
                : 'None';
            $('#info-address .address-action-class').text(data.action_class);
            $('#info-address .address-controller').html((unbind ? 'Unbind ' : 'Bind ') + target);
            // A bind commits the cooldown a later drop will cost; the drop itself reports when it lands.
            $('#info-address .address-cooldown').text(unbind
                ? (data.cooldown_blocks + ' blocks (drops at block ' + data.cooldown_end_block + ')')
                : (data.cooldown_blocks + ' blocks'));
            $('#info-address .address-controller-row').removeClass('d-none');
        } else {
            $('#info-address .address-controller-row').addClass('d-none');
        }
        $('#info-address .address-preference-row').addClass('d-none');
    } else {
        let preference   = (data.fee_preference) ? (' - ' + XC.fee_preferences[data.fee_preference]) : '';
        let require_memo = (data.require_memo==1) ? 'true' : 'false';
        let dispenser    = (data.dispenser_preference) ? XC.dispenser_preferences[data.dispenser_preference] : 'Not set';
        $('#info-address .address-fee-preference').text(data.fee_preference + preference);
        $('#info-address .address-require-memo').text(require_memo);
        $('#info-address .address-dispenser-preference').text(dispenser);
        $('#info-address .address-controller-row').addClass('d-none');
        $('#info-address .address-preference-row').removeClass('d-none');
    }
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
    // Read the broadcast's own fee fraction from its aliased column (broadcast_fee),
    // NOT data.fee: the reserved data.fee slot is overwritten with the protocol-fee
    // record when one exists, so reading it here rendered '[object Object]'.
    let percent = (isNumeric(data.broadcast_fee)) ? (' <span class="badge text-bg-info text-white">' + bcmul(data.broadcast_fee, 100, 2) + '%</span>') : '';
    $('#info-broadcast .broadcast-message').text(data.message);
    $('#info-broadcast .broadcast-value').text(formatAmount(data.value));
    $('#info-broadcast .broadcast-fee').html(data.broadcast_fee + percent);
    $('#info-broadcast .broadcast-memo').text(data.memo);
    // BROADCAST v3 references an earlier broadcast (its only meaningful payload);
    // link it and reveal the row, hidden for v0-v2 which have no reference.
    if(data.broadcast_action_index != null){
        $('#info-broadcast .broadcast-reference').html(formatLink('/' + XC.coin + '/action/' + data.broadcast_action_index, data.broadcast_action_index));
        $('#info-broadcast .broadcast-reference-row').removeClass('d-none');
    } else {
        $('#info-broadcast .broadcast-reference-row').addClass('d-none');
    }
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
    // A multi-destroy burns one leg per `destroys` row; render every leg.
    // Fall back to the header fields (one leg) for a payload without `destroys`.
    let legs = (data.destroys && data.destroys.length) ? data.destroys
             : [{ tick: data.tick, amount: data.amount, memo: data.memo, status: data.status }];
    showActionDatatable('destroy', legs);
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
    // Fiat/oracle-priced dispensers: fiat_amount is the operative price (Get Amount is not),
    // ignored when oracle_address is set. Only show these rows when the dispenser is
    // fiat/oracle-priced so plain crypto-priced dispensers are unchanged.
    let isFiatDispenser = (!isNull(data.fiat_code) || !isNull(data.fiat_amount) || !isNull(data.oracle_address));
    $('#info-dispenser .dispenser-fiat-row').toggleClass('d-none', !isFiatDispenser);
    if(isFiatDispenser){
        $('#info-dispenser .dispenser-fiat-code').text(isNull(data.fiat_code) ? '-' : data.fiat_code);
        $('#info-dispenser .dispenser-fiat-amount').text(isNull(data.fiat_amount) ? '-' : data.fiat_amount);
        $('#info-dispenser .dispenser-oracle-address').html(isNull(data.oracle_address) ? '-' : formatLink('/' + data.get_coin + '/address/' + data.oracle_address, data.oracle_address));
    }
    if(data.expiration)
        $('#info-dispenser .dispenser-expiration').html(data.expiration + ' - ' + formatLivestamp(data.expiration) + ' (' + moment.unix(data.expiration).utcOffset(0).format() + ' GMT)');
    $('#info-dispenser .dispenser-allow-list').html(formatLink('/' + XC.coin + '/action/' + data.allow_list, formatAmount(data.allow_list)));
    $('#info-dispenser .dispenser-block-list').html(formatLink('/' + XC.coin + '/action/' + data.block_list, formatAmount(data.block_list)));
    $('#info-dispenser .dispenser-memo').text(data.memo);
    // Dispenser Status Details
    // getActionData deletes state.get_remaining for DISPENSER (only give_remaining is
    // meaningful), so the data layer never carries the field; do not read it here.
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

// Display DISPENSE action information. get_amount is what THIS fill was
// charged: when one payment fills several dispensers in the same transaction,
// it is that fill's share, not the whole payment restated per fill (mainnet
// not yet armed; testnet/regtest already this way). The "Get Amount" label
// stays as-is since it is still an accurate name for "coin received for this
// event" either way - see protocol/actions/dispenser.md.
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
        // GATE_MIN_AMOUNT (PC-29): the minimum balance of the gate token at which a
        // recipient must be handed the unlock key. Absent means the gate is
        // unconditional (any holder), which is what every FILE published before the
        // field existed carries, so the row is hidden rather than shown as "none" -
        // an empty threshold row would read as a balance requirement of zero.
        if(!isNull(data.gate_min_amount) && data.gate_min_amount !== ''){
            $('#info-file .file-gate-min-amount').html(
                formatAmount(data.gate_min_amount) + ' ' +
                formatLink('/' + XC.coin + '/token/' + data.gate_ticker, data.gate_ticker, data.gate_ticker));
            $('#info-file .file-threshold-row').removeClass('d-none');
        } else {
            $('#info-file .file-threshold-row').addClass('d-none');
        }
    } else {
        $('#info-file .file-gated-row').addClass('d-none');
        $('#info-file .file-threshold-row').addClass('d-none');
    }
    // File viewer: non-gated media renders inline from the raw FILE endpoint
    // (the server only serves whitelisted media MIME types inline; everything
    // else is offered as a download). Gated files show a locked notice. The
    // rawUrl is built from XC.coin + the numeric action_index, not user input;
    // the declared MIME type is escaped where interpolated.
    let viewer = $('#info-file .file-viewer'),
        rawUrl = '/' + XC.coin + '/api/file/' + data.action_index + '/raw',
        type   = String(data.type || '').toLowerCase(),
        html   = '';
    if(!isNull(data.gate_ticker)){
        html = '<i class="fa fa-lock pe-1"></i> Token-gated content &mdash; holders decrypt client-side with their unlock key';
        // With a threshold (PC-29) the key is only owed to recipients whose balance
        // reaches it, so say so here rather than implying every holder gets one.
        if(!isNull(data.gate_min_amount) && data.gate_min_amount !== '')
            html += ', delivered to holders of at least ' + escapeHtml(String(data.gate_min_amount)) +
                    ' ' + escapeHtml(String(data.gate_ticker));
    } else if(type.substring(0,6)=='image/' && type!='image/svg+xml'){
        html = '<img src="' + rawUrl + '" class="img-fluid" style="max-width:400px" alt="">';
    } else if(type.substring(0,6)=='video/'){
        html = '<video controls playsinline class="img-fluid" style="max-width:400px"><source src="' + rawUrl + '" type="' + escapeHtml(type) + '"></video>';
    } else if(type.substring(0,6)=='audio/'){
        html = '<audio src="' + rawUrl + '" controls preload="none"></audio>';
    } else {
        html = formatLink(rawUrl, 'download file');
    }
    viewer.html(html);
}

// Display ATTEST action information (v0 request / v1 response; `attests` table)
function showAttestDetails(data){
    let isResponse = (Number(data.version) === 1);
    // ATTEST v2 is the system-synthesized expire: it writes no attests row, so the
    // explorer resolves only baseline fields + version. Badge it as an Expire and
    // show neither the request nor the response sub-panels (their fields are absent).
    let isExpire   = (Number(data.version) === 2);
    $('#info-attest .attest-type').html(
        isResponse ? '<span class="badge text-bg-primary">Response (v' + data.version + ')</span>' :
        isExpire   ? '<span class="badge text-bg-warning text-dark">Expire (v2)</span>' :
                     '<span class="badge text-bg-secondary">Request (v' + data.version + ')</span>');
    $('#info-attest .attest-request-id').html(formatHash(data.request_id, 32));
    $('#info-attest .attest-provider').text(data.provider_id);
    if(!isNull(data.contract_index))
        $('#info-attest .attest-contract').html(formatLink('/' + XC.coin + '/contract/' + data.contract_index, data.contract_index));
    // Request-side fields
    $('#info-attest .attest-request-fields').toggleClass('d-none', isResponse || isExpire);
    if(!isResponse && !isExpire){
        $('#info-attest .attest-fee-payer').html(isNull(data.fee_payer) ? '-' : formatLink('/' + XC.coin + '/address/' + data.fee_payer, data.fee_payer));
        // Request-side economics the requester escrowed and paid (fee_amount+fee_tick, gas_escrow).
        $('#info-attest .attest-fee').html(isNull(data.fee_amount) ? '-' : formatLink('/' + XC.coin + '/token/' + data.fee_tick, data.fee_tick, formatAmount(data.fee_amount) + ' ' + data.fee_tick));
        $('#info-attest .attest-gas-escrow').html(isNull(data.gas_escrow) ? '-' : formatAmount(data.gas_escrow));
        $('#info-attest .attest-callback').text(data.callback_method);
        $('#info-attest .attest-redundancy').text(data.redundancy);
        $('#info-attest .attest-deadline').html(isNull(data.deadline_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.deadline_block, numeral(data.deadline_block).format('0,0')));
        $('#info-attest .attest-request-status').text(data.request_status);
        let attestParams = isNull(data.callback_params) ? data.callback_params_json : data.callback_params;
        $('#info-attest .attest-payload').text(isNull(data.payload) ? '-' : String(data.payload));
        $('#info-attest .attest-callback-params').text(isNull(attestParams) ? '-' : (typeof attestParams === 'string' ? attestParams : JSON.stringify(attestParams)));
    }
    // Response-side fields
    $('#info-attest .attest-response-fields').toggleClass('d-none', !isResponse);
    if(isResponse){
        $('#info-attest .attest-response-status').text(data.response_status);
        $('#info-attest .attest-response-hash').html(formatHash(data.response_hash, 32));
        // Show the decoded body the response delivered, not only its hash: the detail query has
        // always selected attests.response_payload (action-detail/consensus.js) and nothing read
        // it, so the panel could not be compared against the hash beside it. Written
        // with .text() because the payload is validator-broadcast free text.
        $('#info-attest .attest-response-payload').text(isNull(data.response_payload) ? '-' : String(data.response_payload));
        $('#info-attest .attest-meta').text(isNull(data.meta) ? '-' : data.meta);
        let sigs = Array.isArray(data.signatures) ? data.signatures : [];
        $('#info-attest .attest-sig-count').text(sigs.length);
        let html = sigs.length ? sigs.map(s => formatHash(s.pubkey, 24)).join('<br>') : '-';
        $('#info-attest .attest-signatures').html(html);
        if(!isNull(data.callback_execute_action_index))
            $('#info-attest .attest-callback-execute').html(formatLink('/' + XC.coin + '/action/' + data.callback_execute_action_index, data.callback_execute_action_index));
    }
}

// Display VOTE action information. One action is exactly one of four kinds
// (data.vote_kind, set by the explorer): a v0 poll definition, a v1 ballot, a
// v3 standing delegation, or a v2 system-synthesized poll finalization. Show
// only the matching sub-section; for a poll, also fetch the frozen per-option
// tally (empty until the poll is finalized).
function showVoteDetails(data){
    let kind = data.vote_kind;
    $('#info-vote .vote-kind').html('<span class="badge text-bg-info">' + (kind || '-') + '</span>');
    $('#info-vote .vote-poll-fields').toggleClass('d-none', kind != 'poll');
    $('#info-vote .vote-ballot-fields').toggleClass('d-none', kind != 'ballot');
    $('#info-vote .vote-delegation-fields').toggleClass('d-none', kind != 'delegation');
    $('#info-vote .vote-finalize-fields').toggleClass('d-none', kind != 'finalize');
    if(kind=='finalize'){
        // v2 finalization: link the finalized poll (poll id IS its creating action_index),
        // show the frozen terminal status and winning option.
        $('#info-vote .vote-finalize-poll').html(isNull(data.poll_ref) ? '-' : formatLink('/' + XC.coin + '/action/' + data.poll_ref, data.poll_ref));
        let fst = data.poll_status;
        let fcls = (fst=='finalized') ? 'success' : (fst=='failed_quorum') ? 'danger' : 'secondary';
        $('#info-vote .vote-finalize-status').html(isNull(fst) ? '-' : '<span class="badge text-bg-' + fcls + '">' + fst + '</span>');
        let fopts = Array.isArray(data.options) ? data.options : [];
        let wo = data.winning_option;
        $('#info-vote .vote-finalize-winning').text(isNull(wo) ? '-' : (wo + (fopts[wo] != null ? ': ' + fopts[wo] : '')));
    }
    if(kind=='poll'){
        let pcls = (data.poll_status=='finalized') ? 'success' : (data.poll_status=='failed_quorum') ? 'danger' : 'warning text-dark';
        $('#info-vote .vote-token').html(isNull(data.tick) ? '-' : formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
        $('#info-vote .vote-question').text(isNull(data.question) ? '-' : data.question);
        let opts = Array.isArray(data.options) ? data.options : [];
        $('#info-vote .vote-options').html(opts.length ? opts.map((o, i) => i + ': ' + $('<div>').text(o).html()).join('<br>') : '-');
        $('#info-vote .vote-tally-mode').text(isNull(data.tally_mode) ? '-' : data.tally_mode);
        $('#info-vote .vote-weight-mode').text(isNull(data.weight_mode) ? '-' : data.weight_mode);
        $('#info-vote .vote-max-selections').text(isNull(data.max_selections) ? '-' : data.max_selections);
        $('#info-vote .vote-end-block').html(isNull(data.end_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.end_block, numeral(data.end_block).format('0,0')));
        $('#info-vote .vote-quorum').text(isNull(data.quorum) ? '-' : data.quorum);
        $('#info-vote .vote-min-voters').text(isNull(data.min_voters) ? '-' : data.min_voters);
        // The two remaining gate parameters (polls.sql): min_vote_balance is the dust
        // floor a holder must clear to count toward min_voters, decide_threshold the
        // supply fraction that arms an early decide. Both are inputs the quorum verdict
        // below is judged against, so the verdict is uncheckable without them.
        $('#info-vote .vote-min-vote-balance').text(isNull(data.min_vote_balance) ? '-' : formatAmount(data.min_vote_balance));
        $('#info-vote .vote-decide-threshold').text(isNull(data.decide_threshold) ? '-' : data.decide_threshold);
        $('#info-vote .vote-poll-status').html('<span class="badge text-bg-' + pcls + '">' + (data.poll_status || '-') + '</span>');
        $('#info-vote .vote-winning-option').text(isNull(data.winning_option) ? '-' : data.winning_option);
        // Frozen finalization detail. VOTE v2 measures the turnout and freezes it into
        // the polls row (indexer finalizePoll) precisely so a terminal outcome stays
        // auditable; the detail query has always selected it and nothing rendered it,
        // so a poll badged 'failed_quorum' above named no gate and showed no turnout.
        // Null until v2 lands, which is why an open poll dashes rather than reading 'no':
        // TINYINT 0 is a measured miss, absent is not a measurement.
        let yesNo = function(v){ return isNull(v) ? '-' : (Number(v) ? 'yes' : 'no'); };
        $('#info-vote .vote-quorum-met').text(yesNo(data.quorum_met));
        $('#info-vote .vote-min-voters-met').text(yesNo(data.min_voters_met));
        $('#info-vote .vote-total-weight').text(isNull(data.total_weight) ? '-' : formatAmount(data.total_weight));
        $('#info-vote .vote-total-voters').text(isNull(data.total_voters) ? '-' : numeral(data.total_voters).format('0,0'));
        // fail_reason is the ENUM('quorum','min_voters','both') v2 stamps on a failure
        // and leaves null on a pass, so '-' reads as "no gate failed" rather than unknown.
        $('#info-vote .vote-fail-reason').text(isNull(data.fail_reason) ? '-' : data.fail_reason);
        $('#info-vote .vote-decided-early').text(yesNo(data.decided_early));
        // effective_close_block is the block weights were MEASURED at, which is end_block
        // on a normal close and the crossing block on an early decide, so it is the one
        // that explains the tally; resolved_block is when finalization went terminal.
        $('#info-vote .vote-effective-close-block').html(isNull(data.effective_close_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.effective_close_block, numeral(data.effective_close_block).format('0,0')));
        $('#info-vote .vote-resolved-block').html(isNull(data.resolved_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.resolved_block, numeral(data.resolved_block).format('0,0')));
        $('#info-vote .vote-finalized-by').html(isNull(data.finalized_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.finalized_action_index, data.finalized_action_index));
        $('#info-vote .vote-deposit').html(isNull(data.deposit_amount) ? '-' : formatAmount(data.deposit_amount));
        // Creation-deposit lifecycle: the refund target, and the ENUM('refunded',
        // 'forfeited') outcome v2 stamps once the escrow is released. Rendered as the
        // enum, never as a boolean - a forfeited deposit is not a "yes".
        $('#info-vote .vote-deposit-address').html(isNull(data.deposit_address) ? '-' : formatLink('/' + XC.coin + '/address/' + data.deposit_address, data.deposit_address));
        $('#info-vote .vote-deposit-resolved').text(isNull(data.deposit_resolved) ? '-' : data.deposit_resolved);
        // Binding poll: v2 finalize fires callback_method on the callback contract.
        if(!isNull(data.callback_contract_index))
            $('#info-vote .vote-callback').html(formatLink('/' + XC.coin + '/contract/' + data.callback_contract_index, data.callback_contract_index) + (isNull(data.callback_method) ? '' : '.' + data.callback_method));
        else
            $('#info-vote .vote-callback').text('-');
        // PC-42 timelock (callback_delay_blocks) and the EXECUTE the callback actually
        // fired (callback_execute_action_index). Both are selected by the VOTE detail
        // query and were rendered nowhere, so a binding poll whose callback had already
        // run showed no sign of it. Poll branch only: the v2 finalize action writes no
        // polls row of its own, so its LEFT JOIN misses and both fields are null there
        // (action-detail/governance.js) - a finalize row would be a permanent '-'.
        $('#info-vote .vote-callback-delay').text(isNull(data.callback_delay_blocks) ? '-' : data.callback_delay_blocks);
        if(!isNull(data.callback_execute_action_index))
            $('#info-vote .vote-callback-execute').html(formatLink('/' + XC.coin + '/action/' + data.callback_execute_action_index, data.callback_execute_action_index));
        else
            $('#info-vote .vote-callback-execute').text('-');
        // The rest of the binding-poll contract: callback_on is ENUM('pass','always')
        // (fire only on a finalized win, or on every finalization) and gas_escrow backs
        // the injected EXECUTE. callback_params is developer-supplied on-chain JSON that
        // afterMain has already parsed, so it is rendered as inert text through .text()
        // and never through an HTML sink.
        $('#info-vote .vote-callback-on').text(isNull(data.callback_on) ? '-' : data.callback_on);
        $('#info-vote .vote-callback-params').text(isNull(data.callback_params) ? '-' :
            (typeof data.callback_params === 'string' ? data.callback_params : JSON.stringify(data.callback_params)));
        $('#info-vote .vote-gas-escrow').text(isNull(data.gas_escrow) ? '-' : formatAmount(data.gas_escrow));
        // Frozen per-option tally (poll_results). Empty until VOTE v2 finalizes.
        $.getJSON('/' + XC.coin + '/api/poll/' + data.action_index + '/results', function(res){
            let rows = (res && res.data) ? res.data : [];
            if(rows.length){
                let html = '<table class="table table-sm mb-0"><thead><tr><th>Option</th><th>Weight</th><th>Voters</th></tr></thead><tbody>';
                rows.forEach(function(r){
                    let label = opts[r.option_index];
                    let name  = isNull(label) ? r.option_index : (r.option_index + ': ' + $('<div>').text(label).html());
                    html += '<tr><td>' + name + '</td><td>' + formatAmount(r.total_weight) + '</td><td>' + numeral(r.voter_count).format('0,0') + '</td></tr>';
                });
                html += '</tbody></table>';
                $('#info-vote .vote-results').html(html);
            } else {
                $('#info-vote .vote-results').text(data.poll_status=='open' ? 'Voting open (not yet finalized)' : 'No results');
            }
        });
    }
    if(kind=='ballot'){
        $('#info-vote .vote-poll-ref').html(isNull(data.poll_ref) ? '-' : formatLink('/' + XC.coin + '/action/' + data.poll_ref, data.poll_ref));
        let ballot = Array.isArray(data.ballot) ? data.ballot : [];
        $('#info-vote .vote-choices').html(ballot.length ? ballot.map(b => 'option ' + b.choice + (isNull(b.share) ? '' : ' (share ' + b.share + ')')).join('<br>') : '-');
        $('#info-vote .vote-memo').text(isNull(data.memo) ? '-' : data.memo);
    }
    if(kind=='delegation'){
        $('#info-vote .vote-deleg-token').html(isNull(data.delegation_tick) ? '-' : formatLink('/' + XC.coin + '/token/' + data.delegation_tick, data.delegation_tick, data.delegation_tick));
        $('#info-vote .vote-delegator').html(isNull(data.delegator) ? '-' : formatLink('/' + XC.coin + '/address/' + data.delegator, data.delegator));
        // delegate_to NULL is a CLEAR (revoke) of any standing delegation.
        $('#info-vote .vote-delegate-to').html(isNull(data.delegate_to) ? '<span class="badge text-bg-secondary">cleared</span>' : formatLink('/' + XC.coin + '/address/' + data.delegate_to, data.delegate_to));
    }
}

// Display BET action information: one action name over four formats, so branch on
// bet_kind (set server-side in getActionData). 'feed' is format 0 market creation,
// 'bet' format 2 wager, 'cancel'/'resolve' the row-less formats 1/3.

// RENDERING SAFETY (§11.1): LABEL, OUTCOMES and DETAILS are attacker-controlled
// on-chain bytes. Everything derived from them goes through .text() or the
// $('<div>').text(x).html() escape, DETAILS is shown strictly as inert data, and no
// URL found inside it is ever fetched or turned into a link (SSRF-guard stance).
function showBetDetails(data){
    let kind = data.bet_kind;
    let esc  = function(s){ return $('<div>').text(s == null ? '' : String(s)).html(); };
    $('#info-bet .bet-kind').html('<span class="badge text-bg-info">' + esc(kind || '-') + '</span>');
    $('#info-bet .bet-feed-fields').toggleClass('d-none', kind != 'feed');
    $('#info-bet .bet-wager-fields').toggleClass('d-none', kind != 'bet');
    $('#info-bet .bet-action-fields').toggleClass('d-none', kind != 'cancel' && kind != 'resolve');

    // Feed lifecycle badge colouring shared by the feed and cancel/resolve shapes.
    let statusClass = function(s){
        if(s=='resolved')                      return 'success';
        if(s=='cancelled' || s=='expired')     return 'danger';
        if(s=='resolved_void')                 return 'secondary';
        if(s=='closed')                        return 'warning text-dark';
        return 'primary';
    };

    if(kind=='feed'){
        $('#info-bet .bet-label').text(isNull(data.label) ? '-' : data.label);
        let outs = Array.isArray(data.outcome_labels) ? data.outcome_labels : [];
        $('#info-bet .bet-outcomes').html(outs.length ? outs.map((o, i) => i + ': ' + esc(o)).join('<br>') : '-');
        $('#info-bet .bet-token').html(isNull(data.tick) ? '-' : formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
        // FEE is the ORACLE's percent cut of the pot, NOT the protocol's market
        // duration fee. Label it so the two are never confused (§10 naming pin).
        // Read it from the aliased column (bet_fee): db.js getActionData overwrites the
        // reserved `fee` slot with the protocol-fee RECORD, so this printed
        // '[object Object]% of the pot' (#3932, same collision as broadcast_fee).
        $('#info-bet .bet-fee').text(isNull(data.bet_fee) ? '-' : data.bet_fee + '% of the pot (oracle fee)');
        $('#info-bet .bet-deadline').html(isNull(data.deadline) ? '-' : data.deadline + ' - ' + formatLivestamp(data.deadline) + ' (' + moment.unix(data.deadline).utcOffset(0).format() + ' GMT)');
        $('#info-bet .bet-refund-window').text(isNull(data.refund_window) ? '-' : numeral(data.refund_window).format('0,0') + ' seconds');
        $('#info-bet .bet-expire-at').html(isNull(data.expire_at) ? '-' : data.expire_at + ' - ' + formatLivestamp(data.expire_at) + ' (' + moment.unix(data.expire_at).utcOffset(0).format() + ' GMT)');
        $('#info-bet .bet-min-amount').html(isNull(data.min_amount) ? '<span class="text-muted">none</span>' : formatAmount(data.min_amount));
        $('#info-bet .bet-allow-list').html(isNull(data.allow_list) ? '-' : formatLink('/' + XC.coin + '/action/' + data.allow_list, data.allow_list));
        $('#info-bet .bet-block-list').html(isNull(data.block_list) ? '-' : formatLink('/' + XC.coin + '/action/' + data.block_list, data.block_list));
        let fs = data.feed_status;
        $('#info-bet .bet-feed-status').html(isNull(fs) ? '-' : '<span class="badge text-bg-' + statusClass(fs) + '">' + esc(fs) + '</span>');

        // DETAILS: render as inert, escaped text. Never as markup, and never fetched.
        if(isNull(data.details)){
            $('#info-bet .bet-details').text('-');
        } else if(data.details_json != null){
            $('#info-bet .bet-details').html('<pre class="mb-0 small">' + esc(JSON.stringify(data.details_json, null, 2)) + '</pre>');
        } else {
            $('#info-bet .bet-details').html('<span class="text-muted">unparsed base64 payload</span><pre class="mb-0 small">' + esc(data.details) + '</pre>');
        }

        // Live per-outcome pools (open bets only, the normative settlement predicate).
        $.getJSON('/' + XC.coin + '/api/bet_feed/' + data.action_index, function(res){
            let feed  = (res && res.data) ? (Array.isArray(res.data) ? res.data[0] : res.data) : null;
            let pools = (feed && Array.isArray(feed.pools)) ? feed.pools : [];
            if(!pools.length){ $('#info-bet .bet-pools').text('No open bets'); return; }
            let total = pools.reduce((a, p) => a + Number(p.pool || 0), 0);
            let html  = '<table class="table table-sm mb-0"><thead><tr><th>Outcome</th><th>Pool</th><th>Bets</th><th>Implied</th></tr></thead><tbody>';
            pools.forEach(function(p){
                let label = outs[p.outcome];
                let name  = (label == null) ? String(p.outcome) : (p.outcome + ': ' + esc(label));
                // Implied probability from the parimutuel split. Odds are NOT fixed at
                // bet time; this is the split as it stands right now.
                let pct   = total > 0 ? ((Number(p.pool || 0) / total) * 100).toFixed(1) + '%' : '-';
                html += '<tr><td>' + name + '</td><td>' + formatAmount(p.pool) + '</td><td>' + numeral(p.bet_count).format('0,0') + '</td><td>' + pct + '</td></tr>';
            });
            html += '</tbody></table><div class="small text-muted mt-1">Parimutuel: the split shown is current, not the odds locked at bet time.</div>';
            $('#info-bet .bet-pools').html(html);
        });
    }

    if(kind=='bet'){
        $('#info-bet .bet-feed-ref').html(isNull(data.feed_ref) ? '-' : formatLink('/' + XC.coin + '/action/' + data.feed_ref, data.feed_ref));
        $('#info-bet .bet-outcome').text(isNull(data.outcome) ? '-' : data.outcome);
        $('#info-bet .bet-amount').html(isNull(data.amount) ? '-' : formatAmount(data.amount));
        let bs   = data.bet_status;
        let bcls = (bs=='won') ? 'success' : (bs=='lost') ? 'danger' : (bs=='refunded') ? 'secondary' : 'primary';
        $('#info-bet .bet-status').html(isNull(bs) ? '-' : '<span class="badge text-bg-' + bcls + '">' + esc(bs) + '</span>');
        $('#info-bet .bet-settled-block').html(isNull(data.settled_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.settled_block, numeral(data.settled_block).format('0,0')));
    }

    if(kind=='cancel' || kind=='resolve'){
        $('#info-bet .bet-action-feed-ref').html(isNull(data.feed_ref) ? '-' : formatLink('/' + XC.coin + '/action/' + data.feed_ref, data.feed_ref));
        let fs = data.feed_status;
        $('#info-bet .bet-action-status').html(isNull(fs) ? '-' : '<span class="badge text-bg-' + statusClass(fs) + '">' + esc(fs) + '</span>');
    }
}

// Display BET_EXPIRE action information (feed passed expire_at unresolved, so
// every open bet is refunded in full and the oracle takes no cut)
function showBetExpireDetails(data){
    let esc = function(s){ return $('<div>').text(s == null ? '' : String(s)).html(); };
    $('#info-bet-expire .bet-expire-feed').html(isNull(data.feed_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.feed_action_index, numeral(data.feed_action_index).format('0,0')));
    $('#info-bet-expire .bet-expire-label').text(isNull(data.label) ? '-' : data.label);
    $('#info-bet-expire .bet-expire-token').html(isNull(data.tick) ? '-' : formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    $('#info-bet-expire .bet-expire-deadline').html(isNull(data.deadline) ? '-' : data.deadline + ' - ' + formatLivestamp(data.deadline) + ' (' + moment.unix(data.deadline).utcOffset(0).format() + ' GMT)');
    $('#info-bet-expire .bet-expire-refund-window').text(isNull(data.refund_window) ? '-' : numeral(data.refund_window).format('0,0') + ' seconds');
    $('#info-bet-expire .bet-expire-expire-at').html(isNull(data.expire_at) ? '-' : data.expire_at + ' - ' + formatLivestamp(data.expire_at) + ' (' + moment.unix(data.expire_at).utcOffset(0).format() + ' GMT)');
    // Refund tally. Zero is a real answer (every bet had already left 'open' by
    // another path), so print the count rather than dashing it out.
    $('#info-bet-expire .bet-expire-refund-count').text(isNull(data.refund_count) ? '-' : numeral(data.refund_count).format('0,0'));
    $('#info-bet-expire .bet-expire-refund-amount').html(isNull(data.refund_amount) ? '-' : formatAmount(data.refund_amount));
    let fs = data.feed_status;
    $('#info-bet-expire .bet-expire-feed-status').html(isNull(fs) ? '-' : '<span class="badge text-bg-' + ((fs=='expired') ? 'danger' : 'primary') + '">' + esc(fs) + '</span>');
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
    // ROLLCALL eviction (action_format 3): the protocol removed this validator for
    // missing liveness, the holder never broadcast anything. A user CAN broadcast a
    // format-3 UNSTAKE, but the indexer rejects it as invalid, so requiring status
    // 'valid' alongside the format keeps a rejected broadcast from reading as an
    // eviction that never happened.
    let isEviction = (Number(data.action_format) === 3 && data.status === 'valid');
    $('#info-unstake .unstake-pubkey').html(formatHash(data.signing_pubkey, 24));
    $('#info-unstake .unstake-amount').html(
        (isEviction ? '<span class="badge text-bg-danger me-2">Evicted</span>' : '') + formatAmount(data.amount));
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
    // Stake-key revoke variant: the indexer writes only a stake_key_revocations row (no
    // delegations/contract_delegations row), so signing_pubkey COALESCEs to NULL and the
    // pubkey/deactivation arrive under the revoked_pubkey/revocation_deactivation_block aliases.
    let isRevoke = isNull(data.signing_pubkey) && !isNull(data.revoked_pubkey);
    let pubkey = isNull(data.signing_pubkey) ? data.revoked_pubkey : data.signing_pubkey;
    let deactivation = isNull(data.deactivation_block) ? data.revocation_deactivation_block : data.deactivation_block;
    $('#info-delegate .delegate-pubkey').html(isNull(pubkey) ? '-' : formatHash(pubkey, 24));
    $('#info-delegate .delegate-revoke-row').toggleClass('d-none', !isRevoke);
    if(isRevoke)
        $('#info-delegate .delegate-revoked').html('<span class="badge text-bg-warning text-dark">Stake-key revocation</span>');
    $('#info-delegate .delegate-contract-row').toggleClass('d-none', !isContract);
    if(isContract){
        $('#info-delegate .delegate-contract').html(formatLink('/' + XC.coin + '/contract/' + data.target_contract_index, data.target_contract_index));
        $('#info-delegate .delegate-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    }
    if(!isNull(data.activation_block))
        $('#info-delegate .delegate-activation').html(formatLink('/' + XC.coin + '/block/' + data.activation_block, numeral(data.activation_block).format('0,0')));
    $('#info-delegate .delegate-deactivation').html(isNull(deactivation) ? '-' : formatLink('/' + XC.coin + '/block/' + deactivation, numeral(deactivation).format('0,0')));
}

// Display COLLECT action information (validator reward claim)
function showCollectDetails(data){
    $('#info-collect .collect-amount').html(formatAmount(data.amount));
}

// Display SLASH action information (capability equivocation bond-burn)
function showSlashDetails(data){
    $('#info-slash .slash-pubkey').html(formatHash(data.slashed_pubkey, 24));
    $('#info-slash .slash-capability').html(isNull(data.capability) ? '-' : '<span class="badge text-bg-secondary">' + data.capability + '</span>');
    $('#info-slash .slash-equiv-key').text(isNull(data.equiv_key) ? '-' : data.equiv_key);
    $('#info-slash .slash-amount').html(formatAmount(data.amount));
    $('#info-slash .slash-bounty').html(formatAmount(data.bounty_amount));
    $('#info-slash .slash-treasury').html(formatAmount(data.treasury_amount));
    $('#info-slash .slash-submitter').html(isNull(data.submitter) ? '-' : formatLink('/' + XC.coin + '/address/' + data.submitter, data.submitter));
    $('#info-slash .slash-destination').html(isNull(data.destination) ? '-' : formatLink('/' + XC.coin + '/address/' + data.destination, data.destination));
}

// Display DEPLOY action information (contract; v1 surfaces staking metadata)
function showDeployDetails(data){
    // DEPLOY v4 (action_format 4) is a chunk carrier: one base64 code slice in deploy_chunks,
    // NOT a contract. It has no contract row, api_version, cooldown or slash_destination, so
    // rendering the contract shape would produce a dead /contract/ link and blank fields.
    let isChunk = (Number(data.action_format) === 4);
    $('#info-deploy .deploy-contract-row').toggleClass('d-none', isChunk);
    $('#info-deploy .deploy-chunk-row').toggleClass('d-none', !isChunk);
    $('#info-deploy .deploy-code-hash').html(formatHash(data.code_hash, 32));
    if(isChunk){
        let idx = isNull(data.chunk_index) ? '?' : (Number(data.chunk_index) + 1);
        let total = isNull(data.total_chunks) ? '?' : data.total_chunks;
        $('#info-deploy .deploy-chunk').text('Code chunk ' + idx + ' of ' + total);
        // The base64 code slice is the payload this carrier exists to publish, and it
        // was the one v4 wire field with nowhere to render. Shown truncated with its
        // full length: a part runs to a MEDIUMTEXT of code, and this row is a summary
        // of the chunk, not a code viewer (the assembled source lives on /contract/).
        let part = isNull(data.code_part) ? '' : String(data.code_part);
        $('#info-deploy .deploy-code-part').text(part.length > 96
            ? part.slice(0, 96) + '… (' + numeral(part.length).format('0,0') + ' chars)'
            : part);
        return;
    }
    $('#info-deploy .deploy-contract').html(formatLink('/' + XC.coin + '/contract/' + data.action_index, data.action_index));
    $('#info-deploy .deploy-api-version').text(data.api_version);
    let stakeable = !isNull(data.cooldown_blocks);
    $('#info-deploy .deploy-stakeable').html(stakeable ? '<span class="badge text-bg-info text-white">Stakeable</span>' : 'No');
    $('#info-deploy .deploy-staking-row').toggleClass('d-none', !stakeable);
    if(stakeable){
        $('#info-deploy .deploy-cooldown').text(numeral(data.cooldown_blocks).format('0,0') + ' blocks');
        $('#info-deploy .deploy-slash').html(isNull(data.slash_destination) ? 'BURN' : formatLink('/' + XC.coin + '/address/' + data.slash_destination, data.slash_destination));
    }
    // A DEPLOY runs the contract's constructor, and that gas is recorded on the
    // contract_executions row rather than as a protocol fee row, so a deployer's
    // cost is invisible in the Fee tab and has to render here instead.
    let hasGas = !isNull(data.gas_used);
    $('#info-deploy .deploy-execution-row').toggleClass('d-none', !hasGas);
    if(hasGas){
        $('#info-deploy .deploy-method').text(isNull(data.method_name) ? '-' : data.method_name);
        $('#info-deploy .deploy-gas').text(numeral(data.gas_used).format('0,0') +
            (isNull(data.gas_limit) ? '' : ' / ' + numeral(data.gas_limit).format('0,0')));
    }
}

// Display EXECUTE action information (contract method call)
function showExecuteDetails(data){
    $('#info-execute .execute-contract').html(formatLink('/' + XC.coin + '/contract/' + data.contract_index, data.contract_index));
    $('#info-execute .execute-caller').html(formatLink('/' + XC.coin + '/address/' + data.caller, data.caller));
    $('#info-execute .execute-method').text(data.method_name);
    $('#info-execute .execute-gas').text(numeral(data.gas_used).format('0,0') + ' / ' + numeral(data.gas_limit).format('0,0'));
    $('#info-execute .execute-emitted').text(data.emitted_count);
    // Emitted-children drill-down: list the actions this EXECUTE emitted (emit.execute /
    // emit.send / internal SLASH …) in emission order. Each child links by action_index;
    // internal emissions that move ledger state without minting an on-wire action (e.g. SLASH)
    // have a null action_index and render as "internal".
    let emissions = Array.isArray(data.emissions) ? data.emissions : [];
    if(emissions.length){
        let rows = '';
        emissions.forEach(function(e, idx){
            let child = isNull(e.action_index)
                ? '<span class="text-muted">internal</span>'
                : formatLink('/' + XC.coin + '/action/' + e.action_index, e.action_index);
            rows += '<tr><td class="text-center">' + (idx+1) + '</td><td>' + e.emitted_action + '</td><td>' + child + '</td></tr>';
        });
        let table = '<table class="table table-sm mb-0">'
            + '<thead><tr><th class="text-center">#</th><th>Action</th><th>Emitted</th></tr></thead>'
            + '<tbody>' + rows + '</tbody></table>';
        $('#info-execute .execute-emissions').html(table);
        $('#execute-emissions-row').removeClass('d-none');
    } else {
        $('#info-execute .execute-emissions').empty();
        $('#execute-emissions-row').addClass('d-none');
    }
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

// Display XCALL action information (cross-chain call request v0 / expire v2, VM-emitted,
// read-only). Surfaces the request plus, when present, the target-chain execution outcome
// and the source-chain callback delivery.
function showXcallDetails(data){
    let statusBadge = function(s){
        let cls = (s=='completed') ? 'success' : (s=='expired') ? 'danger' : (s=='pending') ? 'warning text-dark' : 'secondary';
        return '<span class="badge text-bg-' + cls + '">' + (s || '-') + '</span>';
    };
    $('#info-xcall .xcall-call-id').html(formatHash(data.call_id, 32));
    // Version badge: v0 is the cross-chain call request, v1 the result-delivery marker
    // (its data living in cross_chain_call_callbacks, surfaced as callback_delivery
    // below), v2 the expire. All three need a branch; v1 has no request row of its own.
    let xcallV = Number(data.version);
    $('#info-xcall .xcall-version').html(
        xcallV === 2 ? '<span class="badge text-bg-secondary">Expire (v2)</span>' :
        xcallV === 1 ? '<span class="badge text-bg-info">Result delivery (v1)</span>' :
                       '<span class="badge text-bg-primary">Request (v0)</span>');
    $('#info-xcall .xcall-contract').html(isNull(data.contract_index) ? '-' : formatLink('/' + XC.coin + '/contract/' + data.contract_index, data.contract_index));
    $('#info-xcall .xcall-target-chain').text(isNull(data.target_chain) ? '-' : data.target_chain);
    $('#info-xcall .xcall-target-contract').text(isNull(data.target_contract_index) ? '-' : data.target_contract_index);
    $('#info-xcall .xcall-method').text(isNull(data.method) ? '-' : data.method);
    $('#info-xcall .xcall-params').text(Array.isArray(data.params) ? JSON.stringify(data.params) : (isNull(data.params) ? '-' : String(data.params)));
    $('#info-xcall .xcall-gas-limit').text(isNull(data.gas_limit) ? '-' : numeral(data.gas_limit).format('0,0'));
    $('#info-xcall .xcall-cross-hops').text(isNull(data.cross_hops) ? '-' : data.cross_hops);
    $('#info-xcall .xcall-callback-method').text(isNull(data.callback_method) ? '-' : data.callback_method);
    $('#info-xcall .xcall-deadline').html(isNull(data.deadline_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.deadline_block, numeral(data.deadline_block).format('0,0')));
    $('#info-xcall .xcall-request-status').html(statusBadge(data.request_status));
    // The outcome as RECORDED ON THIS CHAIN (xcalls.result_status / result_payload /
    // resolved_block), not a duplicate of the execution block below: the indexer writes
    // these three when it flips the request terminal, and they are what the VM's
    // xchain.crossChain.getCallResult reads, so this is the value a contract sees.
    // Hidden as a group while the call is pending, none of the three being set then.
    let resolved = !isNull(data.result_status) || !isNull(data.resolved_block);
    $('#info-xcall .xcall-resolved-row').toggleClass('d-none', !resolved);
    if(resolved){
        // Plain text, like the execution's own Result Status: these values are
        // delivered result codes, not the request lifecycle the badge colours.
        $('#info-xcall .xcall-recorded-status').text(isNull(data.result_status) ? '-' : data.result_status);
        $('#info-xcall .xcall-recorded-payload').html(isNull(data.result_payload) ? '-' : formatHash(data.result_payload, 32));
        $('#info-xcall .xcall-resolved-block').html(isNull(data.resolved_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.resolved_block, numeral(data.resolved_block).format('0,0')));
    }
    // Target-chain execution outcome (present once the call has executed on the far chain).
    let exec = data.execution || null;
    $('#info-xcall .xcall-execution-row').toggleClass('d-none', !exec);
    if(exec){
        // Namespace the executed action by the TARGET chain: action indexes are chain-local and
        // this one was minted by XEXEC on the far chain, so XC.coin pointed the link at whatever
        // unrelated action shares that index here. The callback link below keeps
        // XC.coin because the callback is delivered back on this chain. Fall back to the page
        // coin only if target_chain is missing.
        let exec_coin = data.target_chain || XC.coin;
        $('#info-xcall .xcall-execute-action').html(isNull(exec.execute_action_index) ? '-' : formatLink('/' + exec_coin + '/action/' + exec.execute_action_index, exec.execute_action_index));
        $('#info-xcall .xcall-result-status').text(isNull(exec.result_status) ? '-' : exec.result_status);
        $('#info-xcall .xcall-return-payload').html(isNull(exec.return_payload_b64) ? '-' : formatHash(exec.return_payload_b64, 32));
        $('#info-xcall .xcall-gas-used').text(isNull(exec.gas_used) ? '-' : numeral(exec.gas_used).format('0,0'));
    }
    // Source-chain callback delivery (present once the result has been delivered back).
    let cb = data.callback_delivery || null;
    $('#info-xcall .xcall-callback-row').toggleClass('d-none', !cb);
    if(cb){
        $('#info-xcall .xcall-callback-result').text(isNull(cb.callback_result_status) ? '-' : cb.callback_result_status);
        $('#info-xcall .xcall-callback-action').html(isNull(data.callback_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.callback_action_index, data.callback_action_index));
    }
}

// Display XEXEC action information (mirror-injected cross-chain call execution:
// the outcome of running a quorum-signed cross-chain dispatch on this chain).
function showXexecDetails(data){
    $('#info-xexec .xexec-call-id').html(isNull(data.call_id) ? '-' : formatHash(data.call_id, 32));
    $('#info-xexec .xexec-execute-action').html(isNull(data.execute_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.execute_action_index, data.execute_action_index));
    $('#info-xexec .xexec-result-status').text(isNull(data.result_status) ? '-' : data.result_status);
    $('#info-xexec .xexec-gas-used').text(isNull(data.gas_used) ? '-' : numeral(data.gas_used).format('0,0'));
    $('#info-xexec .xexec-return-payload').html(isNull(data.return_payload_b64) ? '-' : formatHash(data.return_payload_b64, 32));
    $('#info-xexec .xexec-block').html(isNull(data.block_index) ? '-' : formatLink('/' + XC.coin + '/block/' + data.block_index, numeral(data.block_index).format('0,0')));
}

// Display CROSS_SETTLE action information (mirror-injected cross-chain DEX
// settlement leg: the release of a local ORDER/SWAP against a signed match).
function showCrossSettleDetails(data){
    $('#info-cross-settle .cross-settle-match-id').html(isNull(data.match_id) ? '-' : formatHash(data.match_id, 32));
    $('#info-cross-settle .cross-settle-local-action').html(isNull(data.local_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.local_action_index, data.local_action_index));
    $('#info-cross-settle .cross-settle-a-chain').text(isNull(data.a_chain) ? '-' : data.a_chain);
    $('#info-cross-settle .cross-settle-a-action').text(isNull(data.a_action_index) ? '-' : data.a_action_index);
    $('#info-cross-settle .cross-settle-b-chain').text(isNull(data.b_chain) ? '-' : data.b_chain);
    $('#info-cross-settle .cross-settle-b-action').text(isNull(data.b_action_index) ? '-' : data.b_action_index);
    $('#info-cross-settle .cross-settle-block').html(isNull(data.block_index) ? '-' : formatLink('/' + XC.coin + '/block/' + data.block_index, numeral(data.block_index).format('0,0')));
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
    $('#info-issue .issue-lock-max-mint').text(data.lock_max_mint);
    $('#info-issue .issue-lock-mint').text(data.lock_mint);
    $('#info-issue .issue-lock-mint-supply').text(data.lock_mint_supply);
    $('#info-issue .issue-lock-description').text(data.lock_description);
    $('#info-issue .issue-lock-sleep').text(data.lock_sleep);
    $('#info-issue .issue-lock-callback').text(data.lock_callback);
    // ISSUE v6 binds (or unbinds) a guard contract as the token's controller for one
    // action class. Those four wire fields are null on every other ISSUE format, so
    // the card is shown only for format 6 rather than adding four blank rows to the
    // v0-v5 shape; without it a v6 action page had nothing binding-specific at all.
    let isController = (Number(data.action_format) === 6);
    $('#info-issue .issue-controller-card').toggleClass('d-none', !isController);
    if(isController){
        $('#info-issue .issue-controller').html(isNull(data.controller) ? '-' :
            formatLink('/' + XC.coin + '/contract/' + data.controller, data.controller));
        $('#info-issue .issue-action-class').text(isNull(data.action_class) ? '-' : data.action_class);
        $('#info-issue .issue-cooldown-blocks').text(isNull(data.cooldown_blocks) ? '-' :
            numeral(data.cooldown_blocks).format('0,0') + ' blocks');
        // Bind and unbind are the same wire format and differ only in this flag, so it
        // is rendered as the row's headline rather than a bare 0/1.
        $('#info-issue .issue-unbind').html(Number(data.unbind) === 1
            ? '<span class="badge text-bg-warning text-dark">Unbind</span>'
            : '<span class="badge text-bg-info text-white">Bind</span>');
    }
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
    $('#info-list .list-memo').text((data.memo == null) ? '' : data.memo);
    // Add header columns
    $('#datatable-list-items thead').html('<tr><th class="record" width="155">#</th><th>' + list_type + '</th></tr>');
    $('#datatable-list-edits thead').html('<tr><th class="record" width="155">#</th><th>' + list_type + '</th><th>Status</th></tr>');
    showActionDatatable('list-edits', data.edits, list_type, false);
    // `list` is what THIS action wrote; edits land under their own action
    // index, so on a create with later edits it is a create-time snapshot. Show
    // current membership (state.current_list) whenever the chain resolves the edit
    // chain, and name the action that set it, because consumers pin a list by its
    // CREATE index and this is the page a market's "who may bet" link lands on.
    let state   = data.state || {};
    let current = (state.edit_resolution_active && Array.isArray(state.current_list)) ? state.current_list : null;
    let head    = state.membership_action_index;
    let edited  = current && isNumeric(head) && Number(head) !== Number(data.action_index);
    $('#info-list .list-membership-row').toggleClass('d-none', !edited);
    if(edited)
        $('#info-list .list-membership-action-index').html(formatLink('/' + XC.coin + '/action/' + head, formatAmount(head)));
    $('#list-items-tab').html('<i class="fa fa-lg fa-list"></i> ' + (current ? 'Current List' : 'Full List'));
    showActionDatatable('list-items', current || data.list, list_type, false);

}

// Display MESSAGE action information
function showMessageDetails(data){
    let encryption_method = (XC.encryption_methods[data.encryption_method]) ? (data.encryption_method + ' - ' + XC.encryption_methods[data.encryption_method]) : '';
    $('#info-message .message-method').text(encryption_method);
    $('#info-message .message-key').text(data.encryption_key);
    $('#info-message .message-plaintext').text(data.plaintext_message);
    $('#info-message .message-encrypted').text(data.encrypted_message);
    // Link the destination on ITS own chain (messages.coin), not the broadcast chain.
    $('#info-message .message-destination').html(formatLink('/' + (data.coin || XC.coin) + '/address/' + data.destination, data.destination));
}

// Display MINT action information
function showMintDetails(data){
    $('#info-mint .mint-tick').html(formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    $('#info-mint .mint-amount').html(formatAmount(data.amount));
    $('#info-mint .mint-destination').html(formatLink('/' + XC.coin + '/address/' + data.destination, data.destination));
    $('#info-mint .mint-memo').text(data.memo);
}

// Display ORDER action information
// Map an offer lifecycle status (ORDER, SWAP, DISPENSER) to a badge colour.
// Separate from the bet renderer's lookalike, whose vocabulary is a market's.
// cancelling/expiring are still in flight, so they warn rather than fail.
function offerStatusClass(status){
    if(status=='complete')                       return 'success';
    if(status=='cancelled' || status=='expired') return 'danger';
    if(status=='cancelling' || status=='expiring') return 'warning text-dark';
    return 'primary';
}

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
    // Render the ORDER's lifecycle status; the Action Status row above is the
    // action's parse validity and reads valid for a filled order and an open one
    // alike. Dashed when absent so a missing status stays visible.
    $('#info-order .order-state-status').html(
        isNull(data.state.status)
            ? '-'
            : '<span class="badge text-bg-' + offerStatusClass(data.state.status) + '">' + escapeHtml(data.state.status) + '</span>'
    );
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
    $('#info-order-match .order-match-settlement-type').text(isNull(data.settlement_type) ? '-' : data.settlement_type);
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

// Display COINPAY action information (native-coin settlement payment for an
// obligation). coin_amount/vout name the specific output that paid THIS
// obligation: when one transaction pays more than one obligation, they no
// longer default to the transaction's first output (mainnet not yet armed;
// testnet/regtest already this way). Labels stay as-is since "Coin Amount" /
// "Vout" remain accurate names either way - see components/indexer/database.md.
function showCoinpayDetails(data){
    $('#info-coinpay .coinpay-obligation').html(isNull(data.obligation_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.obligation_action_index, numeral(data.obligation_action_index).format('0,0')));
    $('#info-coinpay .coinpay-coin-amount').html(isNull(data.coin_amount) ? '-' : formatAmount(data.coin_amount));
    $('#info-coinpay .coinpay-txid').html(isNull(data.txid) ? '-' : formatHash(data.txid, 32));
    $('#info-coinpay .coinpay-vout').text(isNull(data.vout) ? '-' : data.vout);
    $('#info-coinpay .coinpay-status').text(isNull(data.status) ? '-' : data.status);
}

// Display COINPAY_EXPIRE action information (obligation settlement window lapsed)
function showCoinpayExpireDetails(data){
    $('#info-coinpay-expire .coinpay-expire-obligation').html(isNull(data.obligation_action_index) ? '-' : formatLink('/' + XC.coin + '/action/' + data.obligation_action_index, numeral(data.obligation_action_index).format('0,0')));
    $('#info-coinpay-expire .coinpay-expire-status').text(isNull(data.status) ? '-' : data.status);
}

// Display ANCHOR action information (DOGE checkpoint: v0 checkpoint, v1 +archive, v2 continuation chunk)
function showAnchorDetails(data){
    $('#info-anchor .anchor-version').text(isNull(data.version) ? '-' : ('v' + data.version));
    $('#info-anchor .anchor-chain').text(isNull(data.chain) ? '-' : data.chain);
    $('#info-anchor .anchor-network').text(isNull(data.network) ? '-' : data.network);
    $('#info-anchor .anchor-checkpoint-seq').text(isNull(data.checkpoint_seq) ? '-' : numeral(data.checkpoint_seq).format('0,0'));
    $('#info-anchor .anchor-snapshot-block').html(isNull(data.snapshot_block) ? '-' : formatLink('/' + XC.coin + '/block/' + data.snapshot_block, numeral(data.snapshot_block).format('0,0')));
    $('#info-anchor .anchor-block-hash').html(isNull(data.block_hash) ? '-' : formatHash(data.block_hash, 32));
    $('#info-anchor .anchor-ledger-hash').html(isNull(data.ledger_hash) ? '-' : formatHash(data.ledger_hash, 32));
    $('#info-anchor .anchor-actions-hash').html(isNull(data.actions_hash) ? '-' : formatHash(data.actions_hash, 32));
    $('#info-anchor .anchor-contract-hash').html(isNull(data.contract_hash) ? '-' : formatHash(data.contract_hash, 32));
    $('#info-anchor .anchor-match-batch').text(isNull(data.match_batch_seq) ? '-' : numeral(data.match_batch_seq).format('0,0'));
    $('#info-anchor .anchor-match-count').text(isNull(data.match_count) ? '-' : numeral(data.match_count).format('0,0'));
    $('#info-anchor .anchor-chunk').text(isNull(data.chunk_index) ? '-' : (data.chunk_index + ' of ' + data.total_chunks));
    $('#info-anchor .anchor-doge-block').text(isNull(data.block_index_doge) ? '-' : numeral(data.block_index_doge).format('0,0'));
    // SPV commitment roots (NULL pre-CHECKPOINT_COMMITMENT flag-day; populated for v3).
    let hasRoots = !isNull(data.state_root) || !isNull(data.block_merkle_root);
    $('#info-anchor .anchor-roots-row').toggleClass('d-none', !hasRoots);
    if(hasRoots){
        $('#info-anchor .anchor-state-root').html(isNull(data.state_root) ? '-' : formatHash(data.state_root, 32));
        $('#info-anchor .anchor-block-merkle-root').html(isNull(data.block_merkle_root) ? '-' : formatHash(data.block_merkle_root, 32));
    }
    // Publisher-attestation tail (v4/v5/v6 reward-derivation anchors; both NULL for
    // v0-v3, so the row stays hidden). publisher is the elected pubkey credited the
    // reward; publisher_attestations is the RAW XANCPUB quorum ([{pubkey,sig}]) carried
    // on the wire - shown for provenance, consumers re-verify against their own set.
    let pubSigs = Array.isArray(data.publisher_attestations) ? data.publisher_attestations : [];
    let hasPublisher = !isNull(data.publisher) || pubSigs.length > 0;
    $('#info-anchor .anchor-publisher-row').toggleClass('d-none', !hasPublisher);
    if(hasPublisher){
        $('#info-anchor .anchor-publisher').html(isNull(data.publisher) ? '-' : formatHash(data.publisher, 32));
        $('#info-anchor .anchor-publisher-attestation-count').text(pubSigs.length);
        $('#info-anchor .anchor-publisher-attestations').html(pubSigs.length ? pubSigs.map(s => formatHash(s.pubkey, 24)).join('<br>') : '-');
    }
}

// Display PRICE action information (v0 validator COIN/FIAT snapshot, v0 validator
// BATCH of rounds, v1 user TOKEN/FIAT oracle).
//
// A batch is the shape a validator actually publishes: one signed action carrying an
// hourly window of rounds, each round a full COIN/FIAT price set. Its single-round
// columns (pair_count / pairs / sig_count) are NULL by construction, so everything
// below that is keyed on them falls back to the batch's own fields rather than
// rendering a dash over data the action plainly carries.
function showPriceDetails(data){
    let rounds = Array.isArray(data.rounds) ? data.rounds : [];
    let sigs   = Array.isArray(data.signatures) ? data.signatures : [];
    $('#info-price .price-version').html(Number(data.version)===0 ? '<span class="badge text-bg-secondary">Validator (v0)</span>' : '<span class="badge text-bg-primary">User (v1)</span>');
    $('#info-price .price-coin').text(isNull(data.coin) ? '-' : data.coin);
    $('#info-price .price-ticker').html(isNull(data.tick) ? '-' : formatLink('/' + XC.coin + '/token/' + data.tick, data.tick, data.tick));
    $('#info-price .price-fiat').text(isNull(data.fiat) ? '-' : data.fiat);
    $('#info-price .price-value').text(isNull(data.value) ? '-' : data.value);
    // PRICE v1 carries the oracle's usage FEE as a decimal fraction (0.01 being 1%)
    // plus an optional MEMO, both selected by the detail query. The raw decimal leads
    // because it is the wire value a DISPENSER's required oracle-fee output is computed
    // from; the percent rides along for readability. v0 snapshots carry neither.
    $('#info-price .price-oracle-fee').text(isNull(data.oracle_fee) ? '-'
        : data.oracle_fee + ' (' + numeral(Number(data.oracle_fee) * 100).format('0,0.[000000]') + '%)');
    $('#info-price .price-round').text(isNull(data.round_number) ? '-' : numeral(data.round_number).format('0,0'));
    // Round window: the batch's declared FIRST_ROUND..LAST_ROUND and how many rounds
    // it actually carries. Row stays hidden on a single-round v0 row and a v1 oracle,
    // where both bounds are NULL.
    let hasWindow = !isNull(data.batch_first_round) && !isNull(data.batch_last_round);
    $('#info-price .price-window-row').toggleClass('d-none', !hasWindow);
    if(hasWindow){
        let count = isNull(data.round_count) ? rounds.length : Number(data.round_count);
        $('#info-price .price-window').text(
            numeral(data.batch_first_round).format('0,0') + ' - ' + numeral(data.batch_last_round).format('0,0') +
            ' (' + numeral(count).format('0,0') + ' round' + (count===1 ? '' : 's') + ')');
    }
    $('#info-price .price-round-timestamp').text(isNull(data.round_timestamp) ? '-' : data.round_timestamp);
    // Pair count: a batch stores none (its rounds each carry their own set), so count
    // the pairs of its first round rather than showing a dash. Every round in a batch
    // is one publisher's full snapshot, so the first round's width describes the batch.
    let pairText = '-';
    if(!isNull(data.pairs))
        pairText = String(data.pairs.length);
    else if(!isNull(data.pair_count))
        pairText = String(data.pair_count);
    else if(rounds.length && Array.isArray(rounds[0].pairs))
        pairText = rounds[0].pairs.length + ' per round';
    $('#info-price .price-pairs').text(pairText);
    // sig_count is NULL on a batch row, but sigs_json holds the signature set that
    // covers the whole window, so fall back to its length rather than to a dash.
    let sigCount = isNull(data.sig_count) ? (sigs.length || null) : Number(data.sig_count);
    $('#info-price .price-sig-count').text(isNull(sigCount) ? '-' : numeral(sigCount).format('0,0'));
    $('#info-price .price-signers-row').toggleClass('d-none', sigs.length === 0);
    if(sigs.length)
        $('#info-price .price-signers').html(sigs.map((s) => formatHash(s.pubkey, 24)).join('<br>'));
    $('#info-price .price-validation-status').text(isNull(data.validation_status) ? '-' : data.validation_status);
    $('#info-price .price-memo').text(isNull(data.memo) ? '-' : data.memo);
    showPriceRounds(rounds);
}

// Render a PRICE batch's decoded round bodies: one table per round, listing every
// COIN/FIAT pair and its price exactly as the signers signed it.
//
// Pair names and prices are on-chain, publisher-supplied values reaching .html(), so
// both are escaped. They are already validated on the way in (the indexer refuses a
// pair that fails the network's pair pattern and a price that is not decimal digits),
// but this renderer also runs against a v1 oracle row and any future carrier, so it
// does not lean on that.
function showPriceRounds(rounds){
    let block = $('#info-price .price-rounds-block');
    block.toggleClass('d-none', rounds.length === 0);
    if(rounds.length === 0){
        $('#info-price .price-rounds').empty();
        $('#info-price .price-rounds-summary').text('');
        return;
    }
    let pairTotal = rounds.reduce((n, r) => n + (Array.isArray(r.pairs) ? r.pairs.length : 0), 0);
    $('#info-price .price-rounds-summary').text(
        '(' + numeral(rounds.length).format('0,0') + ' round' + (rounds.length===1 ? '' : 's') +
        ', ' + numeral(pairTotal).format('0,0') + ' price' + (pairTotal===1 ? '' : 's') + ')');
    let html = '';
    for(let r of rounds){
        let pairs = Array.isArray(r.pairs) ? r.pairs : [];
        html += '<table class="table table-sm table-striped table-hover table-bordered mb-3" width="100%">';
        html += '<thead><tr class="info">';
        html += '<th width="155">Round ' + numeral(r.round).format('0,0') + '</th>';
        html += '<th>' + (isNull(r.timestamp) ? '-' : formatLivestamp(r.timestamp)) + '</th>';
        // The BTC block the round is anchored to. Capability staking is BTC-only, so
        // this height is on Bitcoin whatever chain the action landed on: never link it
        // into the page coin's namespace, which would name a block that does not exist.
        html += '<th>BTC block ' + formatPriceAnchorHeight(r.btc_block_height) + '</th>';
        html += '</tr></thead><tbody>';
        for(let p of pairs){
            let parts = String(p.pair).split('/');
            html += '<tr>';
            html += '<td>' + escapeHtml(nullToBlank(parts[0])) + '</td>';
            html += '<td>' + escapeHtml(nullToBlank(parts[1])) + '</td>';
            html += '<td>' + escapeHtml(String(p.price)) + '</td>';
            html += '</tr>';
        }
        if(pairs.length === 0)
            html += '<tr><td colspan="3">-</td></tr>';
        html += '</tbody></table>';
    }
    $('#info-price .price-rounds').html(html);
}

// Render a PRICE round's BTC anchor height, linked into the BTC explorer for THIS
// network when this instance serves it. Price rounds are anchored to Bitcoin on every
// chain (capability staking is BTC-only), so the height belongs to BTC/TBTC/RBTC and
// never to the page coin. An instance that does not serve the matching BTC network
// (XC.status.available is the same map the header logo and the network-unavailable
// notice read) gets the height as plain text rather than a link to a page it has not
// got - a DOGE-only deployment is a supported configuration, not an error.
function formatPriceAnchorHeight(height){
    if(isNull(height)) return '-';
    let text   = numeral(height).format('0,0');
    // mainnet's prefix is '' by design, so an absent map and a mainnet page both
    // resolve to plain 'BTC' - which is right in the first case and correct in the second.
    let prefix = (XC.networks && XC.networks[XC.network]) ? XC.networks[XC.network] : '';
    let coin   = prefix + 'BTC';
    let served = !!(XC.status && XC.status.available && XC.status.available[coin]);
    return served ? formatLink('/' + coin + '/block/' + height, text) : text;
}

// Display NODEPROOF action information (full-node possession-proof verdict + per-validator PASS list)
function showNodeproofDetails(data){
    $('#info-nodeproof .nodeproof-challenge').html(isNull(data.challenge_id) ? '-' : formatHash(data.challenge_id, 32));
    $('#info-nodeproof .nodeproof-epoch-height').html(isNull(data.epoch_height) ? '-' : formatLink('/' + XC.coin + '/block/' + data.epoch_height, numeral(data.epoch_height).format('0,0')));
    $('#info-nodeproof .nodeproof-target-height').html(isNull(data.target_height) ? '-' : formatLink('/' + XC.coin + '/block/' + data.target_height, numeral(data.target_height).format('0,0')));
    let verifs = Array.isArray(data.verifications) ? data.verifications : [];
    $('#info-nodeproof .nodeproof-verified-count').text(verifs.length);
    let rows = '';
    for(let v of verifs){
        let badge = '<span class="badge text-bg-' + (v.passed==1 ? 'success' : 'danger') + '">' + (v.passed==1 ? 'Pass' : 'Fail') + '</span>';
        let src   = isNull(v.staking_source) ? '-' : formatLink('/' + XC.coin + '/address/' + v.staking_source, v.staking_source);
        rows += '<tr><td>' + formatHash(v.signing_pubkey, 32) + '</td><td>' + src + '</td><td>' + badge + '</td></tr>';
    }
    $('#info-nodeproof .nodeproof-verifications tbody').html(rows || '<tr><td colspan="3">-</td></tr>');
}

// Display ROLLCALL action information (liveness roll call + the validators present at the epoch)
//
// EPOCH_HEIGHT IS A BITCOIN HEIGHT, and a ROLLCALL only ever lands on Dogecoin, so this
// page is always on a DOGE route while that number refers to another chain. It is rendered
// as plain text, deliberately NOT linked to /{COIN}/block/, because linking it would resolve
// to an unrelated Dogecoin block of the same number and read as real. The label carries the
// chain so the reader is not left to infer it.
function showRollcallDetails(data){
    $('#info-rollcall .rollcall-epoch-height').html(isNull(data.epoch_height) ? '-' : numeral(data.epoch_height).format('0,0'));
    $('#info-rollcall .rollcall-ledger-hash').html(isNull(data.ledger_hash) ? '-' : formatHash(data.ledger_hash, 32));
    $('#info-rollcall .rollcall-publisher').html(isNull(data.publisher) ? '-' : formatHash(data.publisher, 32));
    // The signer list IS the present list: presence at an epoch is recorded by having
    // signed the canonical, so there is no separate attendance flag to render.
    let signers = Array.isArray(data.signers) ? data.signers : [];
    $('#info-rollcall .rollcall-signer-count').text(signers.length);
    let rows = '';
    for(let s of signers)
        rows += '<tr><td>' + formatHash(s.pubkey, 32) + '</td><td>' + formatHash(s.sig, 32) + '</td></tr>';
    $('#info-rollcall .rollcall-signers tbody').html(rows || '<tr><td colspan="2">-</td></tr>');
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
                // The transaction actions table nests its summary under `.details`
                // (getActionSummaryData) and a BATCH member carries the same projection
                // under `.summary` (misc.js BATCH.afterQuery2), both built by
                // db.projectActionSummary. A BET feed member keeps the raw
                // attacker-supplied base64 DETAILS string on the `.details` key, so a
                // truthiness test handed getActionDetails a string instead of the action
                // info. Require an object on either key, else fall back to the flat row.
                let details = (info.summary && typeof info.summary === 'object') ? info.summary
                            : (info.details && typeof info.details === 'object') ? info.details
                            : info;
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
            } else if(type=='send'){
                html += '<tr class="' + cls + '">'
                html += '    <td>' + (idx+1) + '</td>';
                html += '    <td>' + formatLink('/' + XC.coin + '/address/' + info.destination, info.destination) + '</td>';
                html += '    <td>' + formatLink('/' + XC.coin + '/token/' + info.tick, info.tick, info.tick) + '</td>';
                html += '    <td>' + formatAmount(info.amount) + '</td>';
                // SEND v3 carries a MEMO per leg, so it belongs beside the leg it
                // describes rather than only inside the raw transaction data.
                // Escaped and null-guarded exactly as the destroy legs are.
                html += '    <td>' + escapeHtml(isNull(info.memo) ? '' : info.memo) + '</td>';
                html += '    <td>' + (isNull(info.status) ? '' : info.status) + '</td>';
                html += '</tr>';
            } else if(type=='destroy'){
                html += '<tr class="' + cls + '">'
                html += '    <td>' + (idx+1) + '</td>';
                html += '    <td>' + formatLink('/' + XC.coin + '/token/' + info.tick, info.tick, info.tick) + '</td>';
                html += '    <td>' + formatAmount(info.amount) + '</td>';
                html += '    <td>' + escapeHtml(isNull(info.memo) ? '' : info.memo) + '</td>';
                html += '    <td>' + (isNull(info.status) ? '' : info.status) + '</td>';
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
    } else {
        // An empty result MUST clear the tbody before DataTables initializes. The
        // markup ships a single placeholder row ("Loading data...") whose colspan
        // stands in for the whole header, and DataTables does not expand colspan
        // when it adopts existing rows: it expects one <td> per <th>, finds one,
        // and dereferences the missing cells as undefined._DT_CellIndex. Leaving
        // the row in place therefore throws instead of rendering, which is exactly
        // the path a user hits right after broadcasting, before the tx confirms.
        // Emptying it lets DataTables draw its own zeroRecords state.
        body.empty();
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
// (description, memo, message, token names) before it reaches an HTML sink.
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
    // onerror/onload during the assignment, which is itself an XSS execution sink.
    try {
        var doc = new DOMParser().parseFromString(String(html), 'text/html');
        return doc.body.textContent || '';
    } catch(e) {
        // Single-pass tag stripping can leave a tag reassembled from adjacent
        // fragments (e.g. "<scr" + "ipt>"); loop the replace to a fixpoint.
        var out = String(html), prev;
        do {
            prev = out;
            out  = out.replace(/<[^>]*>/g, '');
        } while(out !== prev);
        return out;
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
// image URL works (ipfs gateway, arweave, imgur, etc.). The previous
// /relay-based path only worked for .json/.png/arweave.net URLs and
// silently no-op'd on everything else. The IMG's error handler in
// token.html falls back to default.png if the URL fails to load.
function displayTokenIcon(image){
    if(image)
        $('#tokenIcon').attr('src', image);
}

// Wrap attacker-controlled custom token HTML in a minimal document for the
// sandboxed (no allow-same-origin) #customContentViewer iframe, loaded via
// srcdoc. The iframe runs in an opaque origin so this content cannot reach the
// explorer's cookies/storage/DOM; a tiny shim posts its rendered height back to
// the parent (one-way) for auto-resize. (Replaces the old same-origin
// resizeIframe(), which only worked because the iframe was NOT sandboxed.)
// The shim measures the BODY box plus its margins, never documentElement.scrollHeight:
// that value is floored at the iframe's own viewport height, so each report echoed the
// height the parent had just set. With the parent's old +16 padding on top, every resize
// round trip grew the frame by another 16px and the page scrolled without end (seen on
// TDOGE FAIRYWINK, whose artwork is sized as a percentage of its width). Body height is
// content-derived, so a report is now a fixed point: the parent applies it, the child
// re-measures the same number, and the loop settles.
function buildSandboxedContentDoc(html){
    var shim = '<scr' + 'ipt>(function(){'
        + 'var last=-1;'
        + 'function measure(){var b=document.body;if(!b)return 0;'
        + 'var cs=window.getComputedStyle(b);'
        + 'return Math.ceil(b.getBoundingClientRect().height'
        + '+(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0));}'
        // Suppress unchanged heights so a resize storm cannot pump the parent.
        + 'function post(){var h=measure();if(h===last)return;last=h;'
        + 'try{parent.postMessage({type:"xchain-iframe-height",height:h},"*");}catch(e){}}'
        + 'window.addEventListener("load",post);'
        + 'window.addEventListener("resize",post);'
        // Catches content that reflows on its own (late images, nested frames, animation).
        + 'if(window.ResizeObserver)new ResizeObserver(post).observe(document.documentElement);'
        + '[100,250,500,1000,2000].forEach(function(t){setTimeout(post,t);});'
        + '})();</scr' + 'ipt>';
    return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
        + String(html) + shim + '</body></html>';
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

// Resolve an action reference ("action:<index>" same-chain, or
// "action:<COIN>:<index>" sibling-chain (base ticker, network tier implied
// by the page's chain, same convention as LINK COIN1/COIN2) to this
// explorer's raw FILE path. Returns false for anything else.
function actionRefToRawPath(ref){
    if(typeof ref !== 'string')
        return false;
    var m = ref.match(/^action:(?:(BTC|LTC|DOGE):)?([0-9]+)$/i);
    if(!m)
        return false;
    // Same network tier as the current page: RBTC + DOGE → RDOGE, etc.
    var tier = (XC.coin.match(/^([TR])(BTC|LTC|DOGE)$/) || [])[1] || '';
    var coin = m[1] ? (tier + m[1].toUpperCase()) : XC.coin;
    return '/' + coin + '/api/file/' + m[2] + '/raw';
}

// Resolve TIS `data_ref` entries across the media arrays. A data_ref of
// "action:<index>" points at an on-chain FILE action; clients prefer it over
// `data` when both are present (Token_Information_Standard.md, File Entry
// Fields). Resolves to the explorer's own raw FILE endpoint. Also guarantees
// every entry carries a string `data` so downstream substring/split calls are
// safe on data_ref-only entries.
function resolveTisDataRefs(o){
    ['images','audio','video','files'].forEach(function(key){
        if(!o[key] || !o[key].length)
            return;
        o[key].forEach(function(item){
            if(!item)
                return;
            var path = (typeof item.data_ref === 'string') ? actionRefToRawPath(item.data_ref) : false;
            if(path)
                item.data = path;
            if(isNull(item.data))
                item.data = '';
        });
    });
    return o;
}

// Lock marker for token-gated TIS entries (`locked: true`). Lets media lists
// render a locked state without fetching the FILE action first.
function lockedContentIcon(item){
    return (item && item.locked) ? '<i class="fa fa-lock pe-1" title="Token-gated content: holders decrypt with their unlock key"></i>' : '';
}

// Pick the entry whose media should display from a TIS media array: prefer the
// named display types (legacy CoinDaddy/TIS type tags), then fall back to the
// first non-locked entry (gated entries are ciphertext and cannot render).
function pickDisplayMedia(arr, types){
    for(var i=0; i<types.length; i++){
        var item = getArrayItemByType(arr, types[i]);
        if(item && !item.locked)
            return item;
    }
    for(var j=0; j<arr.length; j++){
        if(arr[j] && !arr[j].locked)
            return arr[j];
    }
    return false;
}

// Handle displaying token content (images, audio, video, etc)
function showTokenContent(json){
    // Convert any legacy formated JSON to the new XChain Token Information Standard (TIS)
    json = legacyJsonToXChainTIS(json);

    // Resolve any on-chain data_ref entries to raw FILE URLs
    json = resolveTisDataRefs(json);

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
            // On-chain fields: escape type, href and link text.
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
            // On-chain fields: escape type, size, href and link text.
            let html = '<tr><th>' + lockedContentIcon(item) + escapeHtml(item.type);
            if(item.size)
                html += ' (' + escapeHtml(String(item.size)) + ')';
            html += '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#imagesInfo');
        // Extract the display image from the images array; named display types
        // first, then the first non-locked entry (fixes the old `first.data`
        // dereference of a string, which hid the artwork for plain TIS docs
        // whose entries carry MIME types instead of display-type tags)
        var imageItem = pickDisplayMedia(o.images, ['large','standard']);
        if(imageItem){
            image = imageItem.data;
            title = imageItem.name;
        }
    }

    // Audio
    if(o.audio.length){
        var table = $('#audioInfo table tbody');
        table.empty();
        o.audio.slice(0,10).forEach(function(item){
            let html = '<tr><th>' + lockedContentIcon(item) + escapeHtml(item.type) + '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#audioInfo');
        // Extract the display audio from the audio array
        var audioItem = pickDisplayMedia(o.audio, ['m4a','mp3','wav']);
        if(audioItem){
            audio = audioItem.data;
            if(!title)
                title = audioItem.name;
        }
    }

    // Video
    if(o.video.length){
        var table = $('#videoInfo table tbody');
        table.empty();
        o.video.slice(0,10).forEach(function(item){
            let html = '<tr><th>' + lockedContentIcon(item) + escapeHtml(item.type) + '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#videoInfo');
        // Extract the display video from the videos array
        var videoItem = pickDisplayMedia(o.video, ['mp4','mov','wmv']);
        if(videoItem){
            video = videoItem.data;
            if(!title)
                title = videoItem.name;
        }
    }

    // Files
    if(o.files.length){
        var table = $('#fileInfo table tbody');
        table.empty();
        o.files.slice(0,10).forEach(function(item){
            let html = '<tr><th>' + lockedContentIcon(item) + escapeHtml(item.type) + '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
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
            // On-chain DNS record fields: escape all three.
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
    // https://github.com/XChain-Platform/xchain-documentation/blob/master/protocol/token-information-standard.md#supported-token-description-formats
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
            // image is derived from on-chain token metadata; only allow http(s)
            // URLs into the src attribute so a javascript:/data: URI can't land there.
            var safeImage = String(image);
            if(safeImage.startsWith('http://') || safeImage.startsWith('https://'))
                // .attr() sets through the DOM API, not markup, so no HTML parser later
                // un-escapes entities the way the video/audio src sinks above rely on.

                // STRIP the tag/attribute-breakout characters rather than entity-escaping
                // them: a real URL is percent-encoded and never carries a literal <, >, "
                // or ' (unlike '&', which separates query params), so a benign URL is
                // unaffected while a payload loses its markup bytes.
                el.attr('src', safeImage.replace(/[<>"']/g, ''));
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
                // `video` is an on-chain media URL (attacker-controlled); escape it so it
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
                // `audio` is an on-chain media URL (attacker-controlled); escape it.
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
        // Handle loading custom content when the user clicks the "Load Content" button.
        // The viewer document is FETCHED from /content-viewer rather than injected as
        // srcdoc: a srcdoc document inherits this page's CSP, whose frame-src admits
        // only 'self', youtube and soundcloud, so art embedding any other host rendered
        // as a broken-page placeholder. The route's response carries a policy of its own
        // (XChainExplorer.CONTENT_VIEWER_CSP). Containment is unchanged and does not
        // depend on that policy: the iframe's sandbox has no allow-same-origin, so the
        // content sits in an opaque origin and cannot touch the explorer's
        // cookies/storage/DOM, and el.contents() stays unreachable from here.
        $('#loadCustomContentButton').click(function(){
            $('#customContentWarning').hide();
            var el = $('#customContentViewer');
            // Held, not posted: the viewer asks for it once it is listening.
            XC.pendingCustomContent = buildSandboxedContentDoc(cachedJson.html);
            el.attr('src', '/content-viewer');
            el.show();
        });
        // Bound once, and the only conversation this page has with the viewer: it hands
        // the content over when the frame reports itself ready, and applies the height
        // the frame reports as it renders. Both legs strictly validate the source frame
        // and the message shape, and nothing in a message is ever injected or evaluated.
        if(!XC.customContentResizeBound){
            XC.customContentResizeBound = true;
            // A hostile or broken report must not be able to stretch the page without
            // limit. The frame is scrolling="no", so anything past this cap is clipped:
            // at ~60 screens tall, only broken or deliberate content can reach it.
            var MAX_CUSTOM_CONTENT_HEIGHT = 20000;
            window.addEventListener('message', function(e){
                var iframe = document.getElementById('customContentViewer');
                if(!iframe || e.source !== iframe.contentWindow) return;
                var d = e.data;
                // The viewer is in an opaque origin, so '*' is the only target origin
                // that can reach it; the e.source check above is what pins the recipient
                // to our own frame. Handed over once per click, so a second 'ready' (a
                // frame that reloaded itself) gets nothing.
                if(d && d.type === 'xchain-iframe-ready' && XC.pendingCustomContent){
                    var doc = XC.pendingCustomContent;
                    XC.pendingCustomContent = null;
                    e.source.postMessage({ type: 'xchain-iframe-content', doc: doc }, '*');
                    return;
                }
                if(!(d && d.type === 'xchain-iframe-height' && typeof d.height === 'number' && isFinite(d.height)))
                    return;
                // Apply the reported height verbatim (the shim already counts the body's
                // margins). Adding any constant here would re-enter the child's resize
                // handler with a bigger number every time and never converge.
                var h = Math.max(0, Math.min(Math.round(d.height), MAX_CUSTOM_CONTENT_HEIGHT));
                if(Math.abs(($(iframe).height() || 0) - h) >= 2)
                    $(iframe).height(h);
            });
        }
    }

    // Hide the "No additional information is available" section
    if(XC.someTokenInfoFound)
        $('#additionalInfoNotAvailable').hide();
}

// Render a token's/address's controller bindings (protocol/Controller_Bound_Tokens.md)
// into a table body, revealing the card when at least one binding is gating.
// `controllers` is the API's `controllers` array; bodyId/cardId are element ids.
// Each row: action class, linked guard contract, cooldown, Active/Unbinding badge.
// Render the files a token has LINKed to itself (LINK v0, the NFT pattern) into a table
// body, revealing the card only when the token actually carries one. `files` is getToken's
// linked_files array. A GATED file's bytes need a token balance, so it is labelled rather
// than offered as a raw link that would refuse the reader.
function renderLinkedFiles(files, bodyId, cardId){
    if(!files || !files.length)
        return;
    let html = '';
    files.forEach(function(f){
        let idx   = Number(f.action_index);
        let raw   = f.gated
            ? '<span class="badge text-bg-secondary">gated</span>'
            // The bytes are served from the API route (XChainExplorer.js registers
            // /:coin/api/file/:actionIndex/raw); there is no page-level /file/ route, and
            // linking one 404s with the HTML shell rather than the file.
            : '<a href="/' + XC.coin + '/api/file/' + idx + '/raw" target="_blank">raw bytes</a>';
        // title/name/type are on-chain, author-controlled free text; escape all three.
        html += '<tr>'
             +  '<td>' + formatLink('/' + XC.coin + '/action/' + idx, escapeHtml(nullToBlank(f.title))) + '</td>'
             +  '<td>' + escapeHtml(nullToBlank(f.name)) + '</td>'
             +  '<td>' + escapeHtml(nullToBlank(f.type)) + '</td>'
             +  '<td>' + numeral(Number(f.block_index)).format('0,0') + '</td>'
             +  '<td>' + raw + '</td>'
             +  '</tr>';
    });
    $('#' + bodyId).html(html);
    $('#' + cardId).show();
}

function renderControllerBindings(controllers, bodyId, cardId){
    if(!controllers || !controllers.length)
        return;
    let html = '';
    controllers.forEach(function(c){
        let cls      = escapeHtml(String(c.action_class));
        let contract = formatLink('/' + XC.coin + '/contract/' + Number(c.contract_index), Number(c.contract_index));
        let cooldown = numeral(c.cooldown_blocks).format('0,0') + ' block' + (Number(c.cooldown_blocks)==1 ? '' : 's');
        // is_unbind=1 rows are still gating only during their drop cooldown.
        let badge    = (Number(c.is_unbind)===1)
            ? '<span class="badge text-bg-warning">Unbinding</span>'
            : '<span class="badge text-bg-success text-white">Active</span>';
        html += '<tr><td>' + cls + '</td><td>' + contract + '</td><td>' + cooldown + '</td><td>' + badge + '</td></tr>';
    });
    $('#' + bodyId).html(html);
    $('#' + cardId).show();
}

// Render a token's open governance polls (VOTE v0, poll_status='open') into the
// token page's Active Governance card, revealing it when at least one poll is
// open. Voter apathy is the classic governance attack surface, so open polls
// (binding ones especially: their result fires a contract method) are surfaced
// on the token itself rather than only on the global /polls list.
// `polls` is getToken's open_polls array; bodyId/cardId are element ids.
function renderOpenPolls(polls, bodyId, cardId){
    if(!polls || !polls.length)
        return;
    let html = '';
    polls.forEach(function(p){
        let question = isNull(p.question) ? '-' : escapeHtml(String(p.question));
        let closes   = formatLink('/' + XC.coin + '/block/' + Number(p.end_block), numeral(p.end_block).format('0,0'));
        let binding  = isNull(p.callback_contract_index)
            ? '<span class="badge text-bg-secondary">Advisory</span>'
            : formatLink('/' + XC.coin + '/contract/' + Number(p.callback_contract_index),
                '<span class="badge text-bg-danger">Binding</span>',
                'Binding poll: finalization calls contract ' + Number(p.callback_contract_index));
        let view     = formatLink('/' + XC.coin + '/action/' + Number(p.action_index), 'view', null, true);
        html += '<tr><td>' + formatLink('/' + XC.coin + '/action/' + Number(p.action_index), Number(p.action_index))
             +  '</td><td>' + question + '</td><td>' + closes + '</td><td>' + binding + '</td><td>' + view + '</td></tr>';
    });
    $('#' + bodyId).html(html);
    $('#' + cardId).show();
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

    // Project registry surfaces (protocol/Project_Registry.md). Both surfaces
    // render as green banners in #project-banners, the full-width row under
    // the Token Information / Market Information cards.
    let projectBanners = '';
    // projects = registries whose current owner-attested roster includes this
    // token → banner that ALWAYS names the attesting project (the banner's
    // weight comes from the project's identity, never a bare checkmark).
    // Tick names are consensus-restricted but escaped anyway.
    if(o.projects && o.projects.length){
        o.projects.forEach(function(p){
            let name = escapeHtml(p.project);
            projectBanners += '<div class="alert alert-success mb-1" role="alert">'
                 +  '<i class="fa fa-certificate pe-1"></i>This token is an official token in the '
                 +  formatLink('/' + XC.coin + '/token/' + name, '<b>' + name + '</b>', p.project)
                 +  ' project.'
                 +  '<a href="/' + XC.coin + '/action/' + Number(p.link_action_index) + '" class="float-end small" title="View the on-chain roster attestation">attestation</a>'
                 +  '</div>';
        });
    }
    // registry = this token IS a project with an attested official-token
    // roster → ownership banner linking to the roster, and reveal the
    // Official Tokens tab
    if(o.registry){
        projectBanners += '<div class="alert alert-success mb-1" role="alert">'
             +  '<i class="fa fa-certificate pe-1"></i>This token is the owner of the <b>' + escapeHtml(o.info.tick) + '</b> project. '
             +  '<a href="#" id="registry-link">View its ' + numeral(o.registry.total).format('0,0') + ' official token' + (o.registry.total==1?'':'s') + '</a>.'
             +  '<a href="/' + XC.coin + '/action/' + Number(o.registry.link_action_index) + '" class="float-end small" title="View the on-chain roster attestation">attestation</a>'
             +  '</div>';
        $('#tab-dropdown-project').removeClass('d-none');
    }
    if(projectBanners){
        $('#project-banners').html(projectBanners).removeClass('d-none');
        // The banner's roster link opens the Official Tokens tab
        $('#registry-link').click(function(e){
            e.preventDefault();
            $('#tab-dropdown-project').click();
        });
    }

    // Controller bindings (protocol/Controller_Bound_Tokens.md): guard contracts
    // that gate this token's native actions. Hidden until at least one is gating.
    renderControllerBindings(o.controllers, 'token-controllers-body', 'token-controllers-card');

    // Open governance polls over this token. Hidden until at least one is open.
    renderOpenPolls(o.open_polls, 'token-governance-body', 'token-governance-card');

    // Files LINKed to this token (the NFT pattern). The Files tab already lists them, but
    // a reader looking at the info column was told "No additional information is available"
    // beside a token carrying on-chain artwork, so the link had no surface where it counts.
    renderLinkedFiles(o.linked_files, 'token-linked-files-body', 'token-linked-files-card');

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
        arweave = /^https?:\/\/arweave\.net\//i,
        // On-chain TIS document: DESCRIPTION = "action:<index>" (same chain)
        // or "action:<COIN>:<index>" (sibling chain) pointing at a FILE
        // action whose bytes are the TIS JSON
        // (Token_Information_Standard.md, On-Chain Format).
        act     = /^action:(?:(BTC|LTC|DOGE):)?([0-9]+)$/i;

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

    // On-chain TIS document pointer: show a link to the FILE action that
    // holds the token's information document (on its own chain for the
    // cross-chain form). Coin + index are regex-validated, so the href is
    // safe by construction.
    if(act.test(desc)){
        var actM    = desc.match(act),
            actTier = (XC.coin.match(/^([TR])(BTC|LTC|DOGE)$/) || [])[1] || '',
            actCoin = actM[1] ? (actTier + actM[1].toUpperCase()) : XC.coin;
        $('#token-description').html(
            '<a href="/' + actCoin + '/action/' + actM[2] + '" title="Token information stored on-chain (' + actCoin + ' FILE action ' + actM[2] + ')">'
            + escapeHtml(desc) + '</a>'
        );
    }

    // Set the full url to get JSON content
    let jsonUrl = false;
    if(act.test(desc)){
        // Same-origin raw FILE bytes from the colocated decoder DB;
        // resolution target for an on-chain TIS document (same- or
        // sibling-chain per the action ref).
        jsonUrl = actionRefToRawPath(desc.trim());
    } else if(json.test(desc) || ipfs.test(desc) || ord.test(desc) || ar.test(desc) || arweave.test(desc)){
        if(ipfs.test(desc)){
            // Same gateway the server resolves ipfs: through (IPFS_GATEWAY in
            // src/IconResolver.js) and the same one this file already rewrites
            // ipfs:// image entries to below. Pointing the page somewhere else
            // makes it render icons the downloader could not fetch, and vice
            // versa. The optional // is stripped here too, so the ipfs://HASH
            // form does not land as a double-slashed path the gateway 404s.
            jsonUrl = 'https://ipfsc.crystalsuite.com/' + String(desc).replace(/^ipfs:(\/\/)?/i,'');
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
// https://github.com/XChain-Platform/xchain-documentation/blob/master/protocol/token-information-standard.md
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
                url   = url.replace(/"/g,''),
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
    // Token descriptions are untrusted on-chain free text and must NEVER reach an
    // .html() sink: reduce to plain text through the inert stripHtml. A denylist is
    // not an option here, being trivially bypassed (<img onerror>, <svg onload>);
    // rich descriptions, if ever wanted, need a real sanitizer.
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
    // A nullable column reaches here as a real null (a BROADCAST v3 carries no
    // message, a v0 carries no memo, a token can have no description), and
    // String(null) is the four-character word "null", so an absent value would
    // render as that text. Same defect class as the nullToBlank cells, by a
    // third route: blank it before the coercion below can name it.
    if(isNull(text)) return '';
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

// Handle updating the page info (title, description, canonical, robots, social cards)
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
    // A <link> carries its target in href. Setting src here left every page
    // shipping an EMPTY canonical while still marked index,follow.
    $('link[rel="canonical"]').attr('href', url);
    // Keep the social cards in step with the canonical page identity, or every
    // shared explorer link previews as the bare site-wide default.
    $('meta[property="og:url"]').attr('content', url);
    $('meta[property="og:title"]').attr('content', title);
    $('meta[name="twitter:title"]').attr('content', title);
    if(!isNull(info.description)){
        $('meta[property="og:description"]').attr('content', info.description);
        $('meta[name="twitter:description"]').attr('content', info.description);
    }
    // Update robots tag
    if(!isNull(info.robots))
        $('meta[name="robots"]').attr('content',info.robots);
}

// Resolve the counter-tick of a market pair. A market URL may name only the
// primary tick (/{COIN}/market/{TICK}); the counter then comes from the top
// market listed for that tick, never from the missing path segment (an absent
// segment would stringify as the literal "undefined"). A counter given in the
// URL passes through unchanged. `fail` runs when no market exists for the
// tick, so the page can say so rather than render a half-composed pair.
function resolveMarketPair(tick1, tick2, done, fail){
    if(!isNull(tick2)){
        done(tick2);
        return;
    }
    loadApiData(XC.coin, 'markets', tick1, null, function(o){
        let list    = (o && o.data) ? o.data : [],
            wanted  = String(tick1).toUpperCase(),
            counter = null;
        for(let idx in list){
            // The list re-orients each pair around the searched tick, so take
            // whichever side is not the tick we asked about.
            let m = list[idx],
                c = (String(m.tick1).toUpperCase()==wanted) ? m.tick2 : m.tick1;
            if(!isNull(c) && String(c).toUpperCase()!=wanted){
                counter = c;
                break;
            }
        }
        if(!isNull(counter)){
            done(counter);
        } else if(typeof fail==='function'){
            fail();
        }
    });
}

// Render a visible failed-resolution state for a market page. Silently blank
// panels (or a stringified "undefined") hide that the requested pair does not
// exist on this chain, so the failure is stated in the title and the panels.
function showMarketNotFound(tick){
    XC.pageInfo.title = tick + ' Market Not Found';
    updatePageInfo();
    $('.market-name').text(tick + ' MARKET NOT FOUND');
    $('.market-description').text('No market was found for ' + tick + ' on the ' + XC.name + ' (' + XC.network + ') blockchain network');
    $('.loading-data').text('No market data available');
}

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
        // An answer without a resolvable pair (the API returns no row for an
        // unknown pair) is a resolution failure; say so instead of leaving
        // every panel on "Loading".
        if(!o || isNull(o.tick2)){
            showMarketNotFound(String(market).split('/')[0]);
            return;
        }
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
                // Accumulate volume via bignumber to avoid IEEE-754 drift on
                // high-precision token amounts and overflow past MAX_SAFE_INTEGER
                // for large-supply 0-decimal tokens.
                vol = bcadd(vol, item[2]);
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