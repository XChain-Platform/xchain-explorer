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

// Driven directly rather than through a scheme, so the outbound request options and
// the way a failure is turned into a message can be pinned with no decode path in
// the way.
{

    iconSuite('_httpFetch()', function () {
        it('passes correct axios options (timeout, maxBytes, maxRedirects, User-Agent)', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            await d.httpFetch('https://example.com/img.png');

            expect(stubs.axiosStub.get.callCount).to.equal(1);
            const [url, opts] = stubs.axiosStub.get.firstCall.args;
            expect(url).to.equal('https://example.com/img.png');
            expect(opts.responseType).to.equal('arraybuffer');
            expect(opts.timeout).to.equal(d.cfg.fetchTimeoutMs);
            expect(opts.maxContentLength).to.equal(d.cfg.maxBytes);
            expect(opts.maxRedirects).to.equal(3);
            expect(opts.headers['User-Agent']).to.include('xchain-icon-downloader');
        });

        it('extracts mime from content-type header (strips parameters)', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/png; charset=utf-8' },
                    data:    Buffer.from('PNG'),
                },
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const result = await d.httpFetch('https://example.com/img.png');
            expect(result.mime).to.equal('image/png');
        });

        it('handles missing content-type header gracefully', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: {},
                    data:    Buffer.from('DATA'),
                },
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const result = await d.httpFetch('https://example.com/x');
            expect(result.mime).to.equal('');
        });
    });
}

{

    iconSuite('_log() and _logErr()', function () {
        it('_log outputs a formatted ISO timestamp line', function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const lines = [];
            const orig = console.log;
            console.log = (...args) => lines.push(args.join(' '));
            d.log('test message');
            console.log = orig;

            expect(lines[0]).to.include('ICON_DOWNLOADER');
            expect(lines[0]).to.include('test message');
        });

        it('_logErr outputs to console.error with stack if available', function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const errs = [];
            const orig = console.error;
            console.error = (...args) => errs.push(args);
            d.logErr('test-ctx', new Error('boom'));
            console.error = orig;

            expect(errs.length).to.be.at.least(1);
            expect(errs[0][0]).to.include('ICON_DOWNLOADER_FAILED');
            expect(errs[0][0]).to.include('test-ctx');
            expect(errs[0][0]).to.include('boom');
        });

        it('_logErr handles non-Error objects (no stack)', function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            const errs = [];
            const orig = console.error;
            console.error = (...args) => errs.push(args);
            d.logErr('test-ctx', 'a string error');
            console.error = orig;

            expect(errs.length).to.be.at.least(1);
        });
    });
}

// backoffSeconds is not exported on its own, so it is read back off the retry delay
// markFailure writes into its SQL arguments. That delay is the only place the
// schedule is visible from outside.
{

    iconSuite('backoffSeconds via _markFailure', function () {
        it('attempt=0 gives 3600s (same branch as <=1)', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 4;

            const conn = makeMockConn([[]]);
            await d.markFailure(conn, 1, 0, 'err');
            const [, args] = conn.query.firstCall.args;
            expect(args[2]).to.equal(3600);
        });

        it('attempt >= 4 gives 30*86400s (last backoff branch)', async function () {
            const stubs = makeStubs();
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            // Set maxAttempts high enough so the retry path is taken, not terminal
            d.cfg.maxAttempts = 99;

            const conn = makeMockConn([[]]);
            await d.markFailure(conn, 1, 4, 'fourth fail');
            const [sql, args] = conn.query.firstCall.args;
            // A retry rather than a terminal give-up: only the retry path stamps a
            // next-attempt time, so an INTERVAL in the SQL is what tells the two apart.
            expect(sql).to.include('INTERVAL');
            expect(args[2]).to.equal(30 * 86400);
        });
    });
}

// truncate has no export of its own either. It is observed through the error message
// processToken hands to markFailure, which has to fit the 255-character column the
// failure is stored in.
{

    iconSuite('truncate(): via _processToken error message path', function () {
        it('truncates fetch error messages to 255 chars via _processToken', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 99;

            // A failure message longer than the column can hold, so it must arrive cut.
            const longMsg = 'E'.repeat(300);
            d.fetchSourceBytes = sinon.stub().rejects(new Error(longMsg));

            const markFailureCalls = [];
            d.markFailure = sinon.stub().callsFake(async (conn2, iconId, attempts, errMsg) => {
                markFailureCalls.push(errMsg);
            });
            d.markOk = sinon.stub().resolves();

            const conn = makeMockConn([[]]);
            await d.processToken(conn, { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' }, {
                icon_id: 1, token_id: 10, attempts: 0, description: 'https://example.com/a.png', tick: 'TOK',
            });

            expect(markFailureCalls.length).to.equal(1);
            expect(markFailureCalls[0].length).to.equal(255);
        });

    });

    iconSuite('truncate(): via _processToken error message path', function () {
        it('also truncates convert-failure messages to 255 chars', async function () {
            const src = { scheme: 'image_url', url: 'https://example.com/a.png' };
            const stubs = makeStubs({
                resolveDescriptionToSource: sinon.stub().returns(src),
            });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            d.cfg.maxAttempts = 99;

            d.fetchSourceBytes = sinon.stub().resolves(Buffer.from('DATA'));

            const longMsg = 'F'.repeat(300);
            d.writeIcon = sinon.stub().rejects(new Error(longMsg));

            const markFailureCalls = [];
            d.markFailure = sinon.stub().callsFake(async (conn2, iconId, attempts, errMsg) => {
                markFailureCalls.push(errMsg);
            });
            d.markOk = sinon.stub().resolves();

            const conn = makeMockConn([[]]);
            stubs.fspStub.mkdir.resolves();

            await d.processToken(conn, { coin: 'BTC', network: 'mainnet', poolKey: 'BTC' }, {
                icon_id: 1, token_id: 10, attempts: 0, description: 'https://example.com/a.png', tick: 'TOK',
            });

            expect(markFailureCalls.length).to.equal(1);
            expect(markFailureCalls[0].length).to.equal(255);
        });
    });
}

// Covers the e.code || e.message || 'fetch failed' fallback chain.
{

    iconSuite('_httpFetch "fetch failed" fallback', function () {
        it('uses "fetch failed" when axios error has neither code nor message', async function () {
            const err = {};   // no code, no message, no response
            err.__proto__ = Error.prototype;  // is an Error but empty
            const stubs = makeStubs({ axiosReject: err });
            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);
            try {
                await d.httpFetch('https://example.com/img.png');
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('fetch failed');
            }
        });
    });
}
