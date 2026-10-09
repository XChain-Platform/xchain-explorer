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

const { resolveDescriptionToSource } = require('../../../../src/icons/resolver');
// The token page's own rule, required the way /relay loads it.
const { tokenInfo_metadataUrl } = require('../../../../src/content/js/xchain/token_info.js');

// Token descriptions are on-chain text anyone can pad. The resolver trims before it
// classifies, so the page has to trim the same way, or a padded description gets a
// cached listing icon while its token page fetches nothing (or a different URL).
describe('IconResolver and the token page agree on whitespace-padded descriptions', function(){

    const HEX64 = 'ab'.repeat(32);
    const cases = [
        [' ipfs:QmHash',                         'ipfs'],
        ['ipfs:QmHash ',                         'ipfs'],
        ['ipfs: QmHash',                         'ipfs'],
        [' ipfs://QmHash ',                      'ipfs'],
        [' ar:abc123 ',                          'arweave'],
        ['ar: abc123',                           'arweave'],
        ['ord: ' + HEX64,                        'ord'],
        [' ord:' + HEX64 + '\n',                 'ord'],
        [' https://example.org/meta.json',       'json_url'],
        ['https://example.org/meta.json ',       'json_url'],
        ['\texample.org/meta.json\n',            'json_url'],
        ['https://arweave.net/abc123/x.json ',   'arweave_url'],
    ];

    cases.forEach(([desc, scheme]) => {
        it(`${JSON.stringify(desc)} resolves to the page's URL on both sides`, function(){
            const r = resolveDescriptionToSource(desc);
            expect(r, desc).to.be.an('object');
            expect(r.scheme).to.equal(scheme);
            expect(tokenInfo_metadataUrl(desc)).to.equal(r.url);
        });
    });

    it('builds the same URL for a padded description as for its trimmed form', function(){
        cases.forEach(([desc]) => {
            expect(tokenInfo_metadataUrl(desc), desc).to.equal(tokenInfo_metadataUrl(desc.trim()));
        });
    });

    describe('action: references', function(){
        // actionRefToRawPath is page-only (token_media.js); a recording stand-in shows
        // which ref the page's rule handed it, which is the classification under test.
        let had, saved;
        before(function(){
            had = Object.prototype.hasOwnProperty.call(global, 'actionRefToRawPath');
            saved = global.actionRefToRawPath;
            global.actionRefToRawPath = ref => 'raw:' + ref;
        });
        after(function(){
            if(had) global.actionRefToRawPath = saved;
            else delete global.actionRefToRawPath;
        });

        [[' action:12', null, '12'], ['action:12 ', null, '12'], ['\taction:BTC:5\n', 'BTC', '5']].forEach(([desc, coin, index]) => {
            it(`${JSON.stringify(desc)} is an action ref on both sides`, function(){
                const r = resolveDescriptionToSource(desc);
                expect(r).to.deep.equal({ scheme: 'action', coin, index });
                expect(tokenInfo_metadataUrl(desc)).to.equal('raw:' + desc.trim());
            });
        });
    });
});
