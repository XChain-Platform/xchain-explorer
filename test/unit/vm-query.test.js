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

// Unit tests for src/vm-query.js with the xchain-vm module STUBBED, so the
// suite runs on hosts where isolated-vm never built (the exact degraded mode
// the module must survive). The one real-VM execution path is covered by the
// integration suite, which skips itself when isolated-vm is unavailable.

const { expect } = require('chai');
// noCallThru: the whole point of the stub is hosts WITHOUT a loadable
// xchain-vm; call-through would try (and fail) to require the real module.
const proxyquire = require('proxyquire').noPreserveCache().noCallThru();

// Fresh module instance per test: vm-query keeps sticky module-level state
// (loaded module, singleton instance, in-flight counter) by design.
function loadVmQuery(vmStub){
    const stubs = {};
    if(vmStub !== undefined) stubs['xchain-vm'] = vmStub;
    return proxyquire('../../src/vm-query.js', stubs);
}

// Minimal db stub satisfying simulate()'s reads.
function dbStub(overrides = {}){
    return Object.assign({
        doQuery:              async () => [{ code: 'module.exports={}' }],
        getContractFullState: async () => Object.create(null),
        getMaxBlockIndex:     async () => 100,
        getMaxBlockTime:      async () => 1700000000
    }, overrides);
}

// The consensus surface a canonical contract-era xchain-vm exports. Every stub
// carries it by default, so the fail-closed gate () does not turn the
// rest of the suite into drift refusals; the gate's own tests override it.
const CANONICAL_VM_CONSENSUS = {
    CONSENSUS_VERSION:                   '3',
    BINARY_ALLOC_GATE_BLOCK_TIME:        1786060800,
    ASYNC_SURFACE_GATE_BLOCK_TIME:       1786060800,
    STATE_KEY_NUL_GATE_BLOCK_TIME:       1786060800,
    METERING_EVAL_ORDER_GATE_BLOCK_TIME: 1786060800,
    PKG3_SANDBOX_ACTIVATION:             { BTC: 961000 },
    MAX_CODE_SIZE:                       65536
};

// A fake XChainVM constructor whose execute resolves with a canned result
// (or a caller-supplied implementation). `consensus` overrides the exported
// consensus surface; a key set to undefined removes that export.
function fakeVmModule(executeImpl, consensus){
    const FakeVM = function FakeVM(){
        this.execute  = executeImpl || (async (opts) => ({
            success: true, error: null, gasUsed: 42,
            returnValue: '"ok"', stateChanges: [], stateDeletes: [],
            emittedActions: [], logs: [], _opts: opts
        }));
        this.shutdown = async () => {};
    };
    Object.assign(FakeVM, CANONICAL_VM_CONSENSUS, consensus || {});
    return FakeVM;
}

const CFG = { coin: 'RBTC', data: {} };

