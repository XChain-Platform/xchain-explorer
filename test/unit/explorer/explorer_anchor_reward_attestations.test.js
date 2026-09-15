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
 * (src/db/index.js), the routed, paged list view over the hub-mirrored
 * anchor_reward_attestations table. Modeled on
 * test/unit/explorer.checkpoints.test.js's "M2.1 data leg" describe block
 * and test/unit/explorer.capability-snapshots.test.js (row 21, the sibling
 * mirror-backed M3 row built the same seam).
 *
 * THE ROW'S SUBSTANCE (spec §8): anchor_reward_attestations is a locally-
 * mirrored checkpoint-schema table (HUB_STATE_TABLES in hub_db_sync.js,
 * confirmed at src/hub/hub_db_sync.js:224 -- verified directly against the
 * source before writing this file, not assumed from the spec), transported
 * on the SAME terms as state_checkpoints: id-parity INSERT IGNORE, never
 * retracted. It must be read ONLY via a new `checkpointSource(config)`
 * accessor -- never through HubOperationalCache, never via a new hub RPC.
 * Unlike row 21's capability_snapshots (chain-agnostic, no chain/network
 * columns -- see that row's proposal), the real DDL at
 * src/sql/hub-mirror/anchor_reward_attestations.sql:54-55 declares
 * `chain VARCHAR(10) NOT NULL` and `network VARCHAR(20) NOT NULL`, and its
 * unique key is `(chain, network, reward_type, round_reference,
 * snapshot_block, publisher)`. This table is therefore `table`-shaped (like
 * state_checkpoints), NOT `capTable`-shaped: it DOES need
 * `checkpointSource().filter` / `.filterParams` bound, chain/network FIRST,
 * exactly as getCheckpoints already does. See the proposal file's header for
 * the full citation.
 *
 * These tests exercise the real db/index.js method once the main loop splices in
 * the proposal at
 * /private/tmp/claude-501/-Users-jdog-Sites-XChain-Platform/2638fcd2-4d57-4275-acf1-aba41d9c05fc/scratchpad/m3-proposal-row24.md
 * (getAnchorRewardAttestations itself, its getQueryWhereSql branch, its
 * cursorPagedMethods / getQueryOffsetSql cursor-map entries, the new
 * `checkpointSource().rewardTable` accessor, and the getPagingDataResults
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

const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig, makeExplorerConfig } = require('../fixtures/mock-query-args.js');

const { makeRealDb, HUB } = require('./explorer_anchor_reward_attestations.test/support/helpers.js');

require('./explorer_anchor_reward_attestations.test/support/data_leg.js');

// ─────────────────────────────────────────────────────────────────────────
// checkpointSource: the new rewardTable accessor this row proposes adding.
// Verified against the SAME helper getCheckpoints/getCapabilitySnapshotRows
// already use, never a hand-built schema-qualified string.
// ─────────────────────────────────────────────────────────────────────────

describe('Database#_checkpointSource rewardTable accessor (M3.7 addition)', () => {

    it('resolves rewardTable to the database-qualified anchor_reward_attestations name', () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const src = db.checkpointSource(makeConfig({ coin: 'BTC' }));
        expect(src.rewardTable).to.equal('`XChain_Hub`.anchor_reward_attestations');
    });

    it('still resolves table/capTable unchanged (additive accessor, no regression)', () => {
        const db = makeRealDb();
        db.checkpointDb = { ...HUB };
        const src = db.checkpointSource(makeConfig({ coin: 'BTC' }));
        expect(src.table).to.equal('`XChain_Hub`.state_checkpoints');
        expect(src.capTable).to.equal('`XChain_Hub`.capability_snapshots');
    });

    it('rewardTable fails loud with no co-located hub DB configured, same as table/capTable', () => {
        const db = makeRealDb();
        let err = null;
        try { db.checkpointSource(makeConfig({ coin: 'BTC' })); }
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
    './db/index.js': MockDB
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
