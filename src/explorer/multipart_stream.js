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
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const { once } = require('events');
const zlib = require('zlib');
const compression = require('../http/compression.js');
const multipart = require('./multipart_file.js');

const PART_PAGE_SIZE = 16;

function corrupt(message) {
    return new multipart.MultipartFileError('FILE_PART_CORRUPT', 500, message);
}

function byteLayout(record) {
    const totalParts = Number(record.total_parts);
    if(!Array.isArray(record.parts) || record.parts.length !== totalParts)
        throw new multipart.MultipartFileError('SERVER_ERROR', 500, 'Multipart FILE parts are unavailable');
    const starts = [];
    let total = 0;
    for(let position = 0; position < totalParts; position++) {
        const part = record.parts[position];
        const length = part && Number(part.byte_length);
        if(!part || Number(part.position) !== position || !Number.isSafeInteger(length) || length < 0)
            throw corrupt('Multipart FILE part lengths are corrupt');
        starts.push(total);
        total += length;
        if(!Number.isSafeInteger(total)) throw corrupt('Multipart FILE part lengths are corrupt');
    }
    if(total !== Number(record.total_bytes)) throw corrupt('Multipart FILE part lengths are corrupt');
    return { starts, total };
}

function parseRange(rangeHeader, total) {
    if(rangeHeader === undefined || rangeHeader === null || String(rangeHeader).trim() === '')
        return { status: 200, fromByte: 0, toByte: total - 1 };
    const value = String(rangeHeader).trim();
    if(!value.startsWith('bytes=') || value.includes(',')) return { status: 416 };
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if(!match || (!match[1] && !match[2]) || total === 0) return { status: 416 };
    let fromByte;
    let toByte;
    if(!match[1]) {
        const suffix = Number(match[2]);
        if(!Number.isSafeInteger(suffix) || suffix <= 0) return { status: 416 };
        fromByte = Math.max(0, total - suffix);
        toByte = total - 1;
    } else {
        fromByte = Number(match[1]);
        toByte = match[2] ? Number(match[2]) : total - 1;
        if(!Number.isSafeInteger(fromByte) || !Number.isSafeInteger(toByte) || fromByte >= total || toByte < fromByte)
            return { status: 416 };
        toByte = Math.min(toByte, total - 1);
    }
    return { status: 206, fromByte, toByte };
}

function planServe(record, rangeHeader) {
    const layout = byteLayout(record);
    const storedForm = record.gated || !compression.isCompressedAction(record.data);
    const range = storedForm ? parseRange(rangeHeader, layout.total) : {
        status: 200,
        fromByte: 0,
        toByte: layout.total - 1
    };
    return { ...range, totalBytes: layout.total, starts: layout.starts, storedForm };
}

function normalizeBytes(value) {
    if(Buffer.isBuffer(value)) return value;
    if(value instanceof Uint8Array) return Buffer.from(value);
    return null;
}

async function writeChunk(sink, chunk) {
    if(chunk.length === 0) return;
    if(sink.write(chunk) !== false) return;
    await once(sink, 'drain');
}

async function loadPage(db, config, record, positions) {
    const prefetched = record._multipartPrefetchedPage;
    if(prefetched && prefetched.positions.length === positions.length &&
        prefetched.positions.every((position, index) => position === positions[index])) {
        delete record._multipartPrefetchedPage;
        return prefetched.rows;
    }
    if(prefetched) delete record._multipartPrefetchedPage;
    return await db.readPartBytes(config, record, positions);
}

async function prefetchManifest(db, config, record, fromByte = 0) {
    const { starts } = byteLayout(record);
    const first = starts.findIndex((start, position) => start + Number(record.parts[position].byte_length) > fromByte);
    const pageStart = Math.floor(Math.max(0, first) / PART_PAGE_SIZE) * PART_PAGE_SIZE;
    const positions = record.parts.slice(pageStart, pageStart + PART_PAGE_SIZE).map(part => part.position);
    const rows = await db.readPartBytes(config, record, positions);
    record._multipartPrefetchedPage = { positions, rows };
    if(typeof record.data !== 'string')
        throw new multipart.MultipartFileError('SERVER_ERROR', 500, 'Multipart FILE manifest data is unavailable');
}

async function streamParts(db, config, record, fromByte, toByte, sink) {
    const { starts, total } = byteLayout(record);
    if(total === 0) return;
    const first = starts.findIndex((start, position) => start + Number(record.parts[position].byte_length) > fromByte);
    let last = record.parts.length - 1;
    while(last >= 0 && starts[last] > toByte) last--;
    if(first < 0 || last < first) return;
    const firstPage = Math.floor(first / PART_PAGE_SIZE) * PART_PAGE_SIZE;
    for(let pageStart = firstPage; pageStart <= last; pageStart += PART_PAGE_SIZE) {
        const pageParts = record.parts.slice(pageStart, Math.min(pageStart + PART_PAGE_SIZE, record.parts.length));
        const positions = pageParts.map(part => part.position);
        const rows = await loadPage(db, config, record, positions);
        const byPosition = new Map((rows || []).map(row => [Number(row.position), row]));
        for(const part of pageParts) {
            const row = byPosition.get(Number(part.position));
            const bytes = row ? normalizeBytes(row.raw_data) : null;
            if(!bytes) throw corrupt('Multipart FILE part is unavailable');
            const digest = crypto.createHash('sha256').update(bytes).digest('hex');
            if(bytes.length !== Number(part.byte_length) || digest !== String(part.part_digest).toLowerCase())
                throw corrupt('Multipart FILE part is corrupt');
            const partStart = starts[part.position];
            const sliceStart = Math.max(0, fromByte - partStart);
            const sliceEnd = Math.min(bytes.length, toByte - partStart + 1);
            if(sliceStart < sliceEnd) await writeChunk(sink, bytes.subarray(sliceStart, sliceEnd));
        }
    }
}

async function inspectInflated(db, config, record) {
    const inflater = zlib.createInflateRaw();
    const ceiling = multipart.maxInflatedBytes(record.total_bytes);
    let length = 0;
    let ratioTripped = false;
    const result = new Promise(resolve => {
        inflater.on('data', chunk => {
            length += chunk.length;
            if(length > ceiling && !ratioTripped) {
                ratioTripped = true;
                const error = new Error('Inflated multipart FILE exceeds its output cap');
                error.multipartCompressionError = 'RATIO_GUARD_TRIPPED';
                inflater.destroy(error);
            }
        });
        inflater.on('end', () => resolve({ ok: true, length }));
        inflater.on('error', error => {
            if(!error.multipartCompressionError)
                error.multipartCompressionError = 'INVALID_DEFLATE_STREAM';
            resolve({ ok: false, error: error.multipartCompressionError });
        });
    });
    try {
        await streamParts(db, config, record, 0, Number(record.total_bytes) - 1, inflater);
        inflater.end();
    } catch(error) {
        if(error.multipartCompressionError) return await result;
        inflater.destroy();
        throw error;
    }
    return await result;
}

async function streamInflated(db, config, record, sink) {
    const inflater = zlib.createInflateRaw();
    const ended = new Promise((resolve, reject) => {
        inflater.on('end', resolve);
        inflater.on('error', reject);
        sink.on('error', reject);
    });
    inflater.pipe(sink);
    try {
        await streamParts(db, config, record, 0, Number(record.total_bytes) - 1, inflater);
        inflater.end();
        await ended;
    } catch(error) {
        inflater.destroy();
        throw error;
    }
}

module.exports = {
    PART_PAGE_SIZE,
    planServe,
    prefetchManifest,
    streamParts,
    inspectInflated,
    streamInflated
};
