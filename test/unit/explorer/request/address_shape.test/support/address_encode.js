'use strict';

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
 * Address encoders for the address-shape suites: base58check and
 * bech32/bech32m (BIP-173, BIP-350), so a corpus can carry a valid address
 * for every coin, network and script type without hand-pasted literals.
 */

const crypto = require('crypto');

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function sha256(buf){
    return crypto.createHash('sha256').update(buf).digest();
}

// Version byte plus payload, with the double-SHA256 checksum appended.
function base58check(version, payload){
    const body = Buffer.concat([Buffer.from([version]), payload]);
    const full = Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]);
    let num = BigInt('0x' + full.toString('hex'));
    let out = '';
    while(num > 0n){
        out = BASE58[Number(num % 58n)] + out;
        num /= 58n;
    }
    for(const byte of full){
        if(byte !== 0) break;
        out = '1' + out;
    }
    return out;
}

function polymod(values){
    let chk = 1;
    for(const value of values){
        const top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ value;
        for(let i = 0; i < 5; i++)
            if((top >> i) & 1) chk ^= GEN[i];
    }
    return chk;
}

function hrpExpand(hrp){
    const out = [];
    for(let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
    out.push(0);
    for(let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
    return out;
}

function toWords(bytes){
    const out = [];
    let acc = 0, bits = 0;
    for(const byte of bytes){
        acc = (acc << 8) | byte;
        bits += 8;
        while(bits >= 5){
            bits -= 5;
            out.push((acc >> bits) & 31);
        }
    }
    if(bits > 0) out.push((acc << (5 - bits)) & 31);
    return out;
}

// A segwit address: witness version, then the program as 5-bit words.
function segwit(hrp, version, program){
    const data = [version].concat(toWords(program));
    const constant = version === 0 ? 1 : 0x2bc830a3;
    const mod = polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ constant;
    const checksum = [];
    for(let i = 0; i < 6; i++) checksum.push((mod >> (5 * (5 - i))) & 31);
    return hrp + '1' + data.concat(checksum).map(word => CHARSET[word]).join('');
}

module.exports = { base58check, segwit };
