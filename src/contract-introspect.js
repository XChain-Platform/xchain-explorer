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
 * Presentation-only contract introspection: derives a deployed contract's
 * callable method list from its source via AST parsing, for display on the
 * explorer's contract page. This intentionally mirrors the dispatch rules of
 * the VM's CONTRACT_WRAPPER (xchain-vm/src/index.js: object exports dispatch
 * by key, a function export runs as method 'default') but is NOT consensus
 * code; when the shape is unrecognizable we return null and the UI degrades
 * to "methods unknown" rather than guessing.
 *
 * acorn is pinned to the same version and ecmaVersion (2020) as xchain-vm's
 * lint-core so parse acceptance cannot drift from what the VM's deploy-time
 * syntax gate accepts.
 *
 * Ruled 2026-09-01: this file reports what the VM will EXECUTE, not what the
 * deploy-time linter currently bans. async and generator methods are listed
 * even though banned-async and banned-generator reject them at deploy: those
 * rules gate new deploys only, a contract deployed before its rule armed keeps
 * running, and the wrapper dispatches its async/generator keys like any other
 * key. Hiding them would misreport what a live contract can still do, so no
 * admit site below tests node.async or node.generator, and the unit suite pins
 * that both stay listed.
 *
 * The ABI extraction lives in ./abi-core.js, the CANONICAL copy of the core
 * the SDK vendors byte-identically (xchain-sdk/src/contract/abi-core.js);
 * drift fails CI via bin/sync-abi-core.sh --check and the SDK's drift test.
 */

const acorn = require('acorn');
const { extractAbi, findModuleExports, ABI_PARAM_TYPES, CONTRACT_ECMA_VERSION } = require('./abi-core.js');

// Collect top-level function bindings (declarations plus const/let/var
// initialized with a function or arrow expression). Object-export properties
// that reference these by identifier (`module.exports = { transfer }`) are
// callable at runtime, so they belong in the method list even though the
// consensus linter's stricter object-literal check ignores them.
function collectTopLevelFunctionNames(ast) {
    const names = new Set();
    for (const node of ast.body) {
        if (node.type === 'FunctionDeclaration' && node.id && node.id.name) {
            names.add(node.id.name);
        } else if (node.type === 'VariableDeclaration') {
            for (const d of node.declarations) {
                if (d.id && d.id.type === 'Identifier' && d.init
                    && (d.init.type === 'FunctionExpression' || d.init.type === 'ArrowFunctionExpression'))
                    names.add(d.id.name);
            }
        }
    }
    return names;
}

/**
 * Extract the callable method surface (and optional abi metadata) from
 * contract source.
 *
 * @param {string} code Contract source as stored in contracts.code
 * @returns {{methods: string[]|null, exportKind: 'object'|'function'|null, abi: object|null}}
 *   methods is sorted for stable display; null when the source fails to parse
 *   or the module.exports shape is unrecognized. Never throws.
 */
function extractMethods(code) {
    let ast;
    try {
        ast = acorn.parse(String(code), { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: false });
    } catch (e) {
        return { methods: null, exportKind: null, abi: null };
    }

    try {
        const exported = findModuleExports(ast);
        if (!exported) return { methods: null, exportKind: null, abi: null };

        // module.exports = function(xchain){...}: the wrapper invokes it
        // directly regardless of method name; the protocol calls this 'default'.
        // A function export has no property surface, so no abi either.
        if (exported.type === 'FunctionExpression' || exported.type === 'ArrowFunctionExpression')
            return { methods: ['default'], exportKind: 'function', abi: null };

        if (exported.type !== 'ObjectExpression')
            return { methods: null, exportKind: null, abi: null };

        const topLevelFns = collectTopLevelFunctionNames(ast);
        const methods = new Set();
        for (const p of exported.properties) {
            if (p.type !== 'Property' || p.computed) continue;
            const key = p.key && (p.key.name || p.key.value);
            const v = p.value;
            if (!key || !v) continue;
            if (v.type === 'FunctionExpression' || v.type === 'ArrowFunctionExpression')
                methods.add(String(key));
            else if (v.type === 'Identifier' && topLevelFns.has(v.name))
                methods.add(String(key));
        }
        return { methods: [...methods].sort(), exportKind: 'object', abi: extractAbi(exported) };
    } catch (e) {
        return { methods: null, exportKind: null, abi: null };
    }
}

module.exports = { extractMethods, extractAbi, CONTRACT_ECMA_VERSION, ABI_PARAM_TYPES };
