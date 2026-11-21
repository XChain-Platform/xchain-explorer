// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const proxyquire = require('proxyquire');
const sinon = require('sinon');
const { expect } = require('chai');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { mockRes } = require('../../../fixtures/mock-query-args.js');
const lookupMethods = require('../../../../src/db/readers/entities/lookups.js');
const iconFetch = require('../../../../src/icons/downloader/fetch.js');

function explorer(db){
    const XChainExplorer = proxyquire('../../../../src/XChainExplorer.js', {
        express: { Router: () => ({ get: () => {}, use: () => {} }), static: () => {} },
        axios: {},
        './db/index.js': function() { this.init = () => {}; }
    });
    const app = { get: () => {}, post: () => {}, use: () => {}, listen: () => {} };
    const instance = new XChainExplorer(app, createConfigInfoStub());
    instance.db = db;
    return instance;
}

function missingTableDb(bytes){
    const missing = Object.assign(new Error('missing multipart table'), {
        errno: 1146, code: 'ER_NO_SUCH_TABLE'
    });
    const db = {
        pools: { RBTC: {} },
        util: { isNull: value => value === null || value === undefined },
        doQuery: sinon.stub().rejects(missing),
        getGatedFileRaw: sinon.stub().resolves([]),
        getFileRaw: sinon.stub().resolves({
            raw_data: Buffer.from(bytes), data: 'FILE|0|x', type: 'application/octet-stream'
        })
    };
    db.getMultipartFileRaw = (config, index, options) =>
        lookupMethods.getMultipartFileRaw.call(db, config, index, options);
    return db;
}

describe('multipart FILE missing-table fallthrough', function(){
    it('serves a legacy FILE instead of answering 500', async function(){
        const db = missingTableDb('legacy bytes');
        const res = mockRes();
        const req = { params: { coin: 'rbtc', actionIndex: '50' }, headers: {} };

        await explorer(db).processFileRawRequest(req, res);

        expect(res._status).to.equal(200);
        expect(res._body.equals(Buffer.from('legacy bytes'))).to.equal(true);
        expect(db.getGatedFileRaw.calledOnce).to.equal(true);
        expect(db.getFileRaw.calledOnce).to.equal(true);
    });

    it('reads a legacy icon after the same schema failure', async function(){
        const db = missingTableDb('ICON');

        const bytes = await iconFetch.fetchActionFileBytes(
            { explorer: { db } }, { index: '50' }, { poolKey: 'RBTC' });

        expect(bytes.equals(Buffer.from('ICON'))).to.equal(true);
        expect(db.getGatedFileRaw.calledOnce).to.equal(true);
        expect(db.getFileRaw.calledOnce).to.equal(true);
    });
});
