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
const path       = require('path');
const { createConfigInfoStub } = require('../../fixtures/mock-config.js');
const { mockRes }              = require('../../fixtures/mock-query-args.js');

const ICONS_DIR = path.resolve(path.join(__dirname, '..', '../../src/content/icons'));

/**
 * Build a minimal XChainExplorer instance with the given fs stub.
 * We use proxyquire with noCallThru so that heavy dependencies (mariadb,
 * express, axios) never execute; only fs is the seam we care about here.
 */
function makeExplorer(fsStub) {
    const XChainExplorer = proxyquire('../../../src/XChainExplorer.js', {
        fs:       fsStub,
        express:  { Router: () => ({ get: () => {}, use: () => {} }), static: () => {} },
        axios:    {},
        './db/index.js': function() { this.init = () => {}; }
    });

    const configInfo = createConfigInfoStub();
    const app = {
        get:    () => {},
        post:   () => {},
        use:    () => {},
        listen: () => {}
    };
    return new XChainExplorer(app, configInfo);
}

// The icon handler reads only the request path, so that is all the mock carries.
function makeIconReq(iconPath) {
    return { path: iconPath };
}

describe('XChainExplorer#processIconRequest', function () {
    it('serves the file when icon exists', async function () {
        const existingIcon = '/icon/BTC.png';
        const expectedFile = path.resolve(path.join(ICONS_DIR, '/BTC.png'));

        const fsStub = { existsSync: sinon.stub().returns(true) };
        const explorer = makeExplorer(fsStub);
        const req = makeIconReq(existingIcon);
        const res = mockRes();

        await explorer.processIconRequest(req, res);

        expect(fsStub.existsSync.calledOnce).to.be.true;
        expect(fsStub.existsSync.firstCall.args[0]).to.equal(expectedFile);
        expect(res._sentFile).to.equal(expectedFile);
        expect(res._redirect).to.be.null;
        expect(res._status).to.equal(200);
    });

    it('redirects to /icon/default.png when icon does not exist', async function () {
        const fsStub = { existsSync: sinon.stub().returns(false) };
        const explorer = makeExplorer(fsStub);
        const req = makeIconReq('/icon/UNKNOWN.png');
        const res = mockRes();

        await explorer.processIconRequest(req, res);

        expect(fsStub.existsSync.calledOnce).to.be.true;
        expect(res._sentFile).to.be.null;
        expect(res._redirect).to.deep.equal({ code: 302, url: '/icon/default.png' });
    });

    it('returns 403 for a path traversal that escapes the icons directory', async function () {
        const fsStub = { existsSync: sinon.stub() };
        const explorer = makeExplorer(fsStub);
        // The request path as Express would see it (after /icon prefix)
        const req = makeIconReq('/icon/../../../etc/passwd');
        const res = mockRes();

        await explorer.processIconRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Access denied', code: 'PATH_DENIED' });
        // fs.existsSync must NOT be called; we blocked before reaching it
        expect(fsStub.existsSync.called).to.be.false;
    });
});

describe('XChainExplorer#processIconRequest', function () {
    // A .. segment is only a traversal if it escapes: one that stays inside the
    // icons directory is an edge case that must still be served.
    it('allows a .. segment that resolves back into the icons directory', async function () {
        // e.g. /icon/BTC/../BTC.png resolves to <icons>/BTC.png which is still inside icons dir
        const fsStub = { existsSync: sinon.stub().returns(true) };
        const explorer = makeExplorer(fsStub);
        const req = makeIconReq('/icon/BTC/../BTC.png');
        const res = mockRes();

        await explorer.processIconRequest(req, res);

        // Should NOT get a 403; the resolved path is still inside icons dir
        expect(res._status).to.equal(200);
        expect(res._sentFile).to.not.be.null;
    });

    // A path that escapes is refused before any file lookup, so the disk is never probed.
    it('returns 403 when the resolved path points outside icons directory via deep traversal', async function () {
        const fsStub = { existsSync: sinon.stub() };
        const explorer = makeExplorer(fsStub);
        // Four levels up should escape regardless of where icons dir lives
        const req = makeIconReq('/icon/../../../../tmp/evil');
        const res = mockRes();

        await explorer.processIconRequest(req, res);

        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Access denied', code: 'PATH_DENIED' });
        expect(fsStub.existsSync.called).to.be.false;
    });

});

describe('XChainExplorer#processIconRequest, percent-encoded tick segment', function () {
    // The client percent-encodes the tick segment and the downloader names the
    // file after the raw tick, so the lookup has to decode or a tick carrying
    // '%' or '#' can never be served its own icon.
    it('decodes a percent-encoded tick before the disk lookup', async function () {
        const fsStub = { existsSync: sinon.stub().returns(true) };
        const explorer = makeExplorer(fsStub);
        const req = makeIconReq('/icon/DOGE/testnet/%24%24%24%24%24%24%24%24%24%24%2478324%25%40%23%23*(%40%23.png');
        const res = mockRes();

        await explorer.processIconRequest(req, res);

        const expectedFile = path.resolve(path.join(ICONS_DIR, 'DOGE', 'testnet', '$$$$$$$$$$$78324%@##*(@#.png'));
        expect(fsStub.existsSync.firstCall.args[0]).to.equal(expectedFile);
        expect(res._sentFile).to.equal(expectedFile);
        expect(res._redirect).to.be.null;
    });

    // An encoding that does not parse is a miss served as the default, never a
    // thrown URIError turned into an error page the <img> renders as broken.
    it('redirects a malformed percent-encoding to the default icon without touching disk', async function () {
        const fsStub = { existsSync: sinon.stub() };
        const explorer = makeExplorer(fsStub);
        const req = makeIconReq('/icon/DOGE/testnet/BAD%ZZ.png');
        const res = mockRes();

        await explorer.processIconRequest(req, res);

        expect(res._redirect).to.deep.equal({ code: 302, url: '/icon/default.png' });
        expect(fsStub.existsSync.called).to.be.false;
    });

});

describe('XChainExplorer#processIconRequest, decoding runs before containment', function () {
    // Decoding happens BEFORE the containment check, so an encoded traversal is
    // still caught by it.
    it('returns 403 when the traversal is percent-encoded', async function () {
        const fsStub = { existsSync: sinon.stub() };
        const explorer = makeExplorer(fsStub);
        const req = makeIconReq('/icon/%2E%2E%2F%2E%2E%2F%2E%2E%2F%2E%2E%2Ftmp%2Fevil');
        const res = mockRes();

        await explorer.processIconRequest(req, res);

        expect(res._status).to.equal(403);
        expect(fsStub.existsSync.called).to.be.false;
    });
});
