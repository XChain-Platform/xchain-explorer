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
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Explorer - Hub Connector
 *
 * This file handles connecting to XChain hub instances with
 * multi-endpoint fallback for high availability.
 *
 ********************************************************************/

// Load required libraries
const axios = require('axios');

class XChainHubConnector {

    // Accept an array of endpoint URLs or a single host+port for backward compatibility
    constructor(endpoints, port) {
        if(Array.isArray(endpoints)){
            this.urls = endpoints;
        } else {
            this.urls = ["http://" + endpoints + ":" + port];
        }
        // Retry policy for config fetches. After a power cycle the hub (and its
        // MariaDB) may take several seconds to come up; a single-pass attempt
        // loses that race and leaves the explorer with no config. Retrying a
        // few times with exponential backoff bridges the gap. ping() opts out
        // (passes attempts:1) so liveness checks stay fast. Overridable via
        // HUB_RETRY_ATTEMPTS / HUB_RETRY_DELAY_MS (tests set delay 0).
        this.maxAttempts  = Number(process.env.HUB_RETRY_ATTEMPTS) || 4;
        this.retryDelayMs = process.env.HUB_RETRY_DELAY_MS !== undefined
            ? Number(process.env.HUB_RETRY_DELAY_MS) : 2000;
    }

    // Internal: call a JSON-RPC method, trying each endpoint in order. Repeats
    // the full endpoint pass up to `attempts` times with exponential backoff
    // before giving up and returning null.
    async _call(data, { timeout = 5000, attempts = this.maxAttempts, delayMs = this.retryDelayMs } = {}){
        for(let attempt = 1; attempt <= attempts; attempt++){
            for(let url of this.urls){
                try {
                    let response = await axios.post(url, data, { timeout });
                    if(response.data && response.data.result !== undefined)
                        return response.data.result;
                } catch(err){
                    console.warn('Hub endpoint ' + url + ' failed (attempt ' + attempt + '/' + attempts + '): ' + (err.message || err));
                }
            }
            // All endpoints failed this pass — back off before the next, unless
            // this was the final attempt.
            if(attempt < attempts){
                const backoff = delayMs * Math.pow(2, attempt - 1);
                console.warn('All hub endpoints unreachable (attempt ' + attempt + '/' + attempts + '); retrying in ' + backoff + 'ms');
                await new Promise(resolve => setTimeout(resolve, backoff));
            }
        }
        return null;
    }

    async ping(){
        // Liveness check — a single attempt, no retry/backoff.
        let result = await this._call({ jsonrpc: '2.0', method: 'ping', id: 1 }, { attempts: 1 });
        return result !== null;
    }

    async getAllConfig(){
        return await this._call({ jsonrpc: '2.0', method: 'getallconfigs', params: [], id: 1 });
    }
}

// Parse hub endpoints from environment variables
// Returns an array of URL strings (e.g., ["http://host1:10000", "http://host2:10000"])
XChainHubConnector.parseEndpoints = function(){
    if(process.env.HUB_VALIDATORS){
        return process.env.HUB_VALIDATORS.split(',')
            .map(e => e.trim())
            .filter(e => e)
            .map(e => e.startsWith('http') ? e : 'http://' + e);
    }
    let host = process.env.HUB_API_HOST || 'localhost';
    let port = process.env.HUB_PORT || '10000';
    return ['http://' + host + ':' + port];
};

module.exports = XChainHubConnector