describe('vm-query', () => {
    let envBackup;
    beforeEach(() => {
        envBackup = {
            enabled:    process.env.EXPLORER_VM_QUERY_ENABLED,
            conc:       process.env.EXPLORER_VM_MAX_CONCURRENT,
            stateBytes: process.env.EXPLORER_VM_MAX_STATE_BYTES
        };
        process.env.EXPLORER_VM_QUERY_ENABLED = 'true';
    });
    afterEach(() => {
        if(envBackup.enabled === undefined) delete process.env.EXPLORER_VM_QUERY_ENABLED;
        else process.env.EXPLORER_VM_QUERY_ENABLED = envBackup.enabled;
        if(envBackup.conc === undefined) delete process.env.EXPLORER_VM_MAX_CONCURRENT;
        else process.env.EXPLORER_VM_MAX_CONCURRENT = envBackup.conc;
        if(envBackup.stateBytes === undefined) delete process.env.EXPLORER_VM_MAX_STATE_BYTES;
        else process.env.EXPLORER_VM_MAX_STATE_BYTES = envBackup.stateBytes;
    });

    it('rejects with VM_QUERY_DISABLED (503) when the flag is off', async () => {
        process.env.EXPLORER_VM_QUERY_ENABLED = 'false';
        const vmq = loadVmQuery(fakeVmModule());
        try {
            await vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest');
            throw new Error('should have thrown');
        } catch(e){
            expect(e.code).to.equal('VM_QUERY_DISABLED');
            expect(e.httpStatus).to.equal(503);
        }
        expect(vmq.isEnabled()).to.equal(false);
    });

    it('rejects with VM_MODULE_UNAVAILABLE (503) when xchain-vm did not load', async () => {
        // Stubbing the module as null models a host where the optional
        // dependency was skipped (isolated-vm build failed / never staged).
        const vmq = loadVmQuery(null);
        try {
            await vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest');
            throw new Error('should have thrown');
        } catch(e){
            expect(e.code).to.equal('VM_MODULE_UNAVAILABLE');
            expect(e.httpStatus).to.equal(503);
        }
    });

    describe('request validation (all 400)', () => {
        let vmq;
        beforeEach(() => { vmq = loadVmQuery(fakeVmModule()); });

        async function expectCode(body, code){
            try {
                await vmq.simulate(dbStub(), CFG, 1, body, 'BTC', 'regtest');
                throw new Error('should have thrown');
            } catch(e){
                expect(e.code).to.equal(code);
                expect(e.httpStatus).to.equal(400);
            }
        }

        it('missing method',            () => expectCode({}, 'BAD_METHOD'));
        it('empty method',              () => expectCode({ method: '' }, 'BAD_METHOD'));
        it('method over 64 bytes',      () => expectCode({ method: 'm'.repeat(65) }, 'BAD_METHOD'));
        it('method with wire delimiter', () => expectCode({ method: 'a|b' }, 'BAD_METHOD'));
        it('params not an array',       () => expectCode({ method: 'x', params: 'oops' }, 'BAD_PARAMS'));
        it('more than 32 params',       () => expectCode({ method: 'x', params: new Array(33).fill('p') }, 'BAD_PARAMS'));
        it('param over 1024 bytes',     () => expectCode({ method: 'x', params: ['p'.repeat(1025)] }, 'BAD_PARAMS'));
        it('param with wire delimiter', () => expectCode({ method: 'x', params: ['a|b'] }, 'BAD_PARAMS'));
        it('non-string caller',         () => expectCode({ method: 'x', caller: { a: 1 } }, 'BAD_CALLER'));
    });

    it('rejects with NOT_FOUND (404) when the contract row is missing', async () => {
        const vmq = loadVmQuery(fakeVmModule());
        try {
            await vmq.simulate(dbStub({ doQuery: async () => [] }), CFG, 1, { method: 'x' }, 'BTC', 'regtest');
            throw new Error('should have thrown');
        } catch(e){
            expect(e.code).to.equal('NOT_FOUND');
            expect(e.httpStatus).to.equal(404);
        }
    });

    it('passes nulled snapshots, tip block context, and the derived contract address to the VM', async () => {
        const vmq = loadVmQuery(fakeVmModule());
        const r = await vmq.simulate(dbStub(), CFG, 7, { method: 'run', params: ['a', 'b'] }, 'BTC', 'regtest');
        const o = r._opts;
        expect(o.contractAddress).to.equal('C:BTC:7');
        expect(o.method).to.equal('run');
        expect(o.params).to.deep.equal(['a', 'b']);
        expect(o.caller).to.equal('simulation');
        expect(o.network).to.equal('regtest');
        expect(o.blockContext.height).to.equal(100);
        expect(o.blockContext.timestamp).to.equal(1700000000);
        expect(o.blockContext.hash).to.match(/^[0-9a-f]{64}$/);
        for(const k of ['balances', 'tokenInfo', 'oracleData', 'crossChainData', 'pollData', 'attestationData', 'contractStakeData'])
            expect(o[k], k).to.equal(null);
    });

    it('threads a user-supplied caller through', async () => {
        const vmq = loadVmQuery(fakeVmModule());
        const r = await vmq.simulate(dbStub(), CFG, 7, { method: 'run', caller: 'someAddr' }, 'BTC', 'regtest');
        expect(r._opts.caller).to.equal('someAddr');
    });

    it('rejects with VM_BUSY (429) above the concurrency cap and recovers after', async () => {
        process.env.EXPLORER_VM_MAX_CONCURRENT = '1';
        let release;
        const gate = new Promise(res => { release = res; });
        const vmq = loadVmQuery(fakeVmModule(async () => { await gate; return {
            success: true, error: null, gasUsed: 1, returnValue: null,
            stateChanges: [], stateDeletes: [], emittedActions: [], logs: []
        }; }));

        const first = vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest');
        // Yield so the first call reaches the in-flight section before the probe.
        await new Promise(res => setImmediate(res));
        try {
            await vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest');
            throw new Error('should have thrown');
        } catch(e){
            expect(e.code).to.equal('VM_BUSY');
            expect(e.httpStatus).to.equal(429);
        }
        release();
        await first;
        // Slot freed: the next call goes through.
        const ok = await vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest');
        expect(ok.success).to.equal(true);
    });

    it('a burst arriving during the DB loads cannot bypass the concurrency gate', async () => {
        process.env.EXPLORER_VM_MAX_CONCURRENT = '1';
        let release;
        const gate = new Promise(res => { release = res; });
        // Block in the DB phase, BEFORE the VM runs: the slot must already be
        // reserved here, or a concurrent burst all passes the gate check.
        const db = dbStub({ doQuery: async () => { await gate; return [{ code: 'module.exports={}' }]; } });
        const vmq = loadVmQuery(fakeVmModule());
        const first = vmq.simulate(db, CFG, 1, { method: 'x' }, 'BTC', 'regtest');
        await new Promise(res => setImmediate(res));
        try {
            await vmq.simulate(db, CFG, 1, { method: 'x' }, 'BTC', 'regtest');
            throw new Error('should have thrown');
        } catch(e){
            expect(e.code).to.equal('VM_BUSY');
            expect(e.httpStatus).to.equal(429);
        }
        release();
        const r = await first;
        expect(r.success).to.equal(true);
    });

    it('caps concurrent slots PER IP so paced clients cannot hold the whole pool', async () => {
        process.env.EXPLORER_VM_MAX_CONCURRENT = '4';
        process.env.EXPLORER_VM_MAX_CONCURRENT_PER_IP = '1';
        let release;
        const gate = new Promise(res => { release = res; });
        const vmq = loadVmQuery(fakeVmModule(async () => { await gate; return {
            success: true, error: null, gasUsed: 1, returnValue: null,
            stateChanges: [], stateDeletes: [], emittedActions: [], logs: []
        }; }));
        try {
            const first = vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest', '10.0.0.1');
            await new Promise(res => setImmediate(res));
            // Same IP: per-IP cap (1) trips even though 3 global slots are free.
            try {
                await vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest', '10.0.0.1');
                throw new Error('should have thrown');
            } catch(e){
                expect(e.code).to.equal('VM_BUSY');
                expect(e.httpStatus).to.equal(429);
            }
            // A different IP still gets a slot.
            const otherIp = vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest', '10.0.0.2');
            await new Promise(res => setImmediate(res));
            release();
            await first;
            await otherIp;
            // Slot released: the same IP goes through again.
            const again = await vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest', '10.0.0.1');
            expect(again.success).to.equal(true);
        } finally {
            delete process.env.EXPLORER_VM_MAX_CONCURRENT_PER_IP;
        }
    });

    it('per-IP cap defaults to half the global pool (min 1) and skips when no IP is supplied', async () => {
        process.env.EXPLORER_VM_MAX_CONCURRENT = '4';   // default per-IP share = 2
        let release;
        const gate = new Promise(res => { release = res; });
        const vmq = loadVmQuery(fakeVmModule(async () => { await gate; return {
            success: true, error: null, gasUsed: 1, returnValue: null,
            stateChanges: [], stateDeletes: [], emittedActions: [], logs: []
        }; }));
        const a1 = vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest', '10.0.0.9');
        const a2 = vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest', '10.0.0.9');
        await new Promise(res => setImmediate(res));
        try {
            await vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest', '10.0.0.9');
            throw new Error('should have thrown');
        } catch(e){
            expect(e.code).to.equal('VM_BUSY');
        }
        // Legacy/no-IP callers are bounded only by the global cap (one slot left).
        const noIp = vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest');
        await new Promise(res => setImmediate(res));
        release();
        await a1; await a2;
        const r = await noIp;
        expect(r.success).to.equal(true);
    });

    it('maps a STATE_TOO_LARGE state load to 413 and threads the row/byte caps', async () => {
        let capturedLimits;
        const vmq = loadVmQuery(fakeVmModule());
        const db = dbStub({ getContractFullState: async (c, i, limits) => {
            capturedLimits = limits;
            const err = new Error('too big'); err.code = 'STATE_TOO_LARGE'; throw err;
        } });
        try {
            await vmq.simulate(db, CFG, 1, { method: 'x' }, 'BTC', 'regtest');
            throw new Error('should have thrown');
        } catch(e){
            expect(e.code).to.equal('STATE_TOO_LARGE');
            expect(e.httpStatus).to.equal(413);
        }
        expect(capturedLimits.maxRows).to.equal(10000);            // VM maxStateKeys
        expect(capturedLimits.maxBytes).to.equal(4 * 1024 * 1024); // default byte cap
    });

    it('EXPLORER_VM_MAX_STATE_BYTES overrides the byte cap', async () => {
        process.env.EXPLORER_VM_MAX_STATE_BYTES = '1024';
        let capturedLimits;
        const vmq = loadVmQuery(fakeVmModule());
        await vmq.simulate(dbStub({
            getContractFullState: async (c, i, limits) => { capturedLimits = limits; return Object.create(null); }
        }), CFG, 1, { method: 'x' }, 'BTC', 'regtest');
        expect(capturedLimits.maxBytes).to.equal(1024);
    });

    it('shutdown is a safe no-op when the VM was never used', async () => {
        const vmq = loadVmQuery(null);
        await vmq.shutdown();
    });

    //. The deployed explorer is a systemd unit the fleet flag-day
    // checker cannot reach, and its vendored VM went four times stale unnoticed
    // while the version string moved one patch. bin/check-explorer-vm-drift.sh
    // sees that over SSH, but it is external and skippable; these cases are the
    // part an operator cannot skip, because the endpoint itself refuses.
    describe('vendored-VM consensus gate', () => {
        // Each case names a shape of the measured drift: the live copy carried
        // none of these exports at all.
        const DRIFTED = {
            'no CONSENSUS_VERSION export (VM predates the contract era)': { CONSENSUS_VERSION: undefined },
            'no BINARY_ALLOC_GATE_BLOCK_TIME':                            { BINARY_ALLOC_GATE_BLOCK_TIME: undefined },
            'no PKG3_SANDBOX_ACTIVATION':                                 { PKG3_SANDBOX_ACTIVATION: undefined },
            'an older consensus epoch':                                   { CONSENSUS_VERSION: '2' },
            'a newer consensus epoch':                                    { CONSENSUS_VERSION: '4' },
            'a divergent MAX_CODE_SIZE':                                  { MAX_CODE_SIZE: 32768 }
        };

        for(const [label, consensus] of Object.entries(DRIFTED)){
            it('refuses to simulate with VM_QUERY_VM_DRIFT (503): ' + label, async () => {
                let dbTouched = false;
                const vmq = loadVmQuery(fakeVmModule(null, consensus));
                const db  = dbStub({ doQuery: async () => { dbTouched = true; return [{ code: 'x' }]; } });
                try {
                    await vmq.simulate(db, CFG, 1, { method: 'x' }, 'BTC', 'regtest');
                    throw new Error('should have thrown');
                } catch(e){
                    expect(e.code).to.equal('VM_QUERY_VM_DRIFT');
                    expect(e.httpStatus).to.equal(503);
                }
                // Fail-closed means closed before any work: no query reached the
                // indexer DB and no simulation ran.
                expect(dbTouched).to.equal(false);
                expect(vmq.consensusFault()).to.be.a('string');
            });
        }

        it('refuses before request validation, so a bad body cannot mask the drift', async () => {
            const vmq = loadVmQuery(fakeVmModule(null, { CONSENSUS_VERSION: '2' }));
            try {
                await vmq.simulate(dbStub(), CFG, 1, { method: '' }, 'BTC', 'regtest');
                throw new Error('should have thrown');
            } catch(e){
                expect(e.code).to.equal('VM_QUERY_VM_DRIFT');
            }
        });

        it('the flag being off still answers VM_QUERY_DISABLED, not drift', async () => {
            // Drift on a VM nothing loads is a loaded gun, not a live fault, and
            // the two verdicts must stay distinguishable for the same reason the
            // drift script weights WARN against FAIL.
            process.env.EXPLORER_VM_QUERY_ENABLED = 'false';
            const vmq = loadVmQuery(fakeVmModule(null, { CONSENSUS_VERSION: '2' }));
            try {
                await vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest');
                throw new Error('should have thrown');
            } catch(e){
                expect(e.code).to.equal('VM_QUERY_DISABLED');
            }
        });

        it('an absent module stays VM_MODULE_UNAVAILABLE (a different repair)', async () => {
            const vmq = loadVmQuery(null);
            expect(vmq.consensusFault()).to.equal(null);
            try {
                await vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest');
                throw new Error('should have thrown');
            } catch(e){
                expect(e.code).to.equal('VM_MODULE_UNAVAILABLE');
            }
        });

        it('a canonical-shaped VM passes the gate and simulates', async () => {
            const vmq = loadVmQuery(fakeVmModule());
            expect(vmq.consensusFault()).to.equal(null);
            const r = await vmq.simulate(dbStub(), CFG, 1, { method: 'x' }, 'BTC', 'regtest');
            expect(r.success).to.equal(true);
        });

        it('names the reason, so the log says which repair is needed', async () => {
            const vmq = loadVmQuery(fakeVmModule(null, { CONSENSUS_VERSION: '2' }));
            expect(vmq.consensusFault()).to.contain('CONSENSUS_VERSION 2');
            expect(vmq.consensusFault()).to.contain(vmq.REQUIRED_VM_CONSENSUS_VERSION);
        });
    });
});

