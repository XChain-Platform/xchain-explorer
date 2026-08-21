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

    // The guard is EXHAUSTIVE over the live route table, not an opt-in list. Two
    // older pages (bet_feed, oracle) read XC.query from outside the allowlist and
    // were confirmed dead on arrival; both are in the allowlist now, so
    // there is no gap left to grandfather and no way for a new one to be added quietly.
    // EXEMPT carries the routes that legitimately never read XC.query, each with its
    // reason; anything else that appears in urls.html has to resolve XC.query.
    const EXEMPT = {
        // dispenser.html carries no XC.query reference at all: the server substitutes
        // {QUERY} into the served fragment, so the client never derives the id.
        dispenser: 'server-side {QUERY} substitution; the page reads no XC.query',
        // market is set by its own derivation branch right after this one, because a
        // market URL may omit its counter-tick and needs two path segments joined.
        market: 'derived by the dedicated market branch, deliberately outside the allowlist'
    };
    const COVERED = [...detailRouteTypes()].filter(t => !(t in EXEMPT)).sort();

    it('every exemption still names a live detail route', function () {
        // A stale exemption silently shrinks the guard, which is the failure this file
        // exists to prevent, so the exemptions are pinned to the route table too.
        for (const type of Object.keys(EXEMPT))
            expect(detailRouteTypes().has(type),
                type + ' is exempted here but is no longer a /{QUERY} detail route; drop the exemption').to.equal(true);
    });

    for (const type of COVERED) {
        it('detail route ' + type + ' is in the client allowlist', function () {
            expect(detailRouteTypes().has(type), type + ' detail route missing from urls.html').to.equal(true);
            expect(allowlistedTypes().has(type),
                type + ' is a /{QUERY} detail route but is not in the XC.query allowlist, so the page would fetch /api/' +
                type + '/null and render "not found" on a record that exists').to.equal(true);
        });
    }

    it('numeric-id detail types validate their id', function () {
        // Block heights and action indices belong in the numeric branch; without it a
        // non-numeric segment is passed straight through to the API.
        const inner = CLIENT.match(/if\(\(\[([^\]]*)\]\.includes\(type\) && isNumeric\(query\)\)/);
        expect(inner, 'numeric-id branch not found').to.not.equal(null);
        const numeric = inner[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
        expect(numeric).to.include('checkpoint');
        // poll, anchor, attestation and bet_feed all resolve by action index, so they are
        // numeric too (getBetFeedInfo binds the feed id to m.action_index).
        for (const type of ['poll', 'anchor', 'attestation', 'bet_feed'])
            expect(numeric, type + ' resolves by action index and belongs in the numeric branch').to.include(type);
    });

    it('address-keyed detail types are validated as addresses', function () {
        // oracle is a per-address track record: db.getOracleStats binds the segment to
        // a2.address, and db's id lookup resolves type 'oracle' through index_addresses
        // exactly like 'address', so it shares the isCryptoAddress branch rather than
        // falling through unvalidated.
        const branch = CLIENT.match(/\(\[([^\]]*)\]\.includes\(type\) && isCryptoAddress\(query\)\)/);
        expect(branch, 'no isCryptoAddress branch found for address-keyed detail types').to.not.equal(null);
        const byAddress = branch[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
        expect(byAddress).to.include('address');
        expect(byAddress).to.include('oracle');
    });

    it('non-numeric detail types are validated some other way, not left unchecked', function () {
        // validator (pubkey OR address) and xcall (64-hex call_id) cannot use the
        // numeric check, so they need their own branch. Without one they would fall
        // through with XC.query unset, which is the exact failure this file exists for.
        const branch = CLIENT.match(/\(\[([^\]]*)\]\.includes\(type\) && typeof\(query\)=='string' && query\.length\)/);
        expect(branch, 'no non-numeric validation branch found for pubkey/hash-keyed detail types').to.not.equal(null);
        const nonNumeric = branch[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
        expect(nonNumeric).to.include('validator');
        expect(nonNumeric).to.include('xcall');
    });
});
