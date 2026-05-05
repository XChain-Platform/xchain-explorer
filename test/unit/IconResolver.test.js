'use strict';

const { expect } = require('chai');

const {
    resolveDescriptionToSource,
    selectIconUrlFromCip25Json,
    rewriteSchemeUrl,
} = require('../../src/IconResolver');

// ---------------------------------------------------------------------------
// resolveDescriptionToSource — full priority chain
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// selectIconUrlFromCip25Json — CIP25 / TIS image array priority
// ---------------------------------------------------------------------------

describe('IconResolver.selectIconUrlFromCip25Json', function(){

    it('falls back to top-level image field', function(){
        expect(selectIconUrlFromCip25Json({ image: 'https://x.com/icon.png' }))
            .to.equal('https://x.com/icon.png');
    });

    it('picks 48x48 icon from images[]', function(){
        const json = { images: [{ type: 'icon', size: '48x48', data: 'https://x.com/sm.png' }] };
        expect(selectIconUrlFromCip25Json(json)).to.equal('https://x.com/sm.png');
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
});

// ---------------------------------------------------------------------------
// rewriteSchemeUrl — direct unit tests
// ---------------------------------------------------------------------------

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
