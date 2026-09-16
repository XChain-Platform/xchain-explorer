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

{

    iconSuite('truncate() non-string input via _processToken', function () {
        it('converts non-string error to string before truncating', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 99;

            const weirdErr = new Error();
            weirdErr.message = 42;   // number, not string
            d.fetchSourceBytes = sinon.stub().rejects(weirdErr);

            const receivedMsgs = [];
            d.markFailure = sinon.stub().callsFake(async (conn2, iconId, attempts, errMsg) => {
                receivedMsgs.push(errMsg);
            });
            d.markOk = sinon.stub().resolves();

            const conn = makeMockConn([[]]);
            await d.processToken(conn, { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' }, {
                icon_id: 1, token_id: 10, attempts: 0, description: 'https://example.com/a.png', tick: 'TOK',
            });

            // truncate received a non-string (42) and should have String()'d it
            expect(receivedMsgs.length).to.equal(1);
            expect(receivedMsgs[0]).to.equal('42');
        });
    });
}

{

    iconSuite('_writeIcon convert error e.message fallback', function () {
        it('uses e.message when e.stderr is absent', async function () {
            const fspStub = {
                mkdir:     sinon.stub().resolves(),
                writeFile: sinon.stub().resolves(),
                readFile:  sinon.stub().resolves(Buffer.from('OUT')),
                unlink:    sinon.stub().resolves(),
            };
            const convertErr = new Error('Magick error message');
            // No stderr property
            const execStub = makeExecStub([
                ['--mime-type', { stdout: 'image/png\n', stderr: '' }],
                ['-resize',     convertErr],
            ]);

            const stubs = makeStubs();
            stubs.fspStub  = fspStub;
            stubs.execStub = execStub;

            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.convertBin = '/usr/bin/convert';
            d.cfg.iconSize   = 64;

            try {
                await d.writeIcon(Buffer.from('DATA'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('convert failed');
                expect(e.message).to.include('Magick error message');
            }
        });
    });
}

{

    iconSuite('_processToken src.url undefined fallback', function () {
        it('passes null for sourceUrl when src has no .url property', async function () {
            // stamp scheme sources have .data but no .url
            const src = { scheme: 'stamp', data: 'aGVsbG8=' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d.fetchSourceBytes = sinon.stub().resolves(Buffer.from('PNG'));
            d.writeIcon        = sinon.stub().resolves('abc123');
            d.markOk           = sinon.stub().resolves();
            d.markFailure      = sinon.stub().resolves();

            const conn = makeMockConn([[]]);
            stubs.fspStub.mkdir.resolves();

            await d.processToken(conn, { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' }, {
                icon_id: 1, token_id: 10, attempts: 0, description: 'stamp:aGVsbG8=', tick: 'TOK',
            });

            expect(d.markOk.callCount).to.equal(1);
            const [, , url] = d.markOk.firstCall.args;
            expect(url).to.equal(null);
        });
    });
}

{

    iconSuite('_writeIcon convert error empty fallback', function () {
        it('produces "convert failed: " when error has no stderr or message', async function () {
            const fspStub = {
                mkdir:     sinon.stub().resolves(),
                writeFile: sinon.stub().resolves(),
                readFile:  sinon.stub().resolves(Buffer.from('OUT')),
                unlink:    sinon.stub().resolves(),
            };
            const convertErr = new Error('');
            convertErr.stderr = '';
            convertErr.message = '';
            const execStub = makeExecStub([
                ['--mime-type', { stdout: 'image/png\n', stderr: '' }],
                ['-resize',     convertErr],
            ]);

            const stubs = makeStubs();
            stubs.fspStub  = fspStub;
            stubs.execStub = execStub;

            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.convertBin = '/usr/bin/convert';
            d.cfg.iconSize   = 64;

            try {
                await d.writeIcon(Buffer.from('DATA'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('convert failed: ');
            }
        });
    });
}

{

    iconSuite('_processToken mkdir behavior', function () {
        it('calls fsp.mkdir with recursive:true before writing icon', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            d.fetchSourceBytes = sinon.stub().resolves(Buffer.from('DATA'));
            d.writeIcon        = sinon.stub().resolves('hash');
            d.markOk           = sinon.stub().resolves();
            d.markFailure      = sinon.stub().resolves();

            const conn = makeMockConn([[]]);
            const flavor = { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' };

            await d.processToken(conn, flavor, {
                icon_id: 1, token_id: 10, attempts: 0, description: 'https://example.com/a.png', tick: 'TOK',
            });

            expect(stubs.fspStub.mkdir.callCount).to.equal(1);
            const mkdirArgs = stubs.fspStub.mkdir.firstCall.args;
            expect(mkdirArgs[1]).to.deep.equal({ recursive: true });
            expect(d.writeIcon.callCount).to.equal(1);
        });
    });
}

// Literal-IP URLs bypass the dns.lookup shim (Node skips a custom `lookup`
// for IP-literal hosts), so httpFetch must reject a private literal before
// connecting. Icon URLs come from on-chain token descriptions and are fully
// attacker-controlled.
{
    function downloader(stubs) {
        return new (loadIconDownloader(stubs))(makeExplorer());
    }

    const privateLiterals = [
        'http://169.254.169.254/latest/meta-data/iam/security-credentials/x.json',
        'http://127.0.0.1:6379/x.png',
        'http://10.0.0.5/x.png',
        'http://[fd00:ec2::254]/x.json',
        'http://100.64.0.1/x.png',
        // The URL parser rewrites a mapped IPv6 host to hex pieces, so these
        // reach the guard as ::ffff:7f00:1 / ::ffff:a9fe:a9fe, not as dotted.
        'http://[::ffff:127.0.0.1]/x.json',
        'http://[::ffff:169.254.169.254]/latest/meta-data/x.json',
    ];
    iconSuite('_httpFetch SSRF literal-IP guard', function () {
        for (const url of privateLiterals) {
            it(`refuses a private literal-IP URL without calling axios (${url})`, async function () {
                const stubs = makeStubs();
                const d = downloader(stubs);
                let threw = null;
                try { await d.httpFetch(url); } catch (e) { threw = e; }
                expect(threw, 'expected httpFetch to reject').to.be.an('error');
                expect(threw.code).to.equal('RELAY_DENIED');
                expect(stubs.axiosStub.get.called, 'axios must not be called for a private literal').to.be.false;
            });
        }

        it('allows a public DNS-name URL through with the lookup shim + beforeRedirect wired', async function () {
            const stubs = makeStubs();
            const d = downloader(stubs);
            await d.httpFetch('https://example.com/icon.png');
            expect(stubs.axiosStub.get.calledOnce).to.be.true;
            const opts = stubs.axiosStub.get.firstCall.args[1];
            expect(opts.lookup).to.be.a('function');       // guards DNS-name hosts + redirects
            expect(opts.beforeRedirect).to.be.a('function'); // guards literal-IP redirect hops
        });

        it('allows a PUBLIC IP literal through (only private literals are blocked)', async function () {
            const stubs = makeStubs();
            const d = downloader(stubs);
            await d.httpFetch('http://93.184.216.34/icon.png');
            expect(stubs.axiosStub.get.calledOnce).to.be.true;
        });
    });
}
