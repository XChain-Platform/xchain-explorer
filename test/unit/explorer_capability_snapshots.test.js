'use strict';

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
 * Unit tests for M3.4 (row 21): Database#getCapabilitySnapshots (src/db/index.js),
 * the routed, paged sibling of the existing raw reader
 * Database#getCapabilitySnapshotRows (db/index.js:7673-7682, called ad hoc from
 * checkpoint-verify) and its src/content/html/capability_snapshots.html page
 * fragment. Modeled on test/unit/explorer.checkpoints.test.js's "M2.1 data
 * leg" describe block (Database#getCheckpoints), the sibling hub-mirrored
 * list method built the same seam.
 *
 * THE ROW'S SUBSTANCE (spec §5's corrected pattern for M3.4): capability_snapshots
 * is NOT hub-RPC data. It is self-synced by the explorer into the co-located
 * checkpoint-mirror schema and must be read ONLY via
 * `checkpointSource(config).capTable` -- never through HubOperationalCache,
 * never via a new hub RPC call. The milestone acceptance test drives exactly
 * this: the list must answer for a named block WITH THE HUB UNREACHABLE. The
 * "never touches hub RPC" and "answers with hub down" describe blocks below
 * assert that property directly rather than assuming it.
 *
 * These tests exercise the real db/index.js method once the main loop splices in
 * the proposal at
 * /private/tmp/claude-501/-Users-jdog-Sites-XChain-Platform/2638fcd2-4d57-4275-acf1-aba41d9c05fc/scratchpad/m3-proposal-row21.md
 * (getCapabilitySnapshots itself, its getQueryWhereSql branch, its
 * cursorPagedMethods / getQueryOffsetSql cursor-map entries, and the
 * getPagingDataResults row branch in XChainExplorer.js). Until spliced they
 * are expected to fail (method undefined / branch missing), per the seam
 * contract: written to be run, not to pass vacuously.
 */

const { expect }  = require('chai');
const proxyquire  = require('proxyquire');
const sinon       = require('sinon');
const fs          = require('fs');
const path        = require('path');

const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig, makeExplorerConfig } = require('../fixtures/mock-query-args.js');

const { makeRealDb, HUB } = require('./explorer_capability_snapshots.test/helpers.js');

require('./explorer_capability_snapshots.test/data_leg.js');

// ─────────────────────────────────────────────────────────────────────────
// Regression: the existing raw reader getCapabilitySnapshotRows (db/index.js:7673-7682,
// called ad hoc from checkpoint-verify) must be left unbroken and undupli-
// cated by the new routed sibling above -- the seam contract requires both
// to keep working, whether or not they end up sharing a predicate.
// ─────────────────────────────────────────────────────────────────────────

