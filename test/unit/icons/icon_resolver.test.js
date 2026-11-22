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

const { expect } = require('chai');

const {
    resolveDescriptionToSource,
    selectIconUrlFromCip25Json,
    rewriteSchemeUrl,
} = require('../../../src/icons/resolver');
// The token page's own rule, required the way /relay loads it, so parity is checked
// against shipped code rather than a copy.
const {
    tokenInfo_metadataUrl,
    tokenInfo_jsonPattern,
} = require('../../../src/content/js/xchain/token_info.js');

// One case per DESCRIPTION scheme the resolver understands, so the table below is
// the full list of what a token is allowed to point its icon at.
describe('IconResolver.resolveDescriptionToSource', function(){

    const { cases } = require('./icon_resolver.test/support/description_cases');

    cases.forEach(([desc, expectedScheme, expectedSubstr]) => {
        const label = (desc === null ? 'null' : (desc.length > 60 ? desc.slice(0, 60) + '…' : desc));
        it(`classifies "${label}" -> ${expectedScheme}`, function(){
            const r = resolveDescriptionToSource(desc);
            if(expectedScheme === null){
                expect(r).to.equal(null);
            } else {
                expect(r).to.be.an('object');
                expect(r.scheme).to.equal(expectedScheme);
                const payload = r.url || r.data || '';
                if(expectedSubstr !== null){
                    expect(payload).to.include(expectedSubstr);
                }
            }
        });
    });
});

describe('IconResolver json_url lane mirrors the token page scheme', function(){
    // tokenInfo_getJsonUrl (content/js/xchain/token_info.js) builds this lane as
    // 'https://' + desc.split(';')[0]
    // with any http(s) prefix stripped, and its /relay? retry reuses that same
    // https URL, so the page has no http path here. Forcing
    // http:// on a scheme-less description and pass an explicit http:// through,
    // which made the cached listing icon and the rendered page fetch different
    // documents and pushed https-only origins into a permanent `failed` row.
    const page = d => tokenInfo_metadataUrl(d);

    ['example.com/meta.json',
     'http://example.com/meta.json',
     'https://example.com/meta.json',
     'example.com/meta.json;abc123sha',
     'http://j-dog.net/json/JDOG.json;abc123sha', 'http://a.example/r?u=https://b.example/x.json',
     'HTTPS://h.example/x.json', 'Http://h.example/x.json;abc123sha'].forEach(desc => {
        it(`"${desc}" resolves to the page's URL`, function(){
            const r = resolveDescriptionToSource(desc);
            expect(r).to.be.an('object');
            expect(r.scheme).to.equal('json_url');
            expect(r.url).to.equal(page(desc));
            expect(r.url.slice(0, 8)).to.equal('https://');
        });
    });
});

describe('IconResolver arweave_url lane mirrors the token page', function(){
    // A bare arweave.net description may carry a ';<sha256>' suffix and the legacy
    // '/x.json' tail; both sides must drop them to fetch the same document.
    const TXID = 'jGxVm7yghVDfv39tJds8kRFFrIsGTsg3h-JgXHx_inw';
    const base = 'https://arweave.net/' + TXID;
    [[base, base],
     [base + '/x.json', base],
     [base + ';abc123sha', base],
     [base + '/x.json;abc123sha', base],
     [base + '/meta.json;abc123sha', base + '/meta.json'],
     ['http://arweave.net/' + TXID + ';abc123sha', 'http://arweave.net/' + TXID]].forEach(([desc, expected]) => {
        it(`"${desc}" resolves to the page's arweave URL`, function(){
            const r = resolveDescriptionToSource(desc);
            expect(r).to.be.an('object');
            expect(r.scheme).to.equal('arweave_url');
            expect(r.url).to.equal(expected);
            expect(r.url).to.equal(tokenInfo_metadataUrl(desc));
        });
    });
});

describe('IconResolver json_url lane uses the token page JSON-link rule', function(){
    // Plain-URL descriptions only: arweave, ipfs:, ar:, ord: and action: forms take
    // earlier lanes on both sides.
    const cases = [
        ['example.com/meta.json', 'json_url'],
        ['https://example.com/meta.json;abc123sha', 'json_url'],
        ['https://example.org/meta.json?v=2', 'json_url'],
        ['https://example.org/meta.JSON', 'json_url'],
        ['https://host.example/meta.json/icon.png', 'image_url'],
        ['https://api.example.com/token/json', null],
        ['a jsonish coin', null],
    ];
    cases.forEach(([desc, scheme]) => {
        it(`"${desc}" takes the json_url lane exactly when the page fetches it as JSON`, function(){
            const r = resolveDescriptionToSource(desc);
            expect(r ? r.scheme : null).to.equal(scheme);
            expect(r !== null && r.scheme === 'json_url').to.equal(tokenInfo_jsonPattern().test(desc));
            if(r && r.scheme === 'json_url')
                expect(r.url).to.equal(tokenInfo_metadataUrl(desc));
            else
                expect(tokenInfo_metadataUrl(desc)).to.equal(false);
        });
    });
});

