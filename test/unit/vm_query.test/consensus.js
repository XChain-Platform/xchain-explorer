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

'use strict';

const { expect } = require('chai');
const { loadVmQuery, dbStub, fakeVmModule, CFG } = require('./helpers.js');

let envBackup;

function saveEnvironment() {
    envBackup = {
        enabled:    process.env.EXPLORER_VM_QUERY_ENABLED,
        conc:       process.env.EXPLORER_VM_MAX_CONCURRENT,
        stateBytes: process.env.EXPLORER_VM_MAX_STATE_BYTES
    };
    process.env.EXPLORER_VM_QUERY_ENABLED = 'true';
}

function restoreEnvironment() {
    if(envBackup.enabled === undefined) delete process.env.EXPLORER_VM_QUERY_ENABLED;
    else process.env.EXPLORER_VM_QUERY_ENABLED = envBackup.enabled;
    if(envBackup.conc === undefined) delete process.env.EXPLORER_VM_MAX_CONCURRENT;
    else process.env.EXPLORER_VM_MAX_CONCURRENT = envBackup.conc;
    if(envBackup.stateBytes === undefined) delete process.env.EXPLORER_VM_MAX_STATE_BYTES;
    else process.env.EXPLORER_VM_MAX_STATE_BYTES = envBackup.stateBytes;
}

describe('vm-query', () => {
    beforeEach(saveEnvironment);
    afterEach(restoreEnvironment);

    // A deployed explorer's vendored VM can go stale unnoticed even while an
    // external drift-check script exists, because that script is skippable.
    // These cases are the part an operator cannot skip: the endpoint itself
    // refuses to simulate when its VM has drifted from the required consensus
    // shape.
    describe('vendored-VM consensus gate', () => {
        // Each case names a shape of the measured drift: the live copy carried
        // none of these exports at all.
        const DRIFTED = {
            'no CONSENSUS_VERSION export (VM predates the contract era)': { CONSENSUS_VERSION: undefined },
            'no BINARY_ALLOC_GATE_BLOCK_TIME':                            { BINARY_ALLOC_GATE_BLOCK_TIME: undefined },
            'no PKG3_SANDBOX_ACTIVATION':                                 { PKG3_SANDBOX_ACTIVATION: undefined },
            'an older consensus epoch':                                   { CONSENSUS_VERSION: '2' },
            'a newer consensus epoch':                                    { CONSENSUS_VERSION: '5' },
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
    });
});

describe('vm-query', () => {
    beforeEach(saveEnvironment);
    afterEach(restoreEnvironment);

    describe('vendored-VM consensus gate', () => {
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
    const vmq  = require('../../../src/contract/vm_query.js');

    const DOCS_DIR   = process.env.XCHAIN_DOCS_DIR ||
        path.join(__dirname, '..', '..', '..', '..', 'xchain-documentation');
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

    // The gate's pin is compiled in, so an epoch bump in the VM would otherwise
    // be discovered by an explorer refusing to simulate in production. Read by
    // regex rather than require(), so the assertion never needs to load isolated-vm.
    it('the compiled consensus pin equals the canonical sibling xchain-vm epoch', function(){
        const VM_DIR = process.env.XCHAIN_VM_SOURCE ||
            path.join(__dirname, '..', '..', '..', '..', 'xchain-vm');
        // The VM's layout pass renamed src/consensus-runtime.js to
        // src/consensus_runtime.js and left nothing at the old path, so a sibling
        // checkout sits on one side of that move or the other. Pinning one
        // spelling turns this pin check into a silent skip against the other.
        const RUNTIME = [path.join(VM_DIR, 'src', 'consensus_runtime.js'),
                         path.join(VM_DIR, 'src', 'consensus-runtime.js')].find((p) => fs.existsSync(p));
        if(!RUNTIME) this.skip();
        const m = /CONSENSUS_VERSION\s*=\s*'([^']+)'/.exec(fs.readFileSync(RUNTIME, 'utf8'));
        expect(m, 'canonical CONSENSUS_VERSION not found in ' + RUNTIME).to.not.equal(null);
        expect(vmq.REQUIRED_VM_CONSENSUS_VERSION).to.equal(m[1]);
    });
});
