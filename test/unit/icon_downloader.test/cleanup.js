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

// The disk/DB invariant: whenever a row lands at ok-with-no-icon, the PNG for
// that token must not survive on disk. processIconRequest serves any file that
// exists and only falls back to /icon/default.png when it does not, so a
// surviving file overrides the database and keeps showing the old image - and
// the ok-with-no-icon state is terminal, so nothing revisits it.
{
    function makeRow(overrides) {
        return Object.assign({
            icon_id: 1, token_id: 10, attempts: 0,
            description: 'https://example.com/a.png', tick: 'MYTOKEN',
        }, overrides);
    }
    const flavor = { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' };

    /** The path processToken computes for MYTOKEN on BTC/mainnet. */
    function iconPathFor(d, tick) {
        return require('path').join(d.iconRoot, 'BTC', 'mainnet', tick + '.png');
    }

    iconSuite('terminal no-icon paths remove the stale PNG', function () {
        it('unlinks the icon when the description resolves to no source', async function () {
            const stubs = makeStubs({ resolveDescriptionToSource: sinon.stub().returns(null) });
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            d.markOk = sinon.stub().resolves();
            d.log    = () => {};

            await d.processToken(makeMockConn([]), flavor, makeRow({ description: 'no-match' }));

            expect(stubs.fspStub.unlink.callCount).to.equal(1);
            expect(stubs.fspStub.unlink.firstCall.args[0]).to.equal(iconPathFor(d, 'MYTOKEN'));
            expect(d.markOk.callCount).to.equal(1);
        });

        it('unlinks the icon when stamp bytes fail _writeIcon', async function () {
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns({ scheme: 'stamp', data: 'AAAA' }),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            d.fetchSourceBytes = sinon.stub().resolves(Buffer.from([0xDE, 0xAD]));
            d.writeIcon = sinon.stub().rejects(new Error('unsupported mime'));
            d.markOk    = sinon.stub().resolves();
            d.log       = () => {};

            await d.processToken(makeMockConn([]), flavor, makeRow());

            // convert writes straight to iconPath, so a failed conversion can leave a
            // truncated file on top of the previous good icon. That is the file this
            // unlink removes.
            expect(stubs.fspStub.unlink.callCount).to.equal(1);
            expect(stubs.fspStub.unlink.firstCall.args[0]).to.equal(iconPathFor(d, 'MYTOKEN'));
        });

        it('unlinks the icon when stamp _writeIcon returns no hash', async function () {
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns({ scheme: 'stamp', data: 'AAAA' }),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            d.fetchSourceBytes = sinon.stub().resolves(Buffer.from([0x89, 0x50]));
            d.writeIcon = sinon.stub().resolves(null);
            d.markOk    = sinon.stub().resolves();
            d.log       = () => {};

            await d.processToken(makeMockConn([]), flavor, makeRow());

            expect(stubs.fspStub.unlink.callCount).to.equal(1);
            expect(stubs.fspStub.unlink.firstCall.args[0]).to.equal(iconPathFor(d, 'MYTOKEN'));
        });

    });

    iconSuite('terminal no-icon paths remove the stale PNG', function () {
        it('leaves the icon alone on the success path', async function () {
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns({ scheme: 'image_url', url: 'https://e/a.png' }),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            d.fetchSourceBytes = sinon.stub().resolves(Buffer.from('PNGBYTES'));
            d.writeIcon = sinon.stub().resolves('hash123');
            d.markOk    = sinon.stub().resolves();
            d.log       = () => {};

            await d.processToken(makeMockConn([]), flavor, makeRow());

            expect(stubs.fspStub.unlink.callCount).to.equal(0);
        });

        it('does not unlink on a retryable failure: the old icon stays until it is replaced',
           async function () {
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns({ scheme: 'image_url', url: 'https://e/a.png' }),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            d.fetchSourceBytes = sinon.stub().rejects(new Error('network error'));
            d.markFailure = sinon.stub().resolves();
            d.log = () => {};

            await d.processToken(makeMockConn([]), flavor, makeRow());

            expect(d.markFailure.callCount).to.equal(1);
            expect(stubs.fspStub.unlink.callCount).to.equal(0);
        });
    });
}

// The backlog half. ok-with-no-icon is terminal, so files already stranded in
// that state are never revisited by processToken and the unlink above cannot
// reach them.
{
    const flavor = { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' };

    iconSuite('_sweepOrphanIcons()', function () {
        it('deletes only the PNGs the DB positively reports as icon-less', async function () {
            const stubs = makeStubs({ fspReaddirResult: ['AAA.png', 'BBB.png', 'CCC.png', 'notes.txt'] });
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            d.log = () => {};

            const conn = makeMockConn([[{ tick: 'BBB' }]]);
            await d.sweepOrphanIcons(conn, flavor);

            const unlinked = stubs.fspStub.unlink.getCalls().map(c => c.args[0]);
            const dir = require('path').join(d.iconRoot, 'BTC', 'mainnet');
            expect(unlinked).to.deep.equal([require('path').join(dir, 'BBB.png')]);

            // Bounded by the DIRECTORY, not by the row set: only the three .png names
            // are ever asked about, and notes.txt is not one of them.
            const [sql, args] = conn.query.firstCall.args;
            expect(sql).to.include("i.status = 'ok'");
            expect(sql).to.include('i.icon_hash IS NULL');
            expect(args).to.deep.equal(['AAA', 'BBB', 'CCC']);
        });

        // The negative control for rule 2: an empty answer must delete NOTHING. A
        // sweep written the other way round ("delete what the DB does not claim")
        // passes every test above and wipes the host on a reindexing database.
        it('deletes nothing when the DB returns no rows', async function () {
            const stubs = makeStubs({ fspReaddirResult: ['AAA.png', 'BBB.png'] });
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            d.log = () => {};

            await d.sweepOrphanIcons(makeMockConn([[]]), flavor);

            expect(stubs.fspStub.unlink.callCount).to.equal(0);
        });

        it('issues no query at all when the directory holds no PNGs', async function () {
            const stubs = makeStubs({ fspReaddirResult: ['README.md'] });
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            const conn = makeMockConn([]);

            await d.sweepOrphanIcons(conn, flavor);

            expect(conn.query.callCount).to.equal(0);
            expect(stubs.fspStub.unlink.callCount).to.equal(0);
        });

    });

    iconSuite('_sweepOrphanIcons()', function () {
        it('tolerates a missing flavor directory', async function () {
            const stubs = makeStubs({ fspReaddirReject: true });
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            const conn = makeMockConn([]);

            await d.sweepOrphanIcons(conn, flavor);

            expect(conn.query.callCount).to.equal(0);
        });

        it('chunks the IN list so a large icon directory stays inside packet limits',
           async function () {
            const names = [];
            for (let i = 0; i < 1100; i++) names.push('T' + i + '.png');
            const stubs = makeStubs({ fspReaddirResult: names });
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            d.log = () => {};

            const conn = makeMockConn([]);
            await d.sweepOrphanIcons(conn, flavor);

            expect(conn.query.callCount).to.equal(3);
            expect(conn.query.getCall(0).args[1]).to.have.length(500);
            expect(conn.query.getCall(2).args[1]).to.have.length(100);
        });

        it('a sweep failure does not cost the flavor its batch drain', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const d = new IconDownloader(makeExplorer());
            d.log    = () => {};
            d.logErr = sinon.stub();
            d.discover = sinon.stub().resolves();
            d.sweepOrphanIcons = sinon.stub().rejects(new Error('sweep boom'));
            d.processToken = sinon.stub().resolves();
            d.cfg.requestDelayMs = 0;

            const conn = makeMockConn([[{ icon_id: 1, token_id: 10, attempts: 0, description: null, tick: 'AAA' }]]);
            await d.processFlavor({ coin: 'BTC', network: 'mainnet', pool: makeMockPool(conn) });

            expect(d.logErr.callCount).to.equal(1);
            expect(d.processToken.callCount).to.equal(1);
        });
    });
}
