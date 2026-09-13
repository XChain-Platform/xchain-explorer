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
 * The /{COIN}/prices list row (item ).
 *
 * A validator PRICE on the wire today is a BATCH: one signed action carrying an
 * hourly window of rounds. Its coin, token, fiat, value and fee columns are the
 * v1 user-oracle columns and are NULL on it by construction, and its pair_count
 * is NULL too (it would describe one round out of the window). The list row used
 * to carry ONLY those, so every validator row on /prices rendered as a line of
 * dashes over an action that plainly carried an hour of prices.
 *
 * These assertions drive the SHIPPED getPagingDataResults over a batch row and
 * feed the array it produces to the SHIPPED createdRow, so they fail on the real
 * end-to-end behaviour rather than on a copy of either half.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { expect } = require('chai');
const { JSDOM }  = require('jsdom');
const proxyquire = require('proxyquire');

const ROOT    = path.resolve(__dirname, '../..');
const CONTENT = path.join(ROOT, 'src', 'content');
const JQUERY  = path.join(CONTENT, 'js', 'jquery.min.js');
const CLIENT_SRC = require('../helpers/content-source.js').clientSource();
const SOURCE     = require('../helpers/content-source.js');

const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeExplorerConfig }   = require('../fixtures/mock-query-args.js');

// Minimal Express mock: just enough for the XChainExplorer constructor.
const mockApp = { use: () => {}, get: () => {}, post: () => {}, enable: () => {} };
const express = () => mockApp;
express.static = () => {};
express.json   = () => {};

class MockDB {
    constructor() {}
    async init() {}
    getMaxMethodResults() { return 100; }
}

const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
    'express': express,
    './db.js': MockDB
});

function makeExplorer() {
    return new XChainExplorer(mockApp, createConfigInfoStub());
}

// Shape one prices feed row exactly as the /explorer feed does.
function shape(row) {
    const explorer = makeExplorer();
    const cfg = makeExplorerConfig('getPrices', null, null, { start: 0, length: 10 });
    return explorer.getPagingDataResults(cfg, [row], 1)[0];
}

// A validator BATCH as getPrices actually returns one: the v1 oracle columns and
// the single-round pair/sig counts NULL, the window columns set.
function batchRow(overrides = {}) {
    return Object.assign({
        action_index:      4210,
        block_index:       3901,
        timestamp:         1787964454,
        source:            'validatorAddr',
        version:           0,
        round_number:      910200,
        round_timestamp:   1787960000,
        pair_count:        null,
        pairs_json:        null,
        sig_count:         null,
        sigs_json:         '[{"pubkey":"aa","sig":"bb"}]',
        batch_first_round: 910200,
        batch_last_round:  910259,
        round_count:       60,
        coin:              null,
        tick:              null,
        fiat:              null,
        value:             null,
        fee:               null,
        validation_status: 'valid',
        status:            'valid'
    }, overrides);
}

// A v1 user oracle row: no window, no rounds, a real TOKEN/FIAT price.
function oracleRow(overrides = {}) {
    return Object.assign({
        action_index:      4211,
        block_index:       3902,
        timestamp:         1787964500,
        source:            'oracleAddr',
        version:           1,
        round_number:      null,
        pair_count:        null,
        batch_first_round: null,
        batch_last_round:  null,
        round_count:       null,
        coin:              'DOGE',
        tick:              'XCHAIN',
        fiat:              'USD',
        value:             '0.00123',
        fee:               '0.01',
        status:            'valid'
    }, overrides);
}

// ---------------------------------------------------------------------------
// Render harness: one jsdom realm carrying the shipped jQuery and the shipped
// client, with dataTable() stubbed so the createdRow closure can be captured.
// ---------------------------------------------------------------------------

function bootClient() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/prices'
    });
    const win = dom.window;
    // The shipped numeral is not under test here; a pass-through keeps the
    // assertions on WHAT the cell says rather than on thousands separators.
    win.numeral = function (v) { return { format: function () { return String(v); } }; };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function () { return this; };
    win.eval(CLIENT_SRC);
    const captured = {};
    win.jQuery.fn.dataTable = function (config) { captured.config = config; return this; };
    win.jQuery.fn.DataTable = win.jQuery.fn.dataTable;
    return { win, captured };
}

// Drive the shipped createdRow over one shaped feed row.
function renderRow(data, columns) {
    const { win, captured } = bootClient();
    const $ = win.jQuery;
    win.loadDatatablesData('RDOGE', 'price', null, null);
    expect(captured.config, 'loadDatatablesData did not reach .dataTable()').to.be.an('object');
    const row = $('<tr>')[0];
    for (let i = 0; i < columns; i++)
        $(row).append($('<td>').text('PLACEHOLDER'));
    captured.config.createdRow.call(captured.config, row, data, 0);
    return {
        text: $('td', row).map(function () { return $(this).text(); }).get(),
        html: $('td', row).map(function () { return $(this).html(); }).get()
    };
}

// The <th> count the composed page actually serves.
function priceColumns() {
    const head = /<thead>([\s\S]*?)<\/thead>/.exec(SOURCE.pageSource('prices.html'));
    expect(head, 'prices.html has no <thead>').to.not.equal(null);
    return [...head[1].matchAll(/<th[\s>]/g)].length;
}

