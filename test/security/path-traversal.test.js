/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Security tests — Path Traversal Prevention
 *
 * Tests the /icon endpoint with various directory traversal payloads
 * and verifies the boundary check logic.
 *
 * Run: mocha test/security/path-traversal.test.js --timeout 0
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const path       = require('path');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { mockRes }              = require('../fixtures/mock-query-args.js');

// ---------------------------------------------------------------------------
// Explorer factory with stubbed deps
// ---------------------------------------------------------------------------

function makeExplorer(fsStub) {
    const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
        axios:    { get: sinon.stub().resolves({ data: {} }) },
        express:  { Router: () => ({ get: () => {}, use: () => {} }), static: () => {} },
        fs:       fsStub || { existsSync: () => false },
        './db.js': function() { this.init = () => {}; }
    });

    const configInfo = createConfigInfoStub();
    const app = { get: () => {}, post: () => {}, use: () => {}, listen: () => {} };
    return new XChainExplorer(app, configInfo);
}

function makeIconReq(iconPath) {
    return {
        path:    '/icon' + iconPath,
        headers: { host: 'localhost:8080' }
    };
}

// ===========================================================================
// Basic path traversal
// ===========================================================================

describe('Security: Path Traversal — Basic attacks', function () {

    let explorer;
    before(() => { explorer = makeExplorer(); });

    it('blocks ../ traversal to parent directories', async function () {
        const res = mockRes();
        await explorer.processIconRequest(makeIconReq('/../../../etc/passwd'), res);
        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Access denied' });
    });
});

// ===========================================================================
// Boundary check validation (pure logic test)
// ===========================================================================

describe('Security: Path Traversal — Boundary check logic', function () {

    it('path.resolve prevents ../ from escaping content/icons/', function () {
        const dirPath  = path.resolve(path.join(__dirname, '../../src/content/icons'));
        const evilPath = path.resolve(path.join(dirPath, '/../../../etc/passwd'));
        expect(evilPath.startsWith(dirPath + path.sep)).to.be.false;
    });

    it('boundary check prevents sibling directory access', function () {
        const dirPath  = path.resolve(path.join(__dirname, '../../src/content/icons'));
        const siblingPath = path.resolve(path.join(dirPath, '../html/template.html'));
        expect(siblingPath.startsWith(dirPath + path.sep)).to.be.false;
    });

    it('boundary check allows files within icons directory', function () {
        const dirPath  = path.resolve(path.join(__dirname, '../../src/content/icons'));
        const validPath = path.resolve(path.join(dirPath, 'BTC.png'));
        expect(validPath.startsWith(dirPath + path.sep)).to.be.true;
    });

    it('boundary check blocks path with ../ that resolves outside', function () {
        const dirPath  = path.resolve(path.join(__dirname, '../../src/content/icons'));
        const evilPath = path.resolve(path.join(dirPath, '../../../package.json'));
        expect(evilPath.startsWith(dirPath + path.sep)).to.be.false;
    });
});

// ===========================================================================
// Icon request handling
// ===========================================================================

describe('Security: Path Traversal — Icon request behavior', function () {

    it('sends file when icon exists within directory', async function () {
        const fsStub = { existsSync: sinon.stub().returns(true) };
        const explorer = makeExplorer(fsStub);
        const res = mockRes();

        await explorer.processIconRequest(makeIconReq('/BTC.png'), res);
        // Should call sendFile (not 403)
        expect(res._status).to.not.equal(403);
        expect(res._sentFile).to.be.a('string');
    });

    it('redirects to default.png when icon not found', async function () {
        const explorer = makeExplorer({ existsSync: () => false });
        const res = mockRes();

        await explorer.processIconRequest(makeIconReq('/NONEXISTENT.png'), res);
        expect(res._redirect).to.be.an('object');
        expect(res._redirect.url).to.include('/icon/default.png');
    });

    it('returns 403 for directory escape attempt', async function () {
        const explorer = makeExplorer({ existsSync: () => true });
        const res = mockRes();

        await explorer.processIconRequest(makeIconReq('/../../package.json'), res);
        expect(res._status).to.equal(403);
        expect(res._body).to.deep.equal({ error: 'Access denied' });
    });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe('Security: Path Traversal — Edge cases', function () {

    let explorer;
    before(() => { explorer = makeExplorer(); });

    it('handles empty icon path (blocked — resolves to dir itself)', async function () {
        const res = mockRes();
        await explorer.processIconRequest(makeIconReq('/'), res);
        // After stripping /icon, path is "/" which resolves to the icons dir itself
        // filePath equals dirPath (not dirPath + sep + ...), so boundary check blocks it
        expect(res._status).to.equal(403);
    });

    it('does not crash on very long path', async function () {
        const res = mockRes();
        const longPath = '/' + 'A'.repeat(500) + '.png';
        await explorer.processIconRequest(makeIconReq(longPath), res);
        // Should not throw — either serves or redirects
        expect(res._status).to.not.equal(500);
    });
});
