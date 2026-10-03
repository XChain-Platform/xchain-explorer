/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { expect } = require('chai');
const { clientSource } = require('../../helpers/content-source.js');
const { stakeLifecycleRows } = require('../../../src/explorer/paging/list_rows.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const JQUERY = fs.readFileSync(path.join(ROOT, 'src/content/js/jquery.min.js'), 'utf8');
const CLIENT = clientSource();
const ACTION_HTML = fs.readFileSync(path.join(ROOT, 'src/content/html/action.html'), 'utf8');
const BATCH_KEY = 'a'.repeat(64);

function boot(markup){
    const dom = new JSDOM('<!doctype html><body>' + markup + '</body>', {
        runScripts: 'outside-only', url: 'https://xchain.test/RDOGE/action/500'
    });
    const win = dom.window;
    win.numeral = value => ({ format: () => String(value) });
    win.moment = { unix: () => ({ utcOffset: () => ({ format: () => '' }) }) };
    win.eval(JQUERY);
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT);
    win.XC = Object.assign(win.XC || {}, { coin: 'RDOGE', chain: 'DOGE' });
    return win;
}

function attestPanel(){
    const start = ACTION_HTML.indexOf('<div class="d-none" id="info-attest">');
    expect(start).to.be.greaterThan(-1);
    const end = ACTION_HTML.indexOf('</div>', start);
    return ACTION_HTML.slice(start, end + 6);
}

function batchRow(batchKey=BATCH_KEY, overrides={}){
    return stakeLifecycleRows(Object.assign({
        block_index: 10, timestamp: 20, source: 'publisher', version: 5,
        provider_id: '', request_id: batchKey, action_index: 500,
        batch_key: batchKey, batch_window_start: Date.UTC(2026, 9, 2, 10, 0) / 1000,
        batch_window_end: Date.UTC(2026, 9, 2, 11, 0) / 1000, batch_row_count: 2,
        batch_action_index: null, batch_chunk_index: 0, batch_total_chunks: 1
    }, overrides), { count_reverse: 1, status: 1, method: 'getAttestations' });
}

describe('ATTEST batch navigation', function(){
    it('labels a v5 action detail key as Batch key', function(){
        const win = boot(attestPanel());
        win.showAttestDetails({
            action_format: 5,
            request_id: BATCH_KEY,
            batch_window_start: 1,
            batch_window_end: 2,
            batch_row_count: 0,
            batch_chunk_index: 0,
            batch_total_chunks: 1
        });
        expect(win.jQuery('#info-attest .attest-id-label').text()).to.equal('Batch key');
        expect(win.jQuery('#info-attest .attest-id-label').text()).to.not.equal('Request ID');
    });

    it('links both batch list controls to the displayed batch key', function(){
        const win = boot('<table><thead><tr>' + '<th></th>'.repeat(10)
            + '</tr></thead><tbody><tr id="row">' + '<td></td>'.repeat(10) + '</tr></tbody></table>');
        const $ = win.jQuery;
        const row = $('#row')[0];
        win.xcDatatableRenderAttestationRow({ row, data: batchRow(), coin: 'RDOGE' });
        const expected = '/RDOGE/attestation/' + BATCH_KEY;
        expect($('td', row).eq(6).find('a').attr('href')).to.equal(expected);
        expect($('td', row).eq(9).find('a').attr('href')).to.equal(expected);
        expect($(row).find('a[href="/RDOGE/attestation/500"]')).to.have.length(0);
    });

    it('encodes the batch key as one path segment in both list controls', function(){
        const win = boot('<table><thead><tr>' + '<th></th>'.repeat(10)
            + '</tr></thead><tbody><tr id="row">' + '<td></td>'.repeat(10) + '</tr></tbody></table>');
        const $ = win.jQuery;
        const row = $('#row')[0];
        const batchKey = 'batch/key?#<unsafe>';
        win.xcDatatableRenderAttestationRow({ row, data: batchRow(batchKey), coin: 'RDOGE' });
        const expected = '/RDOGE/attestation/' + encodeURIComponent(batchKey);
        expect($('td', row).eq(6).find('a').attr('href')).to.equal(expected);
        expect($('td', row).eq(9).find('a').attr('href')).to.equal(expected);
    });

    it('labels a continuation from the server-shaped chunk counters', function(){
        const win = boot('<table><thead><tr>' + '<th></th>'.repeat(10)
            + '</tr></thead><tbody><tr id="row">' + '<td></td>'.repeat(10) + '</tr></tbody></table>');
        const row = win.jQuery('#row')[0];
        win.xcDatatableRenderAttestationRow({
            row, coin: 'RDOGE', data: batchRow(BATCH_KEY, {
                version: 6, batch_window_start: null, batch_window_end: null,
                batch_row_count: null, batch_chunk_index: 2, batch_total_chunks: 5
            })
        });
        expect(win.jQuery('td', row).eq(7).text()).to.equal('Batch continuation (chunk 3 of 5)');
    });
});
