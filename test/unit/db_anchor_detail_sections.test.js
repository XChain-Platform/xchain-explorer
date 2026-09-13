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
 * ANCHOR action detail: anchor_actions is keyed (action_index, section_index),
 * one row per checkpointed chain in a v0 bundle. A LIMIT 1 spine with no
 * ORDER BY therefore returns whichever section the join plan reaches first and
 * presents its chain, checkpoint_seq and hashes as the whole anchor, with every
 * other chain elided and nothing on the page saying so. db.getAnchor already
 * reads sections correctly for the /anchor page; this pins the action-detail
 * path to the same contract.
 *********************************************************************/

'use strict';

const assert     = require('assert');
const proxyquire = require('proxyquire');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

const ACTION = 9911;

// Section 0 is the spine the header is taken from. Its snapshot_block is the
// LOWEST of the three: a lagging chain rides at its own older height while the
// election and the publisher attestation are drawn at the bundle MAX.
const SECTIONS = [
    { section_index: 0, chain: 'BTC',  block_index: 500, block_hash: 'aa', checkpoint_seq: 11,
      snapshot_block: 900000, state_root: 'r0', block_merkle_root: 'm0', status: 'valid' },
    { section_index: 1, chain: 'LTC',  block_index: 700, block_hash: 'bb', checkpoint_seq: 12,
      snapshot_block: 910000, state_root: 'r1', block_merkle_root: 'm1', status: 'valid' },
    { section_index: 2, chain: 'DOGE', block_index: 900, block_hash: 'cc', checkpoint_seq: 13,
      snapshot_block: 905000, state_root: 'r2', block_merkle_root: 'm2', status: 'valid' }
];

function headerRow(version) {
    return {
        action: 'ANCHOR', action_format: 1, action_index: ACTION, section_index: 0,
        version, chain: 'BTC', network: 'mainnet', block_index: 1234,
        anchored_block_index: 500, block_hash: 'aa', ledger_hash: 'dd', actions_hash: 'ee',
        contract_hash: 'ff', checkpoint_seq: 11, snapshot_block: 900000,
        match_batch_seq: null, match_count: null, batch_crc32: null, total_chunks: null,
        chunk_index: null, state_root: 'r0', state_root_version: 1,
        block_merkle_root: 'm0', block_merkle_version: 1, validator_signatures: '[]',
        block_index_doge: 77, publisher: null, publisher_attestations: null,
        timestamp: 1700000000, tx_hash: 'hash', tx_index: 7, status: 'valid'
    };
}

// Answer by statement shape and record every statement, so the ORDER BY on the
// spine is observable rather than assumed.
function makeDb(version, sections) {
    const configInfo = createConfigInfoStub();
    const util       = new Utility(configInfo);
    const db         = new Database({ configInfo, util });
    db.queries = [];
    db.doQuery = async (config, sql) => {
        const text = String(sql);
        db.queries.push(text);
        if (/FROM\s+anchor_actions/.test(text) && text.includes('LIMIT 1')) return [headerRow(version)];
        if (/FROM\s+anchor_actions/.test(text)) return sections;
        return [];
    };
    db.getActionType      = async () => 'ANCHOR';
    db.getActionFeeData   = async () => null;
    db.getTransactionData = async () => null;
    return db;
}

const config = { coin: 'DOGE', data: {} };

describe('ANCHOR action detail sections @regression', function () {

    it('orders the LIMIT 1 spine by section_index so the header is section 0', async function () {
        const db = makeDb(0, SECTIONS);
        await db.getActionData(config, ACTION);
        const spine = db.queries.find((q) => /FROM\s+anchor_actions/.test(q) && q.includes('LIMIT 1'));
        assert.ok(spine, 'the anchor spine query must run');
        assert.ok(/ORDER BY\s+m\.section_index ASC\s+LIMIT 1/.test(spine.replace(/\s+/g, ' ')),
            'the spine must order by section_index before LIMIT 1, not take an arbitrary row');
        assert.ok(/m\.section_index/.test(spine), 'the spine must project section_index');
    });

    it('returns every chain of a v0 bundle, ordered by section_index', async function () {
        const db   = makeDb(0, SECTIONS);
        const data = await db.getActionData(config, ACTION);
        assert.ok(Array.isArray(data.sections), 'sections must be the per-chain list');
        assert.strictEqual(data.section_count, 3);
        assert.deepStrictEqual(data.sections.map((s) => s.chain), ['BTC', 'LTC', 'DOGE']);
        assert.deepStrictEqual(data.sections.map((s) => s.section_index), [0, 1, 2]);
    });

    it('takes the bundle snapshot_block as the MAX over the sections', async function () {
        const db   = makeDb(0, SECTIONS);
        const data = await db.getActionData(config, ACTION);
        assert.strictEqual(data.snapshot_block, 910000,
            'section 0 is the lowest height; the election is drawn at the bundle MAX');
    });

    it('keeps the section-0 header fields for single-value consumers', async function () {
        const db   = makeDb(0, SECTIONS);
        const data = await db.getActionData(config, ACTION);
        assert.strictEqual(data.chain, 'BTC');
        assert.strictEqual(data.checkpoint_seq, 11);
        assert.strictEqual(data.block_hash, 'aa');
    });

    it('treats a v1 archive head as a single section and leaves its snapshot_block alone', async function () {
        const db   = makeDb(1, [SECTIONS[0]]);
        const data = await db.getActionData(config, ACTION);
        assert.deepStrictEqual(data.sections, []);
        assert.strictEqual(data.section_count, 1);
        assert.strictEqual(data.snapshot_block, 900000);
    });

    // A non-bundle version never claims a structure it does not have, even when
    // the table happens to hold sibling rows for it.
    it('does not fan a v2 continuation out into sections', async function () {
        const db   = makeDb(2, SECTIONS);
        const data = await db.getActionData(config, ACTION);
        assert.deepStrictEqual(data.sections, []);
        assert.strictEqual(data.section_count, 1);
        assert.strictEqual(data.snapshot_block, 900000);
    });
});
