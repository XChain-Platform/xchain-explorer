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
 * Serve-side FILE payload decompression, explorer side.
 *
 * The explorer is a reader facing hostile input: COMPRESSION is sender-asserted
 * and anyone can publish a lying field for the price of one transaction. These
 * tests are therefore mostly about what must NOT happen:
 *  - a lying field must never crash the route or serve partial output;
 *  - a compression bomb must abort mid-stream on the 150:1 guard;
 *  - GATED ciphertext must never be inflated: the field means
 *    inflate-after-decrypt, and the explorer holds no key;
 *  - COMPRESSION must be read from the ACTION STRING, so a FILE mined before
 *    an indexer upgrade still serves correctly.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const zlib = require('zlib');
const compression = require('../../src/compression.js');

const PUBLIC_RAW = 'FILE|0|doc.txt|text/plain|Doc|memo';
const PUBLIC_COMPRESSED = 'FILE|0|doc.txt|text/plain|Doc|memo|||||1';
const GATED_COMPRESSED = 'FILE|0|s.enc|application/octet-stream|S||MYTOKEN|1|' + 'a'.repeat(64) + '||1';

const ORIGINAL = Buffer.from('explorer serve path payload. '.repeat(300), 'utf8');
const DEFLATED = zlib.deflateRawSync(ORIGINAL);