describe('Database#getCapabilitySnapshotRows (existing raw reader, unchanged)', () => {

    it('still binds [String(capability), Number(snapshotBlock)] positionally, unaffected by the new routed method', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const doQueryStub = sinon.stub(db, 'doQuery').resolves([]);
        await db.getCapabilitySnapshotRows(makeConfig({ coin: 'BTC' }), 'oracle_publish', 100);
        const [, query, args] = doQueryStub.firstCall.args;
        expect(query).to.include('`XChain_Hub`.capability_snapshots');
        expect(query).to.include('WHERE capability = ? AND snapshot_block = ?');
        expect(args).to.deep.equal(['oracle_publish', 100]);
    });

    it('selects exactly signing_pubkey, amount, source (no id/created_at) -- the verify path\'s narrower shape', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const doQueryStub = sinon.stub(db, 'doQuery').resolves([]);
        await db.getCapabilitySnapshotRows(makeConfig({ coin: 'BTC' }), 'oracle_publish', 100);
        const [, query] = doQueryStub.firstCall.args;
        const selectClause = query.slice(0, query.indexOf('FROM'));
        expect(selectClause).to.include('signing_pubkey');
        expect(selectClause).to.include('amount');
        expect(selectClause).to.include('source');
        expect(selectClause).to.not.include('m.id');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// XChainExplorer.getPagingDataResults branch (M3.4 datatables leg). Modeled
// on test/unit/explorer.paging.test.js's rig; that file is a shared seam
// file this row may not edit, so the branch is exercised here instead.
// ─────────────────────────────────────────────────────────────────────────

const mockApp = { use: () => {}, get: () => {}, post: () => {}, enable: () => {} };
const express  = () => mockApp;
express.static = () => {};
express.json   = () => {};

class MockDB {
    constructor() {}
    async init() {}
    getMaxMethodResults() { return 100; }
}

const XChainExplorer = proxyquire('../../src/XChainExplorer.js', {
    'express': express,
    './db/index.js': MockDB
});

function makeExplorer() {
    return new XChainExplorer(mockApp, createConfigInfoStub());
}

function makeCapSnapRow(overrides = {}) {
    return Object.assign({
        id:             7,
        snapshot_block: 100,
        capability:     'oracle_publish',
        signing_pubkey: 'a'.repeat(64),
        amount:         '50000.00000000',
        source:         'src_a',
        created_at:     1700000000
    }, overrides);
}

describe('XChainExplorer.getPagingDataResults: getCapabilitySnapshots row shape', () => {

    it('emits [count_reverse, created_at, snapshot_block, capability, signing_pubkey, amount, source, id] (8 elements, id LAST as the paging cursor)', () => {
        const explorer = makeExplorer();
        const row  = makeCapSnapRow();
        const cfg  = makeExplorerConfig('getCapabilitySnapshots', null, null, { start: 0, length: 10 });
        const [info] = explorer.getPagingDataResults(cfg, [row], 1);
        expect(info).to.be.an('array').with.lengthOf(8);
        expect(info[1]).to.equal(row.created_at);
        expect(info[2]).to.equal(row.snapshot_block);
        expect(info[3]).to.equal(row.capability);
        expect(info[4]).to.equal(row.signing_pubkey);
        expect(info[5]).to.equal(row.amount);
        expect(info[6]).to.equal(row.source);           // second-to-last: consumed as `status` by createdRow
        expect(info[7]).to.equal(row.id);                // last: the paging cursor
    });

    it('empty data returns an empty array', () => {
        const explorer = makeExplorer();
        const cfg  = makeExplorerConfig('getCapabilitySnapshots', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, [], 0);
        expect(result).to.be.an('array').that.is.empty;
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Page fragment sanity: src/content/html/capability_snapshots.html, read
// directly off disk (no server needed). Checks the conventions the
// datatable-endpoint guard and the createdRow row-count convention would
// otherwise catch: id="datatable-<singular action>", colspan == <th> count,
// loadDatatablesData wired to the singular action name, and pageInfo set.
// ─────────────────────────────────────────────────────────────────────────

describe('capability_snapshots.html page fragment', () => {

    const html = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'content', 'html', 'capability_snapshots.html'),
        'utf8'
    );

    it('datatable id matches the singular action (capability_snapshot), per xchain.js:1133', () => {
        expect(html).to.match(/id="datatable-capability_snapshot"/);
    });

    it('has exactly 7 <th> cells, matching the 8-element row (id hidden as the trailing cursor)', () => {
        const theadMatch = html.match(/<thead>[\s\S]*?<\/thead>/);
        expect(theadMatch, 'no <thead> found').to.not.equal(null);
        // `<th[\s>]` (not a bare `<th`) so the `<thead>` tag itself is not
        // miscounted as a `<th>` cell.
        const thCount = (theadMatch[0].match(/<th[\s>]/g) || []).length;
        expect(thCount).to.equal(7);
    });

    it('the loading row colspan equals the <th> count (7)', () => {
        expect(html).to.match(/colspan="7"/);
    });

    it('calls loadDatatablesData with the singular action name capability_snapshot', () => {
        expect(html).to.match(/loadDatatablesData\(XC\.coin,\s*'capability_snapshot',\s*null,\s*null\)/);
    });

    it('sets pageInfo.title/description/canonical and calls updatePageInfo()', () => {
        expect(html).to.include('XC.pageInfo.title');
        expect(html).to.include('XC.pageInfo.description');
        expect(html).to.include('XC.pageInfo.canonical');
        expect(html).to.include('updatePageInfo()');
    });

    it('makes the historical-electorate semantics legible on the page (not just a bare amount column)', () => {
        // The row's stated requirement: "which keys carried which weight at
        // block N" must read as electorate/weight semantics, not a bare number.
        expect(html.toLowerCase()).to.include('electorate');
        expect(html).to.include('Stake Weight');
    });
});
