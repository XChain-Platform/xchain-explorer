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
// The shipped client source, from the shared helper: the cell-rendering
// helpers (isNull, escapeHtml, formatAmount, formatLink and friends) moved
// out of xchain.js into formatters.js in the component milestone, and this
// suite needs whichever of the two a given function landed in.
const CLIENT_SRC  = require('../helpers/content-source.js').clientSource();
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
    win.eval(CLIENT_SRC);
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

    // A chunked group deploys at whichever piece confirms LAST, in that piece's own
    // action. Two pages were wrong about that: the completing carrier's, which showed
    // only its base64 slice and left the contract it created unreachable, and the
    // assembler's, which linked /contract/{its own index} whether or not a contract had
    // ever been created there.
    describe('deferred chunked assembly', function(){

        it('shows the deploy card on the carrier that completed the group', function(){
            const win = bootPage();
            win.showDeployDetails({
                action_format: 4, action_index: 1421, code_hash: 'abc', chunk_index: 0,
                total_chunks: 3, code_part: 'bW9k', deployed_contract_index: 1421,
                api_version: 2, cooldown_blocks: 144, slash_destination: 'addr-slash',
                contract_status: 'valid', assembler_action_index: 1419
            });
            expect(hidden(win, '#info-deploy .deploy-chunk-row'), 'the slice rows stay').to.equal(false);
            expect(hidden(win, '#info-deploy .deploy-contract-row'), 'the contract card is revealed').to.equal(false);
            expect(win.jQuery('#info-deploy .deploy-contract a').attr('href'))
                .to.equal('/RDOGE/contract/1421');
            expect(text(win, '#info-deploy .deploy-api-version')).to.equal('2');
            expect(hidden(win, '#info-deploy .deploy-staking-row')).to.equal(false);
            expect(text(win, '#info-deploy .deploy-cooldown')).to.equal('144 blocks');
            expect(win.jQuery('#info-deploy .deploy-slash a').attr('href'))
                .to.equal('/RDOGE/address/addr-slash');
        });

        it('leaves an ordinary carrier with its slice alone, and no dead contract link', function(){
            const win = bootPage();
            win.showDeployDetails({
                action_format: 4, action_index: 1420, code_hash: 'abc', chunk_index: 1,
                total_chunks: 3, code_part: 'bW9k', deployed_contract_index: null
            });
            expect(hidden(win, '#info-deploy .deploy-contract-row')).to.equal(true);
            expect(hidden(win, '#info-deploy .deploy-staking-row')).to.equal(true);
            expect(text(win, '#info-deploy .deploy-chunk')).to.equal('Code chunk 2 of 3');
        });

        it('points the assembler at the carrier the contract actually landed on', function(){
            const win = bootPage();
            win.showDeployDetails({
                action_format: 2, action_index: 1419, code_hash: 'abc', api_version: 2,
                status: 'pending: CODE_HASH (awaiting chunks)',
                deployed_contract_index: 1421, assembly_status: 'valid'
            });
            expect(win.jQuery('#info-deploy .deploy-contract a').attr('href'))
                .to.equal('/RDOGE/contract/1421');
            // A contract deployed before CONTRACT_META_REQUIRED declares no identity,
            // so the cell names it "Unnamed contract" beside the address it links.
            expect(text(win, '#info-deploy .deploy-contract')).to.equal('Unnamed contract · 1421');
        });

        it('states the status instead of a dead link while the group is incomplete', function(){
            const win = bootPage();
            win.showDeployDetails({
                action_format: 2, action_index: 1419, code_hash: 'abc', api_version: 2,
                status: 'pending: CODE_HASH (awaiting chunks)',
                deployed_contract_index: null, assembly_status: 'pending: CODE_HASH (awaiting chunks)'
            });
            expect(text(win, '#info-deploy .deploy-contract'))
                .to.equal('pending: CODE_HASH (awaiting chunks)');
            expect(win.jQuery('#info-deploy .deploy-contract a').length, 'no link to a contract that does not exist')
                .to.equal(0);
        });

        it('keeps linking its own index when the assembler deployed the contract itself', function(){
            const win = bootPage();
            win.showDeployDetails({
                action_format: 2, action_index: 1427, code_hash: 'abc', api_version: 2,
                status: 'valid', deployed_contract_index: 1427, assembly_status: 'valid'
            });
            expect(win.jQuery('#info-deploy .deploy-contract a').attr('href'))
                .to.equal('/RDOGE/contract/1427');
        });

        it('links its own index on a pre-assembly deploy that carries neither field', function(){
            // An older explorer response, and every DEPLOY on a chain before the gate.
            const win = bootPage();
            win.showDeployDetails({
                action_format: 0, action_index: 1138, code_hash: 'abc', api_version: 1, status: 'valid'
            });
            expect(win.jQuery('#info-deploy .deploy-contract a').attr('href'))
                .to.equal('/RDOGE/contract/1138');
        });

        it('renders the constructor gas on the carrier the constructor ran at', function(){
            // The completing carrier's page is the one page that can show what the
            // deployment COST, so the gas rows must render before the chunk branch returns.
            const win = bootPage();
            win.showDeployDetails({
                action_format: 4, action_index: 1421, code_hash: 'abc', chunk_index: 2,
                total_chunks: 3, code_part: 'bW9k', deployed_contract_index: 1421,
                api_version: 2, contract_status: 'valid', assembler_action_index: 1419,
                contract_index: 1421, method_name: 'constructor',
                gas_used: '118072', gas_limit: '500000'
            });
            expect(hidden(win, '#info-deploy .deploy-execution-row'),
                'the completing carrier hides the gas it was billed').to.equal(false);
            expect(text(win, '#info-deploy .deploy-method')).to.equal('constructor');
            expect(text(win, '#info-deploy .deploy-gas')).to.equal('118072 / 500000');
            expect(hidden(win, '#info-deploy .deploy-chunk-row'), 'the slice rows stay').to.equal(false);
        });

        it('hides the gas rows on a carrier that deployed nothing', function(){
            const win = bootPage();
            win.showDeployDetails({
                action_format: 4, action_index: 1420, code_hash: 'abc', chunk_index: 1,
                total_chunks: 3, code_part: 'bW9k', deployed_contract_index: null
            });
            expect(hidden(win, '#info-deploy .deploy-execution-row')).to.equal(true);
        });
    });

    // The deploy card sits UNDER the chunk rows: a carrier's page reads slice first,
    // then the contract it created. The order is config (action-detail-cards.json),
    // applied to the shipped markup by the detail-card component at mount, so it is
    // driven here through that mount rather than asserted against the JSON.
    describe('the deploy card sits under the chunk rows', function(){

        const listPage = require(path.join(__dirname, '../../src/list-page.js'));
        const CARDS = JSON.parse(fs.readFileSync(
            path.join(CONTENT, 'layouts', 'action-detail-cards.json'), 'utf8'));

        // The page as the browser receives it: composed, with the row-config JSON
        // block spliced in, plus components.js and the real detail-card registered.
        function cardPage(){
            const composed = listPage.dataBlocks(fs.readFileSync(ACTION, 'utf8'));
            const body = composed.slice(0, composed.indexOf('<script'));
            const dom = new JSDOM('<!doctype html><html><body>' + body
                + '<script type="application/json" id="xc-action-detail-cards">'
                + /id="xc-action-detail-cards">([\s\S]*?)<\/script>/.exec(composed)[1]
                + '</script></body></html>', {
                runScripts: 'outside-only', url: 'https://xchain.test/RDOGE/action/1421'
            });
            const win = dom.window;
            win.numeral = function(v){ return { format: function(){ return String(v); } }; };
            win.eval(fs.readFileSync(JQUERY, 'utf8'));
            win.jQuery.fn.ready = function(){ return this; };
            win.eval(fs.readFileSync(path.join(CONTENT, 'js', 'components.js'), 'utf8'));
            win.eval(CLIENT_SRC);
            win.eval(fs.readFileSync(
                path.join(CONTENT, 'components', 'detail-card', 'init.js'), 'utf8'));
            win.XC = win.XC || {};
            win.XC.coin = 'RDOGE';
            return win;
        }

        // The rows of the deploy block in DOM order, named by their value cell.
        function rowCells(win, opts){
            const all = [...win.document.querySelectorAll('#info-deploy tbody tr')];
            const rows = (opts && opts.visibleOnly) ? all.filter((r) => !r.classList.contains('d-none')) : all;
            return rows.map((r) => r.querySelector('td').classList[0]);
        }

        it('puts the chunk rows above the contract rows once the card is mounted', function(){
            const win = cardPage();
            win.showDeployDetails({
                action_format: 4, action_index: 1421, code_hash: 'abc', chunk_index: 2,
                total_chunks: 3, code_part: 'bW9k', deployed_contract_index: 1421,
                api_version: 2, cooldown_blocks: 144, slash_destination: 'addr-slash',
                method_name: 'constructor', gas_used: '118072', gas_limit: '500000'
            });
            expect(win.mountActionDetailCard('deploy'), 'the card did not mount').to.equal(true);
            expect(rowCells(win)).to.deep.equal([
                'deploy-chunk', 'deploy-code-part',
                'deploy-contract', 'deploy-code-hash', 'deploy-api-version', 'deploy-stakeable',
                'deploy-cooldown', 'deploy-slash', 'deploy-method', 'deploy-gas'
            ]);
            // Every row of a completing carrier's page is on screen: the slice it
            // carried, then the whole deploy card under it.
            expect(rowCells(win, { visibleOnly: true })).to.deep.equal(rowCells(win));
        });

        it('leaves a pre-activation deploy page rendering exactly as it did', function(){
            // v0-v3 hide the chunk rows, and the reorder only moves those, so the
            // reader of an ordinary deploy sees the same rows in the same sequence.
            const win = cardPage();
            const payload = {
                action_format: 0, action_index: 1138, code_hash: 'abc', api_version: 1,
                status: 'valid', cooldown_blocks: 144, slash_destination: 'addr-slash',
                method_name: 'constructor', gas_used: '118072', gas_limit: '500000'
            };
            win.showDeployDetails(payload);
            const before = rowCells(win, { visibleOnly: true });
            expect(win.mountActionDetailCard('deploy')).to.equal(true);
            win.showDeployDetails(payload);
            expect(rowCells(win, { visibleOnly: true }), 'the reorder disturbed a v0-v3 page')
                .to.deep.equal(before);
            expect(before).to.deep.equal([
                'deploy-contract', 'deploy-code-hash', 'deploy-api-version', 'deploy-stakeable',
                'deploy-cooldown', 'deploy-slash', 'deploy-method', 'deploy-gas'
            ]);
        });

        it('keeps the row config in step with the markup it permutes', function(){
            // permuteRows matches config POSITION to table position, so the array has
            // to stay in markup order; only `order` may move a row. A config that
            // drifted would relabel values rather than fail visibly.
            const win = cardPage();
            const cells = rowCells(win);
            expect(CARDS.cards.deploy.rows.map((r) => r.cell)).to.deep.equal(cells);
            const placed = CARDS.cards.deploy.rows
                .filter((r) => typeof r.order === 'number').map((r) => r.cell);
            expect(placed, 'the chunk rows are the only rows the config moves')
                .to.deep.equal(['deploy-chunk', 'deploy-code-part']);
        });
    });
});