describe('explorer FILE decompression', function () {

    describe('action-string derivation', function () {
        it('reads the marker from the action string', function () {
            assert.strictEqual(compression.isCompressedAction(PUBLIC_COMPRESSED), true);
            assert.strictEqual(compression.isCompressedAction(PUBLIC_RAW), false);
        });

        it('a historical FILE with no COMPRESSION field reads as raw', function () {
            for (const a of ['FILE|0|a.txt|text/plain', 'FILE|0|a.txt|text/plain|T|M', 'FILE|0'])
                assert.strictEqual(compression.isCompressedAction(a), false, a);
        });

        it('an unknown code degrades to raw rather than erroring', function () {
            for (const code of ['2', '99', 'zstd', 'TRUE', ' 1'])
                assert.strictEqual(compression.isCompressedAction('FILE|0|a|b|c|d|||||' + code), false, code);
        });

        it('ignores non-FILE actions and other versions', function () {
            assert.strictEqual(compression.isCompressedAction('SEND|0|X|1|a|b|c|d|e|f|1'), false);
            assert.strictEqual(compression.isCompressedAction('FILE|1|a|b|c|d|||||1'), false);
        });

        it('never throws on junk', function () {
            for (const junk of [null, undefined, '', 42, {}, []]) {
                assert.strictEqual(compression.isCompressedAction(junk), false);
                assert.strictEqual(compression.isGatedAction(junk), false);
            }
        });

        it('detects gating', function () {
            assert.strictEqual(compression.isGatedAction(GATED_COMPRESSED), true);
            assert.strictEqual(compression.isGatedAction(PUBLIC_COMPRESSED), false);
        });
    });

    describe('resolveServedBytes', function () {
        it('inflates a compressed public FILE and reports both sizes', async function () {
            const r = await compression.resolveServedBytes(DEFLATED, PUBLIC_COMPRESSED);
            assert.strictEqual(r.inflated, true);
            assert.strictEqual(r.storedForm, false);
            assert.ok(r.bytes.equals(ORIGINAL));
            assert.strictEqual(r.storedLength, DEFLATED.length);
            assert.strictEqual(r.originalLength, ORIGINAL.length);
        });

        it('serves an unmarked FILE untouched (every historical payload)', async function () {
            const r = await compression.resolveServedBytes(ORIGINAL, PUBLIC_RAW);
            assert.strictEqual(r.inflated, false);
            assert.strictEqual(r.storedForm, false);
            assert.ok(r.bytes.equals(ORIGINAL));
        });

        it('NEVER inflates gated ciphertext, even when the action declares compression', async function () {
            // The stored bytes here happen to BE a valid deflate stream, so a
            // careless implementation would inflate them. It must not: on a
            // gated FILE the field describes the plaintext, and only the key
            // holder can act on it.
            const r = await compression.resolveServedBytes(DEFLATED, GATED_COMPRESSED);
            assert.strictEqual(r.inflated, false);
            assert.strictEqual(r.storedForm, false);
            assert.ok(r.bytes.equals(DEFLATED), 'gated bytes are served exactly as stored');
        });

        it('honours an explicit gated flag from the caller', async function () {
            const r = await compression.resolveServedBytes(DEFLATED, PUBLIC_COMPRESSED, { gated: true });
            assert.strictEqual(r.inflated, false);
            assert.ok(r.bytes.equals(DEFLATED));
        });

        it('a MISSING action string degrades to serve-raw', async function () {
            // e.g. the decoder row is unavailable. Serving the stored bytes is
            // the safe outcome; guessing is not.
            const r = await compression.resolveServedBytes(DEFLATED, null);
            assert.strictEqual(r.inflated, false);
            assert.ok(r.bytes.equals(DEFLATED));
        });
    });

    describe('fail-closed serving', function () {
        it('a lying field over plain text serves stored bytes with an indicator', async function () {
            const plain = Buffer.from('I am not deflate output', 'utf8');
            const r = await compression.resolveServedBytes(plain, PUBLIC_COMPRESSED);
            assert.strictEqual(r.inflated, false);
            assert.strictEqual(r.storedForm, true);
            assert.strictEqual(r.error, 'INVALID_DEFLATE_STREAM');
            assert.ok(r.bytes.equals(plain));
        });

        it('a TRUNCATED stream never yields partial output', async function () {
            const truncated = DEFLATED.subarray(0, Math.floor(DEFLATED.length / 2));
            const r = await compression.resolveServedBytes(truncated, PUBLIC_COMPRESSED);
            assert.strictEqual(r.storedForm, true);
            assert.ok(r.bytes.equals(truncated));
            assert.ok(!r.bytes.includes(Buffer.from('explorer serve path')),
                'no partially inflated bytes are ever served');
        });

        it('a compression bomb trips the ratio guard', async function () {
            const bomb = zlib.deflateRawSync(Buffer.alloc(4 * 1024 * 1024, 0));
            const r = await compression.resolveServedBytes(bomb, PUBLIC_COMPRESSED);
            assert.strictEqual(r.storedForm, true);
            assert.strictEqual(r.error, 'RATIO_GUARD_TRIPPED');
            assert.ok(r.bytes.equals(bomb));
        });

        it('the bomb guard trips BEFORE the payload is fully inflated', async function () {
            const originalSize = 4 * 1024 * 1024;
            const bomb = zlib.deflateRawSync(Buffer.alloc(originalSize, 0));
            assert.ok(bomb.length * compression.COMPRESSION_MAX_RATIO < originalSize,
                'precondition: the ceiling is below the full inflated size');
            const r = await compression.inflateStoredBytes(bomb);
            assert.strictEqual(r.error, 'RATIO_GUARD_TRIPPED');
        });

        it('a payload just UNDER the ratio guard still serves', async function () {
            // Guard boundary from the safe side: this must not be rejected.
            const body = Buffer.from(crypto.randomBytes(200000).toString('hex'), 'utf8');
            const deflated = zlib.deflateRawSync(body);
            const ratio = body.length / deflated.length;
            assert.ok(ratio < compression.COMPRESSION_MAX_RATIO, `fixture ratio ${ratio.toFixed(2)} must be under the cap`);
            const r = await compression.resolveServedBytes(deflated, PUBLIC_COMPRESSED);
            assert.strictEqual(r.inflated, true);
            assert.ok(r.bytes.equals(body));
        });

        it('never throws on hostile bytes', async function () {
            const cases = [Buffer.alloc(0), Buffer.from([0]), crypto.randomBytes(32),
                           null, undefined, 'a string', 7];
            for (const input of cases) {
                const r = await compression.resolveServedBytes(input, PUBLIC_COMPRESSED);
                assert.ok(r && Buffer.isBuffer(r.bytes), 'always yields servable bytes for ' + String(input));
            }
        });

        it('fuzzed payloads never throw and stay bounded', async function () {
            for (let i = 0; i < 150; i++) {
                const r = await compression.resolveServedBytes(crypto.randomBytes(1 + (i % 96)), PUBLIC_COMPRESSED);
                assert.ok(Buffer.isBuffer(r.bytes));
                if (r.inflated)
                    assert.ok(r.bytes.length <= r.storedLength * compression.COMPRESSION_MAX_RATIO);
            }
        });
    });

    describe('round trip with the encoder (sibling-gated)', function () {
        const path = require('path');
        const fs = require('fs');
        const ENCODER = process.env.XCHAIN_ENCODER_DIR ||
            path.join(__dirname, '..', '..', '..', 'xchain-encoder');
        const ENCODER_COMPRESSION = path.join(ENCODER, 'src', 'compression.js');

        before(function () {
            if (!fs.existsSync(ENCODER_COMPRESSION)) {
                if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
                    throw new Error('xchain-encoder sibling not found but XCHAIN_REQUIRE_SIBLINGS=1');
                this.skip();
            }
        });

        it('what the encoder emits, the explorer serves back byte-for-byte', async function () {
            const encoderCompression = require(ENCODER_COMPRESSION);
            let payload = '';
            for (let i = 0; payload.length < 40000; i++)
                payload += JSON.stringify({ id: i, name: 'row-' + i, v: (i * 7919) % 100000 }) + '\n';
            const original = Buffer.from(payload.slice(0, 40000), 'utf8');

            const emitted = await encoderCompression.compressPayloadForAction(PUBLIC_RAW, original);
            assert.strictEqual(emitted.compressed, true, 'fixture should compress');

            // Exactly what lands on chain: the rewritten action + the bytes.
            const served = await compression.resolveServedBytes(emitted.rawData, emitted.data);
            assert.strictEqual(served.inflated, true);
            assert.ok(served.bytes.equals(original), 'end-to-end byte fidelity');
        });

        it('the two vendored ratio caps agree', function () {
            const encoderCompression = require(ENCODER_COMPRESSION);
            assert.strictEqual(encoderCompression.COMPRESSION_MAX_RATIO, compression.COMPRESSION_MAX_RATIO);
            assert.strictEqual(encoderCompression.COMPRESSION_CODE_DEFLATE_RAW, compression.COMPRESSION_CODE_DEFLATE_RAW);
            assert.strictEqual(encoderCompression.COMPRESSION_FIELD_INDEX, compression.COMPRESSION_FIELD_INDEX);
        });
    });
});
