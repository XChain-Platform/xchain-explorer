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
 * Unit tests for M3.7 (row 24): Database#getAnchorRewardAttestations
 * (src/db.js), the routed, paged list view over the hub-mirrored
 * anchor_reward_attestations table. Modeled on
 * test/unit/explorer.checkpoints.test.js's "M2.1 data leg" describe block
 * and test/unit/explorer.capability-snapshots.test.js (row 21, the sibling
 * mirror-backed M3 row built the same seam).
 *
 * THE ROW'S SUBSTANCE (spec §8): anchor_reward_attestations is a locally-
 * mirrored checkpoint-schema table (HUB_STATE_TABLES in hub_db_sync.js,
 * confirmed at src/hub_db_sync.js:224 -- verified directly against the
 * source before writing this file, not assumed from the spec), transported
 * on the SAME terms as state_checkpoints: id-parity INSERT IGNORE, never
 * retracted. It must be read ONLY via a new `_checkpointSource(config)`
 * accessor -- never through HubOperationalCache, never via a new hub RPC.
 * Unlike row 21's capability_snapshots (chain-agnostic, no chain/network
 * columns -- see that row's proposal), the real DDL at
 * src/sql/hub-mirror/anchor_reward_attestations.sql:54-55 declares
 * `chain VARCHAR(10) NOT NULL` and `network VARCHAR(20) NOT NULL`, and its
 * unique key is `(chain, network, reward_type, round_reference,
 * snapshot_block, publisher)`. This table is therefore `table`-shaped (like
 * state_checkpoints), NOT `capTable`-shaped: it DOES need
 * `_checkpointSource().filter` / `.filterParams` bound, chain/network FIRST,
 * exactly as getCheckpoints already does. See the proposal file's header for
 * the full citation.
 *
 * These tests exercise the real db.js method once the main loop splices in
 * the proposal at
 * /private/tmp/claude-501/-Users-jdog-Sites-XChain-Platform/2638fcd2-4d57-4275-acf1-aba41d9c05fc/scratchpad/m3-proposal-row24.md
 * (getAnchorRewardAttestations itself, its getQueryWhereSql branch, its
 * cursorPagedMethods / getQueryOffsetSql cursor-map entries, the new
 * `_checkpointSource().rewardTable` accessor, and the getPagingDataResults
 * row branch in XChainExplorer.js). Until spliced they are expected to fail
 * (method undefined / branch missing), per the seam contract: written to be
 * run, not to pass vacuously.
 *
 * THIS ROW HAS NO PAGE (by design -- rendering lands with M4.6). There is
 * therefore no page-fragment describe block here (nothing to read off disk),
 * unlike explorer.capability-snapshots.test.js's trailing section. The
 * datatable-endpoint guard (test/unit/content-client-datatable-endpoints.test.js)
 * only checks fragments that call loadDatatablesData, so an unrendered feed
 * with no fragment does not trip it.
 */

const { expect }  = require('chai');
const proxyquire  = require('proxyquire');
const sinon       = require('sinon');

const Utility = require('../../src/utility.js');

const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig, makeExplorerConfig } = require('../fixtures/mock-query-args.js');

// ─────────────────────────────────────────────────────────────────────────
// Database#getAnchorRewardAttestations (real db.js SQL-generating method,
// mariadb stubbed out, no live connection) -- same rig as
// explorer.checkpoints.test.js's DatabaseReal / makeRealDb.
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

// anchor_reward_attestations carries its own chain/network columns (unlike
// row 21's capability_snapshots), so the checkpoint-source HUB fixture's
// chain/network values are expected to be bound, exactly as getCheckpoints
// binds them against state_checkpoints.
const HUB = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

