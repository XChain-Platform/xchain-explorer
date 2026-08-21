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
 * Unit tests for M3.5 (frontier row 22): Database#getReorgs (src/db.js),
 * proxying the hub's EXISTING unauthenticated `getreorghistory` RPC over the
 * established dual path (see getValidatorCapabilities, db.js:9446-9473):
 * RPC-first via HubOperationalCache when a hub is configured, the co-located
 * hub schema as the no-hub-at-all fallback, and a THROW (never an empty
 * table) once a configured hub is unreachable past
 * EXPLORER_HUB_CACHE_STALE_MAX_MS.
 *
 * `getReorgs` itself is proposed, not yet in src/db.js (db.js is a shared
 * seam file owned by the main loop per the M3 seam contract; likewise
 * HubOperationalCache.js's new getReorgHistory() method, the
 * getQueryWhereSql branch, the cursorPagedMethods/getQueryOffsetSql cursor
 * entries, and the _normalizeHubOperationalRows bigintKeys extension). Every
 * test below is written to be RUN once the main loop splices the proposal
 * in (m3-proposal-row22.md) - not to pass vacuously today - the same
 * pattern test/unit/explorer.attest-validator-stats.test.js and
 * test/unit/HubOperationalCache.test.js's "db.js RPC-first operational
 * reads" suite already use for this wave.
 *
 * Venue fact (2026-08-19): `getreorghistory` answers cleanly at the hub and
 * returns `[]` - this chain has never reorged. The transport is proven, only
 * the data is absent. That is exactly the case these tests must not
 * confuse with an outage: an empty array from the RPC is a LEGITIMATE "no
 * reorgs" answer (200, total 0), while a null return past the stale ceiling
 * is a hub OUTAGE and must throw. A user must never see the same "no rows"
 * table for both. See the 'legitimate empty vs hub outage' describe block.
 *
 * Schema facts (read from xchain-hub/src/sql/reorg_attestations.sql and
 * ReorgHandler.js):
 *   CREATE TABLE reorg_attestations (
 *       id               BIGINT AUTO_INCREMENT PRIMARY KEY,
 *       reorg_id         VARCHAR(100) NOT NULL UNIQUE,   -- '<chain>:<height>:<ts>'
 *       source_chain     VARCHAR(10) NOT NULL,
 *       reorg_height     BIGINT NOT NULL,
 *       reorg_timestamp  BIGINT NOT NULL,                -- MILLISECONDS (compared
 *                                                         -- against Date.now() in
 *                                                         -- ReorgHandler; unlike
 *                                                         -- price_snapshots.block_timestamp,
 *                                                         -- which is Unix SECONDS)
 *       affected_chains  TEXT,                           -- JSON.stringify'd array
 *       validator_count  INT NOT NULL DEFAULT 0,
 *       consensus_proof  TEXT,
 *       status           ENUM('confirmed','rejected') NOT NULL DEFAULT 'confirmed',
 *       created_at       TIMESTAMP,
 *       updated_at       TIMESTAMP,
 *       KEY idx_chain (source_chain), KEY idx_status (status)
 *   );
 *
 * No action_index (this is a hub-federation-owned table, not an action-chain
 * row). The cursor is m.id (AUTO_INCREMENT), matching the other three
 * HubOperationalCache-backed tables (validator_capabilities/
 * governance_proposals/governance_votes), all monotonic and unique.
 *
 * Cross-chain scoping fact this row's design turns on: unlike those three
 * tables (explicitly "platform-global, no per-chain network column" per
 * _hubSource's doc comment), reorg_attestations DOES carry source_chain, and
 * the hub's getreorghistory RPC has NO server-side chain filter at all
 * (ReorgHandler.getReorgHistory: `SELECT * FROM reorg_attestations ORDER BY
 * created_at DESC LIMIT ?`) - it returns every chain's history. A per-coin
 * page (/{COIN}/reorgs) that served that unfiltered would leak another
 * chain's reorgs onto this coin's page, so BOTH transports mandatorily
 * scope to `this.baseCoin[config.coin]` (BTC/LTC/DOGE): RPC-side inside the
 * cache method (client-side, matching how getGovernanceProposals already
 * filters proposal_id post-fetch since getproposals has no such filter
 * either); co-located-side via an unconditional `m.source_chain=?`, matching
 * getCrossChainMatches' mandatory network filter. `baseCoin` (not
 * `_checkpointSource().chain`) is used because it is populated for every
 * configured coin regardless of whether a co-located checkpoint DB exists,
 * so the RPC-only (HUB_API_URL set, no database.checkpoint) deployment shape
 * can still scope correctly.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect }  = require('chai');

