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
 * The hub federation registry has NO page of its own. Its hub-only
 * columns (network addr, served chains, registration status) are folded onto
 * the existing on-chain /validators table, so the staked active set and the
 * hub's knowledge of the same signing pubkey read as one table.
 *
 * Covered end to end:
 *   - db.getFederationRegistry(): hub JSON-RPC first, legacy co-located hub
 *     schema as fallback, NULL (unknown) when neither is reachable
 *   - db.getData(): one registry read per page, folded onto every row;
 *     'unregistered' only when the registry actually answered
 *   - the /explorer/validators row shape: hub columns sit BEFORE status and
 *     action_index, which the client reads length-relative
 *   - the shipped client renderer + the shipped validators.html columns
 ********************************************************************/

'use strict';

const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { JSDOM }  = require('jsdom');
const { expect } = require('chai');

const Utility                  = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig, mockReq, mockRes } = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

const PK_A = 'aa'.repeat(32);
const PK_B = 'bb'.repeat(32);

function makeDb(hubOperational) {
    return new Database({ configInfo, util, hubOperational });
}

function validatorConfig(overrides = {}) {
    return makeConfig({ type: 'explorer', data: { method: 'getValidators', ...overrides } });
}

describe('db.getFederationRegistry()', function () {

    afterEach(function () { sinon.restore(); });

    it('reads the hub registry over JSON-RPC and keys it by lowercased pubkey', async function () {
        const ops = {
            enabled: () => true,
            getFederationValidators: sinon.stub().resolves([
                { signing_pubkey: PK_A.toUpperCase(), addr: 'v1.example.com:10001', chains: 'BTC,LTC', status: 'active' }
            ])
        };
        const db = makeDb(ops);
        const registry = await db.getFederationRegistry(validatorConfig());
        expect(registry[PK_A]).to.deep.equal({
            addr: 'v1.example.com:10001', chains: 'BTC,LTC', status: 'active'
        });
    });

    it('leaves a column the hub did not send as null, never the string "undefined"', async function () {
        // A hub older than the getvalidators `chains` column add returns rows
        // without it; the page must show "-", not "undefined".
        const ops = {
            enabled: () => true,
            getFederationValidators: sinon.stub().resolves([
                { signing_pubkey: PK_A, addr: 'v1.example.com:10001', status: 'active' }
            ])
        };
        const db = makeDb(ops);
        const registry = await db.getFederationRegistry(validatorConfig());
        expect(registry[PK_A].chains).to.equal(null);
    });

    it('falls back to the legacy co-located hub schema when the RPC read returns null', async function () {
        const ops = { enabled: () => true, getFederationValidators: sinon.stub().resolves(null) };
        const db  = makeDb(ops);
        db.checkpointDb = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };
        const doQuery = sinon.stub(db, 'doQuery').resolves([
            { signing_pubkey: PK_B, addr: 'v2.example.com:10001', chains: 'DOGE', status: 'suspended' }
        ]);
        const registry = await db.getFederationRegistry(validatorConfig());
        expect(doQuery.firstCall.args[1]).to.contain('`XChain_Hub`.validators');
        expect(registry[PK_B].status).to.equal('suspended');
    });

    it('returns null (unknown) with no hub endpoint and no co-located hub schema', async function () {
        const db = makeDb(null);
        db.checkpointDb = null;
        expect(await db.getFederationRegistry(validatorConfig())).to.equal(null);
    });

    it('returns null (unknown) when the legacy schema read throws', async function () {
        const db = makeDb(null);
        db.checkpointDb = { BTC: { name: 'XChain_Hub' } };
        sinon.stub(db, 'doQuery').rejects(new Error('no pool'));
        expect(await db.getFederationRegistry(validatorConfig())).to.equal(null);
    });
});

