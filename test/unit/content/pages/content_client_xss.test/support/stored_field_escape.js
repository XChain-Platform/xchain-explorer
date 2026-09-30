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
 * A read-only review found several datatable and detail renderers that
 * concatenate an on-chain enum/status field straight into an .html() sink
 * without escaping, the same stored-XSS shape formatHash() and the sibling
 * badge fields in these same files already guard against. This harness pins
 * every field the review named: it renders the SHIPPED row/detail function
 * against an attribute-breakout payload and asserts no live element or
 * inline event handler reaches the DOM.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM } = require('jsdom');

const CONTENT     = path.resolve(__dirname, '..', '..', '..', '..', '..', '..', 'src', 'content');
const CLIENT_SRC  = require('../../../../../helpers/content-source.js').clientSource();
const JQUERY      = path.join(CONTENT, 'js', 'jquery.min.js');
const ACTION      = path.join(CONTENT, 'html', 'action.html');

// The canonical attribute-breakout probe already used by formatHash's own
// pins in this same suite: closes a quoted attribute early, then opens a
// live <img onerror> element. 31 chars, past every truncation length below.
const PAYLOAD = '"><img src=x onerror=alert(1)>';

function bootPage(){
    const markup = fs.readFileSync(ACTION, 'utf8');
    const dom = new JSDOM('<!doctype html><html><body>' + markup + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/TDOGE/action/1'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = win.XC || {};
    win.XC.coin    = 'TDOGE';
    win.XC.network = 'testnet';
    return win;
}

// A <tr> with `count` empty <td> cells, the shape every row handler expects.
function makeRow(win, count){
    let tds = '';
    for(let i = 0; i < count; i++) tds += '<td></td>';
    return win.jQuery('<tr>' + tds + '</tr>')[0];
}

// A cell carries no injected element and no inline event handler: the payload
// broke out of an attribute or a text run only if either is true.
function cellIsInert(win, row, cellIndex){
    const cell = win.jQuery('td', row).eq(cellIndex);
    const hasHandler = cell.find('*').toArray().some(function(el){
        return Array.from(el.attributes).some(function(a){ return /^on/i.test(a.name); });
    });
    return cell.find('img, svg, script').length === 0 && !hasHandler;
}

// One row-handler case per field the review flagged: function name, the row's
// cell count, the data array (payload already placed), and the cell it lands in.
const BADGE_CASES = [
    { field: 'poll_status (rows_protocol_a.js)', fn: 'xcDatatableRenderPollRow', cells: 11,
      cellIndex: 6, data: [null, null, null, null, null, 'Q?', PAYLOAD, null, null, null, null] },
    { field: 'xcall request_status (rows_protocol_a.js)', fn: 'xcDatatableRenderXcallRow', cells: 9,
      cellIndex: 7, data: [null, null, null, null, null, null, null, PAYLOAD] },
    { field: 'capability_slash_event capability (rows_protocol_b.js)', fn: 'xcDatatableRenderCapabilitySlashEventRow', cells: 8,
      cellIndex: 4, data: [null, null, null, null, PAYLOAD, null, null, null] },
    { field: 'reward_type (rows_protocol_b.js)', fn: 'xcDatatableRenderRewardRow', cells: 7,
      cellIndex: 5, data: [null, null, null, null, null, PAYLOAD, null] },
    { field: 'cross_chain_match mstatus (rows_protocol_b.js)', fn: 'xcDatatableRenderCrossChainMatchRow', cells: 11,
      cellIndex: 10, data: [null, null, null, null, null, null, null, null, null, null, PAYLOAD] },
    { field: 'price_snapshot round_status (rows_protocol_b.js)', fn: 'xcDatatableRenderPriceSnapshotRow', cells: 9,
      cellIndex: 8, data: [null, null, null, null, null, null, null, null, PAYLOAD] },
    { field: 'coinpay_obligation pay_status (rows_protocol_c.js)', fn: 'xcDatatableRenderCoinpayObligationRow', cells: 9,
      cellIndex: 7, data: [null, null, null, null, null, null, null, PAYLOAD] },
    { field: 'validator_capability capability (rows_protocol_c.js)', fn: 'xcDatatableRenderValidatorCapabilityRow', cells: 8,
      cellIndex: 3, data: [null, null, null, PAYLOAD, null, null, null, null] },
    { field: 'governance_proposal pstatus (rows_protocol_c.js)', fn: 'xcDatatableRenderGovernanceProposalRow', cells: 9,
      cellIndex: 5, data: [null, null, null, null, null, PAYLOAD, null, null, null] },
    { field: 'governance_vote vote (rows_protocol_c.js)', fn: 'xcDatatableRenderGovernanceVoteRow', cells: 5,
      cellIndex: 4, data: [null, null, null, null, PAYLOAD] },
    { field: 'consensus_state key_name (rows_protocol_c.js)', fn: 'xcDatatableRenderConsensusStateRow', cells: 4,
      cellIndex: 2, data: [null, null, PAYLOAD, null] },
    { field: 'config module_col (rows_protocol_c.js)', fn: 'xcDatatableRenderConfigRow', cells: 7,
      cellIndex: 4, data: [null, null, null, null, PAYLOAD, null, null] },
    { field: 'telemetry_ping event (rows_protocol_c.js)', fn: 'xcDatatableRenderTelemetryPingRow', cells: 8,
      cellIndex: 2, data: [null, null, PAYLOAD, null, null, null, null, null] }
];

describe('client XSS: on-chain enum/status badges escape into .html() @regression', function(){

    BADGE_CASES.forEach(function(c){
        it('keeps ' + c.field + ' inert', function(){
            const win = bootPage();
            const row = makeRow(win, c.cells);
            win[c.fn]({ row: row, data: c.data, idx: 0, coin: 'TDOGE', action: '', type: '',
                action_index: 1, status: 1, count: 1, block_index: 1, timestamp: 1, source: '',
                fmtInteger: '0,0', fmtCurrency: '0,0', fmtCoin: '0,0', action_link: '' });
            expect(cellIsInert(win, row, c.cellIndex), c.field + ' let the payload become markup').to.equal(true);
            // The bytes still show, escaped, rather than vanishing.
            expect(win.jQuery('td', row).eq(c.cellIndex).text()).to.contain('<img');
        });
    });

    it('keeps action_class inert on an ADDRESS controller-bind summary', function(){
        const win  = bootPage();
        const html = win.actionDetail_renderBasicActions('', 'ADDRESS',
            { action_format: 1, unbind: 0, action_class: PAYLOAD, controller: null }, 'TDOGE');
        const out  = win.jQuery('<div></div>').html(html);
        expect(out.find('img, svg, script').length, 'action_class let the payload become markup').to.equal(0);
        expect(out.text()).to.contain('<img');
    });

    it('keeps the FEE panel method field inert', function(){
        const win = bootPage();
        win.XC.fee_preferences = {};
        win.showActionFeeDetails({ method: PAYLOAD, tick: null, amount: null, destination: null });
        const cell = win.jQuery('#info-fee .fee-method');
        expect(cell.find('img, svg, script').length, 'data.method let the payload become markup').to.equal(0);
        expect(cell.text()).to.contain('<img');
    });

});
