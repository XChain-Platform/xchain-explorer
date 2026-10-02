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

function batchRow(batchKey=BATCH_KEY){
    const row = Array(21).fill(null);
    row[4] = 5;
    row[5] = '';
    row[6] = batchKey;
    row[9] = 1;
    row[10] = 500;
    row[14] = batchKey;
    row[15] = Date.UTC(2026, 9, 2, 10, 0) / 1000;
    row[16] = Date.UTC(2026, 9, 2, 11, 0) / 1000;
    row[17] = 2;
    row[19] = 0;
    row[20] = 1;
    return row;
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
});
