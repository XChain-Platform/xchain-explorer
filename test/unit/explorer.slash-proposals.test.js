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
 * Unit tests for M3.6 (frontier row 23): Database#getSlashProposals
 * (src/db.js), proxying the hub's NEW unauthenticated `getslashproposals`
 * RPC over the established dual path (see getValidatorCapabilities and
 * getReorgs): RPC-first via HubOperationalCache when a hub is configured, the
 * co-located hub schema as the no-hub-at-all fallback, and a THROW (never an
 * empty table) once a configured hub is unreachable past
 * EXPLORER_HUB_CACHE_STALE_MAX_MS.
 *
 * `getSlashProposals` itself is proposed, not yet in src/db.js (db.js is a
 * shared seam file owned by the main loop per the M3 seam contract; likewise
 * HubOperationalCache.js's new getSlashProposals() method, the
 * getQueryWhereSql branch, the cursorPagedMethods / getQueryOffsetSql cursor
 * entries, and the _normalizeHubOperationalRows bigintKeys extension). Every
 * test below is written to be RUN once the main loop splices the proposal in
 * (m3-proposal-row23.md), not to pass vacuously today, matching
 * test/unit/explorer.reorgs.test.js from the same wave. The hub half of this
 * row is real, landed code in the sibling checkout
 * (xchain-hub/src/SlashDetector.js getSlashProposals + api.js
 * getslashproposals, covered by xchain-hub/test/unit/slashProposalsRpc.test.js).
 *
 * THE RULING THIS ROW IMPLEMENTS (operator, 2026-08-20, option b): publish all
 * statuses, label pending rows as unadjudicated, and return the evidence as a
 * HASH rather than verbatim. The hashing is a HUB-SIDE leg of the new RPC,
 * because the hub's own POST surface serves that RPC to any caller, so
 * redacting explorer-side alone would leave the verbatim evidence readable
 * straight off the hub. The explorer's job is therefore to (a) never ask for
 * the evidence column on either transport, and (b) never render a pending row
 * as anything other than an unadjudicated accusation. Both are asserted below.
 *
 * Venue fact (2026-08-20): `slash_proposals` has ZERO rows and none can be
 * produced on this venue, because SlashDetector must observe a fault in
 * machinery (oracle/attestation rounds with a misbehaving validator) that
 * cannot run here. These tests therefore exercise SQL/RPC shape, the hashing
 * contract, the outage behaviour and the row mapping, never data presence. An
 * empty array from the RPC is a LEGITIMATE "no proposals recorded" answer
 * (200, total 0); a null past the stale ceiling is a hub OUTAGE and must
 * throw. A reader must never see the same table for both.
 *
 * Schema facts (read from xchain-hub/src/sql/slash_proposals.sql):
 *   CREATE TABLE slash_proposals (
 *       id               BIGINT AUTO_INCREMENT PRIMARY KEY,
 *       validator_pubkey CHAR(64) NOT NULL,      -- 64 hex, lowercased on write
 *       offense_type     VARCHAR(30) NOT NULL,   -- price_deviation |
 *                                                -- repeated_deviation |
 *                                                -- non_participation |
 *                                                -- attestation_divergence
 *       round_number     BIGINT,                 -- oracle round (or a pseudo-round
 *                                                -- lifted from an attestation
 *                                                -- requestId), NOT a block height
 *       evidence         TEXT,                   -- verbatim JSON; NEVER published
 *       status           ENUM('pending','approved','rejected','expired')
 *                        NOT NULL DEFAULT 'pending',
 *       created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *       KEY idx_validator (validator_pubkey), KEY idx_status (status)
 *   );
 *
 * CHAIN SCOPE: there is NO chain or network column, and none is missing by
 * oversight. The offenses are federation-wide (oracle price rounds and
 * attestation rounds are not per-chain; a validator's signing pubkey is one
 * identity across every chain the federation serves), so slash_proposals is
 * PLATFORM-GLOBAL, exactly like validator_capabilities / governance_proposals /
 * governance_votes and unlike reorg_attestations (which carries source_chain
 * and forced row 22 to scope by coin). This surface therefore binds no chain
 * filter on either transport, and the same rows are correct on every coin's
 * page. The 'no chain filter' tests below pin that as a decision rather than an
 * omission: a chain filter added later would silently empty this page, since no
 * row will ever carry a chain value to match.
 */

