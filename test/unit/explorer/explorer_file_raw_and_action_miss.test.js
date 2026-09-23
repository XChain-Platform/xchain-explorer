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

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { mockRes }              = require('../../fixtures/mock-query-args.js');
const { safeAttachmentFilename } = require('../../../src/explorer/files.js');

// Build an explorer with heavy dependencies stubbed, then hand it the db under test.
function makeExplorer(db) {
    const XChainExplorer = proxyquire('../../../src/XChainExplorer.js', {
        express:  { Router: () => ({ get: () => {}, use: () => {} }), static: () => {} },
        axios:    {},
        './db/index.js': function() { this.init = () => {}; }
    });
    const app = { get: () => {}, post: () => {}, use: () => {}, listen: () => {} };
    const explorer = new XChainExplorer(app, createConfigInfoStub());
    explorer.db = db;
    return explorer;
}

function fileReq(actionIndex) {
    return { params: { coin: 'rdoge', actionIndex: String(actionIndex) } };
}

const CIPHERTEXT = Buffer.from([1, 2, 3, 4]);

// Serve one gated FILE whose ciphertext is CIPHERTEXT, with the name lookup under test.
function gatedDb(getActionData) {
    return {
        pools: { RDOGE: {} },
        getGatedFileRaw: sinon.stub().resolves([{ raw_data: CIPHERTEXT }]),
        getFileRaw: sinon.stub().resolves(null),
        getActionData
    };
}

describe('XChainExplorer#processFileRawRequest gated filename', function () {
    it('names a gated download from the action NAME, both filename legs', async function () {
        const getActionData = sinon.stub().resolves({ name: 'report.pdf' });
        const explorer = makeExplorer(gatedDb(getActionData));
        const res = mockRes();

        const ret = await explorer.processFileRawRequest(fileReq(1186), res);

        expect(ret).to.equal(res, 'res.send returns res, not a promise');
        expect(res._body).to.equal(CIPHERTEXT);
        expect(res._headers['X-XChain-Stored-Form']).to.equal('encrypted');
        expect(res._headers['Content-Type']).to.equal('application/octet-stream');
        expect(res._headers['Content-Disposition'])
            .to.equal("attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf");
        expect(getActionData.calledOnce).to.be.true;
        expect(getActionData.firstCall.args[0]).to.deep.equal({ coin: 'RDOGE', data: {} });
        expect(getActionData.firstCall.args[1]).to.equal(1186);
    });

    it('strips CR/LF from a hostile name so it cannot inject a second header', async function () {
        const explorer = makeExplorer(gatedDb(sinon.stub().resolves({ name: 'a\r\nSet-Cookie: x="1"é.txt' })));
        const res = mockRes();

        await explorer.processFileRawRequest(fileReq(7), res);

        const cd = res._headers['Content-Disposition'];
        expect(cd).to.not.match(/[\r\n]/);
        expect(cd).to.equal(
            "attachment; filename=\"aSet-Cookie: x=_1__.txt\"; filename*=UTF-8''aSet-Cookie%3A%20x%3D%221%22%C3%A9.txt"
        );
    });

    it('serves the ciphertext unnamed when the name lookup fails or is empty', async function () {
        for (const getActionData of [
            sinon.stub().rejects(new Error('db down')),
            sinon.stub().resolves(null),
            sinon.stub().resolves({ name: '\r\n' })
        ]) {
            const explorer = makeExplorer(gatedDb(getActionData));
            const res = mockRes();
            await explorer.processFileRawRequest(fileReq(9), res);
            expect(res._body).to.equal(CIPHERTEXT);
            expect(res._headers).to.not.have.property('Content-Disposition');
        }
    });
});

describe('XChainExplorer#processFileRawRequest plain filename', function () {
    it('never resolves a name for a non-gated FILE, which keeps its plain attachment', async function () {
        const getActionData = sinon.stub().resolves({ name: 'x.html' });
        const explorer = makeExplorer({
            pools: { RDOGE: {} },
            getGatedFileRaw: sinon.stub().resolves([]),
            getFileRaw: sinon.stub().resolves({ type: 'text/html', data: Buffer.from('<b>'), compressed: 0 }),
            getActionData
        });
        const res = mockRes();

        await explorer.processFileRawRequest(fileReq(3), res);

        expect(getActionData.called).to.be.false;
        expect(res._headers['Content-Disposition']).to.equal('attachment');
    });

    it('safeAttachmentFilename answers null for a name that is empty after stripping', function () {
        expect(safeAttachmentFilename('\u0000\r\n ')).to.equal(null);
    });
});

describe('XChainExplorer#answerActionNotYetIndexed', function () {
    function actionDb(getMaxActionIndex) {
        return { pools: { RDOGE: {} }, getMaxActionIndex };
    }

    it('answers 404 ACTION_NOT_YET_INDEXED with the mark and a Retry-After above the mark', async function () {
        const explorer = makeExplorer(actionDb(sinon.stub().resolves(100n)));
        const res = mockRes();

        const answered = await explorer.answerActionNotYetIndexed({ path: '/rdoge/api/action/101' }, res);

        expect(answered).to.be.true;
        expect(res._status).to.equal(404);
        expect(res._headers['Retry-After']).to.equal('5');
        expect(JSON.parse(res._body)).to.deep.equal({
            error: 'This action has not been indexed yet.',
            code: 'ACTION_NOT_YET_INDEXED',
            indexed_through: '100'
        });
    });

    it('compares past 2^53 exactly', async function () {
        const explorer = makeExplorer(actionDb(sinon.stub().resolves(9007199254740993n)));
        const res = mockRes();
        expect(await explorer.answerActionNotYetIndexed({ path: '/RDOGE/api/action/9007199254740993' }, res)).to.be.false;
        expect(await explorer.answerActionNotYetIndexed({ path: '/RDOGE/api/action/9007199254740994' }, res)).to.be.true;
    });

    it('falls through at or below the mark, on a read failure, and off the action route', async function () {
        const res = mockRes();
        expect(await makeExplorer(actionDb(sinon.stub().resolves(100n)))
            .answerActionNotYetIndexed({ path: '/RDOGE/api/action/100' }, res)).to.be.false;
        expect(await makeExplorer(actionDb(sinon.stub().rejects(new Error('pool gone'))))
            .answerActionNotYetIndexed({ path: '/RDOGE/api/action/101' }, res)).to.be.false;
        const offRoute = sinon.stub().resolves(0n);
        expect(await makeExplorer(actionDb(offRoute))
            .answerActionNotYetIndexed({ path: '/RDOGE/api/block/101' }, res)).to.be.false;
        expect(offRoute.called).to.be.false;
        expect(res._body).to.equal(null);
    });
});
