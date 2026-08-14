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
 * XChain Explorer - Utility Class
 * 
 * This file provides utility functions used throughout the explorer
 *
 ********************************************************************/

const mathjs = require('mathjs');
const fs     = require('fs/promises');
const crypto = require('crypto');

class Utility {

    constructor(configInfo){
        this.configInfo = configInfo;
    }

    throwError(error){
        console.error('throwError: ' + error);
        throw new Error(error);
    }

    logError(error, info){
        console.error('logError: ' + error, info);
        this.throwError(error);
    }

    startTimer(){
        let now = Date.now();
        return now;
    }

    getTimer(timer){
        let now = Date.now();
        let ms  = now - timer;
        return ms;
    }

    getTimerString(ms){
        let niceString = ms + 'ms';
        let timeString = this.millisecondsToTimeString(ms);
        if(timeString!='')
            niceString = timeString;
        return niceString;
    }

    logTimer(timer, timeName){
        var timeString = this.getTimer(timer);
        var niceString = (timeName!=null) ? timeName : 'Time';
        if(timeString!='')
            niceString += '\t: (' + timeString + ')';
        console.log(niceString);
    }

    millisecondsToTimeString(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
            seconds      = Math.floor((ms / 1000) % 60),
            minutes      = Math.floor((ms / (1000 * 60)) % 60),
            hours        = Math.floor((ms / (1000 * 60 * 60)) % 24),
            days         = Math.floor((ms / (1000 * 60 * 60 * 24)) % 365);
        hours   = (hours < 10)   ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;
        var str = '';
        if(days    > 0) str += days + 'd ';
        if(hours   > 0) str += hours + 'h ';
        if(minutes > 0) str += minutes + 'm ';
        if(seconds > 0) str += seconds + '.' + milliseconds + 's';
        return str;
    }

    // Handle getting the local wall-clock time in seconds.
    // NOTE: this is non-deterministic across hosts. It is for display-only use
    // (e.g. relative "x ago" timers) and must NEVER be used to derive any value
    // that should match consensus state; block processing and any activation /
    // expiration check that mirrors the indexer must use a block timestamp.
    getWallClockTime(){
        return this.bcdiv(Date.now(), 1000, 0);
    }

    async fileExists(filePath){
        let exists = false;
        try {
            await fs.access(filePath);
            exists = true;
        } catch (error){
            if(error.code === 'ENOENT'){
                // file does not exist
            } else {
                // ignore permission errors etc.
            }
        }
        return exists;
    }

    async fileGetContents(filePath){
        let data = false;
        try {
            data = await fs.readFile(filePath, 'utf8');
        } catch (error) {
            // swallow
        }
        return data;
    }

    // Convert a string number to a mathjs bignumber for full precision
    bcnum(num){
        return mathjs.bignumber(num);
    }

    bcformat(num, decimals){
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(this.bcnum(num),{notation: 'fixed', precision: d});
    }

