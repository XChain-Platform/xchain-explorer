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
 * Unit tests for M3.4 (row 21): Database#getCapabilitySnapshots (src/db.js),
 * the routed, paged sibling of the existing raw reader
 * Database#getCapabilitySnapshotRows (db.js:7673-7682, called ad hoc from
 * checkpoint-verify) and its src/content/html/capability_snapshots.html page
 * fragment. Modeled on test/unit/explorer.checkpoints.test.js's "M2.1 data
 * leg" describe block (Database#getCheckpoints), the sibling hub-mirrored
 * list method built the same seam.
 *
 * THE ROW'S SUBSTANCE (spec §5's corrected pattern for M3.4): capability_snapshots
 * is NOT hub-RPC data. It is self-synced by the explorer into the co-located
 * checkpoint-mirror schema and must be read ONLY via
 * `_checkpointSource(config).capTable` -- never through HubOperationalCache,
 * never via a new hub RPC call. The milestone acceptance test drives exactly
 * this: the list must answer for a named block WITH THE HUB UNREACHABLE. The
 * "never touches hub RPC" and "answers with hub down" describe blocks below
 * assert that property directly rather than assuming it.
 *
 * These tests exercise the real db.js method once the main loop splices in
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

const Utility = require('../../src/utility.js');

const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig, makeExplorerConfig } = require('../fixtures/mock-query-args.js');

// ─────────────────────────────────────────────────────────────────────────
// Database#getCapabilitySnapshots (real db.js SQL-generating method, mariadb
// stubbed out, no live connection) -- same rig as explorer.checkpoints.test.js's
// DatabaseReal / makeRealDb.
// ─────────────────────────────────────────────────────────────────────────

const DatabaseReal = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

function makeRealDb(explorerOverrides = {}) {
    const mockConfigInfo = createConfigInfoStub();
    const util           = new Utility(mockConfigInfo);
    const mockExplorer   = { configInfo: mockConfigInfo, util, ...explorerOverrides };
    return new DatabaseReal(mockExplorer);
}

// The mirror is chain-agnostic (capability_snapshots carries no chain/network
// columns -- see the existing getCapabilitySnapshotRows comment at db.js:7669-7672),
// so unlike getCheckpoints' HUB fixture, no chain/network filterParams are
// expected to be bound against this table. See the proposal's header note:
// this contradicts the seam contract's generic "filterParams come FIRST in
// your args array" guidance for mirror-backed rows, and the raw reader
// already proves it by binding only [capability, snapshotBlock].
const HUB = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

function capSnapConfig(extras = {}) {
    return makeConfig({
        data: {
            method: 'getCapabilitySnapshots',
            search: null,
            type: null,
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: 'm.id IS NOT NULL', offset: '', offsetArgs: [] }
            },
            ...extras
        }
    });
}

