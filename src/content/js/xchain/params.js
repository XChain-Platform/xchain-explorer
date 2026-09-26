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
 * params.js
 *
 * Custom javascript for xchain explorer
 */

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
        XC.default = true; XC.coin = 'BTC';
    }
    // Set the remaining XChain Params (chain, name, network)
    XC.chain = getXChainParam(XC.coin,'chain'); XC.name = getXChainParam(XC.coin,'name'); XC.network = getXChainParam(XC.coin,'network');
    // Set query and query type to a valid value based on path
    let type = String(path[2]).toLowerCase(), query = path[path.length-1];
    // A detail page whose type is absent here gets XC.query = null and then requests
    // its own API route with a literal 'null' segment, rendering as "not found" rather
    // than failing visibly, so every new detail route has to be added in BOTH lists.
    if(['block','address','token','action','transaction','contract','execution','checkpoint','validator','xcall','attestation','poll','anchor','bet_feed','oracle','dispenser','rich_list'].includes(type)){
        // bet_feed is keyed by the creating action_index (db.getBetFeedInfo binds it to
        // m.action_index), so it belongs in the numeric branch; oracle is keyed by the
        // operator ADDRESS (db.getOracleStats binds it to a2.address, and db's id lookup
        // resolves type 'oracle' through index_addresses exactly like 'address').
        if((['block','action','contract','execution','checkpoint','poll','anchor','attestation','bet_feed'].includes(type) && isNumeric(query)) ||
           // dispenser takes either key: its action_index (one dispenser, what it
           // holds and its own fills) or its operating GET_ADDRESS (every dispenser
           // buyers pay at that address, as the feeds scope type 'address').
           (['address','oracle','dispenser'].includes(type) && isCryptoAddress(query)) ||
           (type=='dispenser' && isNumeric(query)) ||
           // A validator resolves by signing pubkey OR by staking address, and an xcall by
           // its 64-hex call_id, so neither can use the numeric check above.
           (['validator','xcall'].includes(type) && typeof(query)=='string' && query.length) ||
           (['token','rich_list'].includes(type) && params_hasTextDetailQuery(query))){
            XC.type = type; XC.query = query;
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
            XC.type = (/^[0-9a-f]{64}$/i.test(String(query))) ? 'tx_hash' : (isNumeric(query)) ? 'tx_index' : 'tx_hash';
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

// Keep text route policy separate from the detail-page dispatch.
function params_hasTextDetailQuery(query){
    // rich_list is keyed by TICK, exactly like the token page it is reached
    // from, so it takes the same string branch rather than the numeric one.
    return typeof(query)=='string';
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

// Handle showing the various XChain parameters
function showXChainParams(){
    XCLogger.log('XC.chain=',XC.chain);
    XCLogger.log('XC.name=',XC.name);
    XCLogger.log('XC.network=',XC.network);
    XCLogger.log('XC.type=',XC.type);
    XCLogger.log('XC.query=',XC.query);
    XCLogger.log('XC.coin_price', XC.coin_price);
}