    bcsub(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.subtract(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    bcadd(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.add(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    bcmul(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.multiply(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    bcdiv(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.divide(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    // Handle comparing two big numbers: returns true if numA > numB
    //
    // Uses decimal.js's native .gt/.lt/.gte/.lte (exact) rather than
    // mathjs.larger/smaller/largerEq/smallerEq, which apply mathjs's comparison
    // epsilon (~1e-12 relative) and treat any two amounts differing by less than
    // that as EQUAL, corrupting every comparison of sub-1e-12 amounts for
    // 18-decimal tokens (e.g. bcgt('0.000000000000001','0') returned false).
    bcgt(numA, numB){
        return mathjs.bignumber(numA).gt(mathjs.bignumber(numB));
    }

    bclt(numA, numB){
        return mathjs.bignumber(numA).lt(mathjs.bignumber(numB));
    }

    bcgte(numA, numB){
        return mathjs.bignumber(numA).gte(mathjs.bignumber(numB));
    }

    bclte(numA, numB){
        return mathjs.bignumber(numA).lte(mathjs.bignumber(numB));
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    isNumeric(value){
        return typeof value === 'bigint' || (!isNaN(parseFloat(value)) && isFinite(value));
    }

    isFloat(value){
        return value === +value && value !== (value|0);
    }

    isInteger(value){
        return Number.isInteger(+value);
    }

    isNull(value){
        return (value === null || value === undefined || value==='');
    }

    // JSON.stringify with BigInt and mathjs BigNumber support
    jsonStringify(obj){
        return JSON.stringify(obj, (key, value) => {
            if(typeof value === 'bigint') 
                return value.toString();
            if(value && typeof value === 'object' && value.mathjs === 'BigNumber'){
                // toJSON().value is Decimal.toString(), which is scientific notation below
                // ~1e-7 and above ~1e21 (e.g. '3e-8', '1e-18'), breaking client decimal-string
                // comparison against the wire format. Serialize fixed, matching the indexer's
                // safeToString guard.
                //
                // Guard the conversion: this replacer runs over DB-sourced rows and (via
                // /relay) over external JSON, so a hostile object merely SHAPED like a
                // serialized BigNumber (`{mathjs:'BigNumber', value:'not-a-number'}`) would
                // otherwise make mathjs.bignumber() throw a DecimalError mid-serialize. On the
                // catch-all API path that throw becomes an unhandled rejection (the send()
                // argument is evaluated outside any try/catch), so it must NOT propagate here.
                // Fall back to the raw value string so a malformed value serializes rather than
                // crashes the response.
                try {
                    return mathjs.format(mathjs.bignumber(value.value), {notation: 'fixed'});
                } catch(e){
                    return (value.value === undefined || value.value === null) ? null : String(value.value);
                }
            }
            return value;
        });
    }
    
    // Escape special LIKE wildcard characters in user input
    escapeLike(value){
        return String(value).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    }

    // Safely parse an integer value, returning defaultVal if parsing fails or result is not finite
    sanitizeInt(value, defaultVal=0){
        let parsed = parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : defaultVal;
    }

    // Every address format XChain serves (base58 BTC/LTC/DOGE, bech32, xchain
    // account tokens) is plain alphanumeric within a bounded length. A URL path
    // segment echoed back into a response is not: it can carry HTML/script
    // metacharacters, so anything reflected as an "address" must pass this
    // shape check first, not just get URL-decoded and forwarded.
    isAddressLike(value){
        return typeof value === 'string' && /^[A-Za-z0-9]{1,128}$/.test(value);
    }

    ksort(obj){
        const sortedKeys = Object.keys(obj).sort();
        const sortedObj = sortedKeys.reduce((acc, key) => {
            acc[key] = obj[key];
            return acc;
        }, {});
        return sortedObj;
    }

    // Uses 64-decimal precision to preserve very small prices without loss
    getPrice(numerator, denominator, precision=64){
        return this.bcdiv(numerator, denominator, precision);
    }

    priceSort(data, order='ASC'){
        data.sort((a, b) => {
            if(a.price > b.price)
                return (order=='DESC') ? -1 : 1;
            if(a.price < b.price)
                return (order=='DESC') ? 1 : -1;
            return 0;
        });
        return data;
    }

    // Verify an Ed25519 signature over a UTF-8 payload: returns true/false (never
    // throws). Mirrors xchain-indexer/src/ed25519.js / the hub's ValidatorIdentity
    // (raw 32-byte pubkey wrapped in the RFC 8410 SPKI DER prefix), so checkpoint
    // signatures produced by validators verify identically here.
    ed25519Verify(payload, sigHex, pubkeyHex){
        if(!payload || !sigHex || !pubkeyHex) return false;
        if(!/^[0-9a-fA-F]{64}$/.test(pubkeyHex)) return false;
        if(!/^[0-9a-fA-F]{128}$/.test(sigHex)) return false;
        try {
            let spkiDer = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubkeyHex, 'hex')]);
            let pubkeyObj = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
            return crypto.verify(null, Buffer.from(payload, 'utf8'), pubkeyObj, Buffer.from(sigHex, 'hex'));
        } catch (e) {
            return false;
        }
    }

}

module.exports = Utility;