describe('db.getData() folds the hub registry onto /validators rows', function () {

    afterEach(function () { sinon.restore(); });

    // getQuery returning an OBJECT short-circuits the SQL path in getData, so the
    // fold can be exercised without a database.
    function stubRows(db, rows) {
        sinon.stub(db, 'getQuery').resolves([rows, null, rows.length]);
    }

    it('adds hub_addr / hub_chains / hub_status to a registered validator', async function () {
        const db = makeDb(null);
        stubRows(db, [{ signing_pubkey: PK_A.toUpperCase(), amount: '100' }]);
        sinon.stub(db, 'getFederationRegistry').resolves({
            [PK_A]: { addr: 'v1.example.com:10001', chains: 'BTC,LTC', status: 'active' }
        });
        const [data] = await db.getData(validatorConfig());
        expect(data[0].hub_addr).to.equal('v1.example.com:10001');
        expect(data[0].hub_chains).to.equal('BTC,LTC');
        expect(data[0].hub_status).to.equal('active');
    });

    it('marks a staked pubkey the registry does not list as unregistered', async function () {
        const db = makeDb(null);
        stubRows(db, [{ signing_pubkey: PK_B, amount: '100' }]);
        sinon.stub(db, 'getFederationRegistry').resolves({
            [PK_A]: { addr: 'v1.example.com:10001', chains: 'BTC', status: 'active' }
        });
        const [data] = await db.getData(validatorConfig());
        expect(data[0].hub_status).to.equal('unregistered');
        expect(data[0].hub_addr).to.equal(null);
    });

    it('leaves the columns null (unknown) when no registry is reachable', async function () {
        // An unreachable hub must not libel every validator as unregistered.
        const db = makeDb(null);
        stubRows(db, [{ signing_pubkey: PK_A, amount: '100' }]);
        sinon.stub(db, 'getFederationRegistry').resolves(null);
        const [data] = await db.getData(validatorConfig());
        expect(data[0].hub_status).to.equal(null);
        expect(data[0].hub_addr).to.equal(null);
        expect(data[0].hub_chains).to.equal(null);
    });

    it('reads the registry ONCE per page, not once per row', async function () {
        const db = makeDb(null);
        stubRows(db, [
            { signing_pubkey: PK_A, amount: '1' },
            { signing_pubkey: PK_B, amount: '2' }
        ]);
        const registry = sinon.stub(db, 'getFederationRegistry').resolves({});
        await db.getData(validatorConfig());
        expect(registry.callCount).to.equal(1);
    });

    it('does not touch the registry for other list methods', async function () {
        const db = makeDb(null);
        stubRows(db, [{ signing_pubkey: PK_A, amount: '1' }]);
        const registry = sinon.stub(db, 'getFederationRegistry').resolves({});
        await db.getData(makeConfig({ type: 'explorer', data: { method: 'getStakes' } }));
        expect(registry.callCount).to.equal(0);
    });
});

describe('/explorer/validators datatables row shape', function () {

    let getDataResult = [[], null];

    const mockApp = { use: () => {}, get: () => {}, post: () => {}, enable: () => {} };
    const express = () => mockApp;
    express.static = () => {};
    express.json   = () => {};

    class MockDB {
        constructor() {}
        async init() {}
        getMaxMethodResults() { return 100; }
        async getData() { return getDataResult; }
    }

    const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
        'express': express,
        './db.js': MockDB,
        'fs': { existsSync: () => true, readFileSync: () => 'mock' }
    });

    afterEach(function () { sinon.restore(); });

    async function validatorRow(row) {
        getDataResult = [[row], 1];
        const explorer = new XChainExplorer(mockApp, createConfigInfoStub());
        const req = mockReq('/BTC/explorer/validators', { start: 0, length: 10 });
        const res = mockRes();
        await explorer.processRequest(req, res);
        const body = (typeof res._body === 'string') ? JSON.parse(res._body) : res._body;
        return body.data[0];
    }

    const BASE_ROW = {
        action: 'STAKE', action_index: 4242, block_index: 900001, timestamp: 1750000000,
        source: 'bc1qsource', signing_pubkey: PK_A, version: 1, amount: '1000',
        activation_block: 900011, deactivation_block: null, status: 'valid'
    };

    it('carries the hub addr / chains / registration status columns', async function () {
        const row = await validatorRow({
            ...BASE_ROW, hub_addr: 'v1.example.com:10001', hub_chains: 'BTC,LTC', hub_status: 'active'
        });
        expect(row[7]).to.equal('v1.example.com:10001');
        expect(row[8]).to.equal('BTC,LTC');
        expect(row[9]).to.equal('active');
    });

    it('keeps status second-to-last and action_index LAST (client reads them length-relative)', async function () {
        const row = await validatorRow({
            ...BASE_ROW, hub_addr: null, hub_chains: null, hub_status: 'unregistered'
        });
        expect(row[row.length - 1]).to.equal(4242, 'action_index is the view link + paging cursor');
        expect(row[row.length - 2]).to.equal(1, 'status drives the row color');
        // The activation/deactivation tails stay on the row, just ahead of them.
        expect(row[10]).to.equal(900011);
        expect(row[11]).to.equal(null);
    });
});

