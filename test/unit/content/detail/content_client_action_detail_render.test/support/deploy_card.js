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
 **********************************************************************/

'use strict';

const { srcText } = require('../../../helpers/source_text');

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT = path.resolve(__dirname, '../../../../src/content');
const CLIENT_SRC = require('../../../helpers/content-source.js').clientSource();
const JQUERY = path.join(CONTENT, 'js', 'jquery.min.js');
const ACTION = path.join(CONTENT, 'html', 'action.html');
const listPage = require('../../../../src/render/list_page.js');
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
    win.eval(srcText('src/content/js/components.js'));
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

// The deploy card sits UNDER the chunk rows: a carrier's page reads slice first,
// then the contract it created. The order is config (action-detail-cards.json),
// applied to the shipped markup by the detail-card component at mount, so it is
// driven here through that mount rather than asserted against the JSON.
describe('action detail render: fields that reached the API with nowhere to go', function(){
    describe('the deploy card sits under the chunk rows', function(){
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
    });
});

describe('action detail render: fields that reached the API with nowhere to go', function(){
    describe('the deploy card sits under the chunk rows', function(){
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
    });
});

describe('action detail render: fields that reached the API with nowhere to go', function(){
    describe('the deploy card sits under the chunk rows', function(){
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
