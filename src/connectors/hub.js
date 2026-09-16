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
 * XChain Explorer - Hub Connector
 *
 * This file handles connecting to XChain hub instances with
 * multi-endpoint fallback for high availability.
 *
 ********************************************************************/

const axios = require('axios');
// The getallconfigs half of the connector, installed onto the class below.
const HubConfigSync = require('./hub/config_sync.js');
// One logger for the whole service: getLogger() resolves to the shipper once api.js
// installs observability, and falls through to bare console before that.
const { getLogger } = require('../observability');
const log = getLogger();

// Environment reads go through config.js's live read-through view of process.env.
// config.js requires this module at its top, before it has built its exports, so
// the view is looked up each time a read runs and never captured at load.
const configEnv = () => require('../config.js').env;

// The x-api-key header set for one endpoint pass, read from the live environment.
function hubRequestHeaders(){
    // Attach the hub API key when configured: getallconfigs is in the
    // hub's sensitive-read tier and 401s without it once HUB_API_KEY is
    // set hub-side. Read methods that don't need it ignore it, so
    // sending unconditionally is safe (same pattern as xchain-node's
    // HubConnector).
    //
    // HUB_CONFIG_SECRETS_API_KEY wins when set: the hub can split the
    // credential tier (getallconfigs with include_secrets, which is the
    // only way the explorer gets its DB passwords) onto a key of its own,
    // and one request carries one x-api-key header. Unset, the bulk key
    // authorizes both tiers, which is the ordinary deployment.
    let headers = {};
    let hubKey = configEnv().HUB_CONFIG_SECRETS_API_KEY || configEnv().HUB_API_KEY;
    if(hubKey) headers['x-api-key'] = hubKey;
    return headers;
}

// One pass over every endpoint, starting at the last one that answered. Answers
// { answered: true, result } on the first healthy result, and otherwise
// { answered: false, rpcAnswered } with this pass's failures recorded on the
// connector and on `out`, and any degraded body remembered on `state`.
async function endpointPass(connector, data, { timeout, attempt, attempts, out }, state){
    // Endpoints this pass that answered with a JSON-RPC error body
    // rather than a result: the hub was up and refused the request at
    // the protocol layer, which is not the same signal as unreachable.
    let rpcAnswered = 0;
    let headers = hubRequestHeaders();
    for(let i = 0; i < connector.urls.length; i++){
        let idx = (connector._lastGoodIdx + i) % connector.urls.length;
        let url = connector.urls[idx];
        try {
            let response = await axios.post(url, data, { timeout, headers });
            if(response.data && response.data.result !== undefined){
                connector._lastGoodIdx = idx;
                return { answered: true, result: response.data.result };
            }
            if(response.data && response.data.error !== undefined){
                recordRpcError(connector, url, response.data.error, out);
                rpcAnswered++;
            }
        } catch(err){
            recordUnreachable(connector, url, err, { attempt, attempts, out }, state);
        }
    }
    return { answered: false, rpcAnswered };
}

// Record an endpoint's JSON-RPC error answer on the connector and on `out`.
function recordRpcError(connector, url, rpcError, out){
    // Definitive JSON-RPC error answer over 2xx (the hub's
    // router answers -32601 this way for a method its build
    // does not serve). Record it and keep walking the pass:
    // a mixed-version fleet may still hold an endpoint that
    // serves the method.
    // Held in a local so the detail line below describes THIS
    // answer even when a concurrent call overwrites the field.
    connector.lastRpcError = rpcError;
    if(out) out.rpcError = rpcError;
    let detail = url + ' -> rpc ' +
        (rpcError.code !== undefined ? rpcError.code : '?') +
        ' ' + (rpcError.message || '');
    connector.lastFailures.push(detail);
    if(out) out.failures.push(detail);
}

// A thrown request: remember a degraded JSON-RPC body carried on a non-2xx
// response, otherwise record the endpoint as unreachable and warn.
function recordUnreachable(connector, url, err, { attempt, attempts, out }, state){
    if(err.response && err.response.data && err.response.data.result !== undefined){
        state.degraded = err.response.data.result;
    } else {
        connector.lastFailures.push(url + ' -> ' + (err.code || err.message));
        if(out) out.failures.push(url + ' -> ' + (err.code || err.message));
        log.warn('HUB_ENDPOINT_FAILED', { url, attempt, attempts, code: err.code, err: err.message, stack: err.stack });
    }
}

class XChainHubConnector {

