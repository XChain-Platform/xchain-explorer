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

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

const SIBLING_GATES = [
    ['test/unit/action_detail/action_manifest_conformance.test.js'],
    ['test/unit/config/coins_conformance.test.js'],
    ['test/unit/contract/vm_query.test/support/consensus.js',
        'test/unit/contract/vm_query.test.js'],
    ['test/unit/db/core/db_reorg_real_ddl.test.js'],
    ['test/unit/db/mempool/db_mempool_address_case.test.js'],
    ['test/unit/db/mempool/mempool.test/support/encoding.js',
        'test/unit/db/mempool/mempool.test.js'],
    ['test/unit/explorer/explorer_checkpoints.test/support/parity.js',
        'test/unit/explorer/explorer_checkpoints.test.js'],
    ['test/unit/federation/federation_indexer_parity.test.js'],
    ['test/unit/http/compression.test.js'],
    ['test/unit/http/contract_state_proof.test.js'],
    ['test/unit/http/locked_balance_proof.test.js'],
    ['test/unit/http/openapi_coverage.test.js'],
    ['test/unit/http/proof_server.test.js'],
    ['test/unit/mirror/hub_mirror_client_conformance.test.js'],
    ['test/unit/protocol/consensus_primitive_conformance.test.js']
].map(([source, testFile = source]) => ({ source, testFile }));

const REQUIRED_VM_GUARD = 'test/unit/contract/vm_query.test/support/consensus.js';
const REQUIRED_SIBLING_TESTS = new Set([
    'test/unit/config/coins_conformance.test.js',
    'test/unit/contract/vm_query.test.js',
    'test/unit/db/core/db_reorg_real_ddl.test.js',
    'test/unit/db/mempool/db_mempool_address_case.test.js',
    'test/unit/http/contract_state_proof.test.js',
    'test/unit/http/locked_balance_proof.test.js',
    'test/unit/mirror/hub_mirror_client_conformance.test.js'
]);

function repoRelative(file) {
    return path.relative(REPO_ROOT, path.resolve(file)).split(path.sep).join('/');
}

function pendingSiblingTests(rootSuite) {
    const pending = [];
    rootSuite.eachTest((test) => {
        if(test.pending && test.file && REQUIRED_SIBLING_TESTS.has(repoRelative(test.file)))
            pending.push(test.fullTitle());
    });
    return pending.sort();
}

function enforceSiblingCoverage(rootSuite, env = process.env) {
    if(env.XCHAIN_REQUIRE_SIBLINGS !== '1') return;
    const pending = pendingSiblingTests(rootSuite);
    assert.deepStrictEqual(pending, [],
        'sibling-backed unit coverage became pending:\n' + pending.join('\n'));
}

after(function () {
    enforceSiblingCoverage(this.test.parent);
});

describe('sibling gate policy', function () {
    it('catalogs all fifteen sibling-gated suites', function () {
        assert.strictEqual(SIBLING_GATES.length, 15);
        for(const gate of SIBLING_GATES) {
            const source = path.join(REPO_ROOT, gate.source);
            const testFile = path.join(REPO_ROOT, gate.testFile);
            assert.ok(fs.existsSync(source), 'missing guarded source ' + gate.source);
            assert.ok(fs.existsSync(testFile), 'missing owning test file ' + gate.testFile);
            assert.match(fs.readFileSync(source, 'utf8'), /this\.skip\(\)|skipOrFail/,
                gate.source + ' no longer contains the sibling gate this policy monitors');
        }
    });

    it('requires only the seven targeted sibling-gated suites', function () {
        assert.strictEqual(REQUIRED_SIBLING_TESTS.size, 7);
        for(const testFile of REQUIRED_SIBLING_TESTS) {
            const gate = SIBLING_GATES.find(candidate => candidate.testFile === testFile);
            assert.ok(gate, 'missing sibling gate for required suite ' + testFile);
            assert.match(fs.readFileSync(path.join(REPO_ROOT, gate.source), 'utf8'), /skipOrFail/,
                gate.source + ' must fail rather than pend when required sibling coverage is missing');
        }
    });

    it('keeps the vm-query sibling checks strict-aware at their source', function () {
        const source = fs.readFileSync(path.join(REPO_ROOT, REQUIRED_VM_GUARD), 'utf8');
        assert.doesNotMatch(source, /this\.skip\(\)/,
            REQUIRED_VM_GUARD + ' must delegate missing siblings to skipOrFail');
        assert.match(source, /skipOrFail/,
            REQUIRED_VM_GUARD + ' must fail when required sibling coverage is missing');
    });

    it('allows standalone skips but rejects guarded pending tests in strict mode', function () {
        const guarded = {
            pending: true,
            file: path.join(REPO_ROOT, [...REQUIRED_SIBLING_TESTS][0]),
            fullTitle: () => 'guarded parity case'
        };
        const optional = {
            pending: true,
            file: path.join(REPO_ROOT, SIBLING_GATES[0].testFile),
            fullTitle: () => 'optional sibling case'
        };
        const ordinary = {
            pending: true,
            file: path.join(REPO_ROOT, 'test/unit/example.test.js'),
            fullTitle: () => 'unrelated optional case'
        };
        const optionalRoot = { eachTest: callback => [ordinary, optional].forEach(callback) };
        const guardedRoot = { eachTest: callback => [ordinary, optional, guarded].forEach(callback) };

        assert.doesNotThrow(() => enforceSiblingCoverage(guardedRoot, {}));
        assert.doesNotThrow(() => enforceSiblingCoverage(optionalRoot,
            { XCHAIN_REQUIRE_SIBLINGS: '1' }));
        assert.throws(() => enforceSiblingCoverage(guardedRoot,
            { XCHAIN_REQUIRE_SIBLINGS: '1' }),
            /guarded parity case/);
    });
});
