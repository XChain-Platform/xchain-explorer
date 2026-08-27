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
 * Three DEPLOY/ISSUE wire fields reached the action API but had nowhere to
 * render, so the action detail page silently dropped them:
 *
 *   - ISSUE v6 carries CONTROLLER, ACTION_CLASS, COOLDOWN_BLOCKS and UNBIND.
 *     The page rendered the v0-v5 shape only, so a binding action showed its
 *     raw tx_data and nothing else about the binding it performed.
 *   - DEPLOY v0-v3 pay constructor gas, recorded on the contract_executions row
 *     rather than as a protocol fee, so a deployer's cost appeared nowhere.
 *   - DEPLOY v4 carries CODE_PART, the base64 slice the carrier exists to
 *     publish, which had no row at all.
 *
 * Found by driving /RDOGE/action/1163, /1138 and /1142 on the regtest venue
 * after the API half landed: every field was present in the JSON and absent
 * from the page.
 *
 * The markup is loaded from the SHIPPED action.html rather than a hand-built
 * fixture, so a renamed class in either file fails here instead of silently
 * rendering nothing again.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT = path.resolve(__dirname, '../../src/content');
const CLIENT  = path.join(CONTENT, 'js', 'xchain.js');
const JQUERY  = path.join(CONTENT, 'js', 'jquery.min.js');
const ACTION  = path.join(CONTENT, 'html', 'action.html');

// One jsdom realm carrying the shipped jQuery, the shipped action.html markup and
// the shipped client, matching content-client-search-null-render.test.js. The
// page's own <script> never runs (runScripts: 'outside-only'), so the render
// functions are driven directly, which is exactly how the page calls them.
function bootPage(){
    const markup = fs.readFileSync(ACTION, 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/action/1163'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(fs.readFileSync(CLIENT, 'utf8'));
    win.XC = win.XC || {};
    win.XC.coin = 'RDOGE';
    return win;
}

const text = (win, sel) => win.jQuery(sel).text().trim();
const hidden = (win, sel) => win.jQuery(sel).hasClass('d-none');

describe('action detail render: fields that reached the API with nowhere to go', function(){

    describe('ISSUE v6 controller binding', function(){

        it('renders controller, action class, cooldown and the bind flag', function(){
            const win = bootPage();
            win.showIssueDetails({
                action_format: 6, tick: 'CAMPA',
                controller: '1138', action_class: 'mint', cooldown_blocks: 5, unbind: 0
            });
            expect(hidden(win, '#info-issue .issue-controller-card'), 'card shown for v6').to.equal(false);
            expect(text(win, '#info-issue .issue-controller')).to.equal('1138');
            expect(win.jQuery('#info-issue .issue-controller a').attr('href'))
                .to.equal('/RDOGE/contract/1138');
            expect(text(win, '#info-issue .issue-action-class')).to.equal('mint');
            expect(text(win, '#info-issue .issue-cooldown-blocks')).to.equal('5 blocks');
            expect(text(win, '#info-issue .issue-unbind')).to.equal('Bind');
        });

        it('distinguishes an unbind from a bind, which share the wire format', function(){
            const win = bootPage();
            win.showIssueDetails({
                action_format: 6, tick: 'CAMPA',
                controller: '1138', action_class: 'mint', cooldown_blocks: 5, unbind: 1
            });
            expect(text(win, '#info-issue .issue-unbind')).to.equal('Unbind');
        });

        it('hides the card on a non-v6 ISSUE, which carries none of these fields', function(){
            const win = bootPage();
            win.showIssueDetails({ action_format: 0, tick: 'CAMPA' });
            expect(hidden(win, '#info-issue .issue-controller-card')).to.equal(true);
        });

        it('renders a dash, never the word null, when a v6 field is absent', function(){
            const win = bootPage();
            win.showIssueDetails({
                action_format: 6, tick: 'CAMPA',
                controller: null, action_class: null, cooldown_blocks: null, unbind: 0
            });
            expect(text(win, '#info-issue .issue-controller')).to.equal('-');
            expect(text(win, '#info-issue .issue-action-class')).to.equal('-');
            expect(text(win, '#info-issue .issue-cooldown-blocks')).to.equal('-');
        });
    });

    describe('DEPLOY constructor gas', function(){

        it('renders gas used, gas limit and the method for a contract deploy', function(){
            const win = bootPage();
            win.showDeployDetails({
                action_format: 0, action_index: 1138, code_hash: 'abc',
                gas_used: '118072', gas_limit: '500000', method_name: 'constructor'
            });
            expect(hidden(win, '#info-deploy .deploy-execution-row')).to.equal(false);
            expect(text(win, '#info-deploy .deploy-method')).to.equal('constructor');
            expect(text(win, '#info-deploy .deploy-gas')).to.equal('118072 / 500000');
        });

        it('hides the gas rows when no execution row exists for the deploy', function(){
            const win = bootPage();
            win.showDeployDetails({
                action_format: 0, action_index: 1032, code_hash: 'abc', gas_used: null
            });
            expect(hidden(win, '#info-deploy .deploy-execution-row')).to.equal(true);
        });
    });

    describe('DEPLOY v4 code part', function(){

        it('renders a long part truncated, with its full length', function(){
            const win = bootPage();
            const part = 'A'.repeat(900);
            win.showDeployDetails({
                action_format: 4, code_hash: 'abc', chunk_index: 0, total_chunks: 3, code_part: part
            });
            expect(hidden(win, '#info-deploy .deploy-chunk-row')).to.equal(false);
            expect(text(win, '#info-deploy .deploy-chunk')).to.equal('Code chunk 1 of 3');
            const shown = text(win, '#info-deploy .deploy-code-part');
            expect(shown).to.contain('(900 chars)');
            expect(shown).to.contain('A'.repeat(96));
            expect(shown).to.not.contain('A'.repeat(97));
        });

        it('renders a short part whole, with no truncation marker', function(){
            const win = bootPage();
            win.showDeployDetails({
                action_format: 4, code_hash: 'abc', chunk_index: 2, total_chunks: 3, code_part: 'bW9k'
            });
            expect(text(win, '#info-deploy .deploy-code-part')).to.equal('bW9k');
        });

        it('renders blank, never the word null, for an absent part', function(){
            const win = bootPage();
            win.showDeployDetails({
                action_format: 4, code_hash: 'abc', chunk_index: 1, total_chunks: 3, code_part: null
            });
            expect(text(win, '#info-deploy .deploy-code-part')).to.equal('');
        });
    });
});
