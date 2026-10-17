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
 * The token page asks for per-chain bridge totals only for a bridged token:
 * a rooted copy, or a native row whose `bridged` bit is set. Every other
 * token sends no request and keeps the copies card hidden, and a route answer
 * of `available: false` reads as "could not ask", never as "no copies".
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const render = require('../../../../../src/content/js/xbridge_panels_render.js');
const { makeWindow, INVARIANT } = require('./content_client_bridge_panels.test.js');

// Answer every $.getJSON from a per-URL script; an unscripted URL fails.
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

const asksInvariant = seen => seen.some(u => u.indexOf('/api/bridge-invariant/') !== -1);

describe('explorer bridge panels: invariant gate', function () {
    it('asks for the invariant for a rooted copy and for a native row with the bridged bit', function () {
        const copy = makeWindow();
        const seenCopy = drive(copy, {});
        copy.loadBridgePanels('BTC.FUFU');
        assert.equal(asksInvariant(seenCopy), true);
        for (const bit of [1, '1', true]) {
            const w = makeWindow();
            const seen = drive(w, {});
            w.loadBridgePanels('FUFU', { bridged: bit });
            assert.equal(asksInvariant(seen), true, String(bit));
        }
    });

    it('never asks for an unbridged native row, one with no bridge columns, or a dotted native tick', function () {
        for (const [tick, info] of [['XCHAIN', { bridged: 0, bridge_chains: null }],
            ['ZZZZZZZZZZZZ', { tick: 'ZZZZZZZZZZZZ' }], ['PEPECASH.CARD', undefined]]) {
            const w = makeWindow();
            const seen = drive(w, {});
            w.loadBridgePanels(tick, info);
            assert.equal(asksInvariant(seen), false, tick);
        }
    });

    it('reads an available:false answer as unavailable, never as no copies', function () {
        const built = render.buildBridgeCopies({ available: false, reason: 'HUB_NOT_CONFIGURED' }, 'FUFU');
        assert.equal(built.state, 'unavailable');
        assert.match(render.renderBridgeCopies({ available: false }, 'FUFU', 'BTC'), /xc-bridge-unavailable/);
    });

    it('sends no invariant request for an unbridged token and keeps the card hidden', function () {
        const w = makeWindow();
        w.XC.coin = 'BTC';
        const seen = drive(w, { '/api/bridge-transfers/': { ok: [] } });
        w.loadBridgePanels('XCHAIN', { bridged: 0 });
        assert.equal(asksInvariant(seen), false, seen.join(' '));
        assert.equal(w.$('#token-bridge-card').css('display'), 'none');
    });

    it('requests and renders the invariant for a native row with the bridged bit', function () {
        const w = makeWindow();
        const seen = drive(w, { '/api/bridge-invariant/': { ok: { FUFU: INVARIANT['BTC.FUFU'] } } });
        w.loadBridgePanels('FUFU', { bridged: 1 });
        assert.equal(asksInvariant(seen), true);
        assert.match(w.$('#token-bridge-copies').html(), /xc-bridge-copies/);
    });

    it('shows the unavailable notice on a bridged token when the route could not ask', function () {
        const w = makeWindow();
        drive(w, { '/api/bridge-invariant/': { ok: { available: false, reason: 'HUB_METHOD_MISSING' } } });
        w.loadBridgePanels('BTC.FUFU');
        assert.equal(w.$('#token-bridge-card').css('display') === 'none', false);
        assert.match(w.$('#token-bridge-copies').html(), /xc-bridge-unavailable/);
    });
});
