/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * Unit tests for the four M4 composed detail methods in src/db/index.js
 * (spec explorer-coverage-completion rows 26/28/30/31): getValidator,
 * getAttestation, getAnchor and getAddressStaking.
 *
 * HOW THESE DIFFER FROM THE M3 BUILDER TESTS, and why it matters. Most
 * getXxx methods in db/index.js are SQL BUILDERS: they return [query, args,
 * count] and getData is the executor, so `doQuery.called` can never be
 * true inside them and an assertion on it is vacuous. These four are NOT
 * builders. They follow getXcall/getPoll: they run their own reads and
 * return [object]. doQuery IS therefore called, and it is stubbed here so
 * every query and every arg array can be captured and pinned - shape,
 * bounding predicate, schema qualification, arg order - rather than
 * asserting that a call happened.
 *
 * Venue reality (spec, surveyed 2026-08-20 on RDOGE): `validators` 0 rows,
 * `attests` 0 rows, `polls` 0 rows, `xcalls` 0 rows. None of these tests
 * assert data presence; they assert the SQL, the bounding, the mirror-schema
 * asymmetry and the outage posture, all of which are venue-independent.
 *
 * THE MIRROR-SCHEMA ASYMMETRY these tests exist to pin: both tables are
 * reached through checkpointSource, but `capability_snapshots` is
 * CHAIN-AGNOSTIC (its key is snapshot_block+capability+signing_pubkey+source;
 * there are no chain/network columns to filter on) while
 * `anchor_reward_attestations` is CHAIN-SCOPED (chain/network are part of
 * uq_reward_tuple). A blanket rule in either direction produces a query that
 * is silently wrong rather than one that errors.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');

const Utility = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');

const DatabaseReal = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

// Same co-located hub-mirror identity explorer.checkpoints.test.js and
// explorer.commitments.test.js use, so a regression here surfaces the same way.
const HUB = { BTC: { name: 'XChain_Hub', chain: 'BTC', network: 'mainnet' } };

const PK   = 'a'.repeat(64);
const ADDR = '1XChainStakingAddressExample';
const TXID = 'f'.repeat(64);
const REQ  = 'b'.repeat(64);

// A deliberately NON-DEFAULT page bound. getQuery clamps sql.limit to
// 1..getMaxMethodResults() (100 by default) before the method runs, so a
// method that hardcodes 100 instead of interpolating sql.limit looks correct
// against the default and fails here.
const LIMIT = 25;

function makeDb(hubOperational = null){
    const db = new DatabaseReal({ configInfo, util, hubOperational });
    db.checkpointDb = { ...HUB };
    return db;
}

function detailConfig(method, search, extras = {}){
    return makeConfig({
        coin: 'BTC',
        type: 'api',
        data: {
            method,
            search,
            type: null,
            sql: {
                order: 'DESC',
                limit: LIMIT,
                where: { data: 'm.action_index IS NOT NULL', offset: '', offsetArgs: [] }
            },
            ...extras
        }
    });
}

// Stub doQuery with a substring-routed responder, so a test names the leg it is
// feeding by the table that leg reads rather than by call ordinal (which would
// break the moment a leg is added).
function stubQueries(db, plan = []){
    db.doQuery = sinon.stub().callsFake(async (cfg, query) => {
        const flat = String(query).replace(/\s+/g, ' ').trim();
        for(const [needle, rows] of plan)
            if(flat.includes(needle)) return rows;
        return [];
    });
    return db;
}

function captured(db){
    return db.doQuery.getCalls().map(c => ({
        query: String(c.args[1]).replace(/\s+/g, ' ').trim(),
        args:  c.args[2]
    }));
}

function findQuery(db, needle){
    return captured(db).find(q => q.query.includes(needle));
}

