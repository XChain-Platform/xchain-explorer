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
} = require('../../src/IconResolver');

describe('IconResolver.resolveDescriptionToSource', function(){

    // [description, expected_scheme, substring_or_null_for_url_or_data]
    const cases = [
        ['stamp:iVBORw0KGgo=',                                                                  'stamp',        'iVBORw0KGgo='],
        ['stamp:!!!not-base-64!!!',                                                             null,           null],   // invalid base64 -> null (no retries)
        ['stamp:',                                                                              null,           null],   // empty stub -> null
        ['ord:1d36aa544a20be86dca452e3abe464d33dd8567392dee8e333f72519e97af679',                'ord',          'tx=1d36aa544a20be'],
        ['ord:HTaqVEogvobcpFLjq+Rk0z3YVnOS3ujjM/clGel69nk=',                                    'ord',          'tx=1d36aa544a20be'],
        ['ipfs:QmdnznjxzrjmLGpwjiDrgfdAu5r7VB4tWWWVtNRtqYqACq',                                 'ipfs',         'ipfsc.crystalsuite.com/Qmdn'],
        ['ipfs://QmdnznjxzrjmLGpwjiDrgfdAu5r7VB4tWWWVtNRtqYqACq',                               'ipfs',         'ipfsc.crystalsuite.com/Qmdn'],
        ['ar:jGxVm7yghVDfv39tJds8kRFFrIsGTsg3h-JgXHx_inw',                                      'arweave',      'arweave.net/jGxVm7'],
        ['AR:jGxVm7yghVDfv39tJds8kRFFrIsGTsg3h-JgXHx_inw',                                      'arweave',      'arweave.net/jGxVm7'],
        ['imgur/yTS3gEv.png',                                                                   'imgur',        'i.imgur.com/yTS3gEv.png'],
        ['imgur/yTS3gEv.png;XChain',                                                            'imgur',        'i.imgur.com/yTS3gEv.png'],
        ['imgur.com/yTS3gEv.png',                                                               'imgur',        'i.imgur.com/yTS3gEv.png'],
        ['imgur.com/a/tf7ZeBG.jpg',                                                             'imgur',        'i.imgur.com/tf7ZeBG.jpg'],
        ['imgur.com/gallery/2XaB4Kg',                                                           'imgur',        'i.imgur.com/2XaB4Kg'],
        ['https://imgur.com/2XaB4Kg',                                                           'imgur',        'i.imgur.com/2XaB4Kg'],
        ['https://imgur.com/gallery/2XaB4Kg',                                                   'imgur',        'i.imgur.com/2XaB4Kg'],
        ['https://imgur.com/a/tf7ZeBG',                                                         'imgur',        'i.imgur.com/tf7ZeBG'],
        ['http://imgur.com/cuiDGeH.jpg',                                                        'imgur',        'i.imgur.com/cuiDGeH.jpg'],
        // Direct i.imgur.com URLs must still fall through to image_url, NOT match imgur:
        ['https://i.imgur.com/yTS3gEv.png',                                                     'image_url',    'yTS3gEv.png'],
        ['youtube/FenVJ_cyE5M;Title',                                                           null,           null],
        ['soundcloud/924613324;Track',                                                          null,           null],
        ['https://arweave.net/jGxVm7yghVDfv39tJds8kRFFrIsGTsg3h-JgXHx_inw',                     'arweave_url',  'arweave.net/jGxVm7yghVDfv39'],
        ['https://arweave.net/jGxVm7yghVDfv39tJds8kRFFrIsGTsg3h-JgXHx_inw/x.json',              'arweave_url',  'arweave.net/jGxVm7yghVDfv39'],
        ['https://j-dog.net/json/JDOG.json',                                                    'json_url',     'JDOG.json'],
        ['https://j-dog.net/json/JDOG.json;abc123sha',                                          'json_url',     'JDOG.json'],
        ['https://i.imgur.com/yTS3gEv.png',                                                     'image_url',    'yTS3gEv.png'],
        ['https://example.com/foo.GIF?t=1',                                                     'image_url',    'foo.GIF'],
        ['',                                                                                    null,           null],
        ['just some random text',                                                               null,           null],
        [null,                                                                                  null,           null],
        ['https://arweave.net/abc/x.json',                                                      'arweave_url',  'arweave.net/abc'],
    ];

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

    it('picks 48x48 icon from images[]', function(){
        const json = { images: [{ type: 'icon', size: '48x48', data: 'https://x.com/sm.png' }] };
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://x.com/sm.png');
    });

    // The token page takes 64x64 first (content/js/xchain.js). Starting at 48x48
    // cached a different image than the page displayed, and upscaled it, since
    // the downloader renders at 64px.
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

// The on-chain TIS scheme (DESCRIPTION = action:<index> / action:<COIN>:<index>).
// This file's whole contract is "pick the source the token page would", and the page
// resolves this one live via actionRefToRawPath in content/js/xchain.js. It was the
// one scheme missing here, so an on-chain-documented token showed its real icon on
// its own page and the default icon on every cached listing surface, permanently.
//
// The parity assertion is the regex: the page accepts exactly three sibling tickers
// and a digits-only index, and a resolver that accepts more (or less) drifts the two
// surfaces apart again.
describe('IconResolver.resolveDescriptionToSource: action scheme', function(){
    it('resolves a same-chain ref', function(){
        expect(resolveDescriptionToSource('action:123'))
            .to.deep.equal({ scheme: 'action', coin: null, index: '123' });
    });
    it('resolves a sibling-chain ref and upper-cases the ticker', function(){
        expect(resolveDescriptionToSource('action:doge:45'))
            .to.deep.equal({ scheme: 'action', coin: 'DOGE', index: '45' });
        expect(resolveDescriptionToSource('ACTION:LTC:1'))
            .to.deep.equal({ scheme: 'action', coin: 'LTC', index: '1' });
    });
    it('carries no url, because the bytes are not on the network', function(){
        expect(resolveDescriptionToSource('action:1').url).to.equal(undefined);
    });
    it('matches the page regex exactly: only BTC/LTC/DOGE and a digits-only index', function(){
        for (const bad of ['action:abc', 'action:XCP:1', 'action:', 'action:1.5',
                           'action:-1', 'action:BTC:', 'action:BTC:1x', 'action: 1']) {
            expect(resolveDescriptionToSource(bad), bad).to.equal(null);
        }
    });

    // The grammar is ASCII, and the icon worker's re-stale predicate relies on that
    // being true of BOTH engines that read ACTION_REF_PATTERN. A lookalike that this
    // function rejects but MariaDB accepts is an infinite re-stale on the
    // indexer-owned icons table, mintable by anyone, because descriptions are
    // attacker-controlled on-chain data (#5290). U+0130 is the specific one: MariaDB's
    // utf8mb4 LOWER() folds it to plain 'i' and JavaScript's /i does not.
    it('accepts ASCII spellings only: no Unicode lookalike enters the grammar', function(){
        for (const bad of ['ACTİON:12', 'ACTİON:BTC:5', 'actİon:12', 'actıon:12',
                           'ＡＣＴＩＯＮ:12', 'ACTION：12', 'action:１２', 'ACTIOＮ:12']) {
            expect(resolveDescriptionToSource(bad), JSON.stringify(bad)).to.equal(null);
        }
    });

    it('accepts every ASCII case spelling, since neither engine folds case any more', function(){
        const mix = (w, m) => [...w].map((c, i) => (m >> i) & 1 ? c.toUpperCase() : c).join('');
        for (let m = 0; m < 64; m++) {
            const desc = mix('action', m) + ':12';
            expect(resolveDescriptionToSource(desc), desc)
                .to.deep.equal({ scheme: 'action', coin: null, index: '12' });
        }
        for (const coin of ['btc', 'ltc', 'doge']) {
            for (let k = 0; k < (1 << coin.length); k++) {
                const desc = 'action:' + mix(coin, k) + ':5';
                expect(resolveDescriptionToSource(desc).coin, desc).to.equal(coin.toUpperCase());
            }
        }
    });
});

describe('IconResolver.selectIconUrlFromCip25Json: TIS data_ref', function(){
    it('prefers data_ref over data on the same entry, as the page does', function(){
        // resolveTisDataRefs (content/js/xchain.js) overwrites `data` with the resolved
        // ref before any picker runs, so a downloader that reads `data` fetches a
        // different image than the page renders.
        let json = { images: [{ type: 'icon', size: '64x64', data: 'https://x.com/old.png', data_ref: 'action:9' }] };
        expect(selectIconUrlFromCip25Json(json)).to.equal('action:9');
    });
    it('keeps data when data_ref is absent or empty', function(){
        expect(selectIconUrlFromCip25Json({ images: [{ type: 'icon', data: 'https://x.com/a.png', data_ref: '  ' }] }))
            .to.equal('https://x.com/a.png');
        expect(selectIconUrlFromCip25Json({ images: [{ type: 'icon', data: 'https://x.com/a.png' }] }))
            .to.equal('https://x.com/a.png');
    });
    it('makes a data_ref-only entry usable at all', function(){
        expect(selectIconUrlFromCip25Json({ images: [{ type: 'icon', data_ref: 'action:BTC:12' }] }))
            .to.equal('action:BTC:12');
    });

    // The page substitutes only a RESOLVED action ref (actionRefToRawPath returns false
    // for everything else), and the spec defines data_ref as an on-chain FILE action
    // reference. TIS documents are attacker-mintable, so an ungated substitution let a
    // token point this downloader at a different image than the page renders.
    it('ignores a URL-shaped data_ref and keeps the entry data, as the page does', function(){
        const json = { images: [{ type: 'icon', size: '64x64', data: 'https://good/x.png', data_ref: 'https://other/y.png' }] };
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://good/x.png');
    });
    it('ignores a garbage data_ref and keeps the entry data', function(){
        const json = { images: [{ type: 'icon', data: 'https://good/x.png', data_ref: 'not-a-ref' }] };
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://good/x.png');
    });
    it('never returns a raw non-action data_ref when the entry has no data', function(){
        expect(selectIconUrlFromCip25Json({ images: [{ type: 'icon', data_ref: 'https://other/y.png' }] }))
            .to.equal(null);
        expect(selectIconUrlFromCip25Json({ images: [{ type: 'icon', data_ref: 'action:' }] }))
            .to.equal(null);
    });
    it('still substitutes an upper-case action ref, matching the page regex', function(){
        expect(selectIconUrlFromCip25Json({ images: [{ type: 'icon', data: 'https://x/a.png', data_ref: 'ACTION:9' }] }))
            .to.equal('ACTION:9');
        expect(selectIconUrlFromCip25Json({ images: [{ type: 'icon', data: 'https://x/a.png', data_ref: 'Action:Doge:9' }] }))
            .to.equal('Action:Doge:9');
    });
    it('trims a padded action ref instead of substituting the whitespace', function(){
        expect(selectIconUrlFromCip25Json({ images: [{ type: 'icon', data: 'https://x/a.png', data_ref: '  action:9  ' }] }))
            .to.equal('action:9');
    });
});
