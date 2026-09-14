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
} = require('../db_m4_compositions.test.js');
const { expect } = require('chai');

/* ─────────────────────────────  getAnchor (M4.5) ─────────────────────────── */

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


/* ------------------------- v0 bundle composition ------------------------ */

// A v0 ANCHOR is ONE action carrying every checkpointed chain of a network, stored
// as sibling anchor_actions rows sharing an action_index at section_index 0..N-1.
// The bundle-level fields are denormalized onto every row; the per-chain fields are
// not. Composing them back into one header plus an ordered section list is the
// whole of this leg, and getting it wrong is silent: the page would render one
// arbitrary chain as if it were the entire anchor.
function bundleComposition1() {
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

}


function bundleComposition2() {
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

}

describe('Database#getAnchor (M4 composed anchor detail)', () => {

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

});

describe('Database#getAnchor (M4 composed anchor detail)', () => {

    it('reuses the shared correlated-MAX checkpoint predicate rather than a fourth variant', async () => {
        const db = anchorDb();
        await db.getAnchor(detailConfig('getAnchor', '1006'));
        const q = findQuery(db, '`XChain_Hub`.state_checkpoints sc');
        expect(q).to.exist;
        const src      = db.checkpointSource(detailConfig('getAnchor', '1006'));
        const expected = db.latestCheckpointPredicate(src, 'sc').sql.replace(/\s+/g, ' ').trim();
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

});

describe('Database#getAnchor (M4 composed anchor detail)', () => {
    describe('v0 bundle composition', bundleComposition1);
    describe('v0 bundle composition', bundleComposition2);

});