// A query is legitimately unbounded ONLY when it is a scalar aggregate (one row
// by construction). Everything else must end in an explicit LIMIT.
const AGGREGATE = /SELECT COALESCE\(SUM\(|SELECT count\(\*\) as position_count|SELECT MAX\(/;

function assertEveryQueryBounded(db){
    for(const q of captured(db)){
        if(AGGREGATE.test(q.query)) continue;
        expect(q.query, 'unbounded query: ' + q.query.slice(0, 120)).to.match(/ LIMIT \d+$/);
    }
}

function pageBoundedQueries(db){
    return captured(db).filter(q => new RegExp(' LIMIT ' + LIMIT + '$').test(q.query));
}

const IDENTITY = [{
    signing_pubkey: PK, source: ADDR, stake_action_index: 900,
    version: 1, activation_block: 100, deactivation_block: null, block_index: 90
}];

const PUBKEY_ID  = [['SELECT id FROM index_pubkeys WHERE pubkey=?',    [{ id: 7 }]]];
const ADDRESS_ID = [['SELECT id FROM index_addresses WHERE address=?', [{ id: 9 }]]];

function validatorDb(hubOperational = null, plan = []){
    const db = makeDb(hubOperational);
    stubQueries(db, [...PUBKEY_ID, ...ADDRESS_ID,
                     ['FROM stakes m LEFT JOIN index_addresses', IDENTITY], ...plan]);
    return db;
}

/* ─────────────────────────── getValidator (M4.1) ─────────────────────────── */

describe('Database#getValidator (M4 composed validator detail)', () => {
    it('returns [null] without touching the stakes ledger when the QUERY names nothing', async () => {
        const db = makeDb();
        stubQueries(db, []);
        const out = await db.getValidator(detailConfig('getValidator', PK));
        expect(out).to.deep.equal([null]);
        expect(findQuery(db, 'FROM stakes m'), 'scanned stakes for a name that does not exist').to.not.exist;
    });

    it('returns [null] when the name resolves but carries no valid STAKE', async () => {
        const db = makeDb();
        stubQueries(db, [...PUBKEY_ID, ...ADDRESS_ID]);
        expect(await db.getValidator(detailConfig('getValidator', PK))).to.deep.equal([null]);
        expect(findQuery(db, 'FROM stakes m LEFT JOIN index_addresses'), 'spine never ran').to.exist;
    });

    it('resolves the QUERY to ids in two unique point reads, then keys stakes by INDEXED columns', async () => {
        const db = validatorDb();
        db.getFederationRegistry = async () => null;
        await db.getValidator(detailConfig('getValidator', PK));
        const reads = captured(db);
        expect(reads[0].query).to.equal('SELECT id FROM index_pubkeys WHERE pubkey=? LIMIT 1');
        expect(reads[0].args).to.deep.equal([PK]);
        expect(reads[1].query).to.equal('SELECT id FROM index_addresses WHERE address=? LIMIT 1');
        expect(reads[1].args).to.deep.equal([PK]);
        const spine = findQuery(db, 'FROM stakes m LEFT JOIN index_addresses');
        expect(spine.query).to.include('(m.signing_pubkey_id=? OR m.source_id=?)');
        expect(spine.args).to.deep.equal([7, 9]);
        expect(spine.query).to.include("WHERE s1.status='valid'");
        // The one-query form spanning two JOINED aliases reads correctly and scans the
        // whole stakes table: an OR across two joined tables leaves `stakes` as the only
        // possible driving table. It must never come back.
        expect(spine.query, 'identity spine regressed to a full stakes scan')
            .to.not.match(/a3\.pubkey=\?\s*OR|a2\.address=\?\s*OR/);
    });

    it('binds only the side that resolved, so a pubkey QUERY carries no dead address clause', async () => {
        const db = makeDb();
        stubQueries(db, [...PUBKEY_ID,
                         ['FROM stakes m LEFT JOIN index_addresses', IDENTITY]]);
        db.getFederationRegistry = async () => null;
        await db.getValidator(detailConfig('getValidator', PK));
        const spine = findQuery(db, 'FROM stakes m LEFT JOIN index_addresses');
        expect(spine.query).to.include('(m.signing_pubkey_id=?)');
        expect(spine.query).to.not.include('m.source_id=?');
        expect(spine.args).to.deep.equal([7]);
    });
});

describe('Database#getValidator (M4 composed validator detail)', () => {
    it('EVERY sub-list interpolates sql.limit; nothing but a scalar aggregate is unbounded', async () => {
        const db = validatorDb();
        db.getFederationRegistry = async () => null;
        await db.getValidator(detailConfig('getValidator', PK));
        assertEveryQueryBounded(db);
        // The page-bounded legs, by the table each reads. A leg that loses its
        // `LIMIT ` + limit interpolation drops out of this set.
        const bounded = pageBoundedQueries(db).map(q => q.query);
        for(const table of ['FROM stakes m INNER JOIN blocks', 'FROM unstakes m',
                            'FROM delegations m', 'FROM stake_key_revocations m',
                            'FROM contract_delegation_rotations m', 'FROM validator_rewards m',
                            'FROM reward_claims m INNER JOIN blocks',
                            'FROM capability_slash_events m', 'FROM slash_events m',
                            'FROM full_node_verifications m', 'FROM attest_validator_stats m'])
            expect(bounded.some(q => q.includes(table)), 'unbounded or missing leg: ' + table).to.equal(true);
    });

    it('reads BOTH slash families, each keyed on the validator pubkey', async () => {
        const db = validatorDb();
        db.getFederationRegistry = async () => null;
        await db.getValidator(detailConfig('getValidator', PK));
        const cap = findQuery(db, 'FROM capability_slash_events m');
        const con = findQuery(db, 'FROM slash_events m INNER JOIN blocks');
        expect(cap, 'capability slash family missing').to.exist;
        expect(con, 'contract slash family missing').to.exist;
        expect(cap.query).to.include('WHERE a3.pubkey=?');
        expect(con.query).to.include('WHERE a3.pubkey=?');
        expect(cap.args).to.deep.equal([PK]);
        expect(con.args).to.deep.equal([PK]);
    });

    it('describes a capability slash with the full superset columns (slashed key + submitter + destination)', async () => {
        // Same row shape as getCapabilitySlashEvents and the address staking
        // panel, so one slash reads identically wherever it surfaces.
        const db = validatorDb();
        db.getFederationRegistry = async () => null;
        await db.getValidator(detailConfig('getValidator', PK));
        const cap = findQuery(db, 'FROM capability_slash_events m');
        expect(cap.query).to.include('as slashed_pubkey');
        expect(cap.query).to.include('sub.address as submitter');
        expect(cap.query).to.include('dst.address as destination');
    });

    it('scopes the active-stake aggregate to ONE pubkey and to live rows, with no GROUP BY', async () => {
        const db = validatorDb();
        db.getFederationRegistry = async () => null;
        await db.getValidator(detailConfig('getValidator', PK));
        const agg = captured(db).find(q => q.query.includes('as position_count'));
        expect(agg).to.exist;
        expect(agg.query).to.include('SUM(CAST(m.amount AS DECIMAL(65,18)))');
        expect(agg.query).to.include('m.deactivation_block IS NULL');
        expect(agg.query).to.include('a3.pubkey=?');
        // Latest/active semantics come from the deactivation_block column and a
        // single-key predicate, never from grouping the whole table.
        expect(agg.query).to.not.match(/GROUP BY/i);
    });
});

describe('Database#getValidator (M4 composed validator detail)', () => {
    it('derives claimable as accrued minus collected, from SQL sums not from the fetched page', async () => {
        const db = validatorDb(null, [
            ['FROM validator_rewards m INNER JOIN index_addresses', [{ total: '10.50000000' }]],
            ['FROM reward_claims m INNER JOIN index_addresses',     [{ total: '4.25000000'  }]]
        ]);
        db.getFederationRegistry = async () => null;
        const [data] = await db.getValidator(detailConfig('getValidator', PK));
        expect(data.rewards_total).to.equal('10.50000000');
        expect(data.collected_total).to.equal('4.25000000');
        expect(data.claimable).to.equal('6.25000000');
        // The claims sum counts only VALID claims; an invalid COLLECT must not
        // reduce what the address can still claim.
        const claims = findQuery(db, 'FROM reward_claims m INNER JOIN index_addresses');
        expect(claims.query).to.include("s1.status='valid'");
    });

    it('serves capabilities over hub JSON-RPC when a hub is configured, and never touches the co-located schema', async () => {
        const rpc = { enabled: () => true,
                      getValidatorCapabilities: sinon.stub().resolves([
                          { id: 7, signing_pubkey: PK, capability: 'oracle_publish',
                            qualified: 1, self_test_ok: 1, enabled: 1, qualified_at_block: 1998 }
                      ]) };
        const db = validatorDb(rpc);
        db.getFederationRegistry = async () => null;
        const [data] = await db.getValidator(detailConfig('getValidator', PK));
        expect(rpc.getValidatorCapabilities.calledOnceWith({ signing_pubkey: PK })).to.equal(true);
        expect(data.capabilities).to.have.lengthOf(1);
        expect(data.capabilities[0].self_test_ok).to.equal(1);
        // BIGINT columns normalize to decimal STRINGs on both transports.
        expect(data.capabilities[0].id).to.equal('7');
        expect(data.capabilities[0].qualified_at_block).to.equal('1998');
        expect(findQuery(db, 'validator_capabilities'), 'co-located schema was read anyway').to.not.exist;
    });

    it('FAILS LOUD when a CONFIGURED hub is unreachable past the stale ceiling, never an empty capability list', async () => {
        const rpc = { enabled: () => true, getValidatorCapabilities: async () => null, staleMaxMs: 600000 };
        const db = validatorDb(rpc);
        db.getFederationRegistry = async () => null;
        let err = null;
        try { await db.getValidator(detailConfig('getValidator', PK)); }
        catch(e){ err = e; }
        expect(err, 'an outage was degraded into an empty list').to.be.an('error');
        expect(err.message).to.include('Hub unreachable');
        expect(err.message).to.include('validator_capabilities');
        expect(findQuery(db, 'validator_capabilities'), 'fell back to the stale co-located schema').to.not.exist;
    });
});

describe('Database#getValidator (M4 composed validator detail)', () => {
    it('reads the DB-qualified co-located hub schema on a no-hub deployment', async () => {
        const db = validatorDb(null);
        db.getFederationRegistry = async () => null;
        await db.getValidator(detailConfig('getValidator', PK));
        const caps = findQuery(db, 'validator_capabilities');
        expect(caps).to.exist;
        expect(caps.query).to.include('FROM `XChain_Hub`.validator_capabilities m');
        expect(caps.query).to.include('WHERE m.signing_pubkey=?');
        expect(caps.query).to.match(new RegExp('LIMIT ' + LIMIT + '$'));
        expect(caps.args).to.deep.equal([PK]);
    });

    it('treats an unreachable federation registry as UNKNOWN, not as unregistered', async () => {
        const db = validatorDb();
        db.getFederationRegistry = async () => null;
        const [data] = await db.getValidator(detailConfig('getValidator', PK));
        expect(data.registry).to.equal(null);
        expect(data.registry_known).to.equal(false);
    });
});

module.exports = {
    DatabaseReal, configInfo, util, sinon, makeConfig, HUB, PK, ADDR, TXID, REQ, LIMIT,
    makeDb, detailConfig, stubQueries, captured, findQuery, assertEveryQueryBounded, pageBoundedQueries,
};

require('./db_m4_compositions.test/support/attestation.js');
require('./db_m4_compositions.test/support/anchor.js');
require('./db_m4_compositions.test/support/address_staking.js');
