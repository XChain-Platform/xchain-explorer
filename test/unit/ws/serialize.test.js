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
const Utility = require('../../../src/utility');

describe('serialize.safeStringify', function () {

    it('serializes a BigInt DB column as a decimal STRING instead of throwing (raw JSON.stringify throws)', function () {
        const msg = { type: 'NEW_ACTION', data: { action_index: BigInt('12345'), block_index: BigInt(700000) } };
        expect(() => JSON.stringify(msg)).to.throw(TypeError); // the hazard
        const out = safeStringify(msg);
        const parsed = JSON.parse(out);
        // BIGINT-as-string: matches the REST wire type (utility.jsonStringify).
        expect(parsed.data.action_index).to.equal('12345');
        expect(parsed.data.block_index).to.equal('700000');
    });

    it('serializes BigInt losslessly above 2^53 (no Number() precision loss)', function () {
        const big = BigInt('9007199254740993'); // 2^53 + 1, unrepresentable as a JS Number
        const parsed = JSON.parse(safeStringify({ data: { action_index: big } }));
        expect(parsed.data.action_index).to.equal('9007199254740993');
    });

    it('leaves non-BigInt values untouched', function () {
        const msg = { a: 1, b: 'x', c: true, d: null, e: [1, 2] };
        expect(JSON.parse(safeStringify(msg))).to.deep.equal(msg);
    });

    // Cross-serializer conformance (finding 1778): the WS serializer and the
    // REST serializer (utility.jsonStringify) must agree on the wire type of
    // the same logical BIGINT fields, so a consumer reconciling a REST backfill
    // against live WS frames by strict equality does not silently fail.
    describe('REST/WS BIGINT conformance', function () {
        const util = new Utility(null);

        it('REST and WS emit identical string values for representative BIGINT fields', function () {
            const row = {
                action_index: BigInt('9007199254740993'),
                block_index:  BigInt('700000'),
                block_time:   BigInt('1752000000')
            };
            const rest = JSON.parse(util.jsonStringify(row));
            const ws   = JSON.parse(safeStringify(row));
            for (const field of ['action_index', 'block_index', 'block_time']) {
                expect(ws[field], field + ' is a string on WS').to.be.a('string');
                expect(rest[field], field + ' is a string on REST').to.be.a('string');
                expect(ws[field], field + ' REST===WS').to.equal(rest[field]);
            }
        });
    });

});