describe('/{COIN}/prices list row', function () {

    // -----------------------------------------------------------------------
    // Page shape
    // -----------------------------------------------------------------------

    it('keeps the header width and the loading-row colspan in step', function () {
        const src = SOURCE.pageSource('prices.html');
        const colspan = /<td colspan="(\d+)" class="loading-data"/.exec(src);
        expect(colspan, 'prices.html has no loading-data row').to.not.equal(null);
        expect(priceColumns()).to.equal(Number(colspan[1]));
    });

    it('gives the batch window and the pair count columns of their own', function () {
        const src = SOURCE.pageSource('prices.html');
        expect(src).to.include('>Rounds<');
        expect(src).to.include('>Pairs<');
    });

    // -----------------------------------------------------------------------
    // Feed shaping
    // -----------------------------------------------------------------------

    it('keeps status second-to-last and action_index last (row colour + paging cursor)', function () {
        const r = shape(batchRow());
        expect(r[r.length - 2]).to.equal(1);
        expect(r[r.length - 1]).to.equal(4210);
    });

    it('carries the batch window, round count and pair counts into the row', function () {
        const r = shape(batchRow({ batch_pair_count: 12 }));
        expect(r[8]).to.equal(910200);   // round the action is about
        expect(r[9]).to.equal(910200);   // batch_first_round
        expect(r[10]).to.equal(910259);  // batch_last_round
        expect(r[11]).to.equal(60);      // round_count
        expect(r[12]).to.equal(null);    // pair_count: NULL on a batch
        expect(r[13]).to.equal(12);      // batch_pair_count: width of one round
    });

    it('shapes a feed row that does not carry a batch pair count as null, never undefined', function () {
        const r = shape(batchRow());
        expect(r[13]).to.equal(null);
        expect(JSON.parse(JSON.stringify(r))[13]).to.equal(null);
    });

    // -----------------------------------------------------------------------
    // Render: the defect this item is about
    // -----------------------------------------------------------------------

    it('[REGRESSION] describes a validator batch instead of rendering an empty row', function () {
        const out = renderRow(shape(batchRow({ batch_pair_count: 12 })), priceColumns());
        // The cells that are NULL by construction on a batch still read as a dash...
        expect(out.text[5]).to.equal('-');
        expect(out.text[6]).to.equal('-');
        expect(out.text[7]).to.equal('-');
        // ...but the row now says what the action carried.
        expect(out.html[4]).to.include('Validator (v0)');
        expect(out.html[4]).to.include('Batch');
        expect(out.text[8]).to.equal('910200 - 910259 (60 rounds)');
        expect(out.text[9]).to.equal('12 per round');
        // The row as a whole is no longer describable as "all dashes".
        const dashes = out.text.filter((t) => t === '-').length;
        expect(dashes).to.be.below(out.text.length - 4);
    });

    it('still describes the window when the feed carries no pair count', function () {
        const out = renderRow(shape(batchRow()), priceColumns());
        expect(out.text[8]).to.equal('910200 - 910259 (60 rounds)');
        expect(out.text[9]).to.equal('-');
    });

    it('says "1 round" for a single-round window, not "1 rounds"', function () {
        const out = renderRow(shape(batchRow({ batch_last_round: 910200, round_count: 1 })), priceColumns());
        expect(out.text[8]).to.equal('910200 - 910200 (1 round)');
    });

    it('shows the window without a count when round_count is absent', function () {
        const out = renderRow(shape(batchRow({ round_count: null })), priceColumns());
        expect(out.text[8]).to.equal('910200 - 910259');
    });

    it('does not treat a half-set window as a batch', function () {
        const out = renderRow(shape(batchRow({ batch_last_round: null })), priceColumns());
        expect(out.html[4]).to.not.include('Batch');
        expect(out.text[8]).to.equal('910200'); // falls back to the round the action is about
    });

    // -----------------------------------------------------------------------
    // Render: the shapes that already worked must keep working
    // -----------------------------------------------------------------------

    it('renders a v1 user oracle with its token, fiat, value and fee', function () {
        const out = renderRow(shape(oracleRow()), priceColumns());
        expect(out.html[4]).to.include('User (v1)');
        expect(out.html[4]).to.not.include('Batch');
        expect(out.text[5]).to.equal('DOGE');
        expect(out.html[6]).to.include('/RDOGE/token/XCHAIN');
        expect(out.text[7]).to.equal('USD');
        expect(out.text[8]).to.equal('-');
        expect(out.text[9]).to.equal('-');
        expect(out.text[10]).to.equal('0.00123');
        expect(out.text[11]).to.equal('0.01');
        expect(out.html[12]).to.include('/RDOGE/action/4211');
    });

    it('renders a v0 single-round snapshot with its round and its own pair count', function () {
        const row = batchRow({
            batch_first_round: null,
            batch_last_round:  null,
            round_count:       null,
            pair_count:        8
        });
        const out = renderRow(shape(row), priceColumns());
        expect(out.html[4]).to.include('Validator (v0)');
        expect(out.html[4]).to.not.include('Batch');
        expect(out.text[8]).to.equal('910200');
        expect(out.text[9]).to.equal('8');
    });

    it('writes a dash rather than the literal word "null" into any cell', function () {
        for (const data of [shape(batchRow()), shape(oracleRow())])
            for (const cell of renderRow(data, priceColumns()).text)
                expect(cell).to.not.equal('null');
    });
});
