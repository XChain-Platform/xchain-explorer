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

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');

const Utility = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { makeConfig } = require('../../../../fixtures/mock-query-args.js');

// Real Database class with the mariadb driver stubbed out (no live connection),
// matching explorer_reorgs.test.js / explorer_checkpoints.test.js.
const DatabaseReal = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

const PK = 'a'.repeat(64);

// hubOperational is null by default (no hub configured at all: the co-located
// schema, or nothing, is the only transport). Individual tests override it.
function makeDb(hubOperational = null) {
    return new DatabaseReal({ configInfo, util, hubOperational });
}

function listConfig(overrides = {}) {
    return makeConfig({
        coin: 'RBTC',
        type: 'explorer',
        data: {
            method: 'getSlashProposals',
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

// A row as the hub RPC returns it: evidence already replaced by evidence_hash
// hub-side (SlashDetector.getSlashProposals), never the raw blob.
function rpcRow(i, over = {}) {
    return {
        id: i,
        validator_pubkey: PK,
        offense_type: 'non_participation',
        round_number: 400 + i,
        evidence_hash: 'f'.repeat(64),
        status: 'pending',
        created_at: '2026-08-20T00:00:00.000Z',
        ...over
    };
}

function coLocatedDb() {
    const db = makeDb({ enabled: () => false });
    db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
    return db;
}

describe('Database#getSlashProposals (M3.6 dual-path data leg)', () => {

    afterEach(() => sinon.restore());

    it('getMaxMethodResults clamps getSlashProposals to the platform default of 100', () => {
        expect(makeDb().getMaxMethodResults('getSlashProposals')).to.equal(100);
    });

    it('is registered in cursorPagedMethods so next/prev preserve the client cursor', () => {
        // getSlashProposals -> the get->lowercase table-name mangle looks for
        // "slashproposals", which never matches the underscored table name, so
        // (per the main-loop ruling of 2026-08-19) it must be listed by hand.
        expect(makeDb().cursorPagedMethods).to.include('getSlashProposals');
    });

    // ── RPC-first path (hub configured and reachable) ──────────────────────
    describe('RPC-first via HubOperationalCache', () => {

        it('pages the RPC rows through _pageHubOperationalRows and returns [rows, null, total]', async () => {
            const ops = { enabled: () => true, getSlashProposals: sinon.stub().resolves([rpcRow(1), rpcRow(2)]) };
            const db  = makeDb(ops);
            const [data, args, total] = await db.getSlashProposals(listConfig());
            expect(Array.isArray(data)).to.equal(true, 'RPC path returns rows directly, not a SQL string');
            expect(args).to.equal(null);
            expect(total).to.equal(2);
        });

        it('sends NO chain param: slash proposals are platform-global, not per-coin', async () => {
            const ops = { enabled: () => true, getSlashProposals: sinon.stub().resolves([]) };
            const db  = makeDb(ops);
            await db.getSlashProposals(listConfig());
            expect(ops.getSlashProposals.firstCall.args[0]).to.not.have.property('chain');
        });

        it('maps type=status to the status param and leaves validator_pubkey undefined', async () => {
            const ops = { enabled: () => true, getSlashProposals: sinon.stub().resolves([]) };
            const db  = makeDb(ops);
            await db.getSlashProposals(listConfig({ search: 'pending', type: 'status' }));
            expect(ops.getSlashProposals.firstCall.args[0]).to.deep.equal({
                status: 'pending', validator_pubkey: undefined
            });
        });

        it('maps type=pubkey to the validator_pubkey param and leaves status undefined', async () => {
            const ops = { enabled: () => true, getSlashProposals: sinon.stub().resolves([]) };
            const db  = makeDb(ops);
            await db.getSlashProposals(listConfig({ search: PK, type: 'pubkey' }));
            expect(ops.getSlashProposals.firstCall.args[0]).to.deep.equal({
                status: undefined, validator_pubkey: PK
            });
        });
    });
});

describe('Database#getSlashProposals (M3.6 dual-path data leg)', () => {

    afterEach(() => sinon.restore());

    describe('RPC-first via HubOperationalCache', () => {

        it('normalizes the id and round_number BIGINT columns to decimal strings', async () => {
            // Same wire-type unification normalizeHubOperationalRows already does
            // for id/qualified_at_block/activation_block/reorg_height: the RPC
            // transport delivers BIGINT as JS Number while the co-located read
            // delivers BigInt that the response sink stringifies, so an
            // unnormalized round_number flips type the moment the hub goes away.
            const ops = { enabled: () => true, getSlashProposals: sinon.stub().resolves([rpcRow(1)]) };
            const db  = makeDb(ops);
            const [data] = await db.getSlashProposals(listConfig());
            expect(data[0].id).to.equal('1');
            expect(data[0].round_number).to.equal('401');
        });

        it('never receives (and so never renders) the verbatim evidence blob', async () => {
            // The hub strips it; this asserts the explorer does not reintroduce it
            // by, say, asking for a raw row shape. If a future hub ever returned
            // `evidence`, that is a hub-side regression its own suite catches -
            // here we pin that nothing on this side reconstitutes it.
            const ops = { enabled: () => true, getSlashProposals: sinon.stub().resolves([rpcRow(1)]) };
            const db  = makeDb(ops);
            const [data] = await db.getSlashProposals(listConfig());
            expect(data[0]).to.not.have.property('evidence');
            expect(data[0].evidence_hash).to.match(/^[0-9a-f]{64}$/);
        });

    });
});

describe('Database#getSlashProposals (M3.6 dual-path data leg)', () => {

    afterEach(() => sinon.restore());

    // ── The distinction the milestone acceptance test is written around ────
    describe('legitimate empty vs hub outage (must never look the same)', () => {

        it('an empty array from the hub (no proposals recorded) returns total 0 and does NOT throw', async () => {
            const ops = { enabled: () => true, getSlashProposals: sinon.stub().resolves([]) };
            const db  = makeDb(ops);
            const [data, , total] = await db.getSlashProposals(listConfig());
            expect(data).to.deep.equal([]);
            expect(total).to.equal(0);
        });

        it('null from the cache (hub unreachable past the stale ceiling) THROWS and never falls through to SQL', async () => {
            const ops = { enabled: () => true, staleMaxMs: 600000, getSlashProposals: sinon.stub().resolves(null) };
            const db  = makeDb(ops);
            // A co-located hub schema IS configured here on purpose: this is exactly
            // the deployment shape a wrongly-restored fall-through would serve stale
            // rows from instead of failing loud.
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            let err = null;
            try { await db.getSlashProposals(listConfig()); }
            catch (e) { err = e; }
            expect(err, 'getSlashProposals must throw, never render an empty table, on a hub outage').to.be.an('error');
            expect(err.message).to.contain('slash_proposals');
            expect(err.message).to.contain('Hub unreachable');
            expect(err.message).to.contain('600s');
        });

        it('the outage error names the CONFIGURED stale ceiling, not a hardcoded one', async () => {
            const ops = { enabled: () => true, staleMaxMs: 90000, getSlashProposals: sinon.stub().resolves(null) };
            const db  = makeDb(ops);
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            let err = null;
            try { await db.getSlashProposals(listConfig()); }
            catch (e) { err = e; }
            expect(err.message).to.contain('90s');
        });
    });
});

describe('Database#getSlashProposals (M3.6 dual-path data leg)', () => {

    afterEach(() => sinon.restore());

    // ── Co-located fallback (no hub RPC endpoint configured at all) ─────────
    describe('co-located schema fallback (no-hub-configured deployment shape only)', () => {

        it('reads the co-located schema when hubOperational is disabled', async () => {
            const [query, , count] = await coLocatedDb().getSlashProposals(listConfig());
            expect(query).to.contain('`XChain_Hub`.slash_proposals');
            expect(count).to.contain('count(*)');
        });

        it('throws loud when neither a hub endpoint nor a co-located schema exists', async () => {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = {};
            let err = null;
            try { await db.getSlashProposals(listConfig()); }
            catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.message).to.contain('No co-located hub DB');
        });

        it('NEVER selects the raw evidence column, on this leg either', async () => {
            // The redaction is hub-side for the RPC transport, but the no-hub shape
            // reads MariaDB directly with no hub in the path at all, so it has to
            // redact for itself or the same page publishes verbatim accusations on
            // a co-located install. This is the single most important assertion in
            // this file.
            const [query, , count] = await coLocatedDb().getSlashProposals(listConfig());
            // The column may be READ (the hash has to be computed from something),
            // but only inside the SHA2 expression: strip that one expression and no
            // reference may remain, so the raw text can never reach the output row.
            const withoutHash = query.replace(/SHA2\(COALESCE\(m\.evidence,\s*''\),\s*256\)/g, 'HASHEXPR');
            expect(withoutHash).to.not.match(/m\.evidence/);
            expect(count).to.not.match(/m\.evidence/);
            expect(query).to.not.contain('SELECT *');
        });
    });
});

describe('Database#getSlashProposals (M3.6 dual-path data leg)', () => {

    afterEach(() => sinon.restore());

    describe('co-located schema fallback (no-hub-configured deployment shape only)', () => {

        it('derives evidence_hash in SQL with the same SHA-256 the hub publishes', async () => {
            // SHA2(COALESCE(m.evidence,''), 256) is byte-identical to the hub's
            // crypto.createHash('sha256').update(String(evidence ?? '')) for the
            // ASCII JSON SlashDetector writes, and the COALESCE is load-bearing:
            // SHA2(NULL) is NULL, while the hub hashes a null evidence as the empty
            // string, so without it the two transports would disagree on exactly the
            // rows whose evidence is missing.
            const [query] = await coLocatedDb().getSlashProposals(listConfig());
            expect(query).to.match(/SHA2\(\s*COALESCE\(m\.evidence,\s*''\)\s*,\s*256\s*\)\s+AS\s+evidence_hash/i);
        });

        it('emits the seam-contract column list, in order, under the exact names', async () => {
            const [query] = await coLocatedDb().getSlashProposals(listConfig());
            const cols = ['m.id', 'm.validator_pubkey', 'm.offense_type', 'm.round_number',
                          'evidence_hash', 'm.status', 'm.created_at'];
            let cursor = -1;
            for (const col of cols) {
                const idx = query.indexOf(col);
                expect(idx, `missing or out of order: ${col}`).to.be.greaterThan(cursor);
                cursor = idx;
            }
        });

        it('binds NO chain/network filter (platform-global table, unlike reorg_attestations)', async () => {
            const [query, args, count] = await coLocatedDb().getSlashProposals(listConfig());
            expect(query).to.not.contain('m.source_chain');
            expect(query).to.not.contain('m.network');
            expect(count).to.not.contain('m.network');
            expect(args).to.equal(null, 'no extra placeholder, so getData supplies the single type-bound value');
        });

        it('returns args null so getData supplies [search] for a typed request and [] for list-all', async () => {
            // Matching getValidatorCapabilities/getGovernanceVotes: the only
            // placeholder on this leg is the one getQueryWhereSql emits for {TYPE}.
            const [, argsTyped] = await coLocatedDb().getSlashProposals(
                listConfig({ search: 'pending', type: 'status' }));
            expect(argsTyped).to.equal(null);
        });

        it('the list query carries a LIMIT sourced from config.data.sql.limit, interpolated not bound', async () => {
            const [query] = await coLocatedDb().getSlashProposals(listConfig({ sql: { limit: 37 } }));
            expect(query.trim().endsWith('LIMIT 37')).to.equal(true);
        });
    });
});

describe('Database#getSlashProposals (M3.6 dual-path data leg)', () => {

    afterEach(() => sinon.restore());

    describe('co-located schema fallback (no-hub-configured deployment shape only)', () => {

        it('honours the offset cursor fragment before ORDER BY', async () => {
            const OFFSET_SQL = ' AND m.id < ?';
            const [query] = await coLocatedDb().getSlashProposals(
                listConfig({ sql: { where: { offset: OFFSET_SQL } } }));
            const orderIdx  = query.indexOf('ORDER BY m.id');
            const offsetIdx = query.indexOf(OFFSET_SQL);
            expect(offsetIdx).to.be.greaterThan(-1);
            expect(orderIdx).to.be.greaterThan(offsetIdx);
        });

        it('orders by m.id (no action_index column on this hub-federation table)', async () => {
            const [query] = await coLocatedDb().getSlashProposals(listConfig());
            expect(query).to.match(/ORDER BY m\.id (ASC|DESC)/);
            expect(query).to.not.include('m.action_index');
        });

        it('no GROUP BY and no derived-window subquery (the M2 frontier-row-40/41 defect class)', async () => {
            const [query, , count] = await coLocatedDb().getSlashProposals(listConfig());
            expect(query).to.not.match(/GROUP BY/i);
            expect(count).to.not.match(/GROUP BY/i);
        });

    });

    describe('getQueryWhereSql', () => {
        it('anchors getSlashProposals on m.id IS NOT NULL (no action_index column)', async () => {
            const sql = await makeDb().getQueryWhereSql(
                makeConfig({ data: { method: 'getSlashProposals', type: null } }));
            expect(sql).to.equal('m.id IS NOT NULL');
        });

        it('type=status filters on m.status', async () => {
            const sql = await makeDb().getQueryWhereSql(
                makeConfig({ data: { method: 'getSlashProposals', type: 'status' } }));
            expect(sql).to.equal('m.id IS NOT NULL AND m.status=?');
        });

        it('type=pubkey filters on m.validator_pubkey (matching the hub RPC filter, not an address)', async () => {
            const sql = await makeDb().getQueryWhereSql(
                makeConfig({ data: { method: 'getSlashProposals', type: 'pubkey' } }));
            expect(sql).to.equal('m.id IS NOT NULL AND m.validator_pubkey=?');
        });

        it('offers no round filter, since round_number is not a block height and the hub RPC cannot filter on it', async () => {
            const sql = await makeDb().getQueryWhereSql(
                makeConfig({ data: { method: 'getSlashProposals', type: 'block' } }));
            expect(sql).to.equal('m.id IS NOT NULL');
        });
    });
});

describe('Database#getSlashProposals (M3.6 dual-path data leg)', () => {

    afterEach(() => sinon.restore());

    describe('getQueryOffsetSql', () => {
        it('gives getSlashProposals the m.id cursor field', async () => {
            const config = makeConfig({
                data: { method: 'getSlashProposals', offset: { action: 'next', start: 42, stop: false } }
            });
            const [offsetSql, offsetArgs] = await makeDb().getQueryOffsetSql(config);
            expect(offsetSql).to.include('m.id');
            expect(offsetSql).to.not.include('m.action_index');
            expect(offsetArgs).to.deep.equal([42]);
        });

        it("action='last' uses <= against the cursor (jump-to-final-page shape)", async () => {
            const config = makeConfig({
                data: { method: 'getSlashProposals', offset: { action: 'last', start: 42, stop: false } }
            });
            const [offsetSql, offsetArgs] = await makeDb().getQueryOffsetSql(config);
            expect(offsetSql).to.equal(' AND m.id <= ?');
            expect(offsetArgs).to.deep.equal([42]);
        });
    });
});
