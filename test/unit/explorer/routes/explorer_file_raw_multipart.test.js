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
const zlib = require('zlib');
const { Writable } = require('stream');
const proxyquire = require('proxyquire');
const sinon = require('sinon');
const { expect } = require('chai');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { mockRes } = require('../../../fixtures/mock-query-args.js');
const lookupMethods = require('../../../../src/db/readers/entities/lookups.js');
const compression = require('../../../../src/http/compression.js');
const iconFetch = require('../../../../src/icons/downloader/fetch.js');

function makeExplorer(db) {
    const XChainExplorer = proxyquire('../../../../src/XChainExplorer.js', {
        express: { Router: () => ({ get: () => {}, use: () => {} }), static: () => {} },
        axios: {},
        './db/index.js': function() { this.init = () => {}; }
    });
    const app = { get: () => {}, post: () => {}, use: () => {}, listen: () => {} };
    const explorer = new XChainExplorer(app, createConfigInfoStub());
    explorer.db = db;
    return explorer;
}

function req(index = 50, range) {
    return { params: { coin: 'rbtc', actionIndex: String(index) }, headers: range ? { range } : {} };
}

function digest(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function manifestData({ gated = false, compressed = false } = {}) {
    return ['FILE', '1', 'a'.repeat(64), '2', '4', 'file.bin', 'application/octet-stream',
        '', '', gated ? 'TOKEN' : '', gated ? '1' : '', gated ? 'b'.repeat(64) : '', '',
        compressed ? '1' : '0'].join('|');
}

function completeRecord(chunks, options = {}) {
    return {
        kind: 'manifest',
        action_index: 50,
        file_hash: 'a'.repeat(64),
        total_parts: chunks.length,
        total_bytes: chunks.reduce((sum, bytes) => sum + bytes.length, 0),
        parts_received: chunks.length,
        completion_result: 'complete',
        name: options.name || 'file.bin',
        type: options.type || 'application/octet-stream',
        gated: Boolean(options.gated),
        data: manifestData(options),
        parts: chunks.map((bytes, position) => ({
            position,
            action_index: 60 + position,
            tx_hash: 'part-' + position,
            byte_length: bytes.length,
            part_digest: digest(bytes),
            raw_data: bytes
        }))
    };
}

function routeDb(record) {
    const storedData = record && record.data;
    if(record) record.data = null;
    const db = {
        pools: { RBTC: {} },
        getMultipartFileRaw: sinon.stub().resolves(record),
        readPartBytes: sinon.stub().callsFake(async (_config, current, positions) => {
            current.data = storedData;
            return positions.map(position => ({
                position,
                raw_data: current.parts[position].raw_data
            }));
        }),
        getGatedFileRaw: sinon.stub().resolves([]),
        getFileRaw: sinon.stub().resolves(null)
    };
    return db;
}

function streamRes() {
    const chunks = [];
    const res = new Writable({
        write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
        }
    });
    res._status = 200;
    res._headers = {};
    res._body = null;
    res._headersSent = false;
    Object.defineProperty(res, 'headersSent', { get: () => res._headersSent });
    res.status = code => { res._status = code; return res; };
    res.set = (name, value) => { res._headers[name] = value; return res; };
    res.json = body => { res._body = body; return res; };
    res.send = body => { res._body = body; return res; };
    res.flushHeaders = () => { res._headersSent = true; };
    const write = res.write.bind(res);
    res.write = (...args) => { res._headersSent = true; return write(...args); };
    res.on('error', () => {});
    res.bytes = () => Buffer.concat(chunks);
    return res;
}

