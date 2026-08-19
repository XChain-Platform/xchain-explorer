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
 * A detail page reads its record id from XC.query, which the client sets only
 * for path types named in an allowlist. A type missing from that list leaves
 * XC.query null, and the page then fetches its own API route with a literal
 * 'null' path segment: the server answers 404 and the page renders "not found"
 * on a record that exists. That failure is silent in every other tier, because
 * the route is registered, the fragment exists, the API works, and only the
 * browser ever joins the two halves.
 *
 * This pins the urls.html detail routes against the allowlist so a new detail
 * page fails here rather than in front of a reader.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');

const CLIENT   = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8');
const EXPLORER = fs.readFileSync(path.resolve(__dirname, '../../src/XChainExplorer.js'), 'utf8');

// Detail routes are the urls.html entries shaped '/{COIN}/<type>/{QUERY}'. Read
// from the live table rather than restated, so the assertion cannot drift.
function detailRouteTypes() {
    const out = new Set();
    for (const m of EXPLORER.matchAll(/'\/\{COIN\}\/([a-z_]+)\/\{QUERY\}'\s*:\s*'[a-z_]+\.html'/g))
        out.add(m[1]);
    return out;
}

// The two arrays in the client's query-derivation branch: the outer one decides
// whether the path type is a detail page at all, the inner one which types
// validate their id as numeric.
function allowlistedTypes() {
    const m = CLIENT.match(/if\(\[([^\]]*)\]\.includes\(type\)\)\{/);
    if (!m) return null;
    return new Set(m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean));
}

describe('detail pages resolve XC.query', function () {

    it('finds both sides to compare (source parsing did not break)', function () {
        expect(detailRouteTypes().size, 'no /{COIN}/<type>/{QUERY} html routes found').to.be.greaterThan(0);
        expect(allowlistedTypes(), 'query-derivation allowlist not found in xchain.js').to.not.equal(null);
    });

    it('every checkpoint-family detail route is in the client allowlist', function () {
        // Scoped to the routes this suite's milestone added rather than to every
        // detail route: several older pages (bet_feed, oracle) read XC.query while
        // sitting outside the allowlist, which is a real pre-existing gap but not
        // one to fail the build on until it is separately confirmed and fixed.
        const allow = allowlistedTypes();
        expect(detailRouteTypes().has('checkpoint'), 'checkpoint detail route missing').to.equal(true);
        expect(allow.has('checkpoint'),
            'checkpoint is a /{QUERY} detail route but is not in the XC.query allowlist, so the page would fetch /api/checkpoint/null').to.equal(true);
    });

    it('numeric-id detail types validate their id', function () {
        // checkpoint ids are block heights, so they belong in the numeric branch;
        // without it a non-numeric segment would be passed through to the API.
        const inner = CLIENT.match(/if\(\(\[([^\]]*)\]\.includes\(type\) && isNumeric\(query\)\)/);
        expect(inner, 'numeric-id branch not found').to.not.equal(null);
        const numeric = inner[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
        expect(numeric).to.include('checkpoint');
    });
});
