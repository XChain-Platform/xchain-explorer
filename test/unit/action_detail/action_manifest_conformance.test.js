// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Cross-repo ACTION-manifest conformance guard. Forgetting the explorer detail
// handler for a new action renders its public page blank. The authoritative set
// lives in xchain-documentation/protocol/action-manifest.json (vendored here).
// This guard asserts the registered action-detail handlers equal the manifest's
// explorerRender slice. (The explorer set is the superset: it also renders
// lifecycle + the indexer-renamed order/swap/dispenser cancel+edit views.)

const { srcText } = require('../../helpers/source_text');
const assert = require('assert');
const fs   = require('fs');
const path = require('path');

const VENDORED = path.join(__dirname, '..', '..', 'fixtures', 'action-manifest.json');
const MANIFEST = JSON.parse(fs.readFileSync(VENDORED, 'utf8'));

function decomment(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}
function manifestSlice(flag) {
    return Object.entries(MANIFEST.actions).filter(([, v]) => v[flag]).map(([k]) => k).sort();
}
function localExplorerSet() {
    const { ACTION_TYPES, ACTION_DETAIL_ONLY_TYPES } = require('../../../src/action-detail');
    const invalid = ACTION_DETAIL_ONLY_TYPES.filter(name => !ACTION_TYPES.includes(name) ||
        (MANIFEST.actions[name] && MANIFEST.actions[name].explorerRender));
    assert.deepStrictEqual(invalid, [],
        'action-detail-only types must be registered and absent from the public explorerRender manifest slice');
    const detailOnly = new Set(ACTION_DETAIL_ONLY_TYPES);
    return ACTION_TYPES.filter(n => n !== 'UNKNOWN' && !detailOnly.has(n)).sort();
}
// The two CLIENT halves of the render seam. getActionData returning rich data is
// useless if xchain.js has no dispatch branch or action.html no info-* panel:
// the page falls through to '#additionalInfoNotAvailable' and renders blank.
function dispatchSource() { return decomment(srcText('src/content/js/xchain.js')); }
function renderDispatchSet() { return dispatchNamesIn(dispatchSource()); }

// Credit a DISPATCH only: the disclosure renderer in action_markers.js also compares
// `o.action` for SEND, DESTROY, AIRDROP and BATCH, and a bare comparison is not coverage.
// Regexes are built per call (no shared lastIndex); every link of the call chain is required.
const ACTION_IF = 'if\\s*\\(\\s*o\\.action\\s*==\\s*["\']([A-Z_]+)["\']\\s*\\)\\s*\\{\\s*';
function directDispatchRe() { return new RegExp(ACTION_IF + 'found\\s*=\\s*true\\s*;\\s*show[A-Za-z0-9_]+Details\\s*\\(\\s*o\\s*\\)', 'g'); }
function bridgeDispatchRe() { return new RegExp(ACTION_IF + '\\$\\(\\s*["\']#info-[a-z0-9-]+["\']\\s*\\)\\.html\\([^;\\n]*\\)\\s*;\\s*return\\s+true\\s*;', 'g'); }
const ENTRY_CALL  = /\bfound\s*=\s*detailCore_dispatchAction\s*\(\s*o\s*\)/;
const BRIDGE_CALL = /if\s*\(\s*detailCore_dispatchBridgePanel\s*\(\s*o\s*\)\s*\)\s*found\s*=\s*true/;
function dispatchNamesIn(src) {
    if (!ENTRY_CALL.test(src)) return [];
    const names = [...src.matchAll(directDispatchRe())].map(x => x[1]);
    if (BRIDGE_CALL.test(src)) names.push(...[...src.matchAll(bridgeDispatchRe())].map(x => x[1]));
    return [...new Set(names)].sort();
}
// Drop every line that dispatches `name`, leaving bare comparisons of it in place.
function withoutDispatchOf(src, name) {
    const hit = (line) => [directDispatchRe(), bridgeDispatchRe()].some(re => [...line.matchAll(re)].some(m => m[1] === name));
    return src.split('\n').filter(line => !hit(line)).join('\n');
}
function panelIdSet() {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'content', 'html', 'action.html'), 'utf8');
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
        const DOCS = process.env.XCHAIN_DOCS_DIR || path.join(__dirname, '..', '..', '..', '..', 'xchain-documentation');
        const CANON = path.join(DOCS, 'protocol', 'action-manifest.json');
        // Refuses an absent docs checkout and a lane symlink into a live main checkout alike.
        const { siblingCheckout, skipOrFail } = require('../../helpers/sibling_checkout.js');
        before(function () { const docs = siblingCheckout(__dirname, CANON); if (!docs.usable) skipOrFail(this, docs, 'the canonical action-manifest.json byte-identity guard'); });
        it('vendored test/fixtures/action-manifest.json is byte-identical to canonical', function () {
            assert.strictEqual(fs.readFileSync(VENDORED, 'utf8'), fs.readFileSync(CANON, 'utf8'),
                'vendored action-manifest.json drifted from canonical; edit ' +
                'xchain-documentation/protocol/action-manifest.json and re-vendor all copies.');
        });
    });
});

