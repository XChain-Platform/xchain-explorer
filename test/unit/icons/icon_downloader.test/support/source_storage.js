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

// The on-chain TIS scheme the token page resolves (actionRefToRawPath in
// content/js/xchain/token_media.js). Its bytes are the FILE action's stored
// bytes in the colocated decoder DB, read the way the
// /{COIN}/api/file/{index}/raw route reads them, so nothing here opens a socket.
//
// The load-bearing property is the FAILURE shape, not the happy path: answering
// "no source" for an unreadable FILE would put the row on processToken's terminal
// markOk path, where only a description change can ever revive it, and getFileRaw
// returns null for a decoder DB that is merely unreachable exactly as it does for a
// FILE that does not exist. So every failure throws into the retry backoff instead.
{

    // An explorer whose DB layer answers like the real one, with per-test overrides.
    function makeActionDownloader(dbOverrides, pools) {
        const stubs = makeStubs();
        const IconDownloader = loadIconDownloader(stubs);
        const explorer = makeExplorer(undefined, pools !== undefined ? pools : {
            BTC:   { pool: makeMockPool(makeMockConn([])) },
            RDOGE: { pool: makeMockPool(makeMockConn([])) },
        });
        explorer.db.getGatedFileRaw = sinon.stub().resolves([]);
        explorer.db.getFileRaw      = sinon.stub().resolves(null);
        Object.assign(explorer.db, dbOverrides || {});
        return { d: new IconDownloader(explorer), explorer };
    }

    const FLAVOR = { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' };

    iconSuite('_fetchSourceBytes(): action scheme', function () {
        it('returns the FILE bytes when they are not a JSON document', async function () {
            const { d, explorer } = makeActionDownloader({
                getFileRaw: sinon.stub().resolves({ raw_data: Buffer.from('PNGBYTES'), data: 'FILE|0|x', type: 'image/png' }),
            });
            const out = await d.fetchSourceBytes({ scheme: 'action', coin: null, index: '42' }, 2, FLAVOR);
            expect(out.toString()).to.equal('PNGBYTES');
            expect(explorer.db.getFileRaw.firstCall.args[0]).to.deep.equal({ coin: 'BTC', data: {} });
            expect(explorer.db.getFileRaw.firstCall.args[1]).to.equal('42');
        });

        it('decodes the inline base64 image out of an on-chain TIS document', async function () {
            const tis = JSON.stringify({ images: [{ type: 'icon', size: '64x64', data: 'data:image/png;base64,aGVsbG8=' }] });
            const stubs = makeStubs();
            // The picker is stubbed in this file, so mirror what the real one returns.
            stubs.selectIconUrlFromCip25Json = sinon.stub().returns('data:image/png;base64,aGVsbG8=');
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            explorer.db.getGatedFileRaw = sinon.stub().resolves([]);
            explorer.db.getFileRaw = sinon.stub().resolves({ raw_data: Buffer.from(tis), data: 'FILE|0|x', type: 'application/json' });
            const d = new IconDownloader(explorer);

            const out = await d.fetchSourceBytes({ scheme: 'action', coin: null, index: '7' }, 2, FLAVOR);
            expect(out.toString()).to.equal('hello');
            expect(stubs.axiosStub.get.called).to.equal(false, 'an on-chain icon must cost no egress');
        });

        it('throws rather than answering no-source when the FILE is unreadable here', async function () {
            const { d } = makeActionDownloader({ getFileRaw: sinon.stub().resolves(null) });
            let threw = null;
            try { await d.fetchSourceBytes({ scheme: 'action', coin: null, index: '9' }, 2, FLAVOR); }
            catch (e) { threw = e; }
            expect(threw).to.be.an('error');
            expect(threw.message).to.include('no readable bytes');
        });

        it('throws on a token-gated FILE, whose stored bytes are ciphertext', async function () {
            const { d } = makeActionDownloader({
                getGatedFileRaw: sinon.stub().resolves([{ raw_data: Buffer.from('CIPHER') }]),
            });
            let threw = null;
            try { await d.fetchSourceBytes({ scheme: 'action', coin: null, index: '9' }, 2, FLAVOR); }
            catch (e) { threw = e; }
            expect(threw).to.be.an('error');
            expect(threw.message).to.include('token-gated');
        });

    });

    iconSuite('_fetchSourceBytes(): action scheme', function () {
        it('resolves a sibling-chain ref against this flavor network tier', async function () {
            const { d, explorer } = makeActionDownloader({
                getFileRaw: sinon.stub().resolves({ raw_data: Buffer.from('PNGBYTES'), data: 'FILE|0|x', type: 'image/png' }),
            });
            // A regtest BTC flavor naming DOGE means RDOGE, the same rule the page's
            // actionRefToRawPath applies to the current chain's tier.
            await d.fetchSourceBytes({ scheme: 'action', coin: 'DOGE', index: '3' }, 2,
                { coin: 'BTC', network: 'regtest', poolKey: 'RBTC' });
            expect(explorer.db.getFileRaw.firstCall.args[0].coin).to.equal('RDOGE');
        });

        it('throws when the sibling chain has no pool on this instance', async function () {
            const { d } = makeActionDownloader({}, { BTC: { pool: makeMockPool(makeMockConn([])) } });
            let threw = null;
            try { await d.fetchSourceBytes({ scheme: 'action', coin: 'LTC', index: '3' }, 2, FLAVOR); }
            catch (e) { threw = e; }
            expect(threw).to.be.an('error');
            expect(threw.message).to.include('no pool configured for LTC');
        });
    });
}

{
    function makeWriteIconDownloader(execHandlers, fspOverrides) {
        const fspStub = {
            mkdir:     sinon.stub().resolves(),
            writeFile: sinon.stub().resolves(),
            readFile:  sinon.stub().resolves(Buffer.from('PNGOUT')),
            unlink:    sinon.stub().resolves(),
        };
        Object.assign(fspStub, fspOverrides || {});

        const execStub = makeExecStub(execHandlers || [
            ['--mime-type', { stdout: 'image/png\n', stderr: '' }],
            ['-resize',     null],
        ]);

        const stubs = makeStubs();
        stubs.fspStub  = fspStub;
        stubs.execStub = execStub;

        const IconDownloader = loadIconDownloader(stubs);
        const explorer = makeExplorer();
        const d = new IconDownloader(explorer);
        d.cfg.convertBin = '/usr/bin/convert';
        d.cfg.iconSize   = 64;
        return { d, fspStub, execStub };
    }

    iconSuite('_writeIcon()', function () {
        it('writes tmp file, sniffs mime, runs convert, reads result and returns md5', async function () {
            const { d, fspStub, execStub } = makeWriteIconDownloader();
            const bytes    = Buffer.from('PNGBYTES');
            const iconPath = '/tmp/icons/BTC/mainnet/MYTOKEN.png';

            const hash = await d.writeIcon(bytes, iconPath);

            expect(fspStub.writeFile.callCount).to.equal(1);
            expect(fspStub.writeFile.firstCall.args[1]).to.deep.equal(bytes);

            // The type is sniffed from the bytes on disk rather than taken from the
            // serving host's content-type header, which any host can lie about.
            const sniffCall = execStub.getCalls().find(c => execCmdText(c).includes('--mime-type'));
            expect(sniffCall).to.not.equal(undefined);

            // The convert step is where the size and output format are pinned, so the
            // command line it builds is the contract worth asserting on.
            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            expect(convertCall).to.not.equal(undefined);
            expect(execCmdText(convertCall)).to.include('64x64!');
            expect(execCmdText(convertCall)).to.include('-format png');

            // The file read back is the CONVERTED one, not the temp file written above.
            expect(fspStub.readFile.callCount).to.equal(1);
            expect(fspStub.readFile.firstCall.args[0]).to.equal(iconPath);

            // 32 hex characters: the md5 of the converted image, which is what identifies
            // the stored icon to everything downstream.
            expect(hash).to.be.a('string').with.length(32);
        });

        it('throws "mime sniff failed" when sniffMime exec errors', async function () {
            const { d } = makeWriteIconDownloader([
                ['--mime-type', new Error('file not found')],
            ]);
            try {
                await d.writeIcon(Buffer.from('X'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('mime sniff failed');
            }
        });

    });

    iconSuite('_writeIcon()', function () {
        it('throws "unsupported mime" when MIME is not in ALLOWED_MIME', async function () {
            const { d } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'application/pdf\n', stderr: '' }],
                ['-resize',     null],
            ]);
            try {
                await d.writeIcon(Buffer.from('X'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include("unsupported mime 'application/pdf'");
            }
        });

        it('throws "convert failed" when ImageMagick exec errors', async function () {
            const convertErr = new Error('Magick failed');
            convertErr.stderr = 'convert: no decode delegate';
            const { d } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/png\n', stderr: '' }],
                ['-resize',     convertErr],
            ]);
            try {
                await d.writeIcon(Buffer.from('PNGBYTES'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('convert failed');
                expect(e.message).to.include('no decode delegate');
            }
        });

        it('returns null (not throws) when readFile of iconPath fails', async function () {
            const { d } = makeWriteIconDownloader(
                [
                    ['--mime-type', { stdout: 'image/png\n', stderr: '' }],
                    ['-resize',     null],
                ],
                {
                    readFile: sinon.stub().rejects(new Error('ENOENT')),
                    writeFile: sinon.stub().resolves(),
                    unlink:    sinon.stub().resolves(),
                }
            );
            const result = await d.writeIcon(Buffer.from('PNGBYTES'), '/tmp/out.png');
            expect(result).to.equal(null);
        });

    });

    iconSuite('_writeIcon()', function () {
        it('uses [0] frame selector for GIF mime type', async function () {
            const { d, execStub } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/gif\n', stderr: '' }],
                ['-resize',     null],
            ]);
            await d.writeIcon(Buffer.from('GIFDATA'), '/tmp/out.png');
            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            expect(execCmdText(convertCall)).to.include('[0]');
        });

        // SVG never reaches convert: ImageMagick's SVG renderer dereferences
        // external references, and those fetches leave `convert` without passing
        // this pipeline's SSRF guard. Refuse the format at the sniff instead.
        it('refuses SVG before ImageMagick is ever invoked', async function () {
            const { d, execStub } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/svg+xml\n', stderr: '' }],
                ['-resize',     null],
            ]);
            try {
                await d.writeIcon(Buffer.from('<svg><image xlink:href="http://169.254.169.254/"/></svg>'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include("unsupported mime 'image/svg+xml'");
            }
            expect(execStub.getCalls().find(c => execCmdText(c).includes('-resize'))).to.equal(undefined);
        });

        it('uses [0] frame selector for WebP mime type', async function () {
            const { d, execStub } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/webp\n', stderr: '' }],
                ['-resize',     null],
            ]);
            await d.writeIcon(Buffer.from('WEBPDATA'), '/tmp/out.png');
            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            expect(execCmdText(convertCall)).to.include('[0]');
        });

    });

    iconSuite('_writeIcon()', function () {
        it('does NOT use [0] frame selector for JPEG', async function () {
            const { d, execStub } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/jpeg\n', stderr: '' }],
                ['-resize',     null],
            ]);
            await d.writeIcon(Buffer.from('JPEGDATA'), '/tmp/out.png');
            // The [0] selector picks the first frame of a multi-frame image, which is what
            // the WebP case above needs. A JPEG has a single frame, so the selector is
            // left off rather than applied everywhere.
            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            expect(execCmdText(convertCall)).to.not.match(/\[0\]/);
        });

        // These bytes come from on-chain token descriptions, so both subprocesses
        // are attacker-fed. maxBytes caps the download and never the decode, and
        // runOnce holds the _running guard for the whole pass, so an unbounded
        // convert turns one hostile issuance into a host OOM or a pipeline that is
        // stalled for every coin until restart.
        it('bounds convert with a wall-clock timeout and a SIGKILL', async function () {
            const { d, execStub } = makeWriteIconDownloader();
            d.cfg.convertTimeoutMs = 12345;
            await d.writeIcon(Buffer.from('PNGBYTES'), '/tmp/out.png');

            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            expect(convertCall.args[2]).to.include({ timeout: 12345, killSignal: 'SIGKILL' });
        });

        it('bounds the mime sniff the same way, so a hung `file` cannot wedge the pass', async function () {
            const { d, execStub } = makeWriteIconDownloader();
            d.cfg.convertTimeoutMs = 12345;
            await d.writeIcon(Buffer.from('PNGBYTES'), '/tmp/out.png');

            const sniffCall = execStub.getCalls().find(c => execCmdText(c).includes('--mime-type'));
            expect(sniffCall.args[2]).to.include({ timeout: 12345, killSignal: 'SIGKILL' });
        });

    });

    iconSuite('_writeIcon()', function () {
        it('caps ImageMagick pixel-cache allocation with -limit before the input file', async function () {
            const { d, execStub } = makeWriteIconDownloader();
            await d.writeIcon(Buffer.from('PNGBYTES'), '/tmp/out.png');

            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            const argv  = convertCall.args[1];
            const pairs = [];
            argv.forEach((a, i) => { if (a === '-limit') pairs.push(argv[i + 1] + ' ' + argv[i + 2]); });
            expect(pairs).to.have.members(['memory 256MiB', 'map 256MiB', 'disk 0']);

            // Order is load-bearing: ImageMagick applies settings left to right, so a
            // -limit after the filename does not bound the read that allocates.
            const lastLimit = argv.lastIndexOf('-limit');
            const srcIdx    = argv.findIndex(a => String(a).startsWith('/') && !String(a).endsWith('out.png'));
            expect(srcIdx).to.be.greaterThan(-1);
            expect(lastLimit).to.be.lessThan(srcIdx);
        });

        it('reports a timeout kill as a timeout, so the row records why it failed', async function () {
            const killed  = new Error('Command failed');
            killed.killed = true;
            killed.signal = 'SIGKILL';
            const { d } = makeWriteIconDownloader([
                ['--mime-type', { stdout: 'image/png\n', stderr: '' }],
                ['-resize',     killed],
            ]);
            d.cfg.convertTimeoutMs = 777;
            try {
                await d.writeIcon(Buffer.from('PNGBYTES'), '/tmp/out.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('convert failed: timed out after 777ms');
            }
        });

        it('spawns convert without a shell, so no argv element needs escaping', async function () {
            const { d, execStub } = makeWriteIconDownloader();
            await d.writeIcon(Buffer.from('PNGBYTES'), "/tmp/it's odd.png");

            const convertCall = execStub.getCalls().find(c => execCmdText(c).includes('-resize'));
            expect(convertCall.args[0]).to.equal('/usr/bin/convert');
            expect(convertCall.args[1]).to.be.an('array');
            // The path travels as one argv element, unquoted: there is no shell to
            // re-split it, which is what makes the removed shellEscape unnecessary.
            expect(convertCall.args[1]).to.include("/tmp/it's odd.png");
        });
    });
}
