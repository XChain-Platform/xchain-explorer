'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const crypto = require('crypto');
const { Writable } = require('stream');
const zlib = require('zlib');
const sinon = require('sinon');
const { expect } = require('chai');
const stream = require('../../../src/explorer/multipart_stream.js');

function digest(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function actionData(compressed) {
    return ['FILE', '1', 'a'.repeat(64), '2', '4', 'file.bin', 'application/octet-stream',
        '', '', '', '', '', '', compressed ? '1' : '0'].join('|');
}

function split(bytes, count) {
    const parts = [];
    let offset = 0;
    for(let position = 0; position < count; position++) {
        const remainingParts = count - position;
        const length = Math.ceil((bytes.length - offset) / remainingParts);
        parts.push(bytes.subarray(offset, offset + length));
        offset += length;
    }
    return parts;
}

function noisyBytes(length) {
    const chunks = [];
    for(let index = 0; Buffer.concat(chunks).length < length; index++)
        chunks.push(crypto.createHash('sha256').update(String(index)).digest());
    return Buffer.concat(chunks).subarray(0, length);
}

function fixture(parts, compressed = false) {
    const record = {
        kind: 'manifest',
        total_parts: parts.length,
        total_bytes: parts.reduce((sum, bytes) => sum + bytes.length, 0),
        gated: false,
        data: actionData(compressed),
        parts: parts.map((bytes, position) => ({
            position,
            tx_hash: 'part-' + position,
            byte_length: bytes.length,
            part_digest: digest(bytes)
        }))
    };
    let largestPage = 0;
    const db = {
        readPartBytes: sinon.stub().callsFake(async (_config, _record, positions) => {
            largestPage = Math.max(largestPage, positions.length);
            return positions.map(position => ({ position, raw_data: parts[position] }));
        })
    };
    return { record, db, largestPage: () => largestPage };
}

function sink() {
    const chunks = [];
    const writable = new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            setImmediate(callback);
        }
    });
    writable.bytes = () => Buffer.concat(chunks);
    return writable;
}

describe('multipart FILE byte stream', function () {
    it('streams 600 parts byte-identically with one decoder page buffered', async function () {
        const expected = Buffer.from(Array.from({ length: 18000 }, (_, index) => index % 251));
        const parts = split(expected, 600);
        const { record, db, largestPage } = fixture(parts);
        const output = sink();

        await stream.prefetchManifest(db, {}, record);
        await stream.streamParts(db, {}, record, 0, expected.length - 1, output);
        output.end();

        expect(output.bytes().equals(expected)).to.equal(true);
        expect(largestPage()).to.equal(stream.PART_PAGE_SIZE);
        expect(db.readPartBytes.callCount).to.equal(Math.ceil(600 / stream.PART_PAGE_SIZE));
    });

    it('pins stored and compressed read counts at 40 and 600 parts', async function () {
        for(const count of [40, 600]) {
            const raw = noisyBytes(count * 40);
            const storedFixture = fixture(split(raw, count));
            const storedSink = sink();
            await stream.prefetchManifest(storedFixture.db, {}, storedFixture.record);
            await stream.streamParts(storedFixture.db, {}, storedFixture.record, 0, raw.length - 1, storedSink);
            storedSink.end();
            expect(1 + storedFixture.db.readPartBytes.callCount).to.equal(1 + Math.ceil(count / 16));

            const compressed = zlib.deflateRawSync(raw);
            const compressedFixture = fixture(split(compressed, count), true);
            await stream.prefetchManifest(compressedFixture.db, {}, compressedFixture.record);
            const inspected = await stream.inspectInflated(compressedFixture.db, {}, compressedFixture.record);
            expect(inspected).to.deep.equal({ ok: true, length: raw.length });
            const inflatedSink = sink();
            await stream.streamInflated(compressedFixture.db, {}, compressedFixture.record, inflatedSink);
            expect(inflatedSink.bytes().equals(raw)).to.equal(true);
            expect(1 + compressedFixture.db.readPartBytes.callCount)
                .to.equal(1 + (2 * Math.ceil(count / 16)));
        }
    });

    it('serves a 206 slice across the 16-part page boundary', async function () {
        const bytes = Buffer.from('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
        const { record, db } = fixture(split(bytes, 20));
        const plan = stream.planServe(record, 'bytes=47-51');
        const output = sink();

        expect(plan).to.include({ status: 206, fromByte: 47, toByte: 51, totalBytes: bytes.length });
        await stream.streamParts(db, {}, record, plan.fromByte, plan.toByte, output);
        output.end();

        expect(output.bytes().equals(bytes.subarray(47, 52))).to.equal(true);
        expect(db.readPartBytes.callCount).to.equal(2);
    });

    it('refuses multi-range and unsatisfiable requests with 416 plans', function () {
        const { record } = fixture([Buffer.from('abcd'), Buffer.from('efgh')]);
        expect(stream.planServe(record, 'bytes=0-1,4-5')).to.include({ status: 416, totalBytes: 8 });
        expect(stream.planServe(record, 'bytes=9-10')).to.include({ status: 416, totalBytes: 8 });
    });
});
