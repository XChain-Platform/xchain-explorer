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
 * Unit tests for the shared BigInt-safe serializer (src/ws/serialize.js),
 * used by both Broadcaster and WebSocketServer._send.
 */

'use strict';

const { expect } = require('chai');
const { safeStringify } = require('../../../src/ws/serialize.js');

describe('serialize.safeStringify', function () {

    it('serializes a BigInt DB column instead of throwing (raw JSON.stringify throws)', function () {
        const msg = { type: 'NEW_ACTION', data: { action_index: BigInt(9007199254740993), block_index: BigInt(700000) } };
        expect(() => JSON.stringify(msg)).to.throw(TypeError); // the hazard
        const out = safeStringify(msg);
        const parsed = JSON.parse(out);
        expect(parsed.data.action_index).to.equal(9007199254740993);
        expect(parsed.data.block_index).to.equal(700000);
    });

    it('leaves non-BigInt values untouched', function () {
        const msg = { a: 1, b: 'x', c: true, d: null, e: [1, 2] };
        expect(JSON.parse(safeStringify(msg))).to.deep.equal(msg);
    });

});