describe('ACTION manifest conformance: dispatch extraction credits a dispatch only @regression', function () {
    const ENTRY  = 'var found = detailCore_dispatchAction(o);';
    const BRIDGE = 'if(detailCore_dispatchBridgePanel(o)) found = true;';
    const SEND   = "if(o.action=='SEND'){             found = true;  showSendDetails(o);            }";
    const PANEL  = "if(o.action=='XBRIDGE'){     $('#info-xbridge').html(renderXbridgeAction(o));         return true; }";

    it('a bare comparison of the action name is not coverage', function () {
        const stray = "if(o && o.action=='SEND' && Array.isArray(o.sends)){ render(o); }";
        assert.deepStrictEqual(dispatchNamesIn([ENTRY, stray].join('\n')), []);
        assert.deepStrictEqual(dispatchNamesIn([ENTRY, stray, SEND].join('\n')), ['SEND']);
    });

    it('a bridge panel counts only while the dispatcher calls the bridge helper', function () {
        assert.deepStrictEqual(dispatchNamesIn([ENTRY, PANEL].join('\n')), []);
        assert.deepStrictEqual(dispatchNamesIn([ENTRY, BRIDGE, PANEL].join('\n')), ['XBRIDGE']);
    });

    it('nothing counts once the detail page stops calling the dispatcher', function () {
        assert.deepStrictEqual(dispatchNamesIn([BRIDGE, PANEL, SEND].join('\n')), []);
        const src = dispatchSource();
        assert.ok(ENTRY_CALL.test(src), 'the detail page no longer calls detailCore_dispatchAction');
        assert.deepStrictEqual(dispatchNamesIn(src.replace(ENTRY_CALL, 'found = false')), []);
    });

    it('removing any one dispatch line from the shipped source uncredits that action', function () {
        const src = dispatchSource();
        const all = dispatchNamesIn(src);
        assert.ok(all.length > 0, 'no dispatch line was recognised in the shipped source');
        const stillCredited = all.filter(name => dispatchNamesIn(withoutDispatchOf(src, name)).includes(name));
        assert.deepStrictEqual(stillCredited, [],
            'these actions stay credited with their dispatch line removed, so something other ' +
            'than a dispatch is counted as coverage: ' + JSON.stringify(stillCredited));
    });

    it('removing the bridge helper call from the shipped source uncredits every bridge panel', function () {
        const src = dispatchSource();
        const bridged = [...src.matchAll(bridgeDispatchRe())].map(x => x[1]).sort();
        assert.ok(bridged.length > 0 && BRIDGE_CALL.test(src), 'no bridge panel dispatch was recognised in the shipped source');
        const after = dispatchNamesIn(src.replace(BRIDGE_CALL, ''));
        assert.deepStrictEqual(bridged.filter(name => after.includes(name)), []);
    });
});
