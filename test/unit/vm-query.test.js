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
const proxyquire = require('proxyquire').noPreserveCache();

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

// A fake XChainVM constructor whose execute resolves with a canned result
// (or a caller-supplied implementation).
function fakeVmModule(executeImpl){
    return function FakeVM(){
        this.execute  = executeImpl || (async (opts) => ({
            success: true, error: null, gasUsed: 42,
            returnValue: '"ok"', stateChanges: [], stateDeletes: [],
            emittedActions: [], logs: [], _opts: opts
        }));
        this.shutdown = async () => {};
    };
}

const CFG = { coin: 'RBTC', data: {} };

describe('vm-query', () => {
    let envBackup;
    beforeEach(() => {
        envBackup = {
            enabled: process.env.EXPLORER_VM_QUERY_ENABLED,
            conc:    process.env.EXPLORER_VM_MAX_CONCURRENT
        };
        process.env.EXPLORER_VM_QUERY_ENABLED = 'true';
    });
    afterEach(() => {
        if(envBackup.enabled === undefined) delete process.env.EXPLORER_VM_QUERY_ENABLED;
        else process.env.EXPLORER_VM_QUERY_ENABLED = envBackup.enabled;
        if(envBackup.conc === undefined) delete process.env.EXPLORER_VM_MAX_CONCURRENT;
        else process.env.EXPLORER_VM_MAX_CONCURRENT = envBackup.conc;
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

    it('shutdown is a safe no-op when the VM was never used', async () => {
        const vmq = loadVmQuery(null);
        await vmq.shutdown();
    });
});