describe('IconResolver URL hash pins', function(){
    const hash = 'ab'.repeat(32);

    it('carries a valid pin into JSON and bare arweave document sources', function(){
        expect(resolveDescriptionToSource(`https://example.org/meta.json;${hash}`).expectedHash).to.equal(hash);
        expect(resolveDescriptionToSource(`https://arweave.net/txid;${hash}`).expectedHash).to.equal(hash);
    });

    it('does not treat a legacy title suffix as a hash', function(){
        expect(resolveDescriptionToSource('https://example.org/meta.json;title')).not.to.have.property('expectedHash');
    });
});

// A description can match two lanes at once. The page takes its JSON-link lane
// before it ever reads stamp:, imgur or youtube/soundcloud forms, so the listing
// icon has to follow that same order or the two fetch different documents.
describe('IconResolver picks the page lane for a description matching two lanes', function(){
    ['imgur.com/abc.json', 'https://imgur.com/abc.json', 'http://imgur.com/abc.json',
     'imgur/abc.json', 'imgur.com/abc.json?v=1', 'youtube/x.json', 'soundcloud/x.json;Track',
     'stamp:AAAA.json'].forEach(desc => {
        it(`"${desc}" takes the json_url lane at the page's URL`, function(){
            const r = resolveDescriptionToSource(desc);
            expect(r, desc).to.be.an('object');
            expect(r.scheme).to.equal('json_url');
            expect(r.url).to.equal(tokenInfo_metadataUrl(desc));
        });
    });

    [['imgur.com/yTS3gEv.png', 'imgur'],
     ['youtube/FenVJ_cyE5M;Title', null],
     ['stamp:iVBORw0KGgo=', 'stamp']].forEach(([desc, scheme]) => {
        it(`"${desc}" keeps its own lane, which the page does not fetch as JSON`, function(){
            const r = resolveDescriptionToSource(desc);
            expect(r ? r.scheme : null).to.equal(scheme);
            expect(tokenInfo_metadataUrl(desc)).to.equal(false);
        });
    });

    [['ipfs:abc.json', 'ipfs'], ['ar:abc.json', 'arweave'],
     ['https://arweave.net/abc/x.json', 'arweave_url'], ['action:12', 'action']].forEach(([desc, scheme]) => {
        it(`"${desc}" keeps the earlier ${scheme} lane`, function(){
            expect(resolveDescriptionToSource(desc).scheme).to.equal(scheme);
        });
    });
});

// CIP25 and TIS token metadata can carry several image fields at once, so the order
// they are tried decides which picture a wallet actually shows. These lock that order.
describe('IconResolver.selectIconUrlFromCip25Json', function(){

    it('falls back to top-level image field', function(){
        expect(selectIconUrlFromCip25Json({ image: 'https://x.com/icon.png' }))
            .to.equal('https://x.com/icon.png');
    });

    it('uses top-level icon field (legacy)', function(){
        expect(selectIconUrlFromCip25Json({ icon: 'https://x.com/thumb.png' }))
            .to.equal('https://x.com/thumb.png');
    });

    it('prefers icon over image when both are present', function(){
        const json = { icon: 'https://x.com/sm.png', image: 'https://x.com/lg.png' };
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://x.com/sm.png');
    });

    it('falls back to image_large when icon and image are missing', function(){
        expect(selectIconUrlFromCip25Json({ image_large: 'https://x.com/big.jpg' }))
            .to.equal('https://x.com/big.jpg');
    });

    it('falls back to image_large_hd as last resort', function(){
        expect(selectIconUrlFromCip25Json({ image_large_hd: 'https://x.com/hd.jpg' }))
            .to.equal('https://x.com/hd.jpg');
    });

    it('handles a TOPFLOORPEPE-shaped JSON', function(){
        const json = {
            asset: 'TOPFLOORPEPE',
            icon: 'https://raw.githubusercontent.com/sub/images/main/THUMB.png',
            image_large: 'https://raw.githubusercontent.com/sub/images/main/PEPE.jpg',
            image_large_hd: 'https://cdn.jsdelivr.net/gh/sub/images@main/HIRES.jpg',
        };
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://raw.githubusercontent.com/sub/images/main/THUMB.png');
    });
});