function reader(partCount, decoderDb = 'Decoder_RBTC') {
    const chunks = Array.from({ length: partCount }, (_, position) => Buffer.from('part-' + position));
    const manifestHash = 'manifest-hash';
    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const indexRows = chunks.map((bytes, position) => ({
        manifest_action_index: 50,
        manifest_status: 'valid',
        part_exists: 0,
        file_hash: 'a'.repeat(64),
        total_parts: partCount,
        total_bytes: totalBytes,
        name: 'file.bin',
        type: 'application/octet-stream',
        gated: 0,
        completion_result: 'complete',
        manifest_tx_hash: manifestHash,
        position,
        part_action_index: 60 + position,
        part_tx_hash: 'part-hash-' + position,
        byte_length: bytes.length,
        part_digest: digest(bytes)
    }));
    const decoderRows = [
        { hash: manifestHash, raw_data: null, data: manifestData() },
        ...chunks.map((bytes, position) => ({ hash: 'part-hash-' + position, raw_data: bytes, data: 'FILE|2' }))
    ];
    return {
        util: { isNull: value => value === null || value === undefined },
        decoderDb: { RBTC: decoderDb },
        doQuery: sinon.stub().resolves(indexRows),
        doDecoderQuery: sinon.stub().resolves(decoderRows)
    };
}

describe('multipart FILE raw route', function () {
    it('serves a complete public manifest byte-identically and bypasses legacy readers', async function () {
        const bytes = Buffer.from('multipart byte identity');
        const db = routeDb(completeRecord([bytes.subarray(0, 7), bytes.subarray(7)]));
        const res = streamRes();

        await makeExplorer(db).processFileRawRequest(req(), res);

        expect(res._status).to.equal(200);
        expect(res.bytes().equals(bytes)).to.equal(true);
        expect(res._headers['Content-Length']).to.equal(String(bytes.length));
        expect(res._headers['Accept-Ranges']).to.equal('bytes');
        expect(res._headers['Cache-Control']).to.equal('public, max-age=31536000, immutable');
        expect(db.getGatedFileRaw.called).to.equal(false);
        expect(db.getFileRaw.called).to.equal(false);
    });

    it('inflates a compressed public manifest with the multipart output cap', async function () {
        const original = Buffer.from('compressed multipart '.repeat(200));
        const stored = zlib.deflateRawSync(original);
        const record = completeRecord([stored.subarray(0, 5), stored.subarray(5)], { compressed: true });
        const res = streamRes();

        await makeExplorer(routeDb(record)).processFileRawRequest(req(), res);

        expect(res.bytes().equals(original)).to.equal(true);
        expect(res._headers['X-XChain-Compression']).to.equal('deflate-raw');
        expect(res._headers['X-XChain-Stored-Length']).to.equal(String(stored.length));
    });

    it('serves gated multipart ciphertext without inflating it', async function () {
        const ciphertext = Buffer.from('not-a-deflate-stream');
        const record = completeRecord([ciphertext.subarray(0, 4), ciphertext.subarray(4)], {
            gated: true,
            compressed: true,
            name: 'secret.bin'
        });
        const res = streamRes();

        await makeExplorer(routeDb(record)).processFileRawRequest(req(), res);

        expect(res.bytes().equals(ciphertext)).to.equal(true);
        expect(res._headers['X-XChain-Stored-Form']).to.equal('encrypted');
        expect(res._headers['Content-Disposition']).to.include('secret.bin');
        expect(res._headers).to.not.have.property('X-XChain-Compression');
    });

    it('serves one stored-form range and refuses a multi-range', async function () {
        const chunks = Array.from({ length: 40 }, (_, position) => Buffer.from(String(position).padStart(3, '0')));
        const record = completeRecord(chunks);
        const db = routeDb(record);
        const ranged = streamRes();

        await makeExplorer(db).processFileRawRequest(req(50, 'bytes=95-97'), ranged);

        const all = Buffer.concat(chunks);
        expect(ranged._status).to.equal(206);
        expect(ranged.bytes().equals(all.subarray(95, 98))).to.equal(true);
        expect(ranged._headers['Content-Range']).to.equal(`bytes 95-97/${all.length}`);
        expect(db.readPartBytes.callCount).to.equal(2);
        expect(db.readPartBytes.firstCall.args[2][0]).to.equal(16);

        const refused = streamRes();
        await makeExplorer(routeDb(completeRecord(chunks)))
            .processFileRawRequest(req(50, 'bytes=0-1,4-5'), refused);
        expect(refused._status).to.equal(416);
        expect(refused._headers['Content-Range']).to.equal(`bytes */${all.length}`);
    });

    it('serves ratio bombs and corrupt deflate streams in stored form', async function () {
        const bomb = zlib.deflateRawSync(Buffer.alloc(20000));
        const cases = [
            [bomb, 'RATIO_GUARD_TRIPPED'],
            [Buffer.from('not a deflate stream'), 'INVALID_DEFLATE_STREAM']
        ];
        for(const [stored, error] of cases) {
            const record = completeRecord([stored.subarray(0, 5), stored.subarray(5)], { compressed: true });
            const res = streamRes();
            await makeExplorer(routeDb(record)).processFileRawRequest(req(), res);
            expect(res.bytes().equals(stored)).to.equal(true);
            expect(res._headers['X-XChain-Stored-Form']).to.equal('compressed');
            expect(res._headers['X-XChain-Compression-Error']).to.equal(error);
            expect(res._headers['Content-Type']).to.equal('application/octet-stream');
            expect(res._headers['Content-Disposition']).to.equal('attachment');
        }
    });

    it('destroys the response when a part fails its digest in inflate pass 2', async function () {
        const original = Buffer.from('second pass integrity '.repeat(100));
        const stored = zlib.deflateRawSync(original);
        const record = completeRecord([stored.subarray(0, 5), stored.subarray(5)], { compressed: true });
        const db = routeDb(record);
        db.readPartBytes.callsFake(async (_config, current, positions) => {
            current.data = manifestData({ compressed: true });
            return positions.map(position => ({
                position,
                raw_data: db.readPartBytes.callCount > 1 && position === 0 ? Buffer.alloc(5) : current.parts[position].raw_data
            }));
        });
        const res = streamRes();

        await makeExplorer(db).processFileRawRequest(req(), res);

        expect(res.destroyed).to.equal(true);
        expect(res._headersSent).to.equal(true);
        expect(res.bytes()).to.have.lengthOf(0);
    });
});