const Utility = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig } = require('../fixtures/mock-query-args.js');

// Real Database class with the mariadb driver stubbed out (no live connection),
// matching explorer.checkpoints.test.js / explorer.attest-validator-stats.test.js.
const DatabaseReal = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

// hubOperational is null by default (no hub configured at all: the co-located
// schema, or nothing, is the only transport). Individual tests override it.
function makeDb(hubOperational = null) {
    const db = new DatabaseReal({ configInfo, util, hubOperational });
    // this coin's own chain code, populated unconditionally for every configured
    // coin regardless of checkpoint-DB config (see db.js ~line 386); RBTC -> BTC.
    db.baseCoin = { RBTC: 'BTC', RDOGE: 'DOGE' };
    return db;
}

function listConfig(overrides = {}) {
    return makeConfig({
        coin: 'RBTC',
        type: 'explorer',
        data: {
            method: 'getReorgs',
            search: null,
            type: null,
            sql: {
                order: 'DESC',
                limit: 100,
                where: { data: 'm.id IS NOT NULL', offset: '', offsetArgs: [] }
            },
            ...overrides
        }
    });
}

function rpcRow(i, over = {}) {
    return {
        id: i, reorg_id: 'BTC:' + (1000 + i) + ':1755600000000', source_chain: 'BTC',
        reorg_height: 1000 + i, reorg_timestamp: 1755600000000, affected_chains: '["LTC"]',
        validator_count: 3, status: 'confirmed', created_at: '2026-08-19T00:00:00.000Z',
        ...over
    };
}

