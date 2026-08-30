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
 * Unit tests for the four M4 composed detail methods in src/db.js
 * (spec explorer-coverage-completion rows 26/28/30/31): getValidator,
 * getAttestation, getAnchor and getAddressStaking.
 *
 * HOW THESE DIFFER FROM THE M3 BUILDER TESTS, and why it matters. Most
 * getXxx methods in db.js are SQL BUILDERS: they return [query, args,
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
 * reached through _checkpointSource, but `capability_snapshots` is
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

const Utility = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const DatabaseReal = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
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

/* ─────────────────────────── getValidator (M4.1) ─────────────────────────── */

describe('Database#getValidator (M4 composed validator detail)', () => {

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

/* ────────────────────────── getAttestation (M4.3) ────────────────────────── */

describe('Database#getAttestation (M4 composed attestation lifecycle)', () => {

    function legs(){
        return [
            { action: 'ATTEST', action_index: 500, version: 0, request_id: REQ,
              provider_id: 'http_get', request_status: 'expired', resolved_block: 1200,
              deadline_block: 1150, responsible_set_json: '["' + PK + '"]',
              callback_params_json: '["x"]', origin_chain: 'DOGE', origin_action_index: 42,
              validator_signatures: null, callback_execute_action_index: null },
            { action: 'ATTEST', action_index: 501, version: 1, request_id: REQ,
              provider_id: 'http_get', response_status: 'ok',
              validator_signatures: '[{"pubkey":"' + PK + '","sig":"deadbeef"}]',
              origin_action_index: 42, callback_execute_action_index: 777 }
        ];
    }

    it('reuses getAttestationByActionIndex, unchanged and POSITIONAL, to resolve a numeric QUERY', async () => {
        const db = makeDb();
        stubQueries(db, [['FROM attests m LEFT JOIN actions', legs()]]);
        const spy = sinon.spy(db, 'getAttestationByActionIndex');
        // The WS ChangeDetector owns this signature; a composition that reshaped it
        // would break the detector silently.
        expect(db.getAttestationByActionIndex.length).to.equal(2);
        await db.getAttestation(detailConfig('getAttestation', 501));
        expect(spy.calledOnce).to.equal(true);
        expect(spy.firstCall.args[1]).to.equal(501);
    });

    it('takes a 64-hex QUERY as the request_id directly, lowercased, with no seed read', async () => {
        const db = makeDb();
        stubQueries(db, [['FROM attests m LEFT JOIN actions', legs()]]);
        const spy = sinon.spy(db, 'getAttestationByActionIndex');
        await db.getAttestation(detailConfig('getAttestation', REQ.toUpperCase()));
        expect(spy.called).to.equal(false);
        const q = findQuery(db, 'FROM attests m LEFT JOIN actions');
        expect(q.query).to.include('WHERE m.request_id=?');
        expect(q.args).to.deep.equal([REQ]);
    });

    it('reads the whole lifecycle in one bounded, oldest-first query', async () => {
        const db = makeDb();
        stubQueries(db, [['FROM attests m LEFT JOIN actions', legs()]]);
        await db.getAttestation(detailConfig('getAttestation', REQ));
        const q = findQuery(db, 'FROM attests m LEFT JOIN actions');
        expect(q.query).to.include('ORDER BY m.version ASC, m.action_index ASC');
        expect(q.query).to.match(new RegExp('LIMIT ' + LIMIT + '$'));
        assertEveryQueryBounded(db);
    });

    it('DERIVES the v2 expiry from the request row, because ATTEST v2 writes no row of its own', async () => {
        const db = makeDb();
        stubQueries(db, [['FROM attests m LEFT JOIN actions', legs()]]);
        const [data] = await db.getAttestation(detailConfig('getAttestation', REQ));
        expect(data.expiry.expired).to.equal(true);
        expect(data.expiry.request_status).to.equal('expired');
        expect(data.expiry.resolved_block).to.equal(1200);
        // Nothing may go looking for a version-2 row: the indexer's _parseExpire
        // only flips the v0 row's status, so such a query would always be empty.
        for(const q of captured(db))
            expect(q.query, 'queried for a v2 row that cannot exist').to.not.match(/version\s*=\s*2/);
    });

    it('does NOT call a pending request expired just because its deadline block has passed', async () => {
        const rows = legs();
        rows[0].request_status = 'pending';
        rows[0].resolved_block = null;
        rows[0].deadline_block = 1;
        const db = makeDb();
        stubQueries(db, [['FROM attests m LEFT JOIN actions', rows]]);
        const [data] = await db.getAttestation(detailConfig('getAttestation', REQ));
        // The stored terminal state is the only truth; the expiry sweep may not have
        // reached this request yet.
        expect(data.expiry.expired).to.equal(false);
        expect(data.expiry.request_status).to.equal('pending');
    });

    it('parses the v1 quorum signatures and the v0 responsible set', async () => {
        const db = makeDb();
        stubQueries(db, [['FROM attests m LEFT JOIN actions', legs()]]);
        const [data] = await db.getAttestation(detailConfig('getAttestation', REQ));
        expect(data.response.quorum_signatures).to.deep.equal([{ pubkey: PK, sig: 'deadbeef' }]);
        expect(data.request.responsible_set).to.deep.equal([PK]);
        expect(data.request.callback_params).to.deep.equal(['x']);
        expect(data.provider_id).to.equal('http_get');
    });

    it('names the relay legs from the columns the v3/v4 rows carry', async () => {
        const db = makeDb();
        stubQueries(db, [['FROM attests m LEFT JOIN actions', legs()]]);
        const [data] = await db.getAttestation(detailConfig('getAttestation', REQ));
        expect(data.relay.is_relay).to.equal(true);
        expect(data.relay.origin_chain).to.equal('DOGE');
        expect(data.relay.origin_action_index).to.equal(42);
        expect(data.relay.response_relayed).to.equal(true);
        expect(data.callback_execute_action_index).to.equal(777);
    });

    it('returns [null] for an unknown request_id', async () => {
        const db = makeDb();
        stubQueries(db, []);
        expect(await db.getAttestation(detailConfig('getAttestation', REQ))).to.deep.equal([null]);
    });
});

/* ─────────────────────────────  getAnchor (M4.5) ─────────────────────────── */

describe('Database#getAnchor (M4 composed anchor detail)', () => {

    const ANCHOR = [{
        action: 'ANCHOR', action_index: 1006, version: 5, chain: 'BTC', network: 'mainnet',
        block_index: 2497, checkpoint_seq: 110, snapshot_block: 110, match_batch_seq: 3,
        validator_signatures: '[{"pubkey":"' + PK + '","sig":"aa"}]',
        publisher: PK, publisher_attestations: '[{"pubkey":"' + PK + '","sig":"bb"}]',
        tx_hash: TXID, archive_b64_length: 4096
    }];

    function anchorDb(hubOperational = null){
        const db = makeDb(hubOperational);
        stubQueries(db, [
            ['FROM anchor_actions m INNER JOIN actions', ANCHOR],
            ['`XChain_Hub`.state_checkpoints sc', [{
                block_index: 2497, checkpoint_seq: 110, snapshot_block: 110,
                validator_signatures: '[]'
            }]],
            ['`XChain_Hub`.capability_snapshots m', [{ signing_pubkey: PK, amount: '100', source: ADDR }]],
            ['`XChain_Hub`.anchor_reward_attestations m', [{ id: 1, reward_type: 'anchor_DOGE' }]]
        ]);
        return db;
    }

    it('keys on action_index for a numeric QUERY and on the transaction hash otherwise', async () => {
        const numericDb = anchorDb();
        await numericDb.getAnchor(detailConfig('getAnchor', '1006'));
        const numericSpine = captured(numericDb)[0];
        expect(numericSpine.query).to.include('WHERE m.action_index=?');
        expect(numericSpine.args).to.deep.equal([1006]);

        const hashDb = anchorDb();
        await hashDb.getAnchor(detailConfig('getAnchor', TXID.toUpperCase()));
        const hashSpine = captured(hashDb)[0];
        // A 64-hex hash compared against a BIGINT column is COERCED, not matched, so
        // the two forms must never be folded into one OR.
        expect(hashSpine.query).to.include('WHERE t2.hash=?');
        expect(hashSpine.query).to.not.include('m.action_index=?');
        expect(hashSpine.args).to.deep.equal([TXID]);
    });

    it('binds chain/network on the CHAIN-SCOPED reward table, filterParams first', async () => {
        const db = anchorDb();
        await db.getAnchor(detailConfig('getAnchor', '1006'));
        const q = findQuery(db, '`XChain_Hub`.anchor_reward_attestations m');
        expect(q).to.exist;
        expect(q.query).to.include('AND m.chain = ? AND m.network = ?');
        // chain/network are part of uq_reward_tuple, so they lead the arg array
        // exactly as getAnchorRewardAttestations binds them.
        expect(q.args.slice(0, 2)).to.deep.equal(['BTC', 'mainnet']);
        expect(q.args[2]).to.equal(TXID);
        expect(q.args.slice(3)).to.deep.equal([110, 110, 3]);
        expect(q.query).to.match(new RegExp('LIMIT ' + LIMIT + '$'));
    });

    it('binds NO chain/network on the CHAIN-AGNOSTIC capability_snapshots table', async () => {
        const db = anchorDb();
        await db.getAnchor(detailConfig('getAnchor', '1006'));
        const q = findQuery(db, '`XChain_Hub`.capability_snapshots m');
        expect(q).to.exist;
        // capability_snapshots HAS no chain or network column. A filter here would
        // not error, it would return zero rows forever.
        expect(q.query).to.not.match(/m\.chain\s*=\s*\?/);
        expect(q.query).to.not.match(/m\.network\s*=\s*\?/);
        expect(q.args).to.deep.equal([110, 'oracle_publish']);
        expect(q.query).to.match(new RegExp('LIMIT ' + LIMIT + '$'));
    });

    it('reuses the shared correlated-MAX checkpoint predicate rather than a fourth variant', async () => {
        const db = anchorDb();
        await db.getAnchor(detailConfig('getAnchor', '1006'));
        const q = findQuery(db, '`XChain_Hub`.state_checkpoints sc');
        expect(q).to.exist;
        const src      = db._checkpointSource(detailConfig('getAnchor', '1006'));
        const expected = db._latestCheckpointPredicate(src, 'sc').sql.replace(/\s+/g, ' ').trim();
        expect(q.query).to.include(expected);
        // Left-to-right: the height, the outer chain/network filter, then the same
        // pair inside the correlated subquery.
        expect(q.args).to.deep.equal([2497, 'BTC', 'mainnet', 'BTC', 'mainnet']);
    });

    it('never selects the archive blob, only its length and checksum metadata', async () => {
        const db = anchorDb();
        await db.getAnchor(detailConfig('getAnchor', '1006'));
        for(const q of captured(db))
            expect(q.query, 'archive_b64 blob selected').to.not.match(/(SELECT|,)\s*m\.archive_b64\s*(,|\s+FROM)/);
        expect(captured(db)[0].query).to.include('CHAR_LENGTH(m.archive_b64) as archive_b64_length');
    });

    it('serves entirely from the co-located mirror, with the hub RPC unreachable', async () => {
        // A throwing enabled() is the regression guard: this composition must never
        // acquire a hub-RPC dependency, because state_checkpoints /
        // capability_snapshots / anchor_reward_attestations are mirrored transport.
        const hostile = { enabled(){ throw new Error('hub RPC must not be consulted by getAnchor'); } };
        const db = anchorDb(hostile);
        const [data] = await db.getAnchor(detailConfig('getAnchor', '1006'));
        expect(data.publisher_election).to.have.lengthOf(1);
        expect(data.reward_attestations).to.have.lengthOf(1);
        expect(data.checkpoint.checkpoint_seq).to.equal('110');
    });

    it('parses both signature blobs and bounds the continuation-chunk list', async () => {
        const db = anchorDb();
        const [data] = await db.getAnchor(detailConfig('getAnchor', '1006'));
        expect(data.validator_signatures).to.deep.equal([{ pubkey: PK, sig: 'aa' }]);
        expect(data.publisher_attestations).to.deep.equal([{ pubkey: PK, sig: 'bb' }]);
        const chunks = captured(db).find(q => q.query.includes('WHERE m.match_batch_seq=?'));
        expect(chunks).to.exist;
        expect(chunks.args).to.deep.equal([3]);
        expect(chunks.query).to.match(new RegExp('LIMIT ' + LIMIT + '$'));
        assertEveryQueryBounded(db);
    });

    it('returns [null] for an unknown anchor', async () => {
        const db = makeDb();
        stubQueries(db, []);
        expect(await db.getAnchor(detailConfig('getAnchor', '999999'))).to.deep.equal([null]);
    });

    /* ------------------------- v0 bundle composition ------------------------ */

    // A v0 ANCHOR is ONE action carrying every checkpointed chain of a network, stored
    // as sibling anchor_actions rows sharing an action_index at section_index 0..N-1.
    // The bundle-level fields are denormalized onto every row; the per-chain fields are
    // not. Composing them back into one header plus an ordered section list is the
    // whole of this leg, and getting it wrong is silent: the page would render one
    // arbitrary chain as if it were the entire anchor.
    describe('v0 bundle composition', () => {

        // The serving explorer is DOGE here on purpose. Sections are ordered CHAIN
        // ascending, so this coin's own section is NOT section 0, which is the only
        // arrangement in which picking section 0 for the chain-filtered mirror legs
        // fails visibly instead of accidentally being right.
        const BUNDLE_TXID = 'e'.repeat(64);

        const SECTIONS = [
            { section_index: 0, chain: 'BTC',  network: 'regtest', block_index: 2497, block_hash: 'b7'.repeat(32),
              checkpoint_seq: 110, snapshot_block: 110, state_root: '18'.repeat(32), state_root_version: 1,
              block_merkle_root: '29'.repeat(32), block_merkle_version: 1,
              validator_signatures: '[{"pubkey":"' + PK + '","sig":"aa"}]', status: 'valid' },
            { section_index: 1, chain: 'DOGE', network: 'regtest', block_index: 3001, block_hash: 'd0'.repeat(32),
              checkpoint_seq: 112, snapshot_block: 112, state_root: '3a'.repeat(32), state_root_version: 1,
              block_merkle_root: '4b'.repeat(32), block_merkle_version: 1,
              validator_signatures: '[{"pubkey":"' + PK + '","sig":"bb"},{"pubkey":"' + ADDR + '","sig":"cc"}]', status: 'valid' },
            { section_index: 2, chain: 'LTC',  network: 'regtest', block_index: 1200, block_hash: '1c'.repeat(32),
              checkpoint_seq: 111, snapshot_block: 111, state_root: '5c'.repeat(32), state_root_version: 1,
              block_merkle_root: '6d'.repeat(32), block_merkle_version: 1,
              validator_signatures: '[]', status: 'valid' }
        ];

        // The spine matches section 0 (ORDER BY section_index ASC), so the header
        // arrives carrying BTC's per-chain values and the bundle's shared ones.
        const HEADER = Object.assign({}, SECTIONS[0], {
            action: 'ANCHOR', action_index: 1100, version: 0,
            publisher: PK, publisher_attestations: '[{"pubkey":"' + PK + '","sig":"dd"}]',
            block_index_doge: 3010, tx_hash: BUNDLE_TXID, archive_b64_length: null,
            match_batch_seq: null
        });

        function bundleConfig(search = '1100'){
            return makeConfig({
                coin: 'DOGE',
                type: 'api',
                data: {
                    method: 'getAnchor',
                    search,
                    type: null,
                    sql: {
                        order: 'DESC',
                        limit: LIMIT,
                        where: { data: 'm.action_index IS NOT NULL', offset: '', offsetArgs: [] }
                    }
                }
            });
        }

        function bundleDb(){
            const db = new DatabaseReal({ configInfo, util, hubOperational: null });
            db.checkpointDb = { DOGE: { name: 'XChain_Hub', chain: 'DOGE', network: 'regtest' } };
            stubQueries(db, [
                ['FROM anchor_actions m INNER JOIN actions', [HEADER]],
                ['WHERE m.action_index=? ORDER BY m.section_index ASC', SECTIONS],
                ['`XChain_Hub`.state_checkpoints sc', [{ block_index: 3001, checkpoint_seq: 112, snapshot_block: 112, validator_signatures: '[]' }]],
                ['`XChain_Hub`.capability_snapshots m', [{ signing_pubkey: PK, amount: '100', source: ADDR }]],
                ['`XChain_Hub`.anchor_reward_attestations m', [{ id: 9, reward_type: 'anchor_bundle' }]]
            ]);
            return db;
        }

        it('composes the three sibling rows into ONE header plus three sections in section_index order', async () => {
            const db = bundleDb();
            const [data] = await db.getAnchor(bundleConfig());
            expect(data.action_index).to.equal(1100);
            expect(data.version).to.equal(0);
            expect(data.section_count).to.equal(3);
            expect(data.sections.map(s => s.section_index)).to.deep.equal([0, 1, 2]);
            expect(data.sections.map(s => s.chain)).to.deep.equal(['BTC', 'DOGE', 'LTC']);
            // Per-chain fields stay ON the section, never flattened onto the header.
            expect(data.sections.map(s => s.block_index)).to.deep.equal([2497, 3001, 1200]);
            expect(data.sections.map(s => s.checkpoint_seq)).to.deep.equal([110, 112, 111]);
            // Every section's own quorum is parsed, not just the header's.
            expect(data.sections.map(s => s.validator_signatures.length)).to.deep.equal([1, 2, 0]);
            // Bundle-level fields are the header's, denormalized identically on
            // every row and therefore correct whichever section the spine matched.
            expect(data.publisher).to.equal(PK);
            expect(data.publisher_attestations).to.deep.equal([{ pubkey: PK, sig: 'dd' }]);
            expect(data.tx_hash).to.equal(BUNDLE_TXID);
        });

        it('the header snapshot_block is the MAX over the sections, not section 0\'s', async () => {
            const db = bundleDb();
            const [data] = await db.getAnchor(bundleConfig());
            // Section 0 (BTC) rode at 110; the bundle was elected and attested at 112.
            // Reading 110 as the bundle's block looks the electorate up at the wrong height.
            expect(data.snapshot_block).to.equal(112);
            const cap = findQuery(db, '`XChain_Hub`.capability_snapshots m');
            expect(cap.args).to.deep.equal([112, 'oracle_publish']);
        });

        it('keys the chain-filtered mirror leg off THIS coin\'s section, not section 0', async () => {
            const db = bundleDb();
            const [data] = await db.getAnchor(bundleConfig());
            // The mirror is filtered to DOGE/regtest. Binding BTC's 2497 there cannot
            // error, it returns nothing, and a good bundle reads as uncovered.
            const cp = findQuery(db, '`XChain_Hub`.state_checkpoints sc');
            expect(cp.args).to.deep.equal([3001, 'DOGE', 'regtest', 'DOGE', 'regtest']);
            expect(data.local_section_index).to.equal(1);
        });

        it('correlates the anchor_bundle reward on the SNAPSHOT BLOCK round, not a section seq', async () => {
            const db = bundleDb();
            await db.getAnchor(bundleConfig());
            const q = findQuery(db, '`XChain_Hub`.anchor_reward_attestations m');
            // One anchor_bundle reward per bundle, round_reference = SNAPSHOT_BLOCK, so
            // the bundle's own block has to be among the rounds the OR leg accepts.
            expect(q.args.slice(0, 2)).to.deep.equal(['DOGE', 'regtest']);
            expect(q.args[2]).to.equal(BUNDLE_TXID);
            expect(q.args.slice(3)).to.deep.equal([112, 110, 112]);
        });

        it('bounds the section query and takes NO second query on a single-checkpoint anchor', async () => {
            const bundle = bundleDb();
            await bundle.getAnchor(bundleConfig());
            const sections = findQuery(bundle, 'WHERE m.action_index=? ORDER BY m.section_index ASC');
            expect(sections).to.exist;
            expect(sections.args).to.deep.equal([1100]);
            expect(sections.query).to.match(new RegExp('LIMIT ' + LIMIT + '$'));
            assertEveryQueryBounded(bundle);

            // An archive or retired per-chain version is a single row at section 0 and
            // must not pay for a sibling lookup at all.
            const single = anchorDb();
            const [data] = await single.getAnchor(detailConfig('getAnchor', '1006'));
            expect(captured(single).some(q => q.query.includes('ORDER BY m.section_index ASC'))).to.equal(false);
            expect(data.sections).to.deep.equal([]);
            expect(data.section_count).to.equal(1);
        });
    });
});

/* ─────────────────────── getAddressStaking (M4.6) ────────────────────────── */

describe('Database#getAddressStaking (M4 address staking panel)', () => {

    function stakingDb(plan = []){
        const db = makeDb();
        stubQueries(db, [['SELECT MAX(block_index) as max_index', [{ max_index: 100 }]], ...plan]);
        return db;
    }

    it('computes cooldown maturity against the indexer tip, not wall clock', async () => {
        const db = stakingDb([
            ['FROM contract_unstakes m', [{ action_index: 1, cooldown_end_block: 130, amount: '5' }]],
            ['FROM unstakes m',          [{ action_index: 2, cooldown_end_block: 90,  amount: '7' }]]
        ]);
        const [data] = await db.getAddressStaking(detailConfig('getAddressStaking', ADDR));
        expect(data.chain_tip).to.equal(100);
        expect(data.cooldowns[0].blocks_remaining).to.equal(30);
        expect(data.cooldowns[0].matured).to.equal(false);
        expect(data.capability_cooldowns[0].blocks_remaining).to.equal(0);
        expect(data.capability_cooldowns[0].matured).to.equal(true);
    });

    it('scopes EACH slash family through the stake ledger that family actually burns from', async () => {
        const db = stakingDb();
        await db.getAddressStaking(detailConfig('getAddressStaking', ADDR));
        const cap = findQuery(db, 'FROM capability_slash_events m');
        const con = findQuery(db, 'FROM slash_events m INNER JOIN blocks');
        expect(cap, 'capability slash family missing').to.exist;
        expect(con, 'contract slash family missing').to.exist;
        // Neither slash table names an address, so exposure reaches this address
        // through the KEYS it staked. The capability family burns capability stakes
        // (`stakes`); the contract family burns contract stakes (`contract_stakes`).
        // Sourcing both from one ledger over- or under-reports.
        expect(cap.query).to.include('SELECT s.signing_pubkey_id FROM stakes s');
        expect(cap.query).to.not.include('FROM contract_stakes cs');
        expect(con.query).to.include('SELECT cs.signing_pubkey_id FROM contract_stakes cs');
        expect(con.query).to.not.include('FROM stakes s');
        expect(cap.args).to.deep.equal([ADDR]);
        expect(con.args).to.deep.equal([ADDR]);
    });

    it('describes a capability slash with the full superset columns (slashed key + submitter + destination)', async () => {
        // Same row shape as getCapabilitySlashEvents and the validator page's
        // slash leg, so one slash reads identically wherever it surfaces.
        const db = stakingDb();
        await db.getAddressStaking(detailConfig('getAddressStaking', ADDR));
        const cap = findQuery(db, 'FROM capability_slash_events m');
        expect(cap.query).to.include('pk.pubkey as slashed_pubkey');
        expect(cap.query).to.include('sub.address as submitter');
        expect(cap.query).to.include('dst.address as destination');
    });

    it('EVERY sub-list interpolates sql.limit; nothing but a scalar aggregate is unbounded', async () => {
        const db = stakingDb();
        await db.getAddressStaking(detailConfig('getAddressStaking', ADDR));
        assertEveryQueryBounded(db);
        const bounded = pageBoundedQueries(db).map(q => q.query);
        for(const table of ['FROM contract_stakes m', 'FROM stakes m INNER JOIN blocks',
                            'FROM contract_unstakes m', 'FROM unstakes m',
                            'FROM validator_rewards m INNER JOIN blocks',
                            'FROM reward_claims m INNER JOIN blocks',
                            'FROM capability_slash_events m', 'FROM slash_events m'])
            expect(bounded.some(q => q.includes(table)), 'unbounded or missing leg: ' + table).to.equal(true);
    });

    it('shares the COLLECT trail with the validator page, so claimable cannot diverge', async () => {
        const db = stakingDb([
            ['FROM validator_rewards m INNER JOIN index_addresses', [{ total: '9.00000000' }]],
            ['FROM reward_claims m INNER JOIN index_addresses',     [{ total: '2.00000000' }]]
        ]);
        const [data] = await db.getAddressStaking(detailConfig('getAddressStaking', ADDR));
        expect(data.rewards_total).to.equal('9.00000000');
        expect(data.collected_total).to.equal('2.00000000');
        expect(data.claimable).to.equal('7.00000000');
    });

    it('returns [null] with no reads when the address is absent', async () => {
        const db = stakingDb();
        expect(await db.getAddressStaking(detailConfig('getAddressStaking', null))).to.deep.equal([null]);
        expect(db.doQuery.called).to.equal(false);
    });
});
