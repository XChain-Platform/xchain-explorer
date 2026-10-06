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
 * Explorer bridge surfaces (xchain-bridge.md section 13 / row 9,
 * xchain-token-bridge.md section 9 / row 8, policy spec section 10 / row 7).
 *
 * Drives the SHIPPED derivation and render in
 * src/content/js/xbridge_panels_render.js and the SHIPPED loadBridgePanels()
 * out of src/content/html/token.html, in the JSDOM-eval harness
 * content-client-xcall-timeline.test.js established.
 *
 * WHAT THIS PROTECTS, and why each case is here rather than eyeballed:
 *
 *  1. The explorer is PER-COIN ROUTED. A BTC node cannot read the DOGE ledger,
 *     so a bridged token's per-chain supply is not a query it can make: the
 *     numbers come from the hub's getbridgeinvariant, and the hub can be down,
 *     can serve a tick it never signed a transfer for, or can answer an error
 *     body. All three reach a naive renderer as "no rows", i.e. exactly like a
 *     token with no bridged copies. Telling a holder their bridged supply does
 *     not exist when the truth is "we could not ask" is the failure the
 *     unavailable / none split exists to prevent, so both states are pinned.
 *  2. The invariant is escrow >= supply, NEVER equality (nothing refuses a
 *     stranger's SEND to the escrow role address), so the delta is SIGNED:
 *     positive is a surplus and a warning, negative is a deficit and the alarm
 *     (base spec D65, AT6). A renderer that read |delta| would paint the alarm
 *     on a harmless surplus and, worse, the same badge on both.
 *  3. A transfer is ONE signed record with both legs on it and its direction
 *     DERIVED from src_chain, never stored (seam section 3). Two rows per
 *     transfer would invent a pairing the record does not carry.
 *  4. Every badge colour is an --xc-bridge-* token in BOTH theme files (D30):
 *     a literal is a colour a skin cannot reach.
 ********************************************************************/


'use strict';

const assert = require('node:assert/strict');
const { makeWindow, INVARIANT } = require('../../content_client_bridge_panels.test.js');

// Stub $.getJSON with a per-URL script: `ok` bodies answer the success
// handler, `fail` answers .fail(). Returns the jqXHR-shaped object the page
// chains .fail() onto.
function drive(w, script) {
    const seen = [];
    w.$.getJSON = function (url, cb) {
        seen.push(url);
        const hit = Object.keys(script).find(k => url.indexOf(k) !== -1);
        const entry = hit ? script[hit] : { fail: true };
        if (!entry.fail && typeof cb === 'function') cb(entry.ok);
        return { fail: function (f) { if (entry.fail) f(); return this; } };
    };
    return seen;
}

describe('explorer bridge panels: token.html wiring degrades honestly @regression', function () {
    it('shows the copies card with the UNAVAILABLE notice when the hub read fails', function () {
        const w = makeWindow();
        drive(w, {});   // every read fails
        w.loadBridgePanels('BTC.FUFU');
        assert.equal(w.$('#token-bridge-card').css('display') === 'none', false,
            'the card must be shown, so the reader is told the hub is unreachable');
        assert.match(w.$('#token-bridge-copies').html(), /xc-bridge-unavailable/);
    });

    it('treats an error BODY as unavailable too, not as an empty copy set', function () {
        const w = makeWindow();
        drive(w, { '/api/bridge-invariant/': { ok: { error: 'hub unreachable' } } });
        w.loadBridgePanels('BTC.FUFU');
        assert.match(w.$('#token-bridge-copies').html(), /xc-bridge-unavailable/);
    });

    it('renders the per-chain table when the hub answers', function () {
        const w = makeWindow();
        drive(w, { '/api/bridge-invariant/': { ok: INVARIANT } });
        w.loadBridgePanels('BTC.FUFU');
        const html = w.$('#token-bridge-copies').html();
        assert.match(html, /xc-bridge-copies/);
        assert.ok(html.includes('DOGE'));
    });
});

describe('explorer bridge panels: token.html wiring degrades honestly @regression', function () {
    it('renders the origin badge from network-qualified served coins', function () {
        for (const [page, origin] of [['TDOGE', 'TBTC'], ['RDOGE', 'RBTC']]) {
            const w = makeWindow();
            w.XC.coin = page;
            w.XC.status.available = { [page]: {}, [origin]: {} };
            drive(w, {});
            w.loadBridgePanels('BTC.PEPE');
            assert.equal(w.$('#token-bridge-origin a').attr('href'), '/' + origin + '/token/BTC.PEPE');
        }
    });

    it('asks for the inherited policy on a BRIDGED row only', function () {
        const bridged = makeWindow();
        const seenB   = drive(bridged, {});
        bridged.loadBridgePanels('BTC.FUFU');
        assert.ok(seenB.some(u => u.indexOf('/api/applied-policy/') !== -1),
            'a bridged copy inherits its policy, so the panel must be requested');
        assert.equal(bridged.$('#token-bridge-policy-card').css('display') === 'none', false);

        const native = makeWindow();
        const seenN  = drive(native, {});
        native.loadBridgePanels('FUFU');
        assert.ok(!seenN.some(u => u.indexOf('/api/applied-policy/') !== -1),
            'a native row owns its own lists and must not claim an inherited policy');
        assert.equal(native.$('#token-bridge-policy-card').css('display'), 'none');
    });

    it('URL-encodes the rooted tick rather than pasting a dot-path into the URL', function () {
        const w    = makeWindow();
        const seen = drive(w, {});
        w.loadBridgePanels('BTC.FU/FU');
        assert.ok(seen.every(u => u.indexOf('FU/FU') === -1), 'the tick was not encoded: ' + seen.join(' '));
    });

    it('does nothing at all without a tick', function () {
        const w    = makeWindow();
        const seen = drive(w, {});
        w.loadBridgePanels(null);
        assert.deepEqual(seen, []);
    });
});
