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
 * The bridge panel renderer driven as a node module, function by function.
 * The jsdom harness (content-client-bridge-panels.test.js) proves the page
 * wiring; this file pins each renderer's own contract on plain inputs.
 ********************************************************************/

'use strict';

const assert = require('node:assert/strict');
const R = require('../../../../src/content/js/xbridge_panels_render.js');

describe('xbridge-panels-render as a module', function(){

    it('escapes every HTML-significant character and renders null as empty', function(){
        assert.equal(R.xbEsc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
        assert.equal(R.xbEsc(null), '');
        assert.equal(R.xbEsc(undefined), '');
        assert.equal(R.xbDash(''), '-');
        assert.equal(R.xbDash(0), 0);
    });

    it('splits a rooted tick only when the prefix is a known coin', function(){
        assert.deepEqual(R.bridgeOriginOf('btc.PEPECASH', ['BTC', 'DOGE']), { origin: 'BTC', name: 'PEPECASH' });
        assert.equal(R.bridgeOriginOf('PEPECASH.CARD', ['BTC', 'DOGE']), null);
        assert.equal(R.bridgeOriginOf('BTC.', ['BTC']), null);
        assert.equal(R.bridgeOriginOf('A.B.C', ['A']), null);
        assert.equal(R.bridgeOriginOf(null, ['BTC']), null);
    });

    it('classifies an invariant delta and keeps a malformed one unknown', function(){
        assert.equal(R.bridgeDeltaState('-1'), 'deficit');
        assert.equal(R.bridgeDeltaState('0.5'), 'surplus');
        assert.equal(R.bridgeDeltaState(0), 'ok');
        assert.equal(R.bridgeDeltaState('abc'), 'unknown');
        assert.equal(R.bridgeDeltaState(null), 'unknown');
    });

    it('builds per-chain rows sorted by chain and names the three payload states', function(){
        assert.deepEqual(R.buildBridgeCopies(null, 'XCHAIN'), { state: 'unavailable', rows: [] });
        assert.deepEqual(R.buildBridgeCopies({}, 'XCHAIN'), { state: 'none', rows: [] });
        assert.deepEqual(R.buildBridgeCopies({ XCHAIN: {} }, 'XCHAIN'), { state: 'none', rows: [] });
        const built = R.buildBridgeCopies({ XCHAIN: { LTC: { escrow: '3', delta: '-1' }, DOGE: { supply: '5', delta: 0 } } }, 'XCHAIN');
        assert.equal(built.state, 'ok');
        assert.deepEqual(built.rows.map(r => r.chain), ['DOGE', 'LTC']);
        assert.equal(built.rows[0].state, 'ok');
        assert.equal(built.rows[0].escrow, null);
        assert.equal(built.rows[1].state, 'deficit');
    });

});

describe('xbridge-panels-render as a module', function(){

    it('renders the copies table with the state badge and marks this chain', function(){
        const html = R.renderBridgeCopies({ XCHAIN: { DOGE: { supply: '5', escrow: '5', in_flight: '0', delta: '0', finalized_policy_seq: 2 } } }, 'XCHAIN', 'DOGE');
        assert.match(html, /data-chain="DOGE" data-state="ok" class="xc-bridge-this-chain"/);
        assert.match(html, /xc-bridge-state-ok">balanced</);
        assert.match(html, /xc-bridge-policy-seq">2</);
        assert.match(R.renderBridgeCopies(null, 'XCHAIN', 'DOGE'), /xc-bridge-unavailable.*showing DOGE state only/);
        assert.match(R.renderBridgeCopies({}, 'XCHAIN', 'DOGE'), /xc-bridge-none/);
    });

    it('renders both legs of a transfer on one row, derives direction, and keeps a retracted row visible', function(){
        const rows = [
            { transfer_id: 't1', src_chain: 'BTC', src_address: 'a', dest_chain: 'DOGE', dest_address: 'b', amount: '5', snapshot_block: 600, status: 'finalized' },
            { transfer_id: 't2', src_chain: 'DOGE', src_address: 'b', dest_chain: 'BTC', dest_address: 'a', amount: '2', snapshot_block: 601, status: 'retracted' }
        ];
        const html = R.renderBridgeTransfers(rows, 'DOGE');
        assert.match(html, /data-transfer="t1" data-direction="in" data-status="finalized"/);
        assert.match(html, /data-transfer="t2" data-direction="out" data-status="retracted" class="xc-bridge-retracted"/);
        assert.match(html, /xc-bridge-state-deficit">retracted</);
        assert.match(R.renderBridgeTransfers(null, 'DOGE'), /xc-bridge-transfers-unavailable/);
        assert.match(R.renderBridgeTransfers([], 'DOGE'), /xc-bridge-transfers-none/);
    });

    it('links a bridged copy to its origin chain page and renders nothing for a plain tick', function(){
        assert.match(R.renderBridgeOrigin('BTC.PEPE', ['BTC']), /href="\/BTC\/token\/BTC\.PEPE">origin BTC</);
        assert.equal(R.renderBridgeOrigin('PEPE', ['BTC']), '');
    });

    it('keeps the origin link on the page network: a testnet copy is /TBTC/, never mainnet /BTC/', function(){
        const had = Object.prototype.hasOwnProperty.call(global, 'XC'), prev = global.XC;
        try {
            global.XC = { coin: 'TDOGE', network: 'testnet' };
            assert.match(R.renderBridgeOrigin('BTC.PEPE', ['BTC']), /href="\/TBTC\/token\/BTC\.PEPE">origin BTC</);
            global.XC = { coin: 'RLTC', network: 'regtest' };
            assert.match(R.renderBridgeOrigin('BTC.PEPE', ['BTC']), /href="\/RBTC\/token\/BTC\.PEPE"/);
        } finally { if(had) global.XC = prev; else delete global.XC; }
    });

});

describe('xbridge-panels-render as a module', function(){

    it('renders the applied policy snapshot and says when none applies', function(){
        assert.match(R.renderBridgePolicy(null), /xc-bridge-policy-none/);
        const html = R.renderBridgePolicy({ policy_seq: 3, origin_block: 610, policy_hash: 'ab', allow_list_action_index: null, block_list_action_index: 7, sleeping: 1 });
        assert.match(html, /<th>Applied seq<\/th><td>3<\/td>/);
        assert.match(html, /<th>Allow list<\/th><td>-<\/td>/);
        assert.match(html, /<th>Sleeping<\/th><td>yes<\/td>/);
        assert.match(R.renderBridgePolicy({ sleeping: 0 }), /<th>Sleeping<\/th><td>no<\/td>/);
    });

    it('names every XBRIDGE version and refuses one it does not know', function(){
        assert.equal(R.xbridgeVersionInfo('2').leg, 'settle');
        assert.equal(R.xbridgeVersionInfo(5).asset, 'token');
        assert.equal(R.xbridgeVersionInfo(9), null);
        assert.equal(R.xbridgeVersionInfo('x'), null);
        assert.equal(R.xbridgeVersionInfo(null), null);
    });

    it('renders the action card for a settled leg, an in-flight lock and an unknown version', function(){
        const settled = R.renderXbridgeAction({ action_format: 2, tick: 'XCHAIN', transfer_id: 't1',
            bridge_settlement: { src_chain: 'BTC', src_action_index: 42, dest_chain: 'DOGE', dest_address: 'b', block_index: 700 } });
        assert.match(settled, /data-leg="settle" data-injected="1"/);
        assert.match(settled, /Mirror-injected from a finalized bridge transfer/);
        assert.match(settled, /xc-bridge-source-leg">BTC #42</);
        assert.match(settled, /xc-bridge-settled-in-block">700</);
        const pending = R.renderXbridgeAction({ action_format: 0, tick: 'XCHAIN', transfer_id: 't1', bridge_pending: true });
        assert.match(pending, /data-leg="lock" data-injected="0"/);
        assert.match(pending, /in flight/);
        assert.match(R.renderXbridgeAction({ action_format: 7 }), /xc-bridge-unknown-version/);
        assert.match(R.renderXbridgeAction(null), /xc-bridge-unknown-version/);
    });

    it('renders a source leg own record: destination, decimals, min depth and memo', function(){
        const html = R.renderXbridgeAction({ action_format: 0, tick: 'XCHAIN', bridge_pending: true,
            dest_chain: 'DOGE', dest_address: 'Ddest', decimals: 8, min_depth: 0, memo: 'to <me>', status: 'valid' });
        assert.match(html, /xc-bridge-destination">DOGE Ddest</);
        assert.match(html, /xc-bridge-decimals">8</);
        assert.match(html, /xc-bridge-min-depth">platform default</, '0 is the unset depth');
        assert.match(html, /xc-bridge-memo">to &lt;me&gt;</, 'the memo is escaped');
        assert.match(html, /in flight/, 'the settle is still on the other chain');
        assert.match(R.renderXbridgeAction({ action_format: 3, min_depth: 6 }), /xc-bridge-min-depth">6</);
    });

    it('renders no record rows the node never read, and no in-flight badge for a refused leg', function(){
        const bare = R.renderXbridgeAction({ action_format: 0, tick: 'XCHAIN', bridge_pending: true });
        assert.doesNotMatch(bare, /xc-bridge-(destination|decimals|min-depth|memo)/);
        const refused = R.renderXbridgeAction({ action_format: 0, bridge_pending: true, status: 'invalid: insufficient funds' });
        assert.doesNotMatch(refused, /in flight/);
        assert.match(refused, /the action was refused/);
    });
});
