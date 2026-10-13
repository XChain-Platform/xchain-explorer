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
 *
 * XChain Explorer - does a path segment have the shape of an address
 *
 * The server half of the address page's own check (isCryptoAddress in
 * src/content/js/xchain/address_utils.js): base58 structure plus the network's
 * version byte, or a bech32/bech32m segwit address with a checksum that holds
 * and a known HRP. The two must agree, because the page renders "No address in
 * this URL" exactly when that check fails, and the server answers that page with
 * a 404 on the same verdict. A parity test holds them together.
 *
 * The version bytes and HRPs come from the canonical coin definitions, so a coin
 * or network added there is checked here without a second table.
 *
 ********************************************************************/

'use strict';

const coins = require('../../coins');

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_CHARSET  = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GEN      = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

// Per coin code (BTC, TLTC, RDOGE, ...), resolved once: getCoinConfig clones the
// coin file, which is more than one page view should pay for.
const paramsCache = new Map();

/**
 * The address params for a coin code, or null when the code names no coin.
 *
 * @param {object} config the explorer config, for COIN_NETWORKS and COIN_PREFIXES
 * @param {string} code coin code as the path names it, uppercased
 * @returns {{p2pkh: number, p2sh: number, hrp: string|null}|null}
 */
function addressParams(config, code){
    if(paramsCache.has(code))
        return paramsCache.get(code);
    let params = null;
    for(const network of Object.keys(config.COIN_PREFIXES || {})){
        for(const tick of Object.keys(config.COIN_NETWORKS || {})){
            if(config.COIN_PREFIXES[network] + tick !== code)
                continue;
            const net = coins.getCoinConfig(tick, network).net;
            params = { p2pkh: net.pubKeyHash, p2sh: net.scriptHash, hrp: net.bech32 || null };
        }
    }
    paramsCache.set(code, params);
    return params;
}

/**
 * Decode a base58 string to bytes, or false on a bad charset or implausible length.
 */
function base58Decode(str){
    if(str.length < 26 || str.length > 48)
        return false;
    let num = 0n;
    for(const char of str){
        const value = BASE58_ALPHABET.indexOf(char);
        if(value === -1)
            return false;
        num = num * 58n + BigInt(value);
    }
    let hex = num.toString(16);
    if(hex.length % 2)
        hex = '0' + hex;
    let bytes = [];
    if(num !== 0n)
        for(let i = 0; i < hex.length; i += 2)
            bytes.push(parseInt(hex.substring(i, i + 2), 16));
    // Each leading '1' is a leading zero byte the number itself cannot carry.
    let leading = 0;
    while(leading < str.length && str[leading] === '1')
        leading++;
    return new Array(leading).fill(0).concat(bytes);
}

/**
 * The BIP-173 polymod over the expanded HRP and the data words.
 */
function bech32Polymod(hrp, data){
    let values = [];
    for(let i = 0; i < hrp.length; i++)
        values.push(hrp.charCodeAt(i) >> 5);
    values.push(0);
    for(let i = 0; i < hrp.length; i++)
        values.push(hrp.charCodeAt(i) & 31);
    let chk = 1;
    for(const value of values.concat(data)){
        const top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ value;
        for(let i = 0; i < 5; i++)
            if((top >> i) & 1)
                chk ^= BECH32_GEN[i];
    }
    return chk;
}

/**
 * Decode a bech32/bech32m segwit address to its HRP, or false when the checksum
 * or the witness rules fail.
 */
function bech32Decode(address){
    if(address !== address.toLowerCase() && address !== address.toUpperCase())
        return false;
    const str = address.toLowerCase();
    if(str.length < 8 || str.length > 90)
        return false;
    const pos = str.lastIndexOf('1');
    if(pos < 1 || pos + 7 > str.length)
        return false;
    const hrp  = str.substring(0, pos);
    let data = [];
    for(const char of str.substring(pos + 1)){
        const value = BECH32_CHARSET.indexOf(char);
        if(value === -1)
            return false;
        data.push(value);
    }
    const version = data[0];
    if(version > 16)
        return false;
    // Segwit v0 uses the bech32 constant, v1 and later bech32m (BIP-350).
    if(bech32Polymod(hrp, data) !== (version === 0 ? 1 : 0x2bc830a3))
        return false;
    // The witness program is the data words less the version and the checksum.
    const programBits = (data.length - 7) * 5;
    const programLen  = Math.floor(programBits / 8);
    if(programBits % 8 >= 5 || programLen < 2 || programLen > 40)
        return false;
    if(version === 0 && programLen !== 20 && programLen !== 32)
        return false;
    return hrp;
}

/**
 * Whether a path segment has the shape of an address on this coin and network.
 *
 * @param {object} config the explorer config
 * @param {string} code coin code, e.g. 'BTC' or 'TLTC'
 * @param {string} address the path segment
 * @returns {boolean|null} the verdict, or null when the coin code is not one this
 *   check knows, so the caller can leave the page alone
 */
function isCoinAddress(config, code, address){
    const params = addressParams(config, String(code).toUpperCase());
    if(params === null)
        return null;
    const str = String(address);
    const hrp = bech32Decode(str);
    if(hrp !== false)
        return params.hrp !== null && hrp === params.hrp;
    const bytes = base58Decode(str);
    if(!bytes || bytes.length !== 25)
        return false;
    return bytes[0] === params.p2pkh || bytes[0] === params.p2sh;
}

module.exports = { isCoinAddress };
