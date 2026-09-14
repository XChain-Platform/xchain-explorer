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

const {
    DatabaseReal, configInfo, util, sinon, makeConfig, HUB, PK, ADDR, TXID, REQ, LIMIT,
    makeDb, detailConfig, stubQueries, captured, findQuery, assertEveryQueryBounded, pageBoundedQueries,
} = require('../../db_m4_compositions.test.js');
const { expect } = require('chai');

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

/* ────────────────────────── getAttestation (M4.3) ────────────────────────── */

describe('Database#getAttestation (M4 composed attestation lifecycle)', () => {
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
        // Nothing may go looking for a version-2 row: the indexer's parseExpire
        // only flips the v0 row's status, so such a query would always be empty.
        for(const q of captured(db))
            expect(q.query, 'queried for a v2 row that cannot exist').to.not.match(/version\s*=\s*2/);
    });
});

describe('Database#getAttestation (M4 composed attestation lifecycle)', () => {
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