describe('IconResolver.selectIconUrlFromCip25Json', function(){
    it('picks 48x48 icon from images[]', function(){
        const json = { images: [{ type: 'icon', size: '48x48', data: 'https://x.com/sm.png' }] };
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://x.com/sm.png');
    });

    // The token page takes 64x64 first (content/js/xchain/token_content.js).
    // Starting at 48x48 cached a different image than the page displayed, and
    // upscaled it, since the downloader renders at 64px.
    it('prefers a 64x64 icon over 48x48, as the token page does', function(){
        const json = { images: [
            { type: 'icon', size: '48x48', data: 'https://x.com/48.png' },
            { type: 'icon', size: '64x64', data: 'https://x.com/64.png' },
        ]};
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://x.com/64.png');
    });

    it('still takes 48x48 when no 64x64 icon is present', function(){
        const json = { images: [
            { type: 'icon', size: '128x128', data: 'https://x.com/128.png' },
            { type: 'icon', size: '48x48',   data: 'https://x.com/48.png' },
        ]};
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://x.com/48.png');
    });

    it('takes a 64x64 icon ahead of a same-size entry that is not an icon', function(){
        const json = { images: [
            { type: 'standard', size: '64x64', data: 'https://x.com/std.png' },
            { type: 'icon',     size: '64x64', data: 'https://x.com/64.png' },
        ]};
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://x.com/64.png');
    });
});

describe('IconResolver.selectIconUrlFromCip25Json', function(){
    it('prefers 48x48 icon over a "large" entry', function(){
        const json = { images: [
            { type: 'large', data: 'https://x.com/big.png' },
            { type: 'icon',  size: '48x48', data: 'https://x.com/sm.png' },
        ]};
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://x.com/sm.png');
    });

    it('rewrites ipfs:// in image data to gateway URL', function(){
        const json = { images: [{ type: 'icon', data: 'ipfs://QmHash' }] };
        expect(selectIconUrlFromCip25Json(json)).to.include('ipfsc.crystalsuite.com/QmHash');
    });

    it('rewrites ar: in image data to gateway URL', function(){
        const json = { images: [{ type: 'icon', data: 'ar:abc123' }] };
        expect(selectIconUrlFromCip25Json(json)).to.include('arweave.net/abc123');
    });

    it('rewrites ar: in top-level image field', function(){
        expect(selectIconUrlFromCip25Json({ image: 'ar:abc123' }))
            .to.include('arweave.net/abc123');
    });

    it('returns null on empty object', function(){
        expect(selectIconUrlFromCip25Json({})).to.equal(null);
    });

    it('returns null on null input', function(){
        expect(selectIconUrlFromCip25Json(null)).to.equal(null);
    });

    it('falls back to a standard/large entry in images[] when higher tiers are absent', function(){
        let json = { images: [{ type: 'standard', data: 'https://x.com/std.png' }] };
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://x.com/std.png');
        let json2 = { images: [{ type: 'large', data: 'https://x.com/lg.png' }] };
        expect(selectIconUrlFromCip25Json(json2)).to.equal('https://x.com/lg.png');
    });

    it('falls back to a hires entry in images[] after standard/large', function(){
        let json = { images: [{ type: 'hires', data: 'https://x.com/hi.png' }] };
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://x.com/hi.png');
    });

    it('falls back to the first usable images[] entry of any type', function(){
        let json = { images: [{ type: 'whatever', data: 'https://x.com/any.png' }] };
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://x.com/any.png');
    });

    it('skips malformed images[] entries when scanning fallback tiers', function(){
        let json = { images: [null, 'not-an-object', { type: 'hires', data: 'https://x.com/hi.png' }] };
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://x.com/hi.png');
    });
});

describe('IconResolver.rewriteSchemeUrl', function(){
    it('passes through https URL unchanged', function(){
        expect(rewriteSchemeUrl('https://example.com/x.png'))
            .to.equal('https://example.com/x.png');
    });
    it('rewrites ipfs:// prefix', function(){
        expect(rewriteSchemeUrl('ipfs://QmHash'))
            .to.equal('https://ipfsc.crystalsuite.com/QmHash');
    });
    it('rewrites ipfs: prefix (no slashes)', function(){
        expect(rewriteSchemeUrl('ipfs:QmHash'))
            .to.equal('https://ipfsc.crystalsuite.com/QmHash');
    });
    it('rewrites ar: prefix', function(){
        expect(rewriteSchemeUrl('ar:abc123'))
            .to.equal('https://arweave.net/abc123');
    });
    it('returns null on empty string', function(){
        expect(rewriteSchemeUrl('')).to.equal(null);
    });
    it('returns null on non-string', function(){
        expect(rewriteSchemeUrl(null)).to.equal(null);
    });
});
