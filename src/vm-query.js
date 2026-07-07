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
 **********************************************************************/

/**
 * Read-only contract simulation for the explorer's contract page: runs a
 * deployed contract method in a sandboxed xchain-vm against current state
 * loaded from the indexer DB, then discards all effects. This is the
 * platform's eth_call equivalent; nothing here touches consensus (the
 * "would-be" state changes and emissions are returned for display only and
 * are never committed).
 *
 * xchain-vm is an OPTIONAL dependency (its isolated-vm native module only
 * builds on Node 22), so it is lazy-required on first use and every entry
 * point degrades to a typed error when the module is unavailable. The whole
 * feature is gated behind EXPLORER_VM_QUERY_ENABLED (default off): running
 * arbitrary on-chain code, however sandboxed, is a compute surface an
 * operator must consciously enable.
 */

const crypto = require('crypto');

// Display-only copy of the indexer's gas schedule (xchain-indexer/src/coins/
// BTC.js). The explorer's config pipeline has no GAS_SCHEDULE source, and the
// simulated gasUsed is informational, never fee-charged, so a static copy is
// safe. Keys must satisfy GasTracker's canonical-key check in xchain-vm.
const GAS_SCHEDULE = {
    ISSUE:                 100000,
    ISSUE_SUBTOKEN:        50000,
    EXPIRATION_PER_DAY:    550,
    OWNERSHIP_ESCROW:      50000,
    AIRDROP_PER_RECIPIENT: 100,
    DIVIDEND_PER_RECIPIENT: 100,
    VM_EXECUTE_BASE:       1000,
    VM_DEPLOY_BASE:        100000,
    VM_DEPLOY_PER_BYTE:    10,
    VM_STATE_READ:         100,
    VM_STATE_WRITE:        200,
    VM_STATE_DELETE:       100,
    VM_ORACLE_READ:        100,
    VM_CROSSCHAIN_READ:    100,
    VM_ATTEST_REQUEST:     5000,
    VM_XCALL_REQUEST:      2000,
    VM_XCALL_CALLBACK:     20000,
    VM_EMISSION:           500,
    VM_COMPUTATION:        1,
    VM_GUARD_GAS_CEILING:  200000,
};

// Deliberately far below the indexer's consensus config (1M gas / 30s): this
// is a public, unauthenticated endpoint and a simulation that cannot finish
// inside these bounds is not worth serving.
const VM_OPTIONS = {
    execution:   'subprocess',
    gasSchedule: GAS_SCHEDULE,
    gasCeiling:  200000,
    limits: {
        maxCpuTimeMs:      3000,
        maxMemory:         8,
        maxEmissions:      20,
        maxStateKeys:      10000,
        maxStateValueSize: 65536,
        maxCodeSize:       65536
    }
};

// Wire-format limits mirrored from the VM's own emit.execute validation
// (xchain-vm/src/gateway-emit.js): method <= 64 bytes, params <= 32 entries of
// <= 1024 bytes each. Requests beyond these could never be real EXECUTEs.
const MAX_METHOD_BYTES = 64;
const MAX_PARAMS       = 32;
const MAX_PARAM_BYTES  = 1024;

let XChainVM    = null;   // resolved module (or null until first use)
let vmLoadError = null;   // sticky load failure so we don't re-require per request
let vmInstance  = null;   // lazy singleton; one subprocess worker for all requests
let inFlight    = 0;

function isEnabled(){
    return process.env.EXPLORER_VM_QUERY_ENABLED === 'true';
}

function maxConcurrent(){
    return parseInt(process.env.EXPLORER_VM_MAX_CONCURRENT, 10) || 4;
}

// Byte cap on the initial state load (rows are capped by maxStateKeys). The
// VM's own limits only bound NEW state writes; without this an attacker can
// point simulations at a contract whose accumulated state is huge and burn
// SQL + JSON.parse + IPC on every call.
function maxStateBytes(){
    return parseInt(process.env.EXPLORER_VM_MAX_STATE_BYTES, 10) || 4 * 1024 * 1024;
}

// Typed failure the route maps to an HTTP status. keeps VM-internal errors
// distinguishable from bad requests without string-matching at the route.
class VmQueryError extends Error {
    constructor(code, message, httpStatus){
        super(message);
        this.code       = code;
        this.httpStatus = httpStatus;
    }
}

// Load xchain-vm exactly once. A host whose isolated-vm never built (wrong
// Node major, standalone checkout without the vendored copy) fails here and
// every later call short-circuits on the sticky error.
function loadVm(){
    if(XChainVM || vmLoadError) return;
    try {
        XChainVM = require('xchain-vm');
    } catch(e){
        vmLoadError = e;
    }
}

function getVm(){
    loadVm();
    if(!XChainVM)
        throw new VmQueryError('VM_MODULE_UNAVAILABLE', 'xchain-vm is not available on this host (isolated-vm requires Node 22)', 503);
    if(!vmInstance)
        vmInstance = new XChainVM(VM_OPTIONS);
    return vmInstance;
}

