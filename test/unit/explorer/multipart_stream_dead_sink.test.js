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

function split(bytes, count) {
    const parts = [];
    let offset = 0;
    for(let position = 0; position < count; position++) {
        const length = Math.ceil((bytes.length - offset) / (count - position));
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

// A compressed manifest whose part reads take a real macrotask, as a database read does.
function slowFixture(parts) {
    const record = {
        kind: 'manifest',
        total_parts: parts.length,
        total_bytes: parts.reduce((sum, bytes) => sum + bytes.length, 0),
        gated: false,
        data: ['FILE', '1', 'a'.repeat(64), '2', '4', 'file.bin', 'application/octet-stream',
            '', '', '', '', '', '', '1'].join('|'),
        parts: parts.map((bytes, position) => ({
            position, tx_hash: 'part-' + position, byte_length: bytes.length, part_digest: digest(bytes)
        }))
    };
    const db = {
        readPartBytes: sinon.stub().callsFake(async (_config, _record, positions) => {
            await new Promise(resolve => setTimeout(resolve, 15));
            return positions.map(position => ({ position, raw_data: parts[position] }));
        })
    };
    return { record, db };
}

function deadline(promise, label) {
    let timer;
    const limit = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('hung: ' + label)), 2000);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// Settle a promise within the deadline and return the error it rejected with, or null.
async function captureFailure(promise, label) {
    let failure = null;
    await deadline(promise.catch(error => { failure = error; }), label);
    return failure;
}

describe('multipart FILE byte stream when the sink dies between decoder pages', function () {
    it('settles an invalid deflate stream that errors across a 16-part page', async function () {
        const parts = Array.from({ length: 40 }, (_unused, position) =>
            Buffer.from(position === 0 ? [7, 1, 2, 3] : [4, 5, 6, 7]));
        const { record, db } = slowFixture(parts);

        const inspected = await deadline(stream.inspectInflated(db, {}, record), 'invalid deflate');

        expect(inspected).to.deep.equal({ ok: false, error: 'INVALID_DEFLATE_STREAM' });
        expect(db.readPartBytes.callCount).to.be.below(Math.ceil(40 / stream.PART_PAGE_SIZE) + 1);
    });

    it('settles a ratio bomb whose output cap trips before the second page', async function () {
        const bomb = zlib.deflateRawSync(Buffer.alloc(8 * 1024 * 1024));
        const { record, db } = slowFixture(split(bomb, 40));

        const inspected = await deadline(stream.inspectInflated(db, {}, record), 'ratio trip');

        expect(inspected).to.deep.equal({ ok: false, error: 'RATIO_GUARD_TRIPPED' });
    });

    it('rejects a stored-form write when the client closes during a drain wait', async function () {
        const parts = Array.from({ length: 4 }, () => Buffer.alloc(8, 1));
        const { record, db } = slowFixture(parts);
        const client = new Writable({ highWaterMark: 1, write() {} });
        setTimeout(() => client.destroy(), 20);

        const failure = await captureFailure(stream.streamParts(db, {}, record, 0, 31, client), 'client close');

        expect(failure).to.be.an('error');
        expect(failure.sinkClosed).to.equal(true);
    });

    it('stops the inflated stream when the client sink closes first', async function () {
        const raw = noisyBytes(40 * 64);
        const { record, db } = slowFixture(split(zlib.deflateRawSync(raw), 40));
        const client = new Writable({ highWaterMark: 1, write() {} });
        setTimeout(() => client.destroy(), 30);

        const failure = await captureFailure(stream.streamInflated(db, {}, record, client), 'inflated client close');

        expect(failure).to.be.an('error');
    });

    it('rejects before reading parts when the inflated sink is already destroyed', async function () {
        const raw = noisyBytes(40 * 64);
        const { record, db } = slowFixture(split(zlib.deflateRawSync(raw), 40));
        const client = new Writable({ highWaterMark: 1, write() {} });
        client.destroy();
        await new Promise(resolve => setImmediate(resolve));

        const failure = await captureFailure(stream.streamInflated(db, {}, record, client), 'preclosed sink');

        expect(failure).to.be.an('error');
        expect(failure.sinkClosed).to.equal(true);
        expect(db.readPartBytes.called).to.equal(false);
    });

    it('rejects before reading parts when the inflated sink already ended', async function () {
        const raw = noisyBytes(40 * 64);
        const { record, db } = slowFixture(split(zlib.deflateRawSync(raw), 40));
        const client = new Writable({ write(_chunk, _encoding, done) { done(); } });
        client.end();

        const failure = await captureFailure(stream.streamInflated(db, {}, record, client), 'ended sink');

        expect(failure).to.be.an('error');
        expect(failure.sinkClosed).to.equal(true);
        expect(db.readPartBytes.called).to.equal(false);
    });

    it('settles when the client closes after the last part is written but before the inflater ends', async function () {
        const raw = Buffer.alloc(2 * 1024 * 1024);
        const { record, db } = slowFixture(split(zlib.deflateRawSync(raw), 4));
        const client = new Writable({ highWaterMark: 1, write() {} });
        setTimeout(() => client.destroy(), 80);

        const failure = await captureFailure(stream.streamInflated(db, {}, record, client), 'close after last write');

        expect(failure).to.be.an('error');
        expect(db.readPartBytes.callCount).to.equal(1);
    });
});
