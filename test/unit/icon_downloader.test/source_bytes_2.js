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
    function makeDownloader(stubs) {
        const IconDownloader = loadIconDownloader(stubs);
        const explorer = makeExplorer();
        return new IconDownloader(explorer);
    }
    iconSuite('_fetchSourceBytes()', function () {
        it('arweave_url: same behavior as arweave (raw bytes path)', async function () {
            const imgBytes = Buffer.from('WEBPDATA');
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/webp' },
                    data:    imgBytes,
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'arweave_url', url: 'https://arweave.net/abc456' };
            const result = await d.fetchSourceBytes(src, 2);
            expect(result).to.deep.equal(imgBytes);
        });

        it('image_url: returns body when content-type starts with image/', async function () {
            const imgBytes = Buffer.from('IMGDATA');
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/png; charset=utf-8' },
                    data:    imgBytes,
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'image_url', url: 'https://example.com/icon.png' };
            const result = await d.fetchSourceBytes(src, 2);
            expect(result).to.deep.equal(imgBytes);
        });

        it('image_url: throws when content-type is not an image', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'text/html' },
                    data:    Buffer.from('<html>'),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'image_url', url: 'https://example.com/page' };
            try {
                await d.fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include("not an image");
                expect(e.message).to.include('text/html');
            }
        });

    });

    iconSuite('_fetchSourceBytes()', function () {
        it('imgur: throws when content-type is not an image', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'text/plain' },
                    data:    Buffer.from('not an image'),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'imgur', url: 'https://i.imgur.com/abc123' };
            try {
                await d.fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include("not an image");
            }
        });

        it('imgur: succeeds when content-type starts with image/', async function () {
            const imgBytes = Buffer.from('GIFDATA');
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/gif' },
                    data:    imgBytes,
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'imgur', url: 'https://i.imgur.com/abc123.gif' };
            const result = await d.fetchSourceBytes(src, 2);
            expect(result).to.deep.equal(imgBytes);
        });

        it('throws "recursion limit hit" when depth < 0', async function () {
            const stubs = makeStubs();
            const d = makeDownloader(stubs);
            try {
                await d.fetchSourceBytes({ scheme: 'image_url', url: 'https://x.com/a.png' }, -1);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('recursion limit hit');
            }
        });

    });

    iconSuite('_fetchSourceBytes()', function () {
        it('_httpFetch: throws HTTP status error when axios throws with response', async function () {
            const err = new Error('Request failed');
            err.response = { status: 404 };
            const stubs = makeStubs({ axiosReject: err });
            const d = makeDownloader(stubs);
            const src = { scheme: 'image_url', url: 'https://example.com/missing.png' };
            try {
                await d.fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('HTTP 404');
            }
        });

        it('_httpFetch: throws error code when axios throws without response', async function () {
            const err = new Error('connect ECONNREFUSED');
            err.code = 'ECONNREFUSED';
            const stubs = makeStubs({ axiosReject: err });
            const d = makeDownloader(stubs);
            const src = { scheme: 'image_url', url: 'https://example.com/x.png' };
            try {
                await d.fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('ECONNREFUSED');
            }
        });

        it('_httpFetch: falls back to e.message when code is missing', async function () {
            const err = new Error('timeout exceeded');
            const stubs = makeStubs({ axiosReject: err });
            const d = makeDownloader(stubs);
            const src = { scheme: 'image_url', url: 'https://example.com/x.png' };
            try {
                await d.fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.equal('timeout exceeded');
            }
        });

    });

    iconSuite('_fetchSourceBytes()', function () {
        it('_httpFetch: converts non-buffer resp.data to Buffer', async function () {
            // An HTTP client can hand a response body back as a Uint8Array rather than a
            // Buffer, so the fetch helper normalises it and no caller has to check which.
            const arr = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/png' },
                    data:    arr,
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'image_url', url: 'https://example.com/icon.png' };
            const result = await d.fetchSourceBytes(src, 2);
            expect(Buffer.isBuffer(result)).to.equal(true);
        });
    });
}