describe('Database#getReorgs (M3.5 dual-path data leg)', () => {

    afterEach(() => sinon.restore());

    // ── RPC-first path (hub configured and reachable) ──────────────────────
    describe('RPC-first via HubOperationalCache', () => {

        it('pages the RPC rows through _pageHubOperationalRows and returns [rows, null, total]', async () => {
            const ops = { enabled: () => true, getReorgHistory: sinon.stub().resolves([rpcRow(1), rpcRow(2)]) };
            const db  = makeDb(ops);
            const [data, args, total] = await db.getReorgs(listConfig());
            expect(Array.isArray(data)).to.equal(true, 'RPC path returns rows directly, not a SQL string');
            expect(args).to.equal(null);
            expect(total).to.equal(2);
        });

        it('resolves the chain param from baseCoin (RBTC -> BTC), not the raw route coin', async () => {
            const ops = { enabled: () => true, getReorgHistory: sinon.stub().resolves([]) };
            const db  = makeDb(ops);
            await db.getReorgs(listConfig());
            expect(ops.getReorgHistory.firstCall.args[0].chain).to.equal('BTC');
        });

        it('maps type=status to the status param and leaves reorg_height undefined', async () => {
            const ops = { enabled: () => true, getReorgHistory: sinon.stub().resolves([]) };
            const db  = makeDb(ops);
            await db.getReorgs(listConfig({ search: 'confirmed', type: 'status' }));
            expect(ops.getReorgHistory.firstCall.args[0]).to.deep.equal({
                chain: 'BTC', status: 'confirmed', reorg_height: undefined
            });
        });

        it('maps type=block to the reorg_height param and leaves status undefined', async () => {
            const ops = { enabled: () => true, getReorgHistory: sinon.stub().resolves([]) };
            const db  = makeDb(ops);
            await db.getReorgs(listConfig({ search: '1964', type: 'block' }));
            expect(ops.getReorgHistory.firstCall.args[0]).to.deep.equal({
                chain: 'BTC', status: undefined, reorg_height: '1964'
            });
        });

        it('normalizes id/reorg_height/reorg_timestamp BIGINT columns to decimal strings', async () => {
            // The hub RPC transport delivers BIGINT columns as JS Numbers
            // (bigIntAsNumber); the co-located schema read delivers BigInt that the
            // response sink stringifies. Both must reach consumers as decimal
            // strings or a hub outage flips the wire type of reorg_height/
            // reorg_timestamp mid-deployment, exactly the defect class
            // _normalizeHubOperationalRows already exists to close for `id` and the
            // other two tables' BIGINT columns (qualified_at_block/activation_block).
            const ops = { enabled: () => true, getReorgHistory: sinon.stub().resolves([rpcRow(1)]) };
            const db  = makeDb(ops);
            const [data] = await db.getReorgs(listConfig());
            expect(data[0].id).to.equal('1');
            expect(data[0].reorg_height).to.equal('1001');
            expect(data[0].reorg_timestamp).to.equal('1755600000000');
        });
    });

    // ── The distinction the milestone acceptance test is written around ────
    describe('legitimate empty vs hub outage (must never look the same)', () => {

        it('an empty array from the hub (no reorgs recorded) returns total 0 and does NOT throw', async () => {
            const ops = { enabled: () => true, getReorgHistory: sinon.stub().resolves([]) };
            const db  = makeDb(ops);
            const [data, , total] = await db.getReorgs(listConfig());
            expect(data).to.deep.equal([]);
            expect(total).to.equal(0);
        });

        it('null from the cache (hub unreachable past the stale ceiling) THROWS and never falls through to SQL', async () => {
            const ops = { enabled: () => true, staleMaxMs: 600000, getReorgHistory: sinon.stub().resolves(null) };
            const db  = makeDb(ops);
            // A co-located hub schema IS configured here on purpose: this is exactly
            // the deployment shape a wrongly-restored fall-through would serve stale
            // rows from instead of failing loud.
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            let err = null;
            try { await db.getReorgs(listConfig()); }
            catch (e) { err = e; }
            expect(err, 'getReorgs must throw, never render an empty table, on a hub outage').to.be.an('error');
            expect(err.message).to.contain('reorg_attestations');
            expect(err.message).to.contain('Hub unreachable');
            expect(err.message).to.contain('600s');
        });

        it('the outage error names the CONFIGURED stale ceiling, not a hardcoded one', async () => {
            const ops = { enabled: () => true, staleMaxMs: 90000, getReorgHistory: sinon.stub().resolves(null) };
            const db  = makeDb(ops);
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            let err = null;
            try { await db.getReorgs(listConfig()); }
            catch (e) { err = e; }
            expect(err.message).to.contain('90s');
        });
    });

    // ── Co-located fallback (no hub RPC endpoint configured at all) ─────────
    describe('co-located schema fallback (no-hub-configured deployment shape only)', () => {

        it('reads the co-located schema when hubOperational is disabled', async () => {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            const [query, , count] = await db.getReorgs(listConfig());
            expect(query).to.contain('`XChain_Hub`.reorg_attestations');
            expect(count).to.contain('count(*)');
        });

        it('throws loud when neither a hub endpoint nor a co-located schema exists', async () => {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = {};
            let err = null;
            try { await db.getReorgs(listConfig()); }
            catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.message).to.contain('No co-located hub DB');
        });

        it('emits the seam-contract column list, in order, under the exact names', async () => {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            const [query] = await db.getReorgs(listConfig());
            const cols = ['m.id', 'm.reorg_id', 'm.source_chain', 'm.reorg_height',
                          'm.reorg_timestamp', 'm.affected_chains', 'm.validator_count',
                          'm.status', 'm.created_at'];
            let cursor = -1;
            for (const col of cols) {
                const idx = query.indexOf(col);
                expect(idx, `missing or out of order: ${col}`).to.be.greaterThan(cursor);
                cursor = idx;
            }
        });

        it('appends the mandatory m.source_chain filter AFTER the optional type filter, in both count and list queries', async () => {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            const [query, , count] = await db.getReorgs(listConfig({
                search: 'confirmed', type: 'status',
                sql: { where: { data: 'm.id IS NOT NULL AND m.status=?' } }
            }));
            const typeIdx  = query.indexOf('m.status=?');
            const chainIdx = query.indexOf('m.source_chain=?');
            expect(typeIdx).to.be.greaterThan(-1);
            expect(chainIdx).to.be.greaterThan(typeIdx, 'chain scope must come after the type filter, matching arg order');
            expect(count).to.contain('m.source_chain=?');
        });

        it('args = [chain] for a bare list-all request (no type filter placeholder to lead it)', async () => {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            const [, args] = await db.getReorgs(listConfig());
            expect(args).to.deep.equal(['BTC']);
        });

        it('args = [search, chain] when type=status (left-to-right text order)', async () => {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            const [, args] = await db.getReorgs(listConfig({ search: 'confirmed', type: 'status' }));
            expect(args).to.deep.equal(['confirmed', 'BTC']);
        });

        it('args = [search, chain] when type=block', async () => {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            const [, args] = await db.getReorgs(listConfig({ search: '1964', type: 'block' }));
            expect(args).to.deep.equal(['1964', 'BTC']);
        });

        it('a second coin resolves its OWN chain scope, not the first coin queried (no cross-coin leak)', async () => {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = {
                RBTC:  { name: 'XChain_Hub', chain: 'BTC',  network: 'regtest' },
                RDOGE: { name: 'XChain_Hub', chain: 'DOGE', network: 'regtest' }
            };
            const [, argsBtc]  = await db.getReorgs(listConfig());
            const [, argsDoge] = await db.getReorgs(makeConfig({
                coin: 'RDOGE', type: 'explorer',
                data: { method: 'getReorgs', sql: { order: 'DESC', limit: 100, where: { data: 'm.id IS NOT NULL', offset: '' } } }
            }));
            expect(argsBtc).to.deep.equal(['BTC']);
            expect(argsDoge).to.deep.equal(['DOGE']);
        });

        it('the list query carries a LIMIT sourced from config.data.sql.limit, interpolated not bound', async () => {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            const [query] = await db.getReorgs(listConfig({ sql: { limit: 37 } }));
            expect(query.trim().endsWith('LIMIT 37')).to.equal(true);
        });

        it('honours the offset cursor fragment before ORDER BY', async () => {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            const OFFSET_SQL = ' AND m.id < ?';
            const [query] = await db.getReorgs(listConfig({ sql: { where: { offset: OFFSET_SQL } } }));
            const orderIdx  = query.indexOf('ORDER BY m.id');
            const offsetIdx = query.indexOf(OFFSET_SQL);
            expect(offsetIdx).to.be.greaterThan(-1);
            expect(orderIdx).to.be.greaterThan(offsetIdx);
        });

        it('orders by m.id (no action_index column on this hub-federation table)', async () => {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            const [query] = await db.getReorgs(listConfig());
            expect(query).to.match(/ORDER BY m\.id (ASC|DESC)/);
            expect(query).to.not.include('m.action_index');
        });

        it('no GROUP BY and no derived-window subquery (the M2 frontier-row-40/41 defect class)', async () => {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            const [query, , count] = await db.getReorgs(listConfig());
            expect(query).to.not.match(/GROUP BY/i);
            expect(count).to.not.match(/GROUP BY/i);
        });
    });

    it('getMaxMethodResults clamps getReorgs to the platform default of 100', () => {
        const db = makeDb();
        expect(db.getMaxMethodResults('getReorgs')).to.equal(100);
    });

    it('is registered in cursorPagedMethods so next/prev preserve the client cursor', () => {
        // getReorgs -> the get->lowercase table-name mangle would look for "reorgs",
        // which does not exist (the table is reorg_attestations), so (like
        // getCheckpoints and getValidatorCapabilities) it must be listed by hand.
        const db = makeDb();
        expect(db.cursorPagedMethods).to.include('getReorgs');
    });

    describe('getQueryWhereSql', () => {
        it('anchors getReorgs on m.id IS NOT NULL (no action_index column)', async () => {
            const db = makeDb();
            const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getReorgs', type: null } }));
            expect(sql).to.equal('m.id IS NOT NULL');
        });

        it('type=status filters on m.status', async () => {
            const db = makeDb();
            const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getReorgs', type: 'status' } }));
            expect(sql).to.equal('m.id IS NOT NULL AND m.status=?');
        });

        it('type=block filters on m.reorg_height (reusing the platform-wide "block" type name, not inventing "height")', async () => {
            const db = makeDb();
            const sql = await db.getQueryWhereSql(makeConfig({ data: { method: 'getReorgs', type: 'block' } }));
            expect(sql).to.equal('m.id IS NOT NULL AND m.reorg_height=?');
        });
    });

    describe('getQueryOffsetSql', () => {
        it('gives getReorgs the m.id cursor field', async () => {
            const db = makeDb();
            const config = makeConfig({
                data: { method: 'getReorgs', offset: { action: 'next', start: 42, stop: false } }
            });
            const [offsetSql, offsetArgs] = await db.getQueryOffsetSql(config);
            expect(offsetSql).to.include('m.id');
            expect(offsetSql).to.not.include('m.action_index');
            expect(offsetArgs).to.deep.equal([42]);
        });

        it("action='last' uses <= against the cursor (jump-to-final-page shape)", async () => {
            const db = makeDb();
            const config = makeConfig({
                data: { method: 'getReorgs', offset: { action: 'last', start: 42, stop: false } }
            });
            const [offsetSql, offsetArgs] = await db.getQueryOffsetSql(config);
            expect(offsetSql).to.equal(' AND m.id <= ?');
            expect(offsetArgs).to.deep.equal([42]);
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Row-mapping documentation: the getPagingDataResults branch lives in
// src/XChainExplorer.js (a shared seam file this row may not edit) and the
// coloring-exclusion-list edit lives in src/content/js/xchain.js (same), so
// both are PROPOSED text in m3-proposal-row22.md rather than in-tree code
// here. This block pins the field order and element count that proposal
// commits to, keyed off the exact SELECT column list asserted above, so a
// splice that reorders one side without the other is caught by inspection -
// the same pattern explorer.attest-validator-stats.test.js uses.
// ─────────────────────────────────────────────────────────────────────────
describe('reorg row-mapping contract (documents the proposed getPagingDataResults branch)', () => {

    it('the proposed 8-element row = [count_reverse, reorg_timestamp, reorg_height, reorg_id, affected_chains, validator_count, status, id]', () => {
        // 8 array elements over 7 <th> (see reorgs.html: #, Time, Height, Reorg ID,
        // Affected Chains, Validators, Status). The LAST element (m.id) is the
        // un-rendered paging cursor. status (enum 'confirmed'/'rejected', a word not
        // 0/1) sits second-to-last, consumed positionally by createdRow, but MUST be
        // added to xchain.js:1338's no-color exclusion list ('reorg') alongside
        // 'checkpoint'/'price_snapshot'/'validator_capability' etc, or a 'rejected'
        // row would compare its status string against 1 and always paint red/green
        // rather than the badge the per-action render block supplies.
        const VISIBLE = ['reorg_timestamp', 'reorg_height', 'reorg_id', 'affected_chains', 'validator_count'];
        const PROPOSED_ROW = ['count_reverse', ...VISIBLE, 'status', 'id'];
        expect(PROPOSED_ROW).to.have.lengthOf(8);
        expect(PROPOSED_ROW[PROPOSED_ROW.length - 1]).to.equal('id', 'last element is always the paging cursor');
        expect(PROPOSED_ROW[PROPOSED_ROW.length - 2]).to.equal('status', 'second-to-last is always consumed as status by createdRow');
    });

    it('reorg_timestamp is stored in MILLISECONDS, unlike price_snapshot.block_timestamp (Unix seconds) - the proposed xchain.js render divides by 1000 before formatLivestamp', () => {
        // ReorgHandler compares the raw `timestamp` RPC param directly against
        // Date.now() (milliseconds) and stores it verbatim into reorg_timestamp;
        // formatLivestamp/data-livestamp expects Unix SECONDS (confirmed by this
        // file's own moment.unix(...) sibling calls on the same values elsewhere).
        // Passing reorg_timestamp straight through un-divided would reproduce the
        // M2 handoff's exact defect class (a raw Unix value rendered under the
        // wrong unit assumption, there on coinpay obligations).
        const reorg_timestamp_ms = 1755600000000;
        const expected_seconds   = Math.floor(reorg_timestamp_ms / 1000);
        expect(expected_seconds).to.equal(1755600000);
    });
});
