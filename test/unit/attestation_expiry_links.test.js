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
 * After an ATTEST expiry, the lifecycle surfaces must still name the request
 * (defect D-E067 / ). ATTEST v2 is system-synthesized: it MINTS an action
 * (action_format 2) and writes NO `attests` row, only flipping the v0 request to
 * 'expired' + resolved_block. So nothing in the schema links the expire action to
 * the request it retired, and attests.callback_execute_action_index is stamped on
 * the v1 RESPONSE row alone - which an expired round does not have.
 *
 * What this file pins:
 *
 *  - THE IN-BLOCK CORRELATION IS RANKED, NOT GUESSED. The indexer expires requests
 *    in one deterministic order (deadline_block ASC, action_index ASC) and mints one
 *    v2 action per request in that loop, so the k-th expire action in a block belongs
 *    to the k-th expired request. A block whose two lists differ in length yields NO
 *    link, because a rank correlation over unequal lists names the WRONG request.
 *
 *  - THE INJECTED CALLBACK IS MATCHED ON THE EXECUTION'S OWN COLUMNS: the request's
 *    contract, the request's callback method, and the request_id as the first
 *    positional parameter. The id is re-validated as 64 hex before it reaches a LIKE.
 *
 *  - A v2 ACTION PAGE NAMES ITS REQUEST. The detail handler fills request_id /
 *    provider / contract from the same correlation, and the client renders that as a
 *    path back to the lifecycle page rather than as a blank cell.
 */

'use strict';

const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { JSDOM }  = require('jsdom');
const { expect } = require('chai');

const Utility = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');
const consensus                = require('../../src/action-detail/consensus.js');

const DatabaseReal = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

const REQ_A = 'a'.repeat(64);
const REQ_B = 'b'.repeat(64);

function makeDb(){
    return new DatabaseReal({ configInfo, util, hubOperational: null });
}

function detailConfig(method, search){
    return makeConfig({ coin: 'BTC', type: 'api', data: { method, search, type: null,
        sql: { order: 'DESC', limit: 100, where: { data: 'm.action_index IS NOT NULL', offset: '', offsetArgs: [] } } } });
}

// Queries are matched on a distinctive fragment; anything unplanned answers [],
// exactly as the real read would on a venue with no such rows.
function stubQueries(db, plan){
    db.doQuery = sinon.stub().callsFake(async (cfg, query, args) => {
        const flat = String(query).replace(/\s+/g, ' ').trim();
        for(const [needle, rows] of plan)
            if(flat.includes(needle)) return (typeof rows === 'function') ? rows(args) : rows;
        return [];
    });
    return db;
}

function captured(db){
    return db.doQuery.getCalls().map(c => ({
        query: String(c.args[1]).replace(/\s+/g, ' ').trim(),
        args:  c.args[2]
    }));
}

function findQuery(db, needle){
    return captured(db).find(q => q.query.includes(needle));
}

const EXPIRE_ACTIONS = "a2.action='ATTEST' AND a1.action_format=2";
const EXPIRED_REQS   = "m.request_status='expired' AND m.resolved_block=?";
const CALLBACK_EXEC  = 'FROM contract_executions m';
const LIFECYCLE      = 'FROM attests m LEFT JOIN actions';

// One block, two expiries, in the sweep's own order.
function twoExpiries(){
    return [
        [EXPIRE_ACTIONS, [{ action_index: 461 }, { action_index: 470 }]],
        [EXPIRED_REQS,   [
            { action_index: 460, request_id: REQ_A, provider_id: 'http_get', contract_index: 12,
              callback_method: 'onPrice', deadline_block: 1400, request_status: 'expired', resolved_block: 1480 },
            { action_index: 465, request_id: REQ_B, provider_id: 'llm', contract_index: 13,
              callback_method: 'onAnswer', deadline_block: 1401, request_status: 'expired', resolved_block: 1480 }
        ]]
    ];
}

