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

// noCallThru: the whole point of the stub is hosts WITHOUT a loadable
// xchain-vm; call-through would try (and fail) to require the real module.
const proxyquire = require('proxyquire').noPreserveCache().noCallThru();

// Fresh module instance per test: vm-query keeps sticky module-level state
// (loaded module, singleton instance, in-flight counter) by design.
function loadVmQuery(vmStub){
    const stubs = {};
    if(vmStub !== undefined) stubs['xchain-vm'] = vmStub;
    return proxyquire('../../../src/contract/vm_query.js', stubs);
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
// carries it by default, so the fail-closed drift gate does not turn the rest
// of the suite into drift refusals; the gate's own tests override it.
const CANONICAL_VM_CONSENSUS = {
    CONSENSUS_VERSION:                   '4',
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

module.exports = { loadVmQuery, dbStub, fakeVmModule, CFG };
