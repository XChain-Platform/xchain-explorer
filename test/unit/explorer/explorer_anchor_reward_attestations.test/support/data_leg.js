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
 **********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon      = require('sinon');

const { makeConfig } = require('../../../../fixtures/mock-query-args.js');
const { makeRealDb, HUB, rewardConfig } = require('./helpers.js');

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
        // checkpointSource also resolves.
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
});

describe('Database#getAnchorRewardAttestations (M3.7 data leg)', () => {

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
});

describe('Database#getAnchorRewardAttestations (M3.7 data leg)', () => {

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
});

describe('Database#getAnchorRewardAttestations (M3.7 data leg)', () => {

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
        expect(src).to.not.match(/pageHubOperationalRows/);
        expect(src).to.not.match(/hubOperationalOutage/);
        // Confirms it reads the checkpoint-mirror helper, not the RPC-first
        // hubSource helper getValidatorCapabilities/getGovernanceProposals use.
        expect(src).to.match(/checkpointSource/);
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
});

describe('Database#getAnchorRewardAttestations (M3.7 data leg)', () => {

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