describe('ATTEST expiry: in-block correlation of the v2 expire action', () => {

    it('ranks the block\'s expire actions against its expired requests, in the sweep order', async () => {
        const db = stubQueries(makeDb(), twoExpiries());
        const pairs = await db._correlateAttestationExpiries(detailConfig('getAttestation', REQ_A), 1480);
        expect(pairs.map(p => [p.expire_action_index, p.request.request_id]))
            .to.deep.equal([[461, REQ_A], [470, REQ_B]]);

        // The expired-request read must carry the sweep's ORDER BY verbatim, or the
        // ranks line up against a different order than the indexer minted.
        const q = findQuery(db, EXPIRED_REQS);
        expect(q.query).to.include('ORDER BY m.deadline_block ASC, m.action_index ASC');
        expect(q.args).to.deep.equal([1480]);
        // Never a query for a v2 ROW: _parseExpire writes none, so it is always empty.
        for(const c of captured(db))
            expect(c.query, 'queried for a v2 attests row that cannot exist').to.not.match(/version\s*=\s*2/);
    });

    it('REFUSES to correlate when the block\'s two lists disagree, rather than naming the wrong request', async () => {
        const plan = twoExpiries();
        plan[1][1] = [plan[1][1][0]];   // one expired request, two expire actions
        const db = stubQueries(makeDb(), plan);
        const pairs = await db._correlateAttestationExpiries(detailConfig('getAttestation', REQ_A), 1480);
        expect(pairs).to.deep.equal([]);
    });

    it('resolves the expire action for one request, and null for a request that did not expire', async () => {
        const db = stubQueries(makeDb(), twoExpiries());
        const cfg = detailConfig('getAttestation', REQ_B);
        expect(await db._resolveAttestationExpireAction(cfg,
            { request_id: REQ_B, request_status: 'expired', resolved_block: 1480 })).to.equal(470);
        // A pending request must not even read the block: it has no expiry to name.
        db.doQuery.resetHistory();
        expect(await db._resolveAttestationExpireAction(cfg,
            { request_id: REQ_B, request_status: 'pending', resolved_block: null })).to.equal(null);
        expect(db.doQuery.called).to.equal(false);
    });

    it('reads back from a v2 action_index to the request it retired', async () => {
        const db = stubQueries(makeDb(), twoExpiries());
        const req = await db.resolveAttestationExpireRequest(detailConfig('getAttestation', 470), 470, 1480);
        expect(req.request_id).to.equal(REQ_B);
        expect(req.action_index).to.equal(465);
    });
});

describe('ATTEST expiry: the injected callback EXECUTE', () => {

    const request = { request_id: REQ_A, contract_index: 12, callback_method: 'onPrice' };

    it('matches the callback on contract, method and the request id as first parameter', async () => {
        const db = stubQueries(makeDb(), [[CALLBACK_EXEC, [{ action_index: 462 }]]]);
        const idx = await db._deriveAttestationCallbackExecute(detailConfig('getAttestation', REQ_A), request);
        expect(idx).to.equal(462);
        const q = findQuery(db, CALLBACK_EXEC);
        expect(q.query).to.include("m.input_params LIKE CONCAT(?, '|%')");
        expect(q.args).to.deep.equal([12, 'onPrice', REQ_A]);
        expect(q.query).to.match(/ LIMIT \d+$/);
    });

    it('never lets a non-hex id reach the LIKE pattern', async () => {
        const db = stubQueries(makeDb(), [[CALLBACK_EXEC, [{ action_index: 462 }]]]);
        const idx = await db._deriveAttestationCallbackExecute(detailConfig('getAttestation', REQ_A),
            { request_id: '%', contract_index: 12, callback_method: 'onPrice' });
        expect(idx).to.equal(null);
        expect(db.doQuery.called, 'a wildcard id was handed to the pattern').to.equal(false);
    });

    it('returns null for a request that named no callback method', async () => {
        const db = stubQueries(makeDb(), [[CALLBACK_EXEC, [{ action_index: 462 }]]]);
        expect(await db._deriveAttestationCallbackExecute(detailConfig('getAttestation', REQ_A),
            { request_id: REQ_A, contract_index: 12, callback_method: null })).to.equal(null);
        expect(db.doQuery.called).to.equal(false);
    });
});