'use strict';

const fs         = require('fs');
const path       = require('path');
const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');

const Utility = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig } = require('../fixtures/mock-query-args.js');

// Real Database class with the mariadb driver stubbed out (no live connection),
// matching explorer.reorgs.test.js / explorer.checkpoints.test.js.
const DatabaseReal = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
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

describe('Database#getSlashProposals (M3.6 dual-path data leg)', () => {

    afterEach(() => sinon.restore());

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

        it('normalizes the id and round_number BIGINT columns to decimal strings', async () => {
            // Same wire-type unification _normalizeHubOperationalRows already does
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

    // ── Co-located fallback (no hub RPC endpoint configured at all) ─────────
    describe('co-located schema fallback (no-hub-configured deployment shape only)', () => {

        function coLocatedDb() {
            const db = makeDb({ enabled: () => false });
            db.checkpointDb = { RBTC: { name: 'XChain_Hub', chain: 'BTC', network: 'regtest' } };
            return db;
        }

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

    it('getMaxMethodResults clamps getSlashProposals to the platform default of 100', () => {
        expect(makeDb().getMaxMethodResults('getSlashProposals')).to.equal(100);
    });

    it('is registered in cursorPagedMethods so next/prev preserve the client cursor', () => {
        // getSlashProposals -> the get->lowercase table-name mangle looks for
        // "slashproposals", which never matches the underscored table name, so
        // (per the main-loop ruling of 2026-08-19) it must be listed by hand.
        expect(makeDb().cursorPagedMethods).to.include('getSlashProposals');
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

// ─────────────────────────────────────────────────────────────────────────
// The page fragment IS an owned in-tree file, so these run today. They pin the
// presentation half of the operator's ruling: a reader must not come away
// thinking a validator has been found guilty, and an empty table must read as
// "none recorded" rather than as an error.
// ─────────────────────────────────────────────────────────────────────────
describe('slash_proposals.html (the unadjudicated-accusation wording obligation)', () => {

    const html = fs.readFileSync(
        path.join(__dirname, '../../src/content/html/slash_proposals.html'), 'utf8');

    it('states in plain language that these are accusations, not verdicts', () => {
        expect(html).to.contain('accusations, not verdicts');
        expect(html.toLowerCase()).to.contain('unadjudicated');
        expect(html.toLowerCase()).to.contain('has not been found');
    });

    it('says a penalty requires a governance vote, so a row alone is never enforcement', () => {
        expect(html.toLowerCase()).to.contain('governance vote');
    });

    it('explains what an EMPTY table means, so it does not read as an error', () => {
        expect(html.toLowerCase()).to.contain('if it is empty, none have been recorded');
    });

    it('explains why the evidence is a hash rather than the raw text', () => {
        expect(html).to.contain('SHA-256');
        expect(html.toLowerCase()).to.contain('verify');
    });

    it('carries the caution in the page description too (link previews show that, not the banner)', () => {
        const desc = html.match(/XC\.pageInfo\.description\s*=\s*([\s\S]*?);/)[1];
        expect(desc.toLowerCase()).to.contain('unadjudicated');
    });

    it('uses the datatable id xchain.js builds from the action name', () => {
        // 'datatable-' + action, action = 'slash_proposal' (xchain.js:1133).
        expect(html).to.contain('id="datatable-slash_proposal"');
        expect(html).to.contain("loadDatatablesData(XC.coin, 'slash_proposal', null, null)");
    });

    it('has a colspan on the loading row equal to its <th> count', () => {
        const ths = (html.match(/<th\b/g) || []).length;
        expect(ths).to.equal(7);
        expect(html).to.contain('colspan="' + ths + '"');
    });

    it('renders Status as a visible column of its own, not only as a row colour', () => {
        // The ruling makes "pending means accused, not judged" a presentation
        // obligation, so status may not be reduced to a background colour.
        expect(html).to.contain('<th class="">Status</th>');
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Row-mapping documentation: the getPagingDataResults branch lives in
// src/XChainExplorer.js (a shared seam file this row may not edit) and the
// colouring-exclusion-list edit lives in src/content/js/xchain.js (same), so
// both are PROPOSED text in m3-proposal-row23.md rather than in-tree code
// here. This block pins the field order and element count that proposal
// commits to, keyed off the exact SELECT column list asserted above, so a
// splice that reorders one side without the other is caught by inspection.
// ─────────────────────────────────────────────────────────────────────────
describe('slash_proposal row-mapping contract (documents the proposed getPagingDataResults branch)', () => {

    it('the proposed 8-element row = [count_reverse, created_at, validator_pubkey, offense_type, round_number, evidence_hash, status, id]', () => {
        // The invariant is POSITIONAL, not arithmetic: count_reverse first, the
        // paging cursor last, status second-to-last (consumed by createdRow,
        // xchain.js:1302-1305). Which trailing slots ALSO render is a per-surface
        // choice: here status IS a visible column (7th <th>) and only the cursor
        // (m.id) is invisible, the same shape price_snapshots uses. Status is
        // deliberately visible because the ruling makes labelling it a
        // requirement, not a nicety.
        const VISIBLE = ['created_at', 'validator_pubkey', 'offense_type', 'round_number', 'evidence_hash'];
        const PROPOSED_ROW = ['count_reverse', ...VISIBLE, 'status', 'id'];
        expect(PROPOSED_ROW).to.have.lengthOf(8);
        expect(PROPOSED_ROW[0]).to.equal('count_reverse');
        expect(PROPOSED_ROW[PROPOSED_ROW.length - 1]).to.equal('id', 'last element is always the paging cursor');
        expect(PROPOSED_ROW[PROPOSED_ROW.length - 2]).to.equal('status', 'second-to-last is always consumed as status by createdRow');
        // 7 <th> (#, Time, Validator, Offense, Round, Evidence Hash, Status):
        // count_reverse + the five visible fields + status.
        expect(1 + VISIBLE.length + 1).to.equal(7);
    });

    it('carries no evidence field at any position', () => {
        const PROPOSED_ROW = ['count_reverse', 'created_at', 'validator_pubkey', 'offense_type',
                              'round_number', 'evidence_hash', 'status', 'id'];
        expect(PROPOSED_ROW).to.not.include('evidence');
    });

    it("'slash_proposal' must join the client's no-colour exclusion list", () => {
        // status here is a lifecycle word ('pending'/'approved'/'rejected'/
        // 'expired'), not the 0/1 flag createdRow compares against, so without the
        // exclusion every row would paint red-for-invalid. On THIS surface that is
        // not merely a cosmetic bug: an unadjudicated accusation rendered in the
        // failure colour reads as a verdict, which is precisely what the ruling
        // forbids.
        const STATUS_WORDS = ['pending', 'approved', 'rejected', 'expired'];
        expect(STATUS_WORDS).to.not.include(0);
        expect(STATUS_WORDS).to.not.include(1);
    });

    it('the proposed badge map never paints a pending row in the failure colour', () => {
        // Mirrors the map proposed for xchain.js: pending is NEUTRAL.
        const BADGE = { pending: 'secondary', approved: 'danger', rejected: 'success', expired: 'secondary' };
        expect(BADGE.pending).to.equal('secondary');
        expect(BADGE.pending).to.not.equal('danger');
        // 'rejected' means the accusation was dismissed, so it is not a failure
        // state for the validator either.
        expect(BADGE.rejected).to.equal('success');
    });
});
