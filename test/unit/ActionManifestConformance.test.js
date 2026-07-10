// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Cross-repo ACTION-manifest conformance guard. Forgetting the explorer
// getActionData branch for a new action renders its public page blank. The
// authoritative set lives in xchain-documentation/protocol/action-manifest.json
// (vendored here). This guard asserts the getActionData branches equal the
// manifest's explorerRender slice. (The explorer set is the superset: it also
// renders lifecycle + legacy order/dispenser cancel+edit views.)

const assert = require('assert');
const fs   = require('fs');
const path = require('path');

const VENDORED = path.join(__dirname, '..', 'fixtures', 'action-manifest.json');
const MANIFEST = JSON.parse(fs.readFileSync(VENDORED, 'utf8'));

function decomment(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}
function manifestSlice(flag) {
    return Object.entries(MANIFEST.actions).filter(([, v]) => v[flag]).map(([k]) => k).sort();
}
function localExplorerSet() {
    const src = decomment(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'db.js'), 'utf8'));
    const names = [...new Set([...src.matchAll(/type\s*==\s*["']([A-Z_]+)["']/g)].map(x => x[1]))];
    return names.filter(n => n !== 'UNKNOWN').sort(); // UNKNOWN is the catch-all render, not an action
}
// The two CLIENT halves of the render seam. getActionData returning rich data is
// useless if xchain.js has no dispatch branch or action.html no info-* panel:
// the page falls through to '#additionalInfoNotAvailable' and renders blank.
function renderDispatchSet() {
    const src = decomment(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'content', 'js', 'xchain.js'), 'utf8'));
    return [...new Set([...src.matchAll(/o\.action\s*==\s*["']([A-Z_]+)["']/g)].map(x => x[1]))].sort();
}
function panelIdSet() {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'content', 'html', 'action.html'), 'utf8');
    return [...new Set([...html.matchAll(/id="info-([a-z0-9-]+)"/g)].map(x => x[1]))].sort();
}
const panelSlug = (action) => action.replace(/_/g, '-').toLowerCase();

describe('ACTION manifest conformance: explorer explorerRender set @regression', function () {
    it('getActionData branches exactly equal the manifest explorerRender slice', function () {
        const expected = manifestSlice('explorerRender');
        const actual   = localExplorerSet();
        const missing = expected.filter(a => !actual.includes(a)); // manifest says render, explorer forgot -> blank page
        const extra   = actual.filter(a => !expected.includes(a));  // explorer renders, manifest unaware
        assert.deepStrictEqual({ missing, extra }, { missing: [], extra: [] },
            'explorer getActionData drifted from action-manifest.json explorerRender set. ' +
            'MISSING (in manifest, no render branch -> blank public page): ' + JSON.stringify(missing) +
            '. EXTRA (rendered, not in manifest): ' + JSON.stringify(extra) +
            '. Edit xchain-documentation/protocol/action-manifest.json + re-vendor, or add the getActionData branch.');
    });

    it('every explorerRender action has a showActionDetails dispatch branch in xchain.js', function () {
        const expected = manifestSlice('explorerRender');
        const dispatch = renderDispatchSet();
        const missing  = expected.filter(a => !dispatch.includes(a));
        assert.deepStrictEqual(missing, [],
            'action(s) marked explorerRender have a getActionData branch but NO client render ' +
            'dispatch (showActionDetails in src/content/js/xchain.js), so their detail pages fall ' +
            'through to "No additional information is available": ' + JSON.stringify(missing));
    });

    it('every explorerRender action has a matching info-* panel in action.html', function () {
        const expected = manifestSlice('explorerRender');
        const panels   = panelIdSet();
        const missing  = expected.filter(a => !panels.includes(panelSlug(a)));
        assert.deepStrictEqual(missing, [],
            'action(s) marked explorerRender have no #info-<slug> panel in ' +
            'src/content/html/action.html, so showActionDetails un-hides a nonexistent element ' +
            'and the page stays blank: ' + JSON.stringify(missing));
    });

    it('every render-dispatch branch has a matching info-* panel (no dangling dispatch)', function () {
        const dispatch = renderDispatchSet();
        const panels   = panelIdSet();
        const missing  = dispatch.filter(a => !panels.includes(panelSlug(a)));
        assert.deepStrictEqual(missing, [],
            'showActionDetails dispatches these actions but action.html has no matching ' +
            '#info-<slug> panel to un-hide: ' + JSON.stringify(missing));
    });

    describe('byte-identity to canonical manifest', function () {
        const DOCS = process.env.XCHAIN_DOCS_DIR || path.join(__dirname, '..', '..', '..', 'xchain-documentation');
        const CANON = path.join(DOCS, 'protocol', 'action-manifest.json');
        before(function () { if (!fs.existsSync(CANON)) this.skip(); });
        it('vendored test/fixtures/action-manifest.json is byte-identical to canonical', function () {
            assert.strictEqual(fs.readFileSync(VENDORED, 'utf8'), fs.readFileSync(CANON, 'utf8'),
                'vendored action-manifest.json drifted from canonical; edit ' +
                'xchain-documentation/protocol/action-manifest.json and re-vendor all copies.');
        });
    });
});
