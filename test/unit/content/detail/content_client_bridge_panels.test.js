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

const { srcText } = require('../../../helpers/source_text');

const assert = require('node:assert/strict');
const fs     = require('fs');
const path   = require('path');
const { JSDOM } = require('jsdom');
// The page loads network_coin.js ahead of every link builder (networkCoin).
const NETWORK_COIN_SRC = require('../../../helpers/content-source.js').networkCoinSource();

const SRC_DIR    = path.resolve(__dirname, '..', '..', '../../src/content');
const XCHAIN_SRC = srcText('src/content/js/xchain.js')
    + '\n' + fs.readFileSync(path.join(SRC_DIR, 'js/formatters.js'), 'utf8');
const RENDER_SRC = fs.readFileSync(path.join(SRC_DIR, 'js/xbridge_panels_render.js'), 'utf8');
const PAGE_HTML  = fs.readFileSync(path.join(SRC_DIR, 'html/token.html'), 'utf8');
const JQUERY_SRC = fs.readFileSync(path.join(SRC_DIR, 'js/jquery.min.js'), 'utf8');
const CLASSIC    = fs.readFileSync(path.join(SRC_DIR, 'themes/classic/tokens.css'), 'utf8');
const SKIN       = fs.readFileSync(path.join(SRC_DIR, 'themes/skin-demo/tokens.css'), 'utf8');