describe('multipart FILE raw route refusals', function () {
    it('returns each multipart refusal with no-store', async function () {
        const cases = [
            [{ kind: 'part' }, 404, 'FILE_PART'],
            [{ kind: 'manifest-invalid' }, 404, 'NOT_FOUND'],
            [{ kind: 'manifest', completion_result: null, parts_received: 1, total_parts: 2 }, 409, 'FILE_INCOMPLETE'],
            [{ kind: 'manifest', completion_result: 'mismatch' }, 422, 'FILE_ASSEMBLY_MISMATCH']
        ];
        for(const [record, status, code] of cases) {
            const res = mockRes();
            await makeExplorer(routeDb(record)).processFileRawRequest(req(), res);
            expect(res._status).to.equal(status);
            expect(res._body.code).to.equal(code);
            expect(res._headers['Cache-Control']).to.equal('no-store');
        }
        const incomplete = mockRes();
        await makeExplorer(routeDb({
            kind: 'manifest', completion_result: null, parts_received: 1, total_parts: 2
        })).processFileRawRequest(req(), incomplete);
        expect(incomplete._body).to.include({ parts_received: 1, total_parts: 2 });
    });

    it('returns FILE_PART_CORRUPT when bytes fail their digest', async function () {
        const record = completeRecord([Buffer.from('one'), Buffer.from('two')]);
        record.parts[0].part_digest = '0'.repeat(64);
        const res = streamRes();

        await makeExplorer(routeDb(record)).processFileRawRequest(req(), res);

        expect(res._status).to.equal(500);
        expect(res._body.code).to.equal('FILE_PART_CORRUPT');
        expect(res._headers['Cache-Control']).to.equal('no-store');
    });

    it('turns a multipart decoder failure into a 5xx without legacy reads', async function () {
        const db = routeDb(null);
        db.getMultipartFileRaw.rejects(new Error('decoder unavailable'));
        const res = streamRes();

        await makeExplorer(db).processFileRawRequest(req(), res);

        expect(res._status).to.equal(500);
        expect(res._body.code).to.equal('SERVER_ERROR');
        expect(db.getGatedFileRaw.called).to.equal(false);
        expect(db.getFileRaw.called).to.equal(false);
    });
});