describe('Database#getAttestation after an expiry', () => {

    function expiredLegs(){
        return [{ action: 'ATTEST', action_index: 460, version: 0, request_id: REQ_A,
                  provider_id: 'http_get', contract_index: 12, callback_method: 'onPrice',
                  request_status: 'expired', resolved_block: 1480, deadline_block: 1400,
                  responsible_set_json: null, callback_params_json: null,
                  origin_chain: null, origin_action_index: null,
                  validator_signatures: null, callback_execute_action_index: null }];
    }

    function expiredPlan(){
        return twoExpiries().concat([
            [LIFECYCLE,     expiredLegs()],
            [CALLBACK_EXEC, [{ action_index: 462 }]]
        ]);
    }

    it('names the expire action and the injected callback the v1 stamp never covered', async () => {
        const db = stubQueries(makeDb(), expiredPlan());
        const [data] = await db.getAttestation(detailConfig('getAttestation', REQ_A));
        expect(data.expiry.expired).to.equal(true);
        expect(data.expiry.expire_action_index).to.equal(461);
        expect(data.callback_execute_action_index).to.equal(462);
        expect(data.callback_execute_derived).to.equal(true);
    });

    it('leaves both null when the correlation refuses and no execution matches', async () => {
        const db = stubQueries(makeDb(), [[LIFECYCLE, expiredLegs()]]);
        const [data] = await db.getAttestation(detailConfig('getAttestation', REQ_A));
        expect(data.expiry.expire_action_index).to.equal(null);
        expect(data.callback_execute_action_index).to.equal(null);
        expect(data.callback_execute_derived).to.equal(false);
    });

    it('takes NO extra read for a request that is not expired', async () => {
        const legs = expiredLegs();
        legs[0].request_status = 'fulfilled';
        const db = stubQueries(makeDb(), [[LIFECYCLE, legs]]);
        await db.getAttestation(detailConfig('getAttestation', REQ_A));
        expect(findQuery(db, EXPIRE_ACTIONS), 'correlated a request that never expired').to.not.exist;
        expect(findQuery(db, CALLBACK_EXEC)).to.not.exist;
    });

    it('serves the lifecycle page for the EXPIRE action\'s own action_index', async () => {
        // The seed read is matched FIRST: it shares the ATTEST/format-2 predicate with the
        // correlation read and differs only by keying on the action index.
        const plan = [['WHERE a1.action_index=?', [{ block_index: 1480, action_format: 2 }]]].concat(expiredPlan());
        const db = stubQueries(makeDb(), plan);
        // getAttestationByActionIndex finds no attests row for a v2 (there is none), so
        // a page that trusts that lookup answers NOT FOUND for the expire's own index.
        db.getAttestationByActionIndex = sinon.stub().resolves(null);
        const [data] = await db.getAttestation(detailConfig('getAttestation', 461));
        expect(data).to.not.equal(null);
        expect(data.request_id).to.equal(REQ_A);
    });
});

describe('ATTEST v2 action detail: the page names its request', () => {

    function ctx(db){
        return { db, config: detailConfig('getActionData', 461), action_index: 461, util };
    }

    it('fills request_id, provider, contract and the callback link from the correlation', async () => {
        const db = stubQueries(makeDb(), twoExpiries().concat([[CALLBACK_EXEC, [{ action_index: 462 }]]]));
        const data = { version: null, action_format: 2, block_index: 1480, request_id: null };
        await consensus.ATTEST.afterMain(ctx(db), data);
        expect(data.version).to.equal(2);
        expect(data.request_id).to.equal(REQ_A);
        expect(data.provider_id).to.equal('http_get');
        expect(data.contract_index).to.equal(12);
        expect(data.request_action_index).to.equal(460);
        expect(data.request_status).to.equal('expired');
        expect(data.callback_execute_action_index).to.equal(462);
    });

    it('leaves a v0/v1 row untouched: its own attests row already answered', async () => {
        const db = stubQueries(makeDb(), twoExpiries());
        const data = { version: 0, action_format: 0, block_index: 1480, request_id: REQ_B,
                       provider_id: 'llm', validator_signatures: null };
        await consensus.ATTEST.afterMain(ctx(db), data);
        expect(data.request_id).to.equal(REQ_B);
        expect(db.doQuery.called, 'correlated a version that persists its own row').to.equal(false);
    });
});

/* ------------------------------------------------------------------ *
 * Client render, driven through the SHIPPED client source in JSDOM,
 * exactly as content-client-contract-meta-render.test.js drives it.
 * ------------------------------------------------------------------ */

const CLIENT_SRC = require('../helpers/content-source.js').clientSource();
const JQUERY     = path.resolve(__dirname, '../../src/content/js/jquery.min.js');
const ACTION_HTML = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/action.html'), 'utf8');

function bootClient(bodyHtml){
    const dom = new JSDOM('<!doctype html><html><body>' + (bodyHtml || '') + '</body></html>', {
        runScripts: 'outside-only',
        url: 'https://xchain.test/RDOGE/action/461'
    });
    const win = dom.window;
    win.numeral = function(v){ return { format: function(){ return String(v); } }; };
    win.moment  = { unix: function(){ return { utcOffset: function(){ return { format: function(){ return ''; } }; } }; } };
    win.eval(fs.readFileSync(JQUERY, 'utf8'));
    win.jQuery.fn.ready = function(){ return this; };
    win.eval(CLIENT_SRC);
    win.XC = win.XC || {};
    win.XC.coin  = 'RDOGE';
    win.XC.chain = 'DOGE';
    return win;
}