// Protocol size-cap drift guard for the explorer's read-only query isolate.
// The query VM must enforce the SAME contract code-size cap as the on-chain VM
// and indexer DEPLOY, or it would reject code the chain accepted (breaking
// contract-query previews) with no failing test to catch the drift. The
// canonical source of record is xchain-documentation/protocol/constants.js
// (MAX_CODE_SIZE); we also cross-check the vendored xchain-vm isolate export.
// When the sibling xchain-documentation repo is not checked out (standalone
// deploy), skip the canonical assertion rather than fail, matching the
// ConsensusPrimitiveConformance cross-repo guard convention.
describe('vm-query protocol size-cap parity @regression', () => {
    const fs   = require('fs');
    const path = require('path');
    // Load the module WITHOUT stubbing xchain-vm so we read its real exports.
    const vmq  = require('../../src/vm-query.js');

    const DOCS_DIR   = process.env.XCHAIN_DOCS_DIR ||
        path.join(__dirname, '..', '..', '..', 'xchain-documentation');
    const CONST_PATH = path.join(DOCS_DIR, 'protocol', 'constants.js');

    it('explorer query-VM MAX_CODE_SIZE === canonical protocol constant', function(){
        if(!fs.existsSync(CONST_PATH)) this.skip();
        const protocol = require(CONST_PATH);
        expect(vmq.MAX_CODE_SIZE).to.equal(protocol.MAX_CODE_SIZE);
    });

    it('explorer query-VM MAX_CODE_SIZE === vendored xchain-vm isolate cap', function(){
        let vm;
        try { vm = require('xchain-vm'); } catch(e){ this.skip(); return; }
        if(vm == null || typeof vm.MAX_CODE_SIZE !== 'number') this.skip();
        expect(vmq.MAX_CODE_SIZE).to.equal(vm.MAX_CODE_SIZE);
    });

    it('the caps the isolate actually receives are the named constants (no bare literal reintroduced)', () => {
        expect(vmq.MAX_CODE_SIZE).to.equal(65536);
        expect(vmq.MAX_STATE_VALUE_SIZE).to.equal(65536);
    });

    //. The gate's pin is compiled in, so an epoch bump in the VM would
    // otherwise be discovered by an explorer refusing to simulate in production.
    // Read by regex rather than require(), the way bin/vendor-vm.sh does, so the
    // assertion never needs to load isolated-vm.
    it('the compiled consensus pin equals the canonical sibling xchain-vm epoch', function(){
        const VM_DIR = process.env.XCHAIN_VM_SOURCE ||
            path.join(__dirname, '..', '..', '..', 'xchain-vm');
        const RUNTIME = path.join(VM_DIR, 'src', 'consensus-runtime.js');
        if(!fs.existsSync(RUNTIME)) this.skip();
        const m = /CONSENSUS_VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(RUNTIME, 'utf8'));
        expect(m, 'canonical CONSENSUS_VERSION not found in ' + RUNTIME).to.not.equal(null);
        expect(vmq.REQUIRED_VM_CONSENSUS_VERSION).to.equal(m[1]);
    });
});
