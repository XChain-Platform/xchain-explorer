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
        // XCLogger.error, not XCLogger.log: this IS an error, and error-only console
        // filters are how these get noticed at all.
        XCLogger.error('[XChain] DataTables feed failed  table=' + id +
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

// Coarse "how long ago" for the freshness banner: seconds in, one unit out.