describe('multipart FILE reader', function () {
    it('separates one metadata query from paged decoder reads', async function () {
        for(const count of [2, 26]) {
            const db = reader(count);
            const result = await lookupMethods.getMultipartFileRaw.call(db, { coin: 'RBTC' }, 50);
            expect(result.parts).to.have.lengthOf(count);
            expect(db.doQuery.callCount).to.equal(1);
            expect(db.doDecoderQuery.callCount).to.equal(0);
            const rows = await lookupMethods.readPartBytes.call(db, { coin: 'RBTC' }, result, [0, 1]);
            expect(rows).to.have.lengthOf(2);
            expect(db.doDecoderQuery.callCount).to.equal(1);
            expect(db.doDecoderQuery.firstCall.args[2]).to.have.lengthOf(3);
            expect(result.data).to.equal(manifestData());
        }
    });

    it('trips the decoder identifier guard before issuing the decoder query', async function () {
        const db = reader(2, 'bad`name');
        let error = null;
        try {
            const result = await lookupMethods.getMultipartFileRaw.call(db, { coin: 'RBTC' }, 50);
            await lookupMethods.readPartBytes.call(db, { coin: 'RBTC' }, result, [0]);
        } catch(e) {
            error = e;
        }
        expect(error).to.be.an('error');
        expect(db.doQuery.callCount).to.equal(1);
        expect(db.doDecoderQuery.called).to.equal(false);
    });

    it('detects part indexes and invalid manifests without querying the decoder', async function () {
        for(const [row, kind] of [
            [{ manifest_action_index: null, part_exists: 1 }, 'part'],
            [{ manifest_action_index: 50, manifest_status: 'invalid: VERSION', part_exists: 0 }, 'manifest-invalid']
        ]) {
            const db = reader(2);
            db.doQuery.resolves([row]);
            const result = await lookupMethods.getMultipartFileRaw.call(db, { coin: 'RBTC' }, 50);
            expect(result.kind).to.equal(kind);
            expect(db.doDecoderQuery.called).to.equal(false);
        }
    });
});

describe('multipart FILE action fields', function () {
    it('reads version 1 gate and compression fields', function () {
        expect(compression.isCompressedAction(manifestData({ compressed: true }))).to.equal(true);
        expect(compression.isGatedAction(manifestData({ gated: true }))).to.equal(true);
        expect(compression.isCompressedAction('FILE|2|' + 'a'.repeat(64) + '|0')).to.equal(false);
    });

    it('enforces an explicit maximum output size', async function () {
        const original = Buffer.from('bounded output '.repeat(20));
        const stored = zlib.deflateRawSync(original);
        const result = await compression.resolveServedBytes(
            stored,
            manifestData({ compressed: true }),
            { maxOutputBytes: original.length - 1 }
        );
        expect(result.storedForm).to.equal(true);
        expect(result.bytes.equals(stored)).to.equal(true);
    });
});

describe('multipart FILE icon source', function () {
    it('skips a manifest before the gated and legacy FILE readers', async function () {
        const db = {
            pools: { RBTC: {} },
            getMultipartFileRaw: sinon.stub().resolves({ kind: 'manifest' }),
            getGatedFileRaw: sinon.stub().resolves([]),
            getFileRaw: sinon.stub().resolves(null)
        };
        let error = null;
        try {
            await iconFetch.fetchActionFileBytes({ explorer: { db } }, { index: '50' }, { poolKey: 'RBTC' });
        } catch(e) {
            error = e;
        }
        expect(error).to.be.an('error');
        expect(error.message).to.include('multi-part manifest');
        expect(db.getMultipartFileRaw.firstCall.args[2]).to.deep.equal({ metadataOnly: true });
        expect(db.getGatedFileRaw.called).to.equal(false);
        expect(db.getFileRaw.called).to.equal(false);
    });
});
