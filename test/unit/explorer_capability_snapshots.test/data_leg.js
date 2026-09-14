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

const { makeConfig } = require('../../fixtures/mock-query-args.js');
const { makeRealDb, HUB, capSnapConfig } = require('./helpers.js');

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
        // sibling checkpointSource also resolves.
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
});

describe('Database#getCapabilitySnapshots (M3.4 data leg)', () => {

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
});

describe('Database#getCapabilitySnapshots (M3.4 data leg)', () => {

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
        expect(src).to.not.match(/pageHubOperationalRows/);
        expect(src).to.not.match(/hubOperationalOutage/);
        // Confirms it reads the checkpoint-mirror helper, not the RPC-first
        // hubSource helper getValidatorCapabilities/getGovernanceProposals use.
        expect(src).to.match(/checkpointSource/);
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
});

describe('Database#getCapabilitySnapshots (M3.4 data leg)', () => {

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
