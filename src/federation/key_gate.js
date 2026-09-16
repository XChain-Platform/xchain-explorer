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
 **********************************************************************
 *
 * XChain Explorer - federation read key gate
 *
 * The perimeter in front of the JSON-RPC dispatcher for the federation read
 * methods. A call naming one of them must carry an x-api-key equal to
 * EXPLORER_FEDERATION_READ_KEY, compared in constant time; anything else answers
 * HTTP 401 with the indexer's own JSON-RPC -32001 Unauthorized body, which is
 * what a validator's client already knows how to read.
 *
 * FAILS CLOSED. With the key unset, every federation call is refused. The indexer
 * has a keyless escape hatch for single-host regtest nodes; a public explorer has
 * no such case, so this gate does not.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');

// Constant-time key comparison. A plain !== stops at the first differing byte and
// leaks the key through response timing; timingSafeEqual needs equal lengths, so the
// length is checked first (a length mismatch is not itself the secret).
function keyEquals(provided, expected) {
    const a = Buffer.from(String(provided == null ? '' : provided));
    const b = Buffer.from(String(expected == null ? '' : expected));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// Whether any call in a single or batch body names a gated method. Every element of
// a batch is inspected: the router dispatches them all, so reading only the top-level
// method would let a one-element batch smuggle a gated call past the check.
function namesGatedMethod(body, gatedMethods) {
    const calls = Array.isArray(body) ? body : [body];
    return calls.some(call => {
        const method = call && call.method;
        return typeof method === 'string' && gatedMethods.has(method.toLowerCase());
    });
}

/**
 * Build the gate middleware.
 *
 * @param {function(): string} readKey returns the configured key, '' when unset; read
 *   per request so the gate always grades against the live environment
 * @param {Set<string>} gatedMethods lowercase method names that require the key
 * @returns {function} Express middleware
 */
function makeFederationKeyGate(readKey, gatedMethods) {
    return function federationKeyGate(req, res, next) {
        if (!namesGatedMethod(req.body, gatedMethods)) return next();
        const expected = readKey();
        const provided = req.headers['x-api-key'] || '';
        // An unset key refuses everyone, and a set key admits only its exact holder
        if (!expected || !keyEquals(provided, expected)) {
            const id = (Array.isArray(req.body) ? null : (req.body && req.body.id)) || null;
            return res.status(401).json({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
        }
        return next();
    };
}

module.exports = { keyEquals, namesGatedMethod, makeFederationKeyGate };
