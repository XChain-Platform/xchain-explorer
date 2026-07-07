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
 * The ABI extraction here is kept in MANUAL sync with the SDK's copy
 * (xchain-sdk/src/contracts.js parseAbi; the explorer cannot depend on the
 * SDK). No CI drift guard exists, unlike lint-core; both test suites share
 * fixture strings as acceptance-parity insurance.
 */

const acorn = require('acorn');
const walk  = require('acorn-walk');

// Must match CONTRACT_ECMA_VERSION in xchain-vm/src/lint-core.js: contracts
// are validated at deploy time against ES2020, so we parse the same dialect.
const CONTRACT_ECMA_VERSION = 2020;

// Informational param types the ABI convention allows (spec:
// xchain-documentation/protocol/Contract_ABI.md). Types only shape input UX;
// the wire format stays positional pipe-delimited strings.
const ABI_PARAM_TYPES = new Set(['string', 'number', 'amount', 'address', 'tick', 'bool', 'json']);

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

// Literal-value helpers for the ABI walk: the convention requires the whole
// abi block to be static literals so it can be read without executing code.
function literalOfType(node, type) {
    return node && node.type === 'Literal' && typeof node.value === type ? node.value : undefined;
}
function propMap(objectExpression) {
    const map = new Map();
    for (const p of objectExpression.properties) {
        if (p.type !== 'Property' || p.computed) continue;
        const key = p.key && (p.key.name || p.key.value);
        if (key) map.set(String(key), p.value);
    }
    return map;
}

/**
 * Extract the optional `abi` metadata block from an object-export contract
 * (spec: xchain-documentation/protocol/Contract_ABI.md). Fail-closed: a
 * dynamic or structurally wrong abi/version/methods yields null, while a
 * malformed SINGLE method entry drops only that method so one typo does not
 * blank the whole ABI. This metadata is self-declared by the contract author
 * and is never validated against the code; consumers treat it as display
 * hints only.
 *
 * @param {object} exported The module.exports ObjectExpression AST node
 * @returns {{version: number, methods: object}|null}
 */
function extractAbi(exported) {
    try {
        const abiNode = propMap(exported).get('abi');
        if (!abiNode || abiNode.type !== 'ObjectExpression') return null;

        const abiProps = propMap(abiNode);
        const version  = literalOfType(abiProps.get('version'), 'number');
        const methodsNode = abiProps.get('methods');
        if (version === undefined || !methodsNode || methodsNode.type !== 'ObjectExpression') return null;

        const methods = {};
        for (const [name, specNode] of propMap(methodsNode)) {
            if (specNode.type !== 'ObjectExpression') continue;
            const spec    = propMap(specNode);
            const entry   = { params: [] };
            const summary = literalOfType(spec.get('summary'), 'string');
            const view    = literalOfType(spec.get('view'), 'boolean');
            if (summary !== undefined) entry.summary = summary;
            if (view !== undefined) entry.view = view;

            let ok = true;
            const paramsNode = spec.get('params');
            if (paramsNode !== undefined) {
                if (paramsNode.type !== 'ArrayExpression') { ok = false; }
                else {
                    for (const el of paramsNode.elements) {
                        if (!el || el.type !== 'ObjectExpression') { ok = false; break; }
                        const pSpec = propMap(el);
                        const pName = literalOfType(pSpec.get('name'), 'string');
                        const pType = literalOfType(pSpec.get('type'), 'string');
                        if (pName === undefined || pType === undefined || !ABI_PARAM_TYPES.has(pType)) { ok = false; break; }
                        entry.params.push({ name: pName, type: pType });
                    }
                }
            }
            if (ok) methods[name] = entry;
        }
        return { version, methods };
    } catch (e) {
        return null;
    }
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
        // Find the first `module.exports = <expr>` assignment, same walk shape
        // as lint-core's findExportsObject but keeping the raw right-hand side
        // so the function-export case is detectable too.
        let exported = null;
        walk.simple(ast, {
            AssignmentExpression(node) {
                if (exported) return;
                const l = node.left;
                const isModuleExports = l && l.type === 'MemberExpression' && !l.computed
                    && l.object && l.object.type === 'Identifier' && l.object.name === 'module'
                    && l.property && l.property.name === 'exports';
                if (isModuleExports && node.right) exported = node.right;
            }
        });
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
