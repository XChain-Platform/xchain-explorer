// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md.

// Unit coverage for src/abi-core.js: the CANONICAL contract-ABI extraction
// core (vendored byte-identically into the SDK). It parses deployed contract
// source with acorn and extracts the self-declared, static `abi` display
// block. The contract here is fail-closed: never throws, drops one malformed
// method rather than blanking the ABI, and rejects anything dynamic.

const assert = require('assert');
const { parseAbi } = require('../../src/abi-core.js');

const withAbi = (abiSrc) => `
    function transfer(state, ctx) { return state; }
    module.exports = {
        transfer,
        abi: ${abiSrc}
    };
`;

describe('abi-core parseAbi', function () {
    it('extracts version, method summary/view flags, and typed params', function () {
        const abi = parseAbi(withAbi(`{
            version: 1,
            methods: {
                balanceOf: { summary: 'read a balance', view: true, params: [ { name: 'addr', type: 'address' } ] },
                send: { summary: 'move tokens', params: [ { name: 'to', type: 'address' }, { name: 'amount', type: 'amount' } ] }
            }
        }`));
        assert.ok(abi, 'a well-formed abi block must parse');
        assert.strictEqual(abi.version, 1);
        assert.deepStrictEqual(abi.methods.balanceOf, {
            params: [{ name: 'addr', type: 'address' }],
            summary: 'read a balance',
            view: true,
        });
        assert.strictEqual(abi.methods.send.view, undefined, 'absent view flag is left off, not defaulted');
        assert.strictEqual(abi.methods.send.params.length, 2);
    });

    it('defaults params to an empty array when the method omits them', function () {
        const abi = parseAbi(withAbi(`{ version: 2, methods: { ping: { summary: 'noop' } } }`));
        assert.deepStrictEqual(abi.methods.ping.params, []);
        assert.strictEqual(abi.version, 2);
    });

    it('drops only the malformed method, keeping the valid siblings', function () {
        const abi = parseAbi(withAbi(`{
            version: 1,
            methods: {
                good: { params: [ { name: 'x', type: 'number' } ] },
                badType: { params: [ { name: 'y', type: 'not-a-real-type' } ] },
                badShape: { params: [ 42 ] }
            }
        }`));
        assert.ok(abi.methods.good, 'valid method survives');
        assert.ok(!('badType' in abi.methods), 'method with an unknown param type is dropped');
        assert.ok(!('badShape' in abi.methods), 'method with a non-object param is dropped');
    });

    it('returns null when version or methods is missing / non-literal', function () {
        assert.strictEqual(parseAbi(withAbi(`{ methods: {} }`)), null, 'missing version');
        assert.strictEqual(parseAbi(withAbi(`{ version: 1 }`)), null, 'missing methods');
        assert.strictEqual(parseAbi(withAbi(`{ version: someVar, methods: {} }`)), null, 'dynamic version is not a static literal');
    });

    it('returns null for a function-export contract (no property surface)', function () {
        const src = `module.exports = function handler(state, ctx) { return state; };`;
        assert.strictEqual(parseAbi(src), null);
    });

    it('returns null (never throws) for non-string and unparseable input', function () {
        assert.strictEqual(parseAbi(null), null);
        assert.strictEqual(parseAbi(42), null);
        assert.strictEqual(parseAbi(undefined), null);
        assert.strictEqual(parseAbi('this is ( not valid javascript'), null);
    });

    it('returns null when there is no abi block at all', function () {
        assert.strictEqual(parseAbi(`module.exports = { transfer: function(){} };`), null);
    });
});
