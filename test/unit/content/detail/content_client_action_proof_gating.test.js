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
 * The action page offered its "Request Proof" button for every action, but an
 * action proof binds to the signed block_merkle_root of the action's OWN block
 * and that root is per-block with no cumulative accumulator, so only a
 * checkpointed block can be proven. Checkpoints are cut every 6 blocks.
 *
 * Measured on TBTC while this was found: of the 18 distinct blocks carrying the
 * 38 most recent actions, exactly ONE (150208) was checkpointed. So the button
 * spent a rate-limited proof request to return 409 ACTION_BLOCK_NOT_CHECKPOINTED
 * for essentially every action a reader clicked, which reads as a broken feature
 * rather than as a property of the rail.
 *
 * The wiring is extracted from the SHIPPED action.html rather than a fixture, so
 * a rename in the page fails here instead of silently un-gating the button again.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT = path.resolve(__dirname, '../../src/content');
// The shipped client source, from the shared helper: the cell-rendering
// helpers (isNull, escapeHtml, formatAmount, formatLink and friends) moved
// out of xchain.js into formatters.js in the component milestone, and this
// suite needs whichever of the two a given function landed in.
const CLIENT_SRC  = require('../helpers/content-source.js').clientSource();
const JQUERY  = path.join(CONTENT, 'js', 'jquery.min.js');
const PAGE    = fs.readFileSync(path.join(CONTENT, 'html', 'action.html'), 'utf8');

// Slice a top-level function out of the page's inline script by walking braces,
// the same technique the sibling content-client tests use against xchain.js.
function extractFn(name){
    const sig = 'function ' + name + '(';
    const start = PAGE.indexOf(sig);
    if(start < 0) throw new Error('function not found in action.html: ' + name);
    const braceStart = PAGE.indexOf('{', start);
    let depth = 0, i = braceStart;
    for(; i < PAGE.length; i++){
        const c = PAGE[i];
        if(c === '{') depth++;
        else if(c === '}'){ depth--; if(depth === 0){ i++; break; } }
    }
    return PAGE.slice(start, i);
}

// checkpointed=true  -> /api/checkpoint/<block> answers 200, a proof is available
// checkpointed=false -> it 404s, which is what roughly five blocks in six do
function bootPage(checkpointed){
    const dom = new JSDOM('<!doctype html><html><body>' + PAGE + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/TBTC/action/39'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = win.XC || {};
    win.XC.coin = 'TBTC';
    win.probed = [];
    win.proofUrls = [];
    win.ok = !!checkpointed;
    // Stand in for the two network calls the wiring can make: the cheap checkpoint
    // probe it now asks first, and the rate-limited proof request a click spends.
    // proofNotice stays the SHIPPED one, so the refusal wording is really rendered.
    win.eval(`
        $.ajax = function(opts){
            probed.push(opts.url);
            return { done: function(cb){ if(ok) cb({}); return this; },
                     fail: function(cb){ if(!ok) cb({ status: 404 }); return this; } };
        };
        window.loadProofWidget  = function(url){ proofUrls.push(url); };
        window.renderActionProof = function(){ return ''; };
    `);
    win.eval(extractFn('wireActionProofButton'));
    return win;
}

const $btn    = (win) => win.jQuery('#action-proof-btn');
const $result = (win) => win.jQuery('#action-proof-result');

describe('client: action proof button is gated on the block being checkpointed', function(){

    it('offers the button on a checkpointed block, and the click spends the proof request', function(){
        const win = bootPage(true);
        win.wireActionProofButton({ action_index: '39', block_index: '150208' });

        expect(win.probed, 'the checkpoint route is asked about the action\'s own block')
            .to.deep.equal(['/TBTC/api/checkpoint/150208']);
        expect($btn(win).length, 'the button survives').to.equal(1);
        expect($btn(win).prop('disabled'), 'and is enabled').to.equal(false);

        $btn(win).trigger('click');
        expect(win.proofUrls, 'the click asks for the proof by action_index, not by tx hash')
            .to.deep.equal(['/TBTC/api/proof/action/39']);
    });

    it('removes the button on an uncheckpointed block and says why, spending no proof request', function(){
        const win = bootPage(false);
        win.wireActionProofButton({ action_index: '38', block_index: '150182' });

        expect(win.probed).to.deep.equal(['/TBTC/api/checkpoint/150182']);
        expect($btn(win).length, 'no control is offered that could only refuse').to.equal(0);
        expect($result(win).text(), 'the reader is told the reason instead')
            .to.contain('no signed checkpoint');
        // The whole point of probing first: the 409 is stated without burning one of
        // the reader's rate-limited proof requests to discover it.
        expect(win.proofUrls, 'no proof request is spent').to.deep.equal([]);
    });

    it('wires nothing at all when the action carries no index or no block', function(){
        // action_index is absent until the action lookup resolves it (the page's
        // :query may be a tx hash), and a mempool action has no block yet. Neither
        // can be probed, so neither may leave a live button behind.
        for(const o of [ { action_index: null, block_index: '150208' },
                         { action_index: '39', block_index: null },
                         { action_index: '39', block_index: '' } ]){
            const win = bootPage(true);
            win.wireActionProofButton(o);
            expect(win.probed, 'nothing is probed for ' + JSON.stringify(o)).to.deep.equal([]);
            expect($btn(win).prop('disabled'), 'the button stays disabled').to.equal(true);
        }
    });
});