describe('Database#getCapabilitySnapshots (M3.4 data leg)', () => {

    it('returns a 3-element array', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const result = await db.getCapabilitySnapshots(capSnapConfig());
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('database-qualifies capability_snapshots (capTable), aliased m, for both the count and the list query', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getCapabilitySnapshots(capSnapConfig());
        expect(query).to.include('`XChain_Hub`.capability_snapshots m');
        expect(count).to.include('`XChain_Hub`.capability_snapshots m');
        // Must read the capTable accessor, never the state_checkpoints table
        // sibling _checkpointSource also resolves.
        expect(query).to.not.include('.state_checkpoints');
    });

    it('emits exactly the seam-contract column list, in order, under the exact names', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCapabilitySnapshots(capSnapConfig());
        const cols = ['m.id', 'm.snapshot_block', 'm.capability', 'm.signing_pubkey', 'm.amount', 'm.source', 'm.created_at'];
        let cursor = -1;
        for (const col of cols) {
            const idx = query.indexOf(col);
            expect(idx, `missing or out of order: ${col}`).to.be.greaterThan(cursor);
            cursor = idx;
        }
    });

    it('the list query carries a LIMIT sourced from config.data.sql.limit', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCapabilitySnapshots(capSnapConfig({ sql: { limit: 37 } }));
        expect(query.trim().endsWith('LIMIT 37')).to.equal(true);
    });

    it('orders by m.id, the id-keyed paging cursor (auto-increment PK: monotonic and unique)', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getCapabilitySnapshots(capSnapConfig({ sql: { order: 'ASC' } }));
        expect(query).to.match(/ORDER BY m\.id ASC/);
    });

    it('honours the offset cursor fragment from config.data.sql.where.offset', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const OFFSET_SQL = ' AND m.id < ?';
        const [query] = await db.getCapabilitySnapshots(capSnapConfig({
            sql: { where: { offset: OFFSET_SQL } }
        }));
        const orderIdx  = query.indexOf('ORDER BY m.id');
        const offsetIdx = query.indexOf(OFFSET_SQL);
        expect(offsetIdx).to.be.greaterThan(-1);
        expect(orderIdx).to.be.greaterThan(-1);
        expect(offsetIdx).to.be.lessThan(orderIdx);
    });

    it('returns args: null (getData supplies [config.data.search] itself on a filtered TYPE query)', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [, args] = await db.getCapabilitySnapshots(capSnapConfig({ type: 'block', search: '100' }));
        expect(args).to.equal(null);
    });

    it('no checkpoint mirror DB configured -> fails loud (no silent empty read)', async () => {
        const db = makeRealDb();
        let err = null;
        try { await db.getCapabilitySnapshots(capSnapConfig()); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
    });

    it('rejects an unsafe mirror DB identifier by failing loud (no identifier injection)', async () => {
        const db = makeRealDb();
        db.checkpointDb = { BTC: { name: 'bad name; DROP', chain: 'BTC', network: 'mainnet' } };
        let err = null;
        try { await db.getCapabilitySnapshots(capSnapConfig()); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.not.include('bad name');
    });

    it('getMaxMethodResults clamps getCapabilitySnapshots to the platform default of 100', () => {
        const db = makeRealDb();
        expect(db.getMaxMethodResults('getCapabilitySnapshots')).to.equal(100);
    });

    it('is registered in cursorPagedMethods so next/prev preserve the client cursor', () => {
        const db = makeRealDb();
        expect(db.cursorPagedMethods).to.include('getCapabilitySnapshots');
    });

    it('getQueryOffsetSql gives getCapabilitySnapshots the m.id cursor field (id-keyed, no action_index)', async () => {
        const db = makeRealDb();
        const config = makeConfig({
            data: { method: 'getCapabilitySnapshots', offset: { action: 'next', start: 42, stop: false } }
        });
        const [offsetSql, offsetArgs] = await db.getQueryOffsetSql(config);
        expect(offsetSql).to.include('m.id');
        expect(offsetSql).to.not.include('m.action_index');
        expect(offsetArgs).to.deep.equal([42]);
    });

    // ── THE ROW'S SUBSTANCE: never touches HubOperationalCache, never an RPC ──

    it('never references hubOperational / HubOperationalCache in its own source (static guard against a re-added hub RPC)', () => {
        const db = makeRealDb();
        const src = db.getCapabilitySnapshots.toString();
        expect(src).to.not.match(/hubOperational/i);
        expect(src).to.not.match(/HubOperationalCache/i);
        expect(src).to.not.match(/_pageHubOperationalRows/);
        expect(src).to.not.match(/_hubOperationalOutage/);
        // Confirms it reads the checkpoint-mirror helper, not the RPC-first
        // _hubSource helper getValidatorCapabilities/getGovernanceProposals use.
        expect(src).to.match(/_checkpointSource/);
    });

    it('answers WITH THE HUB UNREACHABLE: resolves purely from the co-located mirror when hub RPC would throw', async () => {
        // A hubOperational whose .enabled() throws simulates "hub completely
        // unreachable" as hard as a stub can. If getCapabilitySnapshots ever
        // routed through it (the mistake the spec's corrected pattern calls
        // out), this test fails with that thrown error instead of resolving.
        const db = makeRealDb({
            hubOperational: {
                enabled: () => { throw new Error('hub unreachable: connection refused'); }
            }
        });
        db.checkpointDb = { ...HUB };
        const doQueryStub = sinon.stub(db, 'doQuery').resolves([
            { id: 1, snapshot_block: 100, capability: 'oracle_publish',
              signing_pubkey: 'a'.repeat(64), amount: '50000.00000000', source: 'src_a', created_at: new Date() }
        ]);
        // "which keys carried which weight at block N": the row's stated question.
        const config = capSnapConfig({ type: 'block', search: '100' });
        const result = await db.getCapabilitySnapshots(config);
        expect(result).to.be.an('array').with.lengthOf(3);
        // getXxx(config) is a SQL BUILDER, not an executor: getData runs the returned
        // query, so no doQuery is expected here. What "resolves purely from the
        // co-located mirror" means at this layer is that the query handed back is
        // DB-qualified to the mirror schema and no hub transport was consulted to
        // build it - which the throwing enabled() above would have surfaced.
        expect(result[0]).to.include('`XChain_Hub`.capability_snapshots m');
        expect(doQueryStub.called).to.equal(false);
    });

    it('the block-N electorate query filters on m.snapshot_block (the row\'s core question)', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getCapabilitySnapshots', type: 'block' } }));
        expect(sql).to.include('m.snapshot_block=?');
    });

    it('filters by capability (which capability\'s electorate)', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getCapabilitySnapshots', type: 'capability' } }));
        expect(sql).to.include('m.capability=?');
    });

    it('filters by signing pubkey (one key\'s weight across history)', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getCapabilitySnapshots', type: 'pubkey' } }));
        expect(sql).to.include('m.signing_pubkey=?');
    });

    it('getQueryWhereSql anchors getCapabilitySnapshots on m.id IS NOT NULL (no action_index column)', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getCapabilitySnapshots', type: null } }));
        expect(sql).to.equal('m.id IS NOT NULL');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression: the existing raw reader getCapabilitySnapshotRows (db.js:7673-7682,
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
    './db.js': MockDB
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