    // Endpoints are always an array of full URL strings (see parseEndpoints()).
    constructor(endpoints) {
        if (!Array.isArray(endpoints)) {
            throw new TypeError('XChainHubConnector: endpoints must be an array of URL strings');
        }
        this.urls = endpoints;
        // Retry policy for config fetches. After a power cycle the hub (and its
        // MariaDB) may take several seconds to come up; a single-pass attempt
        // loses that race and leaves the explorer with no config. Retrying a
        // few times with exponential backoff bridges the gap. ping() opts out
        // (passes attempts:1) so liveness checks stay fast. Overridable via
        // HUB_RETRY_ATTEMPTS / HUB_RETRY_DELAY_MS (tests set delay 0).
        this.maxAttempts  = Number(configEnv().HUB_RETRY_ATTEMPTS) || 4;
        this.retryDelayMs = configEnv().HUB_RETRY_DELAY_MS !== undefined
            ? Number(configEnv().HUB_RETRY_DELAY_MS) : 2000;
        // Sticky-last-good endpoint: start each endpoint pass at the last
        // endpoint that answered, so a degraded first endpoint isn't retried
        // first every call (which would cost the full timeout per call before
        // falling back).
        this._lastGoodIdx = 0;
        // Per-endpoint failure detail from the most recent call() (final retry
        // pass). Populated with "url -> code|message" strings for each unreachable
        // endpoint so callers can report exactly what was tried and why, instead
        // of a bare null.
        this.lastFailures = [];
        // JSON-RPC error object from the most recent call() that got a definitive
        // protocol-level answer (e.g. {code:-32601} from a hub build that does not
        // serve the method). Distinct from lastFailures: the hub was reachable and
        // refused the request, so callers can report a capability gap instead of
        // an outage. null when the last call got a result or never got an answer.
        //
        // Both fields are LAST-CALL-WINS diagnostics on a connector shared by the
        // whole process, so a caller that decides control flow from them must pass
        // `out` to call and read the per-invocation copy instead: two calls in
        // flight interleave across the await and one reads the other's answer.
        this.lastRpcError = null;
        // Cached full config tree + its high-water mark (epoch seconds). The mark
        // is sent back as `since_updated_at` so the hub returns only rows changed
        // since the previous poll; the delta is merged into this cache and the
        // full map is returned, so config.js sees the same shape as before. 0
        // (initial / post-restart / old hub) requests the full tree.
        this.configs       = null;
        this.lastWatermark = 0;
        // Endpoint index the cursor was obtained from. A wall-clock since_updated_at
        // cursor is only valid against the hub that produced it (each hub stamps
        // updated_at = NOW() at its own apply time of a PBFT-committed config), so on
        // failover to a different endpoint the cursor must be reset and re-fetched full.
        this._watermarkEndpointIdx = null;
    }

    // Internal: call a JSON-RPC method, trying each endpoint starting from the
    // last one that succeeded and wrapping around through the rest. Repeats the
    // full endpoint pass up to `attempts` times with exponential backoff before
    // giving up and returning null.
    //
    // `out`, when supplied, is a CALL-SCOPED diagnostics sink: this invocation
    // writes its own `rpcError` and `failures` onto it. The instance fields below
    // are last-call-wins on a process-wide connector, so a caller that branches on
    // the answer (HubOperationalCache's -32601 capability-gap throw) must read
    // `out` or it can read a concurrent call's error across its own await.
    async call(data, { timeout = 5000, attempts = this.maxAttempts, delayMs = this.retryDelayMs, out = null } = {}){
        // A reachable-but-unhealthy hub responds with a non-2xx status (e.g. the
        // 503 "degraded" health body returned when its DB pool is down) that
        // still carries a valid JSON-RPC body. Axios throws on any non-2xx, so
        // without inspecting err.response that state is indistinguishable from an
        // unreachable endpoint. Remember such a body as a fallback but keep
        // retrying (a degraded DB may recover within the backoff window), and
        // only surface it if no endpoint comes back healthy.
        const state = { degraded: null };
        this.lastRpcError = null;
        if(out){ out.rpcError = null; out.failures = []; }
        for(let attempt = 1; attempt <= attempts; attempt++){
            // Reset each pass so lastFailures reflects the final attempt's
            // outcome rather than accumulating duplicates across retries.
            this.lastFailures = [];
            // A separate array, never an alias of the instance field: a concurrent
            // call rebinds this.lastFailures out from under us on its own pass.
            if(out) out.failures = [];
            const pass = await endpointPass(this, data, { timeout, attempt, attempts, out }, state);
            if(pass.answered) return pass.result;
            // Every endpoint answered at the protocol layer (no endpoint was
            // unreachable): the outcome is deterministic for this request, so
            // backoff cannot change it and the unreachable warning below would
            // misname a live hub as down. Give up without retrying.
            if(pass.rpcAnswered === this.urls.length) break;
            // All endpoints failed this pass. Back off before the next unless
            // this was the final attempt.
            if(attempt < attempts){
                const backoff = delayMs * Math.pow(2, attempt - 1);
                log.warn('HUB_ENDPOINTS_UNREACHABLE', { attempt, attempts, retry_in_ms: backoff });
                await new Promise(resolve => setTimeout(resolve, backoff));
            }
        }
        // No endpoint returned a healthy result after all retries. Surface a
        // reachable-but-degraded response (if any) so the caller can distinguish
        // "up but DB down" from "unreachable"; otherwise null.
        return state.degraded;
    }