// The #info-attest panel is lifted out of the SHIPPED action.html, so the render
// writes into the real cells rather than into a hand-copied table.
function attestPanelHtml(){
    const anchor = ACTION_HTML.indexOf('attest-type');
    if(anchor < 0) throw new Error('the #info-attest panel was not found in action.html');
    const start = ACTION_HTML.lastIndexOf('<div', ACTION_HTML.lastIndexOf('<table', anchor));
    const end   = ACTION_HTML.indexOf('</table>', ACTION_HTML.indexOf('attest-batch-chunk'));
    return '<div id="info-attest">' + ACTION_HTML.slice(start, end + 8) + '</div>';
}

describe('ATTEST v2 action page render', () => {

    it('links the expire page back to its lifecycle page, its request and its callback', () => {
        const win = bootClient(attestPanelHtml());
        win.showAttestDetails({
            version: 2, action_format: 2, request_id: REQ_A, provider_id: 'http_get',
            contract_index: 12, request_action_index: 460, callback_execute_action_index: 462
        });
        const $ = win.jQuery;
        const cell = $('#info-attest .attest-request-id');
        expect(cell.find('a[href="/RDOGE/attestation/' + REQ_A + '"]').length,
            'the expire page still names no attestation').to.equal(1);
        expect(cell.find('a[href="/RDOGE/action/460"]').length).to.equal(1);
        expect(cell.find('a[href="/RDOGE/action/462"]').length).to.equal(1);
        expect($('#info-attest .attest-provider').text()).to.equal('http_get');
        expect($('#info-attest .attest-type').text()).to.contain('Expire (v2)');
    });

    it('says the request is not recorded when the correlation resolved nothing', () => {
        const win = bootClient(attestPanelHtml());
        win.showAttestDetails({ version: 2, action_format: 2, request_id: null, provider_id: null });
        const $ = win.jQuery;
        expect($('#info-attest .attest-expire-unresolved').length).to.equal(1);
        expect($('#info-attest .attest-request-id a').length).to.equal(0);
    });

    it('leaves a v0 request page rendering the plain hash, with no attestation link', () => {
        const win = bootClient(attestPanelHtml());
        win.showAttestDetails({
            version: 0, action_format: 0, request_id: REQ_A, provider_id: 'http_get',
            contract_index: 12, fee_payer: null, fee_amount: null, gas_escrow: null,
            callback_method: 'onPrice', redundancy: 3, deadline_block: 1400,
            request_status: 'pending', payload: 'https://example.invalid', callback_params: null
        });
        const $ = win.jQuery;
        expect($('#info-attest .attest-request-id a').length).to.equal(0);
        expect($('#info-attest .attest-request-id').text()).to.contain('aaaa');
    });
});

/* ------------------------------------------------------------------ *
 * The attestations LIST row. The list linked a v0 row's Request ID cell
 * and its view button to /{COIN}/action/<the fee-payer ADDRESS>, which
 * answers 200 with a blank action page: the generic tail parse read
 * fee_payer as the action index on this feed alone.
 * ------------------------------------------------------------------ */

describe('attestations list row', () => {

    // getAttestations shaping order (XChainExplorer.getPagingDataResults):
    // count_reverse, block_index, timestamp, source, version, provider_id, request_id,
    // request_status, response_status, status, action_index, payload,
    // callback_params_json, fee_payer.
    function attestationRow(version){
        return [1, 1480, 1700000000, 'mSource', version, 'http_get', REQ_A,
                'expired', null, 1, 460, 'https://example.invalid', '[]', 'mFeePayerAddr'];
    }

    function renderRow(data, columns){
        const win = bootClient('<table id="datatable-attestation"></table>');
        const $ = win.jQuery;
        const captured = {};
        $.fn.dataTable = function(config){ captured.config = config; return this; };
        $.fn.DataTable = $.fn.dataTable;
        win.loadDatatablesData('RDOGE', 'attestation', null, null);
        expect(captured.config, 'loadDatatablesData did not reach .dataTable()').to.be.an('object');
        const row = $('<tr>')[0];
        for(let i = 0; i < columns; i++) $(row).append($('<td>'));
        captured.config.createdRow.call(captured.config, row, data, 0);
        return { $, row };
    }

    [0, 1].forEach(function(version){
        it('[v' + version + '] links the row to its ACTION index, never to the fee-payer address', () => {
            const { $, row } = renderRow(attestationRow(version), 10);
            const hrefs = $(row).find('a').map(function(){ return this.getAttribute('href'); }).get();
            expect(hrefs.length, 'a lifecycle row with no link at all').to.be.greaterThan(0);
            hrefs.forEach(function(h){
                expect(h, 'an address reached an /action/ route').to.not.contain('mFeePayerAddr');
            });
            expect(hrefs).to.include('/RDOGE/action/460');
        });
    });
});
