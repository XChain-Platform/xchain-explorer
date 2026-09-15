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

function stakingDb(plan = []){
    const db = makeDb();
    stubQueries(db, [['SELECT MAX(block_index) as max_index', [{ max_index: 100 }]], ...plan]);
    return db;
}

/* ─────────────────────── getAddressStaking (M4.6) ────────────────────────── */

describe('Database#getAddressStaking (M4 address staking panel)', () => {
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
});

describe('Database#getAddressStaking (M4 address staking panel)', () => {
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