    async ping(){
        // Liveness check: a single attempt, no retry/backoff.
        let result = await this.call({ jsonrpc: '2.0', method: 'ping', id: 1 }, { attempts: 1 });
        // A reachable-but-degraded hub returns a non-null {status:"degraded"}
        // body. The hub is up, so report it as reachable, but log the degraded
        // state so it stays visible to operators.
        if(result && typeof result === 'object' && result.status === 'degraded'){
            log.warn('HUB_DEGRADED', { result });
        }
        return result !== null;
    }

    // Params for every getallconfigs call this connector makes.
    //
    // include_secrets is NOT optional for the explorer: db/index.js builds its MariaDB
    // pools straight out of this tree (db_host/db_port/user/pass per coin), so a
    // redacted response leaves every pool authenticating with the literal
    // "[redacted]". The hub redacts secret-bearing params by default and serves
    // them only to a caller that asks and is authorized to (HUB_CONFIG_SECRETS_API_KEY
    // when the hub sets one, the bulk HUB_API_KEY otherwise), which is why the
    // explorer sends the flag and other config consumers - the indexer's param
    // overlay, the SDK's explorer discovery, the dashboard - do not.
    //
    // Older hubs ignore an unknown param and return the full tree, so this is safe
    // to deploy ahead of the hub change (and must be: an explorer without the flag
    // against a redacting hub loses its DB passwords).
    configParams(cursor){
        return { since_updated_at: cursor, include_secrets: true };
    }

    // One warning, not one per 60s poll: a redacted response means this explorer
    // is not authorized for credentials (wrong or missing HUB_API_KEY /
    // HUB_CONFIG_SECRETS_API_KEY), and the DB pools built from it will fail to
    // authenticate. Said here because the failure otherwise surfaces several
    // layers away as an opaque MariaDB access-denied per coin.
    warnIfRedacted(result){
        if(!result || typeof result !== 'object' || result.secrets_redacted !== true) return;
        if(this._warnedRedacted) return;
        this._warnedRedacted = true;
        log.error('HUB_CONFIG_CREDENTIALS_REDACTED', {
            redacted_params: result.redacted_params || 0,
            detail: 'the hub served a CREDENTIAL-REDACTED config tree (' + (result.redacted_params || 0) +
                ' params withheld): this explorer asked for secrets but is not authorized for them. ' +
                'Set HUB_API_KEY (or the hub\'s HUB_CONFIG_SECRETS_API_KEY) to the value the hub expects; ' +
                'until then every DB pool built from this config will fail to authenticate.'
        });
    }

}

// Parse the hub endpoints out of the environment variables.
// Returns an array of URL strings (e.g., ["http://host1:10000", "http://host2:10000"]),
// or null when the hub is intentionally disabled (standalone mode).
XChainHubConnector.parseEndpoints = function(){
    // Standalone mode: when the hub is disabled (NO_HUB=1) the explorer reads its
    // coin/network + DB config from src/config.json instead of the hub. Returning
    // null makes getConfig()/startSync() take the file/NODE_CONFIG path (see
    // config.js). This is how a single-server instance points at a local/synced
    // MariaDB the hub doesn't advertise (the hub publishes docker-internal db_host).
    if(['1','true','yes'].includes(String(configEnv().NO_HUB || '').toLowerCase()))
        return null;
    if(configEnv().HUB_VALIDATORS){
        return configEnv().HUB_VALIDATORS.split(',')
            .map(e => e.trim())
            .filter(e => e)
            .map(e => e.startsWith('http') ? e : 'http://' + e);
    }
    let host = configEnv().HUB_API_HOST || 'localhost';
    let port = configEnv().HUB_PORT || '10000';
    return ['http://' + host + ':' + port];
};

// Copy each part's methods onto the class prototype by descriptor, so they stay
// non-enumerable exactly as methods written in the class body are, and refuse a
// name the class already defines: a split must never silently shadow a method.
function installParts(target, parts){
    for(const part of parts){
        for(const name of Object.getOwnPropertyNames(part.prototype)){
            if(name === 'constructor') continue;
            if(Object.prototype.hasOwnProperty.call(target.prototype, name))
                throw new Error(target.name + ': part method ' + name + ' collides with an existing method');
            Object.defineProperty(target.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name));
        }
    }
}

installParts(XChainHubConnector, [HubConfigSync]);

module.exports = XChainHubConnector