function rewardConfig(extras = {}) {
    return makeConfig({
        data: {
            method: 'getAnchorRewardAttestations',
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

describe('Database#getAnchorRewardAttestations (M3.7 data leg)', () => {

    it('returns a 3-element array', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const result = await db.getAnchorRewardAttestations(rewardConfig());
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('database-qualifies anchor_reward_attestations (the new rewardTable accessor), aliased m, for both the count and the list query', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query, , count] = await db.getAnchorRewardAttestations(rewardConfig());
        expect(query).to.include('`XChain_Hub`.anchor_reward_attestations m');
        expect(count).to.include('`XChain_Hub`.anchor_reward_attestations m');
        // Must read the new rewardTable accessor, never the sibling tables
        // _checkpointSource also resolves.
        expect(query).to.not.include('.state_checkpoints');
        expect(query).to.not.include('.capability_snapshots');
    });

    it('emits exactly the seam-contract column list, in order, under the exact names', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getAnchorRewardAttestations(rewardConfig());
        const cols = ['m.id', 'm.chain', 'm.network', 'm.reward_type', 'm.round_reference',
                      'm.snapshot_block', 'm.publisher', 'm.reward_amount', 'm.doge_anchor_txid', 'm.created_at'];
        let cursor = -1;
        for (const col of cols) {
            const idx = query.indexOf(col);
            expect(idx, `missing or out of order: ${col}`).to.be.greaterThan(cursor);
            cursor = idx;
        }
    });

    // publisher_attestations is the raw 2f+1 signature quorum JSON: large,
    // and not needed by the list view (no verification happens here, unlike
    // the checkpoint-verify path). It must never ride along on the list SELECT.
    it('never selects the raw publisher_attestations JSON blob on the list query', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getAnchorRewardAttestations(rewardConfig());
        const selectClause = query.slice(0, query.indexOf('FROM'));
        expect(selectClause).to.not.include('publisher_attestations');
    });

    it('the list query carries a LIMIT sourced from config.data.sql.limit', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getAnchorRewardAttestations(rewardConfig({ sql: { limit: 37 } }));
        expect(query.trim().endsWith('LIMIT 37')).to.equal(true);
    });

    it('orders by m.id, the id-keyed paging cursor (auto-increment PK: monotonic and unique, append-only mirror)', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getAnchorRewardAttestations(rewardConfig({ sql: { order: 'ASC' } }));
        expect(query).to.match(/ORDER BY m\.id ASC/);
    });

    it('honours the offset cursor fragment from config.data.sql.where.offset', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const OFFSET_SQL = ' AND m.id < ?';
        const [query] = await db.getAnchorRewardAttestations(rewardConfig({
            sql: { where: { offset: OFFSET_SQL } }
        }));
        const orderIdx  = query.indexOf('ORDER BY m.id');
        const offsetIdx = query.indexOf(OFFSET_SQL);
        expect(offsetIdx).to.be.greaterThan(-1);
        expect(orderIdx).to.be.greaterThan(-1);
        expect(offsetIdx).to.be.lessThan(orderIdx);
    });

    // The chain/network filter must come BEFORE the (optional) type-bound
    // predicate in the WHERE text, per the seam contract's explicit
    // instruction to row 24 that filterParams come first in the args array;
    // the args array only matches the SQL text if the filter text also comes
    // first. getCheckpoints puts the filter AFTER sql.where.data (fine there,
    // since getCheckpoints has no type filter at all); this row has one, so
    // the ordering is deliberately built differently. See the proposal.
    it('binds the chain/network filter BEFORE the type-bound placeholder in the WHERE text', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [query] = await db.getAnchorRewardAttestations(rewardConfig({
            type: 'block', search: '100',
            sql: { where: { data: 'm.id IS NOT NULL AND m.snapshot_block=?', offset: '', offsetArgs: [] } }
        }));
        const filterIdx = query.indexOf('m.chain = ?');
        const typeIdx    = query.indexOf('m.snapshot_block=?');
        expect(filterIdx).to.be.greaterThan(-1);
        expect(typeIdx).to.be.greaterThan(-1);
        expect(filterIdx).to.be.lessThan(typeIdx);
    });

    it('args: filterParams (chain, network) FIRST, with no type set and no trailing type arg', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [, args] = await db.getAnchorRewardAttestations(rewardConfig());
        expect(args).to.deep.equal(['BTC', 'mainnet']);
    });

    it('args: filterParams FIRST, then the type-bound search value when a TYPE filter is set', async () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const [, args] = await db.getAnchorRewardAttestations(rewardConfig({
            type: 'block', search: '100',
            sql: { where: { data: 'm.id IS NOT NULL AND m.snapshot_block=?', offset: '', offsetArgs: [] } }
        }));
        expect(args).to.deep.equal(['BTC', 'mainnet', '100']);
    });

    ['anchor', 'block', 'pubkey'].forEach((type) => {
        it(`args stays [chain, network, search] for type=${type} (every declared TYPE emits exactly one extra placeholder)`, async () => {
            const db = makeRealDb();
            db.checkpointDb = { ...HUB };
            const [, args] = await db.getAnchorRewardAttestations(rewardConfig({
                type, search: 'probe-value',
                sql: { where: { data: 'm.id IS NOT NULL AND m.x=?', offset: '', offsetArgs: [] } }
            }));
            expect(args).to.deep.equal(['BTC', 'mainnet', 'probe-value']);
        });
    });

    it('no checkpoint mirror DB configured -> fails loud (no silent empty read)', async () => {
        const db = makeRealDb();
        let err = null;
        try { await db.getAnchorRewardAttestations(rewardConfig()); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
    });

    it('rejects an unsafe mirror DB identifier by failing loud (no identifier injection)', async () => {
        const db = makeRealDb();
        db.checkpointDb = { BTC: { name: 'bad name; DROP', chain: 'BTC', network: 'mainnet' } };
        let err = null;
        try { await db.getAnchorRewardAttestations(rewardConfig()); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
        expect(err.message).to.not.include('bad name');
    });

    it('getMaxMethodResults clamps getAnchorRewardAttestations to the platform default of 100', () => {
        const db = makeRealDb();
        expect(db.getMaxMethodResults('getAnchorRewardAttestations')).to.equal(100);
    });

    it('is registered in cursorPagedMethods so next/prev preserve the client cursor', () => {
        const db = makeRealDb();
        expect(db.cursorPagedMethods).to.include('getAnchorRewardAttestations');
    });

    it('getQueryOffsetSql gives getAnchorRewardAttestations the m.id cursor field (id-keyed, no action_index)', async () => {
        const db = makeRealDb();
        const config = makeConfig({
            data: { method: 'getAnchorRewardAttestations', offset: { action: 'next', start: 42, stop: false } }
        });
        const [offsetSql, offsetArgs] = await db.getQueryOffsetSql(config);
        expect(offsetSql).to.include('m.id');
        expect(offsetSql).to.not.include('m.action_index');
        expect(offsetArgs).to.deep.equal([42]);
    });

    // ── THE ROW'S SUBSTANCE: mirror transport, never HubOperationalCache/RPC ──

    it('never references hubOperational / HubOperationalCache in its own source (static guard against a hub RPC being added later)', () => {
        const db = makeRealDb();
        const src = db.getAnchorRewardAttestations.toString();
        expect(src).to.not.match(/hubOperational/i);
        expect(src).to.not.match(/HubOperationalCache/i);
        expect(src).to.not.match(/_pageHubOperationalRows/);
        expect(src).to.not.match(/_hubOperationalOutage/);
        // Confirms it reads the checkpoint-mirror helper, not the RPC-first
        // _hubSource helper getValidatorCapabilities/getGovernanceProposals use.
        expect(src).to.match(/_checkpointSource/);
    });

    it('answers WITH THE HUB UNREACHABLE: resolves purely from the co-located mirror when hub RPC would throw', async () => {
        const db = makeRealDb({
            hubOperational: {
                enabled: () => { throw new Error('hub unreachable: connection refused'); }
            }
        });
        db.checkpointDb = { ...HUB };
        const doQueryStub = sinon.stub(db, 'doQuery').resolves([
            { id: 1, chain: 'BTC', network: 'mainnet', reward_type: 'anchor_BTC', round_reference: 7,
              snapshot_block: 100, publisher: 'a'.repeat(64), reward_amount: '5.00000000',
              doge_anchor_txid: 'd'.repeat(64), created_at: new Date() }
        ]);
        const result = await db.getAnchorRewardAttestations(rewardConfig());
        expect(result).to.be.an('array').with.lengthOf(3);
        // getXxx(config) is a SQL BUILDER, not an executor: getData runs the returned
        // query, so no doQuery is expected here. What "resolves purely from the
        // co-located mirror" means at this layer is that the query handed back is
        // DB-qualified to the mirror schema and no hub transport was consulted to
        // build it - which the throwing enabled() above would have surfaced.
        expect(result[0]).to.include('`XChain_Hub`.anchor_reward_attestations m');
        expect(doQueryStub.called).to.equal(false);
    });

    // ── {TYPE} filter shape: anchor / block / pubkey ──

    it('type=anchor filters on m.doge_anchor_txid (rows behind a real ANCHOR)', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getAnchorRewardAttestations', type: 'anchor' } }));
        expect(sql).to.include('m.doge_anchor_txid=?');
    });

    it('type=block filters on m.snapshot_block (matches idx_snapshot_block(network, snapshot_block))', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getAnchorRewardAttestations', type: 'block' } }));
        expect(sql).to.include('m.snapshot_block=?');
    });

    it('type=pubkey filters on m.publisher (the elected publisher pubkey credited the reward)', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getAnchorRewardAttestations', type: 'pubkey' } }));
        expect(sql).to.include('m.publisher=?');
    });

    it('getQueryWhereSql anchors getAnchorRewardAttestations on m.id IS NOT NULL (no action_index column)', async () => {
        const db = makeRealDb();
        const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getAnchorRewardAttestations', type: null } }));
        expect(sql).to.equal('m.id IS NOT NULL');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// _checkpointSource: the new rewardTable accessor this row proposes adding.
// Verified against the SAME helper getCheckpoints/getCapabilitySnapshotRows
// already use, never a hand-built schema-qualified string.
// ─────────────────────────────────────────────────────────────────────────

describe('Database#_checkpointSource rewardTable accessor (M3.7 addition)', () => {

    it('resolves rewardTable to the database-qualified anchor_reward_attestations name', () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const src = db._checkpointSource(makeConfig({ coin: 'BTC' }));
        expect(src.rewardTable).to.equal('`XChain_Hub`.anchor_reward_attestations');
    });

    it('still resolves table/capTable unchanged (additive accessor, no regression)', () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const src = db._checkpointSource(makeConfig({ coin: 'BTC' }));
        expect(src.table).to.equal('`XChain_Hub`.state_checkpoints');
        expect(src.capTable).to.equal('`XChain_Hub`.capability_snapshots');
    });

    it('rewardTable fails loud with no co-located hub DB configured, same as table/capTable', () => {
        const db = makeRealDb();
        let err = null;
        try { db._checkpointSource(makeConfig({ coin: 'BTC' })); }
        catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.message).to.match(/co-located hub DB/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// XChainExplorer.getPagingDataResults branch (M3.7 datatables/API leg). This
// row has NO page, but /api still routes json.data through
// getPagingDataResults exactly like every other route (XChainExplorer.js
// line ~1003), so the branch is required and tested here even absent a
// fragment. Modeled on explorer.capability-snapshots.test.js's trailing rig;
// XChainExplorer.js is a shared seam file this row may not edit.
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

function makeRewardRow(overrides = {}) {
    return Object.assign({
        id:               11,
        chain:            'BTC',
        network:          'mainnet',
        reward_type:      'anchor_BTC',
        round_reference:  7,
        snapshot_block:   100,
        publisher:        'a'.repeat(64),
        reward_amount:    '5.00000000',
        doge_anchor_txid: 'd'.repeat(64),
        created_at:       1700000000
    }, overrides);
}

describe('XChainExplorer.getPagingDataResults: getAnchorRewardAttestations row shape', () => {

    it('emits [count_reverse, created_at, chain, network, reward_type, round_reference, snapshot_block, publisher, doge_anchor_txid, id] (10 elements, id LAST as the paging cursor)', () => {
        const explorer = makeExplorer();
        const row  = makeRewardRow();
        const cfg  = makeExplorerConfig('getAnchorRewardAttestations', null, null, { start: 0, length: 10 });
        const [info] = explorer.getPagingDataResults(cfg, [row], 1);
        expect(info).to.be.an('array').with.lengthOf(10);
        expect(info[1]).to.equal(row.created_at);
        expect(info[2]).to.equal(row.chain);
        expect(info[3]).to.equal(row.network);
        expect(info[4]).to.equal(row.reward_type);
        expect(info[5]).to.equal(row.round_reference);
        expect(info[6]).to.equal(row.snapshot_block);
        expect(info[7]).to.equal(row.publisher);
        expect(info[8]).to.equal(row.doge_anchor_txid);   // second-to-last: consumed as `status` by createdRow
        expect(info[9]).to.equal(row.id);                 // last: the paging cursor
    });

    it('empty data returns an empty array', () => {
        const explorer = makeExplorer();
        const cfg  = makeExplorerConfig('getAnchorRewardAttestations', null, null, { start: 0, length: 10 });
        const result = explorer.getPagingDataResults(cfg, [], 0);
        expect(result).to.be.an('array').that.is.empty;
    });
});
