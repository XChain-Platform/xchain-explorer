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
 * Contract-ABI extraction core (spec: xchain-documentation/protocol/
 * Contract_ABI.md), shared by the explorer's contract introspection and the
 * SDK's ContractUtils.parseAbi. The abi block is display metadata self-declared
 * by the contract author: never validated against the code, never consensus.
 * Extraction is fail-closed: a dynamic or structurally wrong abi/version/
 * methods yields null, while a malformed SINGLE method entry drops only that
 * method so one typo does not blank the whole ABI.
 *
 * CANONICAL COPY: xchain-explorer/src/abi-core.js. The SDK vendors it
 * byte-identically at xchain-sdk/src/contract/abi-core.js (it cannot depend on
 * the explorer). Edit the canonical file and run
 * xchain-explorer/bin/sync-abi-core.sh; drift fails CI (the SDK's
 * abi-core-drift unit test and the platform root's bin/ci-all.sh guard).
 */

const acorn = require('acorn');
const walk  = require('acorn-walk');

// Must match CONTRACT_ECMA_VERSION in xchain-vm/src/lint-core.js: contracts
// are validated at deploy time against ES2020, so we parse the same dialect.
const CONTRACT_ECMA_VERSION = 2020;

// Informational param types the ABI convention allows. Types only shape input
// UX; the wire format stays positional pipe-delimited strings.
const ABI_PARAM_TYPES = new Set(['string', 'number', 'amount', 'address', 'tick', 'bool', 'json']);

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

// Find the first `module.exports = <expr>` assignment and return its
// right-hand side AST node, or null when absent. Same walk shape as
// lint-core's findExportsObject but keeping the raw right-hand side so
// callers can also detect the function-export case.
function findModuleExports(ast) {
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
    return exported;
}

/**
 * Extract the optional `abi` metadata block from an object-export contract's
 * module.exports ObjectExpression AST node.
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
 * Parse contract source and extract its declared abi block. Function-export
 * contracts have no property surface, so no abi either.
 *
 * @param {string} sourceCode Contract source as deployed / as stored on-chain
 * @returns {{version: number, methods: object}|null} Never throws.
 */
function parseAbi(sourceCode) {
    if (typeof sourceCode !== 'string') return null;
    try {
        const ast = acorn.parse(sourceCode, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script', locations: false });
        const exported = findModuleExports(ast);
        if (!exported || exported.type !== 'ObjectExpression') return null;
        return extractAbi(exported);
    } catch (e) {
        return null;
    }
}

module.exports = { parseAbi, extractAbi, findModuleExports, propMap, literalOfType, ABI_PARAM_TYPES, CONTRACT_ECMA_VERSION };
