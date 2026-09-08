/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The Artwork Information title read only the display entry's
 * `name` (the FILENAME). A TBTC token whose large image came from the legacy
 * image_large field (no name) and whose audio entry was BADGUY.mp3 titled its
 * artwork "BADGUY.mp3", while the JSON carried a top-level `title` and a
 * `title` on every entry, both ignored.
 *
 * Pins resolveArtworkTitle's precedence (top-level title, then entry title,
 * then entry name, image before audio before video) and that the legacy
 * mapper forwards the top-level `title` at all.
 *********************************************************************/
'use strict';

const vm   = require('vm');
const { expect } = require('chai');
const CLIENT = require('../helpers/content-source.js').clientSource();

// Slice a top-level function out of xchain.js by walking braces, the same
// technique the sibling content-client tests use.
function extractFn(name){
    const sig = 'function ' + name + '(';
    const start = CLIENT.indexOf(sig);
    if(start < 0) throw new Error('function not found in client source: ' + name);
    const braceStart = CLIENT.indexOf('{', start);
    let depth = 0, i = braceStart;
    for(; i < CLIENT.length; i++){
        const c = CLIENT[i];
        if(c === '{') depth++;
        else if(c === '}'){ depth--; if(depth === 0){ i++; break; } }
    }
    return CLIENT.slice(start, i);
}

// The mapper leans on two formatters.js helpers (stripHtml, isNull); load them
// from the same composed source so the slice runs as it does in the page.
const ctx = vm.createContext({ console: { log: function(){} }, XC: { debug: false } });
vm.runInContext(
    ['isNull', 'stripHtml', 'resolveArtworkTitle', 'legacyJsonToXChainTIS'].map(extractFn).join('\n'),
    ctx
);
const resolveArtworkTitle   = ctx.resolveArtworkTitle;
const legacyJsonToXChainTIS = ctx.legacyJsonToXChainTIS;

// The OBEY document as published (trimmed to the fields that matter here).
function obeyJson(){
    return {
        name: 'YOU ARE NOW CONSUMING',
        title: 'CONSUME / OBEY / FREE WILL SOLD SEPARATELY',
        description: 'desire installed.',
        image: 'https://example.test/hypnosis-icon.png',
        image_large: 'https://example.test/CONSUME-OBEY-0.gif',
        images: [
            { data: 'https://example.test/hypnosis-icon.png', name: 'hypnosis-icon.png', type: 'image/png', title: 'CONSUME token icon' }
        ],
        audio: [
            { data: 'https://example.test/BADGUY.mp3', name: 'BADGUY.mp3', type: 'audio/mpeg', title: 'BAD GUY audio layer' }
        ],
        video: [
            { data: 'https://example.test/grandma.mp4', name: 'grandma.mp4', type: 'video/mp4', title: 'GRANDMA video layer' }
        ]
    };
}

describe('content client: Artwork Information title', function(){

    it('the legacy mapper forwards the top-level title', function(){
        const tis = legacyJsonToXChainTIS(obeyJson());
        expect(tis.title).to.equal('CONSUME / OBEY / FREE WILL SOLD SEPARATELY');
    });

    it('the measured shape: image_large entry with no name, audio named BADGUY.mp3 -> top-level title wins', function(){
        const tis = legacyJsonToXChainTIS(obeyJson());
        // What showTokenContent hands over: the synthetic large entry (no name,
        // no title), the mp3 entry, the mp4 entry.
        const large = tis.images.filter(function(i){ return i.type === 'large'; })[0];
        expect(large).to.be.an('object');
        expect(large.name).to.equal(undefined);
        const title = resolveArtworkTitle(tis.title, [large, tis.audio[0], tis.video[0]]);
        expect(title).to.equal('CONSUME / OBEY / FREE WILL SOLD SEPARATELY');
        expect(title).to.not.equal('BADGUY.mp3');
    });

    it('with no top-level title, the first entry TITLE wins over any filename, image first', function(){
        const title = resolveArtworkTitle(undefined, [
            { name: 'cover.png' },
            { name: 'BADGUY.mp3', title: 'BAD GUY audio layer' },
            { name: 'grandma.mp4', title: 'GRANDMA video layer' }
        ]);
        expect(title).to.equal('BAD GUY audio layer');
    });

    it('an image entry title outranks an audio entry title', function(){
        const title = resolveArtworkTitle(null, [
            { name: 'cover.png', title: 'The Cover' },
            { name: 'BADGUY.mp3', title: 'BAD GUY audio layer' }
        ]);
        expect(title).to.equal('The Cover');
    });

    it('with no titles anywhere, the first entry NAME is the fallback (the old behaviour)', function(){
        const title = resolveArtworkTitle('', [false, { name: 'BADGUY.mp3' }, { name: 'grandma.mp4' }]);
        expect(title).to.equal('BADGUY.mp3');
    });

    it('blank and missing values are skipped, and nothing at all yields false', function(){
        expect(resolveArtworkTitle('   ', [{ title: ' ', name: '' }, null])).to.equal(false);
        expect(resolveArtworkTitle(undefined, [])).to.equal(false);
        expect(resolveArtworkTitle(undefined, undefined)).to.equal(false);
    });

    it('the legacy image_title still names the large entry, so the old workaround keeps working', function(){
        const o = obeyJson();
        delete o.title;
        o.image_title = 'Large by image_title';
        const tis = legacyJsonToXChainTIS(o);
        const large = tis.images.filter(function(i){ return i.type === 'large'; })[0];
        expect(resolveArtworkTitle(tis.title, [large, tis.audio[0]])).to.equal('BAD GUY audio layer');
        // ...but only behind a real title: strip the entry titles and the name shows.
        delete tis.audio[0].title;
        expect(resolveArtworkTitle(tis.title, [large, tis.audio[0]])).to.equal('Large by image_title');
    });
});