// Lift one named function out of a source file by brace matching, so the test
// drives the SHIPPED body instead of a copy of it.
function extractFn(src, name) {
    const sig = 'function ' + name + '(';
    const start = src.indexOf(sig);
    if (start < 0) throw new Error('function not found: ' + name);
    const braceStart = src.indexOf('{', start);
    let depth = 0, i = braceStart;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

// The page fragment's markup with every <script> removed; the scripts are
// eval'd by hand so JSDOM never fetches /js/*.
function pageMarkup() {
    return PAGE_HTML.replace(/<script[\s\S]*?<\/script>/g, '');
}

function makeWindow() {
    const dom = new JSDOM('<!DOCTYPE html><body>' + pageMarkup() + '</body>', { runScripts: 'outside-only' });
    dom.window.eval(JQUERY_SRC);
    dom.window.eval(extractFn(XCHAIN_SRC, 'isNull'));
    dom.window.eval(NETWORK_COIN_SRC);
    dom.window.eval(RENDER_SRC);
    dom.window.XC = { coin: 'DOGE', name: 'Dogecoin', network: 'regtest', query: 'BTC.FUFU',
                      status: { available: { BTC: {}, DOGE: {}, LTC: {} } } };
    // Only loadBridgePanels is lifted out of the page's inline block: the rest of
    // that block is the page's own document-ready wiring (icons, panels, action
    // listeners), which has nothing to do with the bridge surfaces.
    dom.window.eval(extractFn(PAGE_HTML, 'loadBridgePanels'));
    return dom.window;
}

// A getbridgeinvariant payload: tick -> chain -> entry.
const INVARIANT = {
    'BTC.FUFU': {
        BTC:  { escrow: '5.00000000', supply: '0.00000000', in_flight: 0, delta: '0.00000000', finalized_policy_seq: 2 },
        DOGE: { escrow: '0.00000000', supply: '5.00000000', in_flight: 0, delta: '0.00000000', finalized_policy_seq: 2 }
    }
};

describe('explorer bridge panels: per-chain copies from getbridgeinvariant @regression', function () {

    it('separates "the hub did not answer" from "the hub answered with no copies"', function () {
        const w = makeWindow();
        assert.equal(w.buildBridgeCopies(null, 'FUFU').state, 'unavailable');
        assert.equal(w.buildBridgeCopies(undefined, 'FUFU').state, 'unavailable');
        // A real payload that simply carries no chain for this tick.
        assert.equal(w.buildBridgeCopies({}, 'FUFU').state, 'none');
        assert.equal(w.buildBridgeCopies({ 'BTC.OTHER': { BTC: {} } }, 'FUFU').state, 'none');
        assert.equal(w.buildBridgeCopies(INVARIANT, 'BTC.FUFU').state, 'ok');
    });

    it('renders the unavailable state as prose naming this chain, never as an empty table', function () {
        const w    = makeWindow();
        const html = w.renderBridgeCopies(null, 'BTC.FUFU', 'DOGE');
        assert.match(html, /xc-bridge-unavailable/);
        assert.ok(html.includes('DOGE'), 'the unavailable notice must say whose state is being shown');
        assert.ok(!/<table/.test(html), 'an unreachable hub must not render a copies table at all');
    });

    it('orders chains deterministically, so two readers of one token see one order', function () {
        const w    = makeWindow();
        const rows = w.buildBridgeCopies(INVARIANT, 'BTC.FUFU').rows.map(r => r.chain);
        // join() rather than deepEqual: the array is built inside the JSDOM realm,
        // so its Array prototype is not this realm's and a strict deep-equal
        // compares prototypes before values.
        assert.equal(rows.join(','), 'BTC,DOGE');
    });

});

describe('explorer bridge panels: per-chain copies from getbridgeinvariant @regression', function () {

    it('reads the SIGNED delta: negative is the deficit alarm, positive only a surplus', function () {
        const w = makeWindow();
        assert.equal(w.bridgeDeltaState('-1.00000000'), 'deficit');
        assert.equal(w.bridgeDeltaState('1.00000000'), 'surplus');
        assert.equal(w.bridgeDeltaState('0'), 'ok');
        // An absent or unparseable number must NOT paint the healthy badge.
        assert.equal(w.bridgeDeltaState(null), 'unknown');
        assert.equal(w.bridgeDeltaState(''), 'unknown');
        assert.equal(w.bridgeDeltaState('not-a-number'), 'unknown');
    });

    it('paints surplus and deficit with DIFFERENT badges in the rendered table', function () {
        const w = makeWindow();
        const payload = { FOO: { BTC: { delta: '1' }, DOGE: { delta: '-1' } } };
        const $ = w.$;
        const el = $('<div>').html(w.renderBridgeCopies(payload, 'FOO', 'DOGE'));
        assert.equal(el.find('tr[data-chain="BTC"]').attr('data-state'), 'surplus');
        assert.equal(el.find('tr[data-chain="DOGE"]').attr('data-state'), 'deficit');
        assert.equal(el.find('tr[data-chain="BTC"] .xc-bridge-state').hasClass('xc-bridge-state-surplus'), true);
        assert.equal(el.find('tr[data-chain="DOGE"] .xc-bridge-state').hasClass('xc-bridge-state-deficit'), true);
    });

    it('marks the row for the chain this page is served for', function () {
        const w  = makeWindow();
        const $  = w.$;
        const el = $('<div>').html(w.renderBridgeCopies(INVARIANT, 'BTC.FUFU', 'DOGE'));
        assert.equal(el.find('tr[data-chain="DOGE"]').hasClass('xc-bridge-this-chain'), true);
        assert.equal(el.find('tr[data-chain="BTC"]').hasClass('xc-bridge-this-chain'), false);
    });

    it('escapes a hostile chain name out of the hub payload', function () {
        const w    = makeWindow();
        const html = w.renderBridgeCopies({ FOO: { '<img src=x onerror=alert(1)>': { delta: '0' } } }, 'FOO', 'DOGE');
        assert.ok(!html.includes('<img'), 'a hub-supplied chain name reached the DOM unescaped');
    });
});

describe('explorer bridge panels: origin badge for a bridged copy @regression', function () {

    it('splits a rooted tick only when the prefix is a known coin', function () {
        const w = makeWindow();
        const coins = ['BTC', 'DOGE', 'LTC'];
        assert.equal(JSON.stringify(w.bridgeOriginOf('BTC.FUFU', coins)), JSON.stringify({ origin: 'BTC', name: 'FUFU' }));
        // An ordinary subasset is NOT a bridged copy: its prefix is a tick.
        assert.equal(w.bridgeOriginOf('PEPECASH.CARD', coins), null);
        // A native, unrooted tick.
        assert.equal(w.bridgeOriginOf('FUFU', coins), null);
        // More than one dot is not the milestone-1 bridged form.
        assert.equal(w.bridgeOriginOf('BTC.FUFU.CARD', coins), null);
        assert.equal(w.bridgeOriginOf(null, coins), null);
    });

    it('links the origin badge at the token page on the ORIGIN chain', function () {
        const w    = makeWindow();
        const html = w.renderBridgeOrigin('BTC.FUFU', ['BTC', 'DOGE']);
        assert.match(html, /href="\/BTC\/token\/BTC\.FUFU"/);
        assert.match(html, /xc-bridge-origin/);
    });

    it('keeps the origin link on the page network, never the bare mainnet /BTC/', function () {
        const w = makeWindow();
        w.XC.coin = 'TDOGE';
        assert.match(w.renderBridgeOrigin('BTC.FUFU', ['BTC', 'DOGE']), /href="\/TBTC\/token\/BTC\.FUFU"/);
        w.XC.coin = 'RDOGE';
        assert.match(w.renderBridgeOrigin('BTC.FUFU', ['BTC', 'DOGE']), /href="\/RBTC\/token\/BTC\.FUFU"/);
    });

    it('renders no badge at all for a native row', function () {
        const w = makeWindow();
        assert.equal(w.renderBridgeOrigin('FUFU', ['BTC', 'DOGE']), '');
    });
});

describe('explorer bridge panels: inherited policy (policy spec section 10) @regression', function () {

    it('says so plainly when no snapshot has been applied yet', function () {
        const w    = makeWindow();
        const html = w.renderBridgePolicy(null);
        assert.match(html, /xc-bridge-policy-none/);
        assert.ok(!/<table/.test(html));
    });

    it('shows the applied seq and the origin block it was read at', function () {
        const w  = makeWindow();
        const $  = w.$;
        const el = $('<div>').html(w.renderBridgePolicy({
            policy_seq: 2, origin_block: 861234, policy_hash: 'ab'.repeat(32),
            allow_list_action_index: null, block_list_action_index: 991, sleeping: 0
        }));
        const text = el.text();
        assert.ok(text.includes('2'),      'the applied seq must be on the panel');
        assert.ok(text.includes('861234'), 'the origin block the policy was read at must be on the panel');
        assert.ok(text.includes('991'),    'the materialized block list must be reachable');
        assert.ok(text.includes('no'),     'sleeping 0 must read as a word, not as a raw 0');
    });

    it('renders sleeping 1 as yes, so a sleeping copy is not read as awake', function () {
        const w = makeWindow();
        assert.ok(w.renderBridgePolicy({ sleeping: 1 }).includes('yes'));
    });
});

describe('explorer bridge panels: transfer list, both legs on one row @regression', function () {

    const TRANSFERS = [
        { transfer_id: 'a'.repeat(64), src_chain: 'BTC', src_address: 'bc1qsrc', dest_chain: 'DOGE',
          dest_address: 'Ddest', amount: '5.00000000', snapshot_block: 101, status: 'finalized' },
        { transfer_id: 'b'.repeat(64), src_chain: 'DOGE', src_address: 'Dsrc', dest_chain: 'BTC',
          dest_address: 'bc1qdest', amount: '2.00000000', snapshot_block: 104, status: 'retracted' }
    ];

    it('renders ONE row per transfer carrying both legs', function () {
        const w  = makeWindow();
        const $  = w.$;
        const el = $('<div>').html(w.renderBridgeTransfers(TRANSFERS, 'DOGE'));
        assert.equal(el.find('tbody tr').length, 2, 'a transfer is one signed record, not two rows');
        const first = el.find('tr[data-transfer="' + 'a'.repeat(64) + '"]').text();
        assert.ok(first.includes('bc1qsrc'), 'the source leg must be on the row');
        assert.ok(first.includes('Ddest'),   'the destination leg must be on the same row');
    });

    it('derives direction from src_chain rather than reading a column that does not exist', function () {
        const w  = makeWindow();
        const $  = w.$;
        const el = $('<div>').html(w.renderBridgeTransfers(TRANSFERS, 'DOGE'));
        assert.equal(el.find('tr[data-transfer="' + 'a'.repeat(64) + '"]').attr('data-direction'), 'in');
        assert.equal(el.find('tr[data-transfer="' + 'b'.repeat(64) + '"]').attr('data-direction'), 'out');
    });

    it('keeps a RETRACTED transfer visible and badges it as the alarm state', function () {
        const w  = makeWindow();
        const $  = w.$;
        const el = $('<div>').html(w.renderBridgeTransfers(TRANSFERS, 'DOGE'));
        const row = el.find('tr[data-status="retracted"]');
        assert.equal(row.length, 1, 'a retracted transfer must stay on the page: it is the evidence');
        assert.equal(row.find('.xc-bridge-state').hasClass('xc-bridge-state-deficit'), true);
    });

    it('separates an unavailable list from an empty one', function () {
        const w = makeWindow();
        assert.match(w.renderBridgeTransfers(null, 'DOGE'), /xc-bridge-transfers-unavailable/);
        assert.match(w.renderBridgeTransfers([], 'DOGE'), /xc-bridge-transfers-none/);
    });

    it('escapes a hostile destination address', function () {
        const w = makeWindow();
        const html = w.renderBridgeTransfers(
            [{ transfer_id: 'c', src_chain: 'BTC', dest_chain: 'DOGE', dest_address: '<script>x</script>',
               amount: '1', snapshot_block: 1, status: 'finalized' }], 'DOGE');
        assert.ok(!html.includes('<script>x'), 'an address reached the DOM unescaped');
    });
});

describe('explorer bridge panels: the XBRIDGE action card, v0 to v5 @regression', function () {

    it('names all six versions and marks v2/v5 as mirror-injected', function () {
        const w = makeWindow();
        for (const v of [0, 1, 2, 3, 4, 5])
            assert.ok(w.xbridgeVersionInfo(v), 'version ' + v + ' has no card mapping');
        assert.equal(w.xbridgeVersionInfo(2).injected, true);
        assert.equal(w.xbridgeVersionInfo(5).injected, true);
        for (const v of [0, 1, 3, 4])
            assert.equal(w.xbridgeVersionInfo(v).injected, false, 'v' + v + ' is user-broadcast');
    });

    it('maps the leg and the asset the way the two specs split them', function () {
        const w = makeWindow();
        // Base spec: v0 lock, v1 burn, v2 settle, all of the GAS token.
        assert.deepEqual([w.xbridgeVersionInfo(0).leg, w.xbridgeVersionInfo(1).leg, w.xbridgeVersionInfo(2).leg],
            ['lock', 'burn', 'settle']);
        assert.equal(w.xbridgeVersionInfo(0).asset, 'gas');
        // Token spec: v3 lock, v4 burn, v5 settle, of an arbitrary token.
        assert.deepEqual([w.xbridgeVersionInfo(3).leg, w.xbridgeVersionInfo(4).leg, w.xbridgeVersionInfo(5).leg],
            ['lock', 'burn', 'settle']);
        assert.equal(w.xbridgeVersionInfo(3).asset, 'token');
    });

    it('refuses to invent a card for an unknown version', function () {
        const w = makeWindow();
        assert.equal(w.xbridgeVersionInfo(9), null);
        assert.equal(w.xbridgeVersionInfo(null), null);
        assert.match(w.renderXbridgeAction({ action_format: 9 }), /xc-bridge-unknown-version/);
    });

    it('reads a user leg with no local settlement as IN FLIGHT, not as missing', function () {
        const w = makeWindow();
        // A BTC v0 lock settles on DOGE, so the BTC node holds no settlement row
        // for it by construction. That is the in-flight state.
        const html = w.renderXbridgeAction({ action_format: 0, bridge_settlement: null, bridge_pending: true });
        assert.ok(html.includes('in flight'), 'an unsettled user leg must read as in flight');
    });

    it('renders the injected leg against its bridge_settlements row', function () {
        const w  = makeWindow();
        const $  = w.$;
        const el = $('<div>').html(w.renderXbridgeAction({
            action_format: 5, transfer_id: 'd'.repeat(64), tick: 'BTC.FUFU', bridge_pending: false,
            bridge_settlement: { transfer_id: 'd'.repeat(64), kind: 'transfer', block_index: 77,
                                 src_chain: 'BTC', src_action_index: 42, dest_chain: 'DOGE',
                                 dest_address: 'Ddest', tick: 'BTC.FUFU' }
        }));
        const text = el.text();
        assert.ok(text.includes('BTC.FUFU'), 'the bridged tick must be on the card');
        assert.ok(text.includes('42'),       'the source leg it closes must be on the card');
        assert.ok(text.includes('Ddest'),    'the destination credited must be on the card');
        assert.equal(el.find('table').attr('data-injected'), '1');
    });
});

module.exports = { makeWindow, INVARIANT, CLASSIC, SKIN, PAGE_HTML };
require('./content_client_bridge_panels.test/support/wiring.js');
require('./content_client_bridge_panels.test/support/theme_tokens.js');
