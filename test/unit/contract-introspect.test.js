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

// Unit tests for src/contract-introspect.js: the presentation-only AST method
// extractor behind getContract's `methods` field. The cases mirror the VM
// wrapper's dispatch rules (object exports by key, function export as
// 'default') plus every way extraction must degrade to null instead of
// throwing into db.js.

const { expect } = require('chai');
const { extractMethods } = require('../../src/contract-introspect.js');

describe('contract-introspect.extractMethods', () => {

    it('extracts function-valued keys from an object export', () => {
        const r = extractMethods(`module.exports = {
            transfer: function(xchain){ return 1; },
            balanceOf: (xchain) => xchain.state.get('b')
        };`);
        expect(r.exportKind).to.equal('object');
        expect(r.methods).to.deep.equal(['balanceOf', 'transfer']);
    });

    it('extracts shorthand method definitions', () => {
        const r = extractMethods(`module.exports = { mint(xchain){}, burn(xchain){} };`);
        expect(r.methods).to.deep.equal(['burn', 'mint']);
    });

    it('resolves identifier values that reference top-level functions', () => {
        const r = extractMethods(`
            function transfer(xchain){ return 1; }
            const approve = (xchain) => 2;
            module.exports = { transfer, approve };
        `);
        expect(r.methods).to.deep.equal(['approve', 'transfer']);
    });

    it('excludes non-function and computed properties', () => {
        const r = extractMethods(`
            const key = 'dynamic';
            module.exports = {
                name: 'MyToken',
                version: 2,
                [key]: function(xchain){},
                run: function(xchain){}
            };
        `);
        expect(r.methods).to.deep.equal(['run']);
    });

    it('excludes identifier values that are not top-level functions', () => {
        const r = extractMethods(`
            const config = { a: 1 };
            module.exports = { config, run: function(xchain){} };
        `);
        expect(r.methods).to.deep.equal(['run']);
    });

    it('maps a direct function export to ["default"]', () => {
        const r = extractMethods(`module.exports = function(xchain){ return 'hi'; };`);
        expect(r.exportKind).to.equal('function');
        expect(r.methods).to.deep.equal(['default']);
    });

    it('maps an arrow function export to ["default"]', () => {
        const r = extractMethods(`module.exports = (xchain) => 'hi';`);
        expect(r.methods).to.deep.equal(['default']);
    });

    it('uses the FIRST module.exports assignment, ignoring later decoys', () => {
        const r = extractMethods(`
            module.exports = { real: function(xchain){} };
            if(false){ module.exports = { decoy: function(xchain){} }; }
        `);
        expect(r.methods).to.deep.equal(['real']);
    });

    it('returns an empty list for an empty object export', () => {
        const r = extractMethods(`module.exports = {};`);
        expect(r.exportKind).to.equal('object');
        expect(r.methods).to.deep.equal([]);
    });

    it('returns null on a parse error', () => {
        const r = extractMethods(`this is not javascript (`);
        expect(r.methods).to.equal(null);
        expect(r.exportKind).to.equal(null);
    });

    it('returns null when there is no module.exports assignment', () => {
        const r = extractMethods(`const x = 1;`);
        expect(r.methods).to.equal(null);
    });

    it('returns null for an unrecognized export shape (identifier)', () => {
        const r = extractMethods(`const api = { run(xchain){} }; module.exports = api;`);
        expect(r.methods).to.equal(null);
    });

    it('handles non-string input without throwing', () => {
        expect(extractMethods(null).methods).to.equal(null);
        expect(extractMethods(undefined).methods).to.equal(null);
        expect(extractMethods(12345).methods).to.equal(null);
    });

    // The extractor reports what the VM will execute, not what the deploy-time
    // linter bans. banned-async/banned-generator gate NEW deploys; a contract
    // deployed before its rule armed still runs, and the wrapper dispatches its
    // async/generator keys like any other key, so both stay listed.
    it('lists async methods, which the wrapper still dispatches', () => {
        const r = extractMethods(`module.exports = {
            transfer: async function(xchain){ return 1; },
            settle: async (xchain) => 2,
            mint: async function(xchain){}
        };`);
        expect(r.exportKind).to.equal('object');
        expect(r.methods).to.deep.equal(['mint', 'settle', 'transfer']);
    });

    it('lists shorthand async and generator methods', () => {
        const r = extractMethods(`module.exports = { async fund(xchain){}, *stream(xchain){ yield 1; } };`);
        expect(r.methods).to.deep.equal(['fund', 'stream']);
    });

    it('lists identifier values referencing top-level async and generator functions', () => {
        const r = extractMethods(`
            async function claim(xchain){ return 1; }
            function* walk(xchain){ yield 1; }
            const settle = async (xchain) => 2;
            module.exports = { claim, walk, settle };
        `);
        expect(r.methods).to.deep.equal(['claim', 'settle', 'walk']);
    });

    it('maps an async or generator function export to ["default"]', () => {
        expect(extractMethods(`module.exports = async function(xchain){ return 1; };`).methods)
            .to.deep.equal(['default']);
        expect(extractMethods(`module.exports = function*(xchain){ yield 1; };`).methods)
            .to.deep.equal(['default']);
        expect(extractMethods(`module.exports = async (xchain) => 1;`).methods)
            .to.deep.equal(['default']);
    });

    it('rejects post-ES2020 syntax, matching the VM deploy gate', () => {
        // Class static blocks are ES2022; the VM's deploy-time parse (pinned
        // to ecmaVersion 2020) rejects them, so extraction must too.
        const r = extractMethods(`class A { static { } } module.exports = { run(xchain){} };`);
        expect(r.methods).to.equal(null);
    });
});

