/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain Explorer - Utility Class
 * 
 * This file provides utility functions used throughout the explorer
 *
 ********************************************************************/

// Load required libraries
const mathjs = require('mathjs');
const fs     = require('fs/promises');

class Utility {

    // Handle constructing a class instance
    constructor(configInfo){
        // Setup alias to passed config
        this.configInfo = configInfo;
    }

    /******************************************************************
     * Error functions
     ******************************************************************/

    // Throw an error and log to console
    throwError(error){
        console.error('throwError: ' + error);
        throw new Error(error);
    }

    // Log an error to the error.log file
    logError(error, info){
        // let file  = '/XChainIndexer/error.log';
        // fs.appendFileSync(file, error);
        console.error('logError: ' + error, info);
        // DEBUG: Throw exception on any error
        this.throwError(error);
    }

    /******************************************************************
     * Timer functions
     ******************************************************************/

    // Start a debug timer
    startTimer(){
        let now = Date.now();
        return now;
    }

    // get a timer using a given name
    getTimer(timer){
        let now = Date.now();
        let ms  = now - timer;
        return ms;
    }

    // Get human readable time string based on milliseconds
    getTimerString(ms){
        let niceString = ms + 'ms';
        let timeString = this.millisecondsToTimeString(ms);
        if(timeString!='')
            niceString = timeString;
        return niceString;
    }

    // Log a timer using a given name (timeName : (timeString))
    logTimer(timer, timeName){
        var timeString = this.getTimer(timer);
        var niceString = (timeName!=null) ? timeName : 'Time';
        if(timeString!='')
            niceString += '\t: (' + timeString + ')';
        console.log(niceString);
    }

    // Create nice human readable time string based on miliiseconds
    millisecondsToTimeString(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
            seconds      = Math.floor((ms / 1000) % 60),
            minutes      = Math.floor((ms / (1000 * 60)) % 60),
            hours        = Math.floor((ms / (1000 * 60 * 60)) % 24),
            days         = Math.floor((ms / (1000 * 60 * 60 * 24)) % 365);
        // Display time in XX format
        hours   = (hours < 10)   ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;
        // Build out time string to nicely display time
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
    // that should match consensus state — block processing and any activation /
    // expiration check that mirrors the indexer must use a block timestamp.
    getWallClockTime(){
        return this.bcdiv(Date.now(), 1000, 0);
    }

    /******************************************************************
     * File Functions 
     ******************************************************************/

    // Handle checking if a file exists and return true/false
    async fileExists(filePath){
        let exists = false;
        try {
            await fs.access(filePath); // Attempts to access the file
            exists = true;
        } catch (error){
            if(error.code === 'ENOENT'){
                // File does not exist
            } else {
                // Handle other potential errors (e.g., permission issues)
                // throw error;
            }
        }
        return exists;
    }

    // Handle getting contents of a file
    async fileGetContents(filePath){
        let data = false;
        try {
            data = await fs.readFile(filePath, 'utf8'); // 'utf8' specifies the encoding
        } catch (error) {
            // console.error('Error reading file:', error);
            // throw error; // Re-throw the error for further handling
        }
        return data;
    }

    /******************************************************************
     * BC math functions
     ******************************************************************/

    // Handle converting a string number to a mathjs bignumber for full precision
    bcnum(num){
        return mathjs.bignumber(num);
    }

    // Handle returning a number to a given decimal point precision
    bcformat(num, decimals){
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return mathjs.format(this.bcnum(num),{notation: 'fixed', precision: d});
    }

    // Handle subtracting 2 big numbers
    bcsub(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.subtract(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    // Handle adding 2 big numbers
    bcadd(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.add(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    // Handle multiplying 2 big numbers
    bcmul(numA, numB, decimals){
        let a = (!this.isNull(numA)) ? numA : 0;
        let b = (!this.isNull(numB)) ? numB : 0;
        let d = (!this.isNull(decimals)) ? parseInt(decimals) : 0;
        return this.bcnum(mathjs.format(mathjs.multiply(mathjs.bignumber(a),mathjs.bignumber(b)),{notation: 'fixed', precision: d}));
    }

    // Handle dividing 2 big numbers
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
    // that as EQUAL — corrupting every comparison of sub-1e-12 amounts for
    // 18-decimal tokens (e.g. bcgt('0.000000000000001','0') returned false).
    bcgt(numA, numB){
        return mathjs.bignumber(numA).gt(mathjs.bignumber(numB));
    }

    // Handle comparing two big numbers: returns true if numA < numB
    bclt(numA, numB){
        return mathjs.bignumber(numA).lt(mathjs.bignumber(numB));
    }

    // Handle comparing two big numbers: returns true if numA >= numB
    bcgte(numA, numB){
        return mathjs.bignumber(numA).gte(mathjs.bignumber(numB));
    }

    // Handle comparing two big numbers: returns true if numA <= numB
    bclte(numA, numB){
        return mathjs.bignumber(numA).lte(mathjs.bignumber(numB));
    }

    /* 
     * General utility functions
     */

    // Handle sleeping for a given number of milliseconds
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Determine if a value is numeric
    isNumeric(value){
        return typeof value === 'bigint' || (!isNaN(parseFloat(value)) && isFinite(value));
    }

    // Determine if value is floating point
    isFloat(value){
        return value === +value && value !== (value|0);
    }

    // Determine if value is integer
    isInteger(value){
        return value === +value && value === (value|0);
    }

    // Determine if value is null or undefined or empty
    isNull(value){
        return (value === null || value === undefined || value==='');
    }

    // JSON.stringify with BigInt and mathjs BigNumber support
    jsonStringify(obj){
        return JSON.stringify(obj, (key, value) => {
            if(typeof value === 'bigint') 
                return value.toString();
            if(value && typeof value === 'object' && value.mathjs === 'BigNumber') 
                return value.value;
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

    // Sort an object by key values
    ksort(obj){
        const sortedKeys = Object.keys(obj).sort();
        const sortedObj = sortedKeys.reduce((acc, key) => {
            acc[key] = obj[key];
            return acc;
        }, {});
        return sortedObj;
    }

    // Determine price of an item (numerator / denominator)
    // Note : Use precision up to 64 decimals points for very precise prices
    getPrice(numerator, denominator, precision=64){
        return this.bcdiv(numerator, denominator, precision);
    }

    // Handle sorting an object by the 'price' property in ASC or DESC order
    priceSort(data, order='ASC'){
        // Sort bids in DESCENDING order
        data.sort((a, b) => {
            if(a.price > b.price)
                return (order=='DESC') ? -1 : 1;
            if(a.price < b.price)
                return (order=='DESC') ? 1 : -1;
            return 0;
        });
        return data;
    }

}

module.exports = Utility;