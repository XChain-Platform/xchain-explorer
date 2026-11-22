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
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const SOURCE = require('../../helpers/content-source.js');
const {
    resolveDescriptionToSource,
    selectIconUrlFromCip25Json,
} = require('../../../src/icons/resolver');

function pageWindow(){
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only', url: 'https://xchain.test/BTC/token/XCHAIN'
    });
    const win = dom.window;
    win.eval(fs.readFileSync(path.join(SOURCE.JS_DIR, 'jquery.min.js'), 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(SOURCE.clientSource());
    win.XC.coin = 'BTC';
    win.XC.network = 'mainnet';
    win.XC.status = { available: { BTC: {}, LTC: {}, DOGE: {} } };
    return win;
}

// Keep the resolver aligned with the token page's on-chain action reference grammar.
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

    // Reject Unicode lookalikes that can fold differently in database comparisons.
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
        // Prefer the action reference resolved by the token page.
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

    // Ignore unresolved data_ref values so the downloader matches the token page.
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

    it('keeps browser and worker selection aligned for normalized data refs', function(){
        const win = pageWindow();
        const refs = ['action:9', '  action:9  ', '\taction:BTC:12\n', ' ACTION:Doge:7 ',
            '\u00a0action:9\u00a0', 'not-a-ref', 'https://other/y.png', '   ', 'action:'];
        for(const ref of refs){
            const source = { images: [{ type: 'icon', size: '64x64', data: 'https://x/a.png', data_ref: ref }] };
            const page = JSON.parse(JSON.stringify(source));
            win.resolveTisDataRefs(page);
            const worker = selectIconUrlFromCip25Json(source);
            const workerUsesRef = typeof worker === 'string' && /^action:/i.test(worker);
            const pageUsesRef = page.images[0].data !== source.images[0].data;
            expect(pageUsesRef, JSON.stringify(ref)).to.equal(workerUsesRef);
            if(workerUsesRef) expect(page.images[0].data).to.equal(win.actionRefToRawPath(worker));
        }
        win.close();
    });
});
