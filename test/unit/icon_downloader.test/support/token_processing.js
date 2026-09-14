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

const {
    ACTION_REF_PATTERN, expect, execCmdText, iconSuite, loadIconDownloader,
    makeExecStub, makeExplorer, makeMockConn, makeMockPool, makeStubs, path,
    setClock, sinon, tickClock,
} = require('./helpers.js');

// The decision tree for one token: resolve its DESCRIPTION to a source, fetch the
// bytes, write the icon, and record either success or a retryable failure. Every
// step below is a place that walk can stop.
{
    function makeFlavor(coin, network) {
        return { coin: coin || 'BTC', network: network || 'mainnet', poolKey: coin || 'BTC' };
    }

    function makeRow(overrides) {
        return Object.assign({
            icon_id:     1,
            token_id:    10,
            attempts:    0,
            description: 'https://example.com/a.png',
            tick:        'MYTOKEN',
        }, overrides);
    }

    iconSuite('_processToken()', function () {
        it('calls _markOk with nulls when resolveDescriptionToSource returns null', async function () {
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(null),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const conn = makeMockConn([[]]);
            d.markOk      = sinon.stub().resolves();
            d.markFailure = sinon.stub().resolves();
            d.fetchSourceBytes = sinon.stub().resolves(Buffer.from('X'));
            d.writeIcon   = sinon.stub().resolves('hash123');

            await d.processToken(conn, makeFlavor(), makeRow({ description: 'no-match' }));

            expect(d.markOk.callCount).to.equal(1);
            const [, , url, srcHash, iconHash] = d.markOk.firstCall.args;
            expect(url).to.equal(null);
            expect(srcHash).to.equal(null);
            expect(iconHash).to.equal(null);
            expect(d.markFailure.callCount).to.equal(0);
        });

        it('calls _markFailure when _fetchSourceBytes throws', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d.fetchSourceBytes = sinon.stub().rejects(new Error('network error'));
            d.markFailure = sinon.stub().resolves();
            d.markOk      = sinon.stub().resolves();

            const conn = makeMockConn([]);
            await d.processToken(conn, makeFlavor(), makeRow({ attempts: 0 }));

            expect(d.markFailure.callCount).to.equal(1);
            const [, , attempts, errMsg] = d.markFailure.firstCall.args;
            expect(attempts).to.equal(1);   // row.attempts + 1
            expect(errMsg).to.include('network error');
            expect(d.markOk.callCount).to.equal(0);
        });

    });

    iconSuite('_processToken()', function () {
        it('calls _markFailure with "empty body" when bytes is empty', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d.fetchSourceBytes = sinon.stub().resolves(Buffer.alloc(0));
            d.markFailure = sinon.stub().resolves();
            d.markOk      = sinon.stub().resolves();

            const conn = makeMockConn([]);
            await d.processToken(conn, makeFlavor(), makeRow({ attempts: 2 }));

            expect(d.markFailure.callCount).to.equal(1);
            const [, , attempts, msg] = d.markFailure.firstCall.args;
            expect(attempts).to.equal(3);
            expect(msg).to.equal('empty body');
        });

        it('calls _markOk(null) when stamp bytes fail _writeIcon (stamp terminal path)', async function () {
            const src = { scheme: 'stamp', data: 'AAAA' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d.fetchSourceBytes = sinon.stub().resolves(Buffer.from([0xDE, 0xAD]));
            d.writeIcon   = sinon.stub().rejects(new Error('unsupported mime'));
            d.markOk      = sinon.stub().resolves();
            d.markFailure = sinon.stub().resolves();

            const conn = makeMockConn([]);
            stubs.fspStub.mkdir.resolves();

            await d.processToken(conn, makeFlavor(), makeRow());

            expect(d.markOk.callCount).to.equal(1);
            const [, , url, srcH, iconH] = d.markOk.firstCall.args;
            expect(url).to.equal(null);
            expect(srcH).to.equal(null);
            expect(iconH).to.equal(null);
            expect(d.markFailure.callCount).to.equal(0);
        });

    });

    iconSuite('_processToken()', function () {
        it('calls _markFailure when non-stamp _writeIcon throws', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d.fetchSourceBytes = sinon.stub().resolves(Buffer.from('PNGBYTES'));
            d.writeIcon   = sinon.stub().rejects(new Error('convert failed'));
            d.markOk      = sinon.stub().resolves();
            d.markFailure = sinon.stub().resolves();

            const conn = makeMockConn([]);
            stubs.fspStub.mkdir.resolves();

            await d.processToken(conn, makeFlavor(), makeRow({ attempts: 1 }));

            expect(d.markFailure.callCount).to.equal(1);
            const [, , attempts, msg] = d.markFailure.firstCall.args;
            expect(attempts).to.equal(2);
            expect(msg).to.include('convert failed');
        });

        it('calls _markOk(null) when stamp _writeIcon returns null (iconHash null)', async function () {
            const src = { scheme: 'stamp', data: 'AAAA' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d.fetchSourceBytes = sinon.stub().resolves(Buffer.from([0x89, 0x50]));
            d.writeIcon   = sinon.stub().resolves(null);   // returns null => no icon hash
            d.markOk      = sinon.stub().resolves();
            d.markFailure = sinon.stub().resolves();

            const conn = makeMockConn([]);
            stubs.fspStub.mkdir.resolves();

            await d.processToken(conn, makeFlavor(), makeRow());

            expect(d.markOk.callCount).to.equal(1);
            expect(d.markFailure.callCount).to.equal(0);
        });

    });

    iconSuite('_processToken()', function () {
        it('calls _markFailure("image conversion failed") when non-stamp _writeIcon returns null', async function () {
            const src = { scheme: 'image_url', url: 'https://x.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d.fetchSourceBytes = sinon.stub().resolves(Buffer.from('PNGBYTES'));
            d.writeIcon   = sinon.stub().resolves(null);
            d.markOk      = sinon.stub().resolves();
            d.markFailure = sinon.stub().resolves();

            const conn = makeMockConn([]);
            stubs.fspStub.mkdir.resolves();

            await d.processToken(conn, makeFlavor(), makeRow({ attempts: 0 }));

            expect(d.markFailure.callCount).to.equal(1);
            const [, , attempts, msg] = d.markFailure.firstCall.args;
            expect(msg).to.equal('image conversion failed');
            expect(attempts).to.equal(1);
        });

        it('calls _markOk with url/sourceHash/iconHash on success', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d.fetchSourceBytes = sinon.stub().resolves(Buffer.from('PNGDATA'));
            d.writeIcon   = sinon.stub().resolves('abc123');
            d.markOk      = sinon.stub().resolves();
            d.markFailure = sinon.stub().resolves();

            const conn = makeMockConn([]);
            stubs.fspStub.mkdir.resolves();

            await d.processToken(conn, makeFlavor(), makeRow());

            expect(d.markOk.callCount).to.equal(1);
            const [, , url, , iconHash] = d.markOk.firstCall.args;
            expect(url).to.equal('https://example.com/a.png');
            expect(iconHash).to.equal('abc123');
        });
    });
}