// Validate the request body before any DB or VM work. Throws VmQueryError
// with httpStatus 400 on the first violation.
function validateRequest(body){
    const method = body ? body.method : null;
    if(typeof method !== 'string' || method.length === 0 || Buffer.byteLength(method, 'utf8') > MAX_METHOD_BYTES)
        throw new VmQueryError('BAD_METHOD', 'method must be a non-empty string of at most ' + MAX_METHOD_BYTES + ' bytes', 400);
    if(method.indexOf('|') !== -1 || method.indexOf(';') !== -1)
        throw new VmQueryError('BAD_METHOD', 'method must not contain wire delimiters', 400);

    let params = body.params === undefined || body.params === null ? [] : body.params;
    if(!Array.isArray(params) || params.length > MAX_PARAMS)
        throw new VmQueryError('BAD_PARAMS', 'params must be an array of at most ' + MAX_PARAMS + ' entries', 400);
    params = params.map(p => String(p));
    for(const p of params){
        if(Buffer.byteLength(p, 'utf8') > MAX_PARAM_BYTES)
            throw new VmQueryError('BAD_PARAMS', 'each param must be at most ' + MAX_PARAM_BYTES + ' bytes', 400);
        if(p.indexOf('|') !== -1)
            throw new VmQueryError('BAD_PARAMS', 'params must not contain the | wire delimiter', 400);
    }

    let caller = null;
    if(body.caller !== undefined && body.caller !== null && body.caller !== ''){
        if(typeof body.caller !== 'string' || body.caller.length > 128)
            throw new VmQueryError('BAD_CALLER', 'caller must be an address string', 400);
        caller = body.caller;
    }
    return { method, params, caller };
}

/**
 * Run one read-only simulation. Loads the contract's code and current state
 * from the indexer DB, executes the method against the chain tip's block
 * context with all consensus snapshots nulled (the gateway degrades: oracle /
 * cross-chain / balance reads return null inside the contract), and returns
 * the raw VM result. Effects are NOT committed anywhere.
 *
 * @param {object} db      The explorer Database instance
 * @param {object} config  Route config ({coin, data:{}}) for doQuery
 * @param {number} contractIndex
 * @param {object} body    {method, params?, caller?}
 * @param {string} chain   Base chain name (BTC/LTC/DOGE) for the contract address
 * @param {string} network mainnet | testnet | regtest
 */
async function simulate(db, config, contractIndex, body, chain, network){
    if(!isEnabled())
        throw new VmQueryError('VM_QUERY_DISABLED', 'contract simulation is disabled on this explorer', 503);

    const { method, params, caller } = validateRequest(body);
    const vm = getVm();

    if(inFlight >= maxConcurrent())
        throw new VmQueryError('VM_BUSY', 'too many concurrent simulations, retry shortly', 429);
    // Reserve the slot at the gate: the DB loads below await, and a burst
    // arriving during them must not all pass the check above. Bracketing the
    // loads also puts the (potentially heavy) state queries under the cap.
    inFlight++;
    try {
        // Contract source (the simulation runs the exact on-chain code).
        let rows = await db.doQuery(config, 'SELECT code FROM contracts WHERE action_index=? LIMIT 1', [contractIndex]);
        if(!rows || !rows.length)
            throw new VmQueryError('NOT_FOUND', 'contract not found', 404);

        let state;
        try {
            state = await db.getContractFullState(config, contractIndex, {
                maxRows:  VM_OPTIONS.limits.maxStateKeys,
                maxBytes: maxStateBytes()
            });
        } catch(e){
            if(e && e.code === 'STATE_TOO_LARGE')
                throw new VmQueryError('STATE_TOO_LARGE', 'contract state exceeds simulation limits', 413);
            throw e;
        }
        const blockIndex  = await db.getMaxBlockIndex(config);
        const blockTime   = await db.getMaxBlockTime(config);
        // Same synthetic hash derivation the indexer uses for real executions
        // (sha256 of "index:time"); contracts reading getBlockHash see the same
        // shape they would on-chain.
        const blockHash   = crypto.createHash('sha256')
            .update(String(blockIndex) + ':' + String(blockTime)).digest('hex');

        // Default caller is a synthetic marker (eth_call-from-zero semantics):
        // contracts comparing it to real addresses get false, so permissioned
        // branches behave as "not the admin" unless the user supplies one.
        return await vm.execute({
            code:              rows[0].code,
            state:             state,
            method:            method,
            params:            params,
            caller:            caller || 'simulation',
            contractAddress:   'C:' + chain + ':' + contractIndex,
            contractIndex:     contractIndex,
            txHash:            '',
            blockContext:      { height: blockIndex, timestamp: blockTime, hash: blockHash },
            callDepth:         0,
            actionIndex:       0,
            callPath:          '',
            rootActionIndex:   0,
            network:           network || '',
            balances:          null,
            tokenInfo:         null,
            oracleData:        null,
            crossChainData:    null,
            pollData:          null,
            attestationData:   null,
            contractStakeData: null
        });
    } finally {
        inFlight--;
    }
}

// Tear down the subprocess worker on host shutdown. Safe to call when the
// feature never loaded (no-op).
async function shutdown(){
    if(vmInstance){
        try { await vmInstance.shutdown(); } catch(e){ /* already dying */ }
        vmInstance = null;
    }
}

module.exports = { isEnabled, simulate, shutdown, VmQueryError };
