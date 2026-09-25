/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Versioned asset URLs. After the develop-1a3010dd deploy the edge
 * held a 404 for a script the new release added, and any changed script could
 * be served stale for four hours; a content version in the URL retires both.
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { versionAssetUrls } = require('../../../src/render/asset_version.js');

describe('versionAssetUrls', function () {

    this.timeout(10000);

    // A throwaway content root, so a test can change a file and watch its URL move.
    function contentRoot(files){
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-version-'));
        for(const [rel, text] of Object.entries(files)){
            fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
            fs.writeFileSync(path.join(root, rel), text);
        }
        return root;
    }

    it('stamps a static-mount script and stylesheet with a content version', () => {
        const root = contentRoot({ 'js/a.js': 'one', 'css/b.css': 'two' });
        const out = versionAssetUrls('<script src="/js/a.js"></script><link href="/css/b.css">', root);
        assert.match(out, /src="\/js\/a\.js\?v=[0-9a-f]{10}"/);
        assert.match(out, /href="\/css\/b\.css\?v=[0-9a-f]{10}"/);
    });

    it('gives changed content a different URL and identical content the same one', () => {
        const a = contentRoot({ 'js/x.js': 'release one' });
        const b = contentRoot({ 'js/x.js': 'release two' });
        const c = contentRoot({ 'js/x.js': 'release one' });
        const url = (root) => versionAssetUrls('<script src="/js/x.js"></script>', root);
        assert.notStrictEqual(url(a), url(b));
        assert.strictEqual(url(a), url(c));
    });

    it('leaves alone what it cannot or should not version', () => {
        const root = contentRoot({ 'js/a.js': 'one' });
        const untouched = [
            '<script src="/js/missing.js"></script>',            // no such file: bare URL, same 404 as before
            '<script src="/js/a.js?v=manual"></script>',         // already versioned by its author
            '<script src="https://cdn.example/js/a.js"></script>', // another origin
            '<a href="/TDOGE/dispenser/3048">x</a>',             // a page, not an asset
            '<script src="/js/../secret.js"></script>',          // traversal never hashes outside a mount
            '<img src="/images/a.png">',                         // only scripts and stylesheets
            '<link href="/themes/classic/tokens.css">',         // the theme resolver swaps this by exact href
        ];
        for(const html of untouched) assert.strictEqual(versionAssetUrls(html, root), html);
    });

    it('versions every script and stylesheet the shipped template loads from a mount', () => {
        const tpl = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'content', 'html', 'template.html'), 'utf8');
        const out = versionAssetUrls(tpl);
        const bare = out.match(/(src|href)="\/(js|css|components|charts)\/[^"?]+\.(js|css)"/g) || [];
        assert.deepStrictEqual(bare, [], 'template assets left unversioned (missing files?)');
    });

});