describe('client: the validators table renders the hub registry columns', function () {

    // formatters.js is read alongside xchain.js because the cell-rendering helpers
    // moved there in the component milestone.
    const SRC = fs.readFileSync(path.resolve(__dirname, '../../src/content/js/xchain.js'), 'utf8')
        + '\n' + fs.readFileSync(path.resolve(__dirname, '../../src/content/js/formatters.js'), 'utf8');
    const HTML = fs.readFileSync(path.resolve(__dirname, '../../src/content/html/validators.html'), 'utf8');

    // Slice the SHIPPED createdRow callback out of loadDatatablesData by walking
    // braces, so this drives production code rather than a copy that can drift.
    function extractCreatedRow() {
        const sig = 'createdRow: function(row, data, idx)';
        const start = SRC.indexOf(sig);
        if (start < 0) throw new Error('createdRow not found in xchain.js');
        const braceStart = SRC.indexOf('{', start + sig.length - 1);
        let depth = 0, i = braceStart;
        for (; i < SRC.length; i++) {
            const c = SRC[i];
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
        }
        return 'var createdRow = function(row, data, idx)' + SRC.slice(braceStart, i) + ';';
    }

    function extractFn(name) {
        const sig = 'function ' + name + '(';
        const start = SRC.indexOf(sig);
        if (start < 0) throw new Error('function not found in xchain.js: ' + name);
        const braceStart = SRC.indexOf('{', start);
        let depth = 0, i = braceStart;
        for (; i < SRC.length; i++) {
            const c = SRC[i];
            if (c === '{') depth++;
            else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
        }
        return SRC.slice(start, i);
    }

    // Count the <th> cells the shipped page declares for the validators table.
    function pageColumns() {
        const thead = HTML.slice(HTML.indexOf('<thead>'), HTML.indexOf('</thead>'));
        return (thead.match(/<th[\s>]/g) || []).length;
    }

    // Render one row through the shipped createdRow, into a table with the
    // shipped column count.
    function render(data) {
        const cells = Array.from({ length: pageColumns() }, () => '<td></td>').join('');
        const dom = new JSDOM(
            '<!DOCTYPE html><body><table id="datatable-validator"><tbody><tr>' + cells +
            '</tr></tbody></table></body>', { runScripts: 'outside-only' });
        dom.window.eval(fs.readFileSync(path.resolve(__dirname, '../../src/content/js/jquery.min.js'), 'utf8'));
        dom.window.eval(`
            var coin = 'BTC', action = 'validator', type = null;
            function formatLink(href, text){ return '<a href="' + href + '">' + text + '</a>'; }
            function formatLivestamp(t){ return String(t); }
            function formatAmount(v){ return String(v); }
            var numeral = function(v){ return { format: function(){ return String(v); } }; };
        `);
        dom.window.eval(extractFn('isNull'));
        dom.window.eval(extractFn('escapeHtml'));
        dom.window.eval(extractFn('formatHash'));
        dom.window.XC = { coin: 'BTC' };
        dom.window.eval(extractCreatedRow());
        const row = dom.window.document.querySelector('tr');
        dom.window.createdRow(row, data, 0);
        return { dom, row };
    }

    function validatorData(hub_addr, hub_chains, hub_status) {
        return [1, 900001, 1750000000, 'bc1qsource', PK_A, 1, '1000',
                hub_addr, hub_chains, hub_status, 900011, null, 1, 4242];
    }

    it('the shipped page declares the three hub columns', function () {
        expect(HTML).to.contain('Hub Address');
        expect(HTML).to.contain('Chains');
        expect(HTML).to.contain('Registration');
        // The loading placeholder must span every declared column.
        expect(HTML).to.contain('colspan="' + pageColumns() + '"');
    });

    it('renders addr, chains and an active registration badge', function () {
        const { row } = render(validatorData('v1.example.com:10001', 'BTC,LTC', 'active'));
        const tds = row.querySelectorAll('td');
        expect(tds[7].textContent).to.equal('v1.example.com:10001');
        expect(tds[8].textContent).to.equal('BTC,LTC');
        expect(tds[9].textContent).to.equal('active');
        expect(tds[9].querySelector('span').className).to.contain('text-bg-success');
    });

    it('renders an unreachable registry as unknown and a missing entry as unregistered', function () {
        const unknown = render(validatorData(null, null, null)).row.querySelectorAll('td');
        expect(unknown[7].textContent).to.equal('-');
        expect(unknown[8].textContent).to.equal('-');
        expect(unknown[9].textContent).to.equal('unknown');

        const missing = render(validatorData(null, null, 'unregistered')).row.querySelectorAll('td');
        expect(missing[9].textContent).to.equal('unregistered');
        expect(missing[9].querySelector('span').className).to.contain('text-bg-secondary');
    });

    it('[XSS] hub-supplied registry strings render as inert text', function () {
        const payload = '<img src=x onerror=alert(1)>';
        const { row } = render(validatorData(payload, payload, payload));
        const tds = row.querySelectorAll('td');
        expect(tds[7].querySelector('img')).to.equal(null);
        expect(tds[7].textContent).to.equal(payload);
        expect(tds[8].querySelector('img')).to.equal(null);
        expect(tds[9].querySelector('img')).to.equal(null);
        expect(tds[9].textContent).to.equal(payload);
    });

    it('the view link still points at the action_index, not the deactivation tail', function () {
        const { row } = render(validatorData('v1.example.com:10001', 'BTC', 'active'));
        const tds = row.querySelectorAll('td');
        expect(tds[tds.length - 1].querySelector('a').getAttribute('href'))
            .to.equal('/BTC/action/4242');
    });

    it('there is no second federation-registry page', function () {
        const pages = fs.readdirSync(path.resolve(__dirname, '../../src/content/html'));
        const extra = pages.filter(p => /federation|validator_registry|registry/i.test(p));
        expect(extra).to.deep.equal([], 'the hub registry folds into validators.html');
    });
});
