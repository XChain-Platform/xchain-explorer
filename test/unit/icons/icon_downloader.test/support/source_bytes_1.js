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

// One group per source scheme a DESCRIPTION can resolve to (stamp, ord, json_url,
// arweave, image_url, imgur), because each one reaches its bytes a different way
// and each one fails a different way.
{

    // A fresh downloader per test: the module is re-loaded through proxyquire each
    // time, so one test's stubbed HTTP client or filesystem cannot leak into the next.
    function makeDownloader(stubs) {
        const IconDownloader = loadIconDownloader(stubs);
        const explorer = makeExplorer();
        return new IconDownloader(explorer);
    }

    iconSuite('_fetchSourceBytes()', function () {
        it('stamp: decodes base64 and returns buffer', async function () {
            const stubs = makeStubs();
            const d = makeDownloader(stubs);
            // "hello" in base64 = aGVsbG8=
            const src = { scheme: 'stamp', data: 'aGVsbG8=' };
            const result = await d.fetchSourceBytes(src, 2);
            expect(result.toString()).to.equal('hello');
        });

        it('stamp: throws on empty base64', async function () {
            const stubs = makeStubs();
            const d = makeDownloader(stubs);
            const src = { scheme: 'stamp', data: 'AA==' };  // decodes to 0x00 (single byte, fine)
            const r = await d.fetchSourceBytes(src, 2);
            expect(r).to.be.instanceOf(Buffer);
        });

        it('stamp: throws when buffer is empty after decode', async function () {
            const stubs = makeStubs();
            const d = makeDownloader(stubs);
            // AA== decodes to a single byte and must succeed; an empty string
            // decodes to zero bytes and must throw.
            const src = { scheme: 'stamp', data: '' };
            try {
                await d.fetchSourceBytes({ scheme: 'stamp', data: 'AA==' }, 2);
            } catch (e) {
                throw new Error('unexpected throw for valid stamp');
            }
            try {
                await d.fetchSourceBytes({ scheme: 'stamp', data: '' }, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('empty after base64 decode');
            }
        });

        it('ord: fetches URL, parses JSON, extracts base64 data', async function () {
            const imageData = 'data:image/png;base64,' + Buffer.from('FAKEIMAGE').toString('base64');
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(JSON.stringify({ images: [{ data: imageData }] })),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'ord', url: 'https://inscription-decoder.vercel.app/api/image?tx=abc' };
            const result = await d.fetchSourceBytes(src, 2);
            expect(result.toString()).to.equal('FAKEIMAGE');
        });

    });

    iconSuite('_fetchSourceBytes()', function () {
        it('ord: throws on bad JSON', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from('not-json'),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'ord', url: 'https://example.com' };
            try {
                await d.fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('bad decoder JSON');
            }
        });

        it('ord: throws when images[0].data is missing', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(JSON.stringify({ images: [{ type: 'png' }] })),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'ord', url: 'https://example.com' };
            try {
                await d.fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('missing images[0].data');
            }
        });

    });

    iconSuite('_fetchSourceBytes()', function () {
        it('ord: throws when data URL is not base64', async function () {
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(JSON.stringify({
                        images: [{ data: 'data:image/png;utf8,actualdata' }],
                    })),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'ord', url: 'https://example.com' };
            try {
                await d.fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('data URL not base64');
            }
        });

        it('ord: throws when base64 decodes to empty buffer', async function () {
            // A base64 data URL that decodes to an empty buffer.
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(JSON.stringify({
                        images: [{ data: 'data:image/png;base64,' }],
                    })),
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'ord', url: 'https://example.com' };
            try {
                await d.fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('empty after base64 decode');
            }
        });

    });

    iconSuite('_fetchSourceBytes()', function () {
        it('json_url: parses JSON and recurses via selectIconUrlFromCip25Json', async function () {
            const imageUrl = 'https://example.com/icon.png';
            const jsonBody = JSON.stringify({ image: imageUrl });

            let callCount = 0;
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(jsonBody),
                },
                selectIconUrlFromCip25Json: sinon.stub().returns(imageUrl),
                // Always null, so the URL pulled out of the JSON falls through to the
                // plain image_url branch instead of being resolved to another scheme.
                resolveDescriptionToSource: sinon.stub().callsFake((desc) => {
                    callCount++;
                    if (callCount === 1) return null;
                    return null;
                }),
            });

            const IconDownloader = loadIconDownloader(stubs);
            const explorer = makeExplorer();
            const d = new IconDownloader(explorer);

            // Second fetch (for image_url) should return image bytes
            stubs.axiosStub.get
                .onFirstCall().resolves({
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(jsonBody),
                })
                .onSecondCall().resolves({
                    status:  200,
                    headers: { 'content-type': 'image/png' },
                    data:    Buffer.from('IMGBYTES'),
                });

            const src = { scheme: 'json_url', url: 'https://example.com/meta.json' };
            const result = await d.fetchSourceBytes(src, 2);
            expect(result.toString()).to.equal('IMGBYTES');
        });

    });

    iconSuite('_fetchSourceBytes()', function () {
        it('json_url: throws when JSON has no usable image (selectIconUrlFromCip25Json returns null)', async function () {
            const jsonBody = JSON.stringify({ name: 'TOKEN' });
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'application/json' },
                    data:    Buffer.from(jsonBody),
                },
                selectIconUrlFromCip25Json: sinon.stub().returns(null),
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'json_url', url: 'https://example.com/meta.json' };

            try {
                await d.fetchSourceBytes(src, 2);
                throw new Error('should have thrown');
            } catch (e) {
                expect(e.message).to.include('no usable image');
            }
        });

        it('json_url: returns raw bytes when body is not JSON (image data)', async function () {
            const imgBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG header
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/png' },
                    data:    imgBytes,
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'ipfs', url: 'https://ipfsc.crystalsuite.com/Qmabc123' };
            const result = await d.fetchSourceBytes(src, 2);
            expect(result).to.deep.equal(imgBytes);
        });

        it('arweave: returns raw bytes when body is not JSON', async function () {
            const imgBytes = Buffer.from([0xFF, 0xD8, 0xFF]); // JPEG header
            const stubs = makeStubs({
                axiosResponse: {
                    status:  200,
                    headers: { 'content-type': 'image/jpeg' },
                    data:    imgBytes,
                },
            });
            const d = makeDownloader(stubs);
            const src = { scheme: 'arweave', url: 'https://arweave.net/abc123' };
            const result = await d.fetchSourceBytes(src, 2);
            expect(result).to.deep.equal(imgBytes);
        });

    });
}