// ABI extraction (spec: xchain-documentation/protocol/Contract_ABI.md).
// NOTE: these fixture strings are duplicated verbatim in the SDK suite
// (xchain-sdk/test/unit/contracts.parseAbi.test.js) so the two hand-synced
// parser copies are tested against identical inputs.
describe('contract-introspect ABI extraction', () => {

    it('parses a well-formed abi block with typed params, summary, and view', () => {
        const r = extractMethods(`module.exports = {
            abi: { version: 1, methods: {
                fund:   { summary: 'Deposit the escrow amount', params: [ { name: 'tick', type: 'tick' }, { name: 'amount', type: 'amount' } ] },
                status: { summary: 'Read escrow status', params: [], view: true }
            } },
            fund: function(xchain){}, status: function(xchain){}
        };`);
        expect(r.abi.version).to.equal(1);
        expect(r.abi.methods.fund.params).to.deep.equal([
            { name: 'tick', type: 'tick' }, { name: 'amount', type: 'amount' }
        ]);
        expect(r.abi.methods.fund.summary).to.equal('Deposit the escrow amount');
        expect(r.abi.methods.status.view).to.equal(true);
        expect(r.methods).to.deep.equal(['fund', 'status']);
    });

    it('drops only the malformed method entry, keeping the rest', () => {
        const r = extractMethods(`module.exports = {
            abi: { version: 1, methods: {
                good:   { params: [ { name: 'x', type: 'string' } ] },
                badType: { params: [ { name: 'x', type: 'floatish' } ] },
                badShape: { params: 'nope' }
            } },
            good: function(xchain){}, badType: function(xchain){}, badShape: function(xchain){}
        };`);
        expect(Object.keys(r.abi.methods)).to.deep.equal(['good']);
    });

    it('returns abi=null when version is not a numeric literal', () => {
        const r = extractMethods(`module.exports = { abi: { version: '1', methods: {} }, run: function(x){} };`);
        expect(r.abi).to.equal(null);
        expect(r.methods).to.deep.equal(['run']);
    });

    it('returns abi=null for a dynamic (non-literal) abi value', () => {
        const r = extractMethods(`const a = { version: 1, methods: {} }; module.exports = { abi: a, run: function(x){} };`);
        expect(r.abi).to.equal(null);
    });

    it('treats an abi-named FUNCTION as an ordinary method, not metadata', () => {
        const r = extractMethods(`module.exports = { abi: function(xchain){ return 1; } };`);
        expect(r.methods).to.deep.equal(['abi']);
        expect(r.abi).to.equal(null);
    });

    it('returns abi=null for function-export contracts', () => {
        const r = extractMethods(`module.exports = function(xchain){ return 1; };`);
        expect(r.abi).to.equal(null);
    });

    it('defaults omitted params to an empty array and omitted view to absent', () => {
        const r = extractMethods(`module.exports = {
            abi: { version: 1, methods: { ping: { summary: 'Ping' } } },
            ping: function(xchain){}
        };`);
        expect(r.abi.methods.ping.params).to.deep.equal([]);
        expect(r.abi.methods.ping).to.not.have.property('view');
    });
});
