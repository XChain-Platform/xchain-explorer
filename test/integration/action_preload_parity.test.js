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
 * Golden-parity coverage for the page-level shared-leg prefetch.
 *
 * getActionDataBatch used to overlap up to BATCH_CONCURRENCY unmodified
 * getActionData calls, so a page's DB work stayed O(actions x queries): every
 * index ran its own action-type, three ledger-effect, fee and transaction
 * queries. It now prefetches those legs ONCE for the page (_buildActionPreload)
 * and threads them in, leaving only the per-handler detail queries per index.
 *
 * This file is the evidence that the rewrite is payload-neutral, and it is
 * deliberately mock-free: the sibling unit suite
 * (db.action-summary-batch-parity.test.js) stubs getActionData itself, so a
 * green there says nothing about getActionData's INTERNALS, which is exactly
 * what changed. Here the real methods run against the real seeded MariaDB and
 * the two paths are compared byte for byte:
 *
 *   baseline  - getActionData(config, idx) per index, cold cache, no preload
 *   batched   - getActionDataBatch(config, [all indexes]), cold cache
 *
 * It also pins the point of the change: a counting wrapper over doQuery proves
 * the page's shared-leg query count stopped scaling with the row count.
 *
 * Requires the integration MariaDB on 127.0.0.1:3307
 * (npm run test:integration:up).
 */

'use strict';

const { expect } = require('chai');
const db         = require('./helpers/db-setup');
const { createApp } = require('./helpers/app-setup');

let explorer, configInfo, database, util;

// Every action_index the baseline fixture seeds.
const ACTION_INDEXES = Array.from({ length: 30 }, (_, i) => i + 1);

function cfg() {
    return { coin: 'RBTC', data: {} };
}

// The single-index and batched effect queries share an ORDER BY, so a fixture
// with one row per action proves nothing about grouping. These rows give the
// comparison teeth: several ticks under one action, two amounts under one tick,
// and two addresses at an identical tick+amount (the ORDER BY's last tie-break).
const EXTRA_CREDITS = `
    INSERT INTO credits (action_index, address_id, tick_id, amount) VALUES
    (3, 1, 2, '10.00000000'),
    (3, 3, 2, '90.00000000'),
    (3, 4, 3, '5.00000000'),
    (3, 5, 1, '1000.00000000'),
    (5, 1, 1, '2000.00000000'),
    (5, 2, 2, '7.50000000'),
    (5, 4, 2, '7.50000000')`;

const EXTRA_DEBITS = `
    INSERT INTO debits (action_index, address_id, tick_id, amount) VALUES
    (3, 2, 3, '33.00000000'),
    (3, 5, 3, '33.00000000'),
    (7, 1, 1, '12.00000000')`;

const EXTRA_ESCROWS = `
    INSERT INTO escrows (action_index, address_id, tick_id, amount) VALUES
    (7, 2, 2, '1.00000000'),
    (7, 3, 2, '2.00000000')`;

// No fee rows exist in the baseline fixture, so without these the fee leg would
// be compared only in its "absent" shape.
const EXTRA_FEES = `
    INSERT INTO fees (action_index, tick_id, amount, method, destination_id,
                      gas_cost, gas_price, xchain_amount, payment_mode,
                      native_coin_amount, native_coin, oracle_round,
                      fee_preference, status_id, fee_version) VALUES
    (3,  1, '0.00100000', 2, 2, 21000, '0.00000010', '0.00021000', 2, NULL, NULL, NULL, 2, 1, 2),
    (7,  1, '0.00050000', 1, 3, 10500, '0.00000020', '0.00021000', 1, '0.00000500', 'BTC', 7, 1, 1, 2),
    (11, 2, '0.00200000', 2, 1, 42000, '0.00000010', '0.00042000', 2, NULL, NULL, NULL, 3, 1, 1)`;

before(async function () {
    this.timeout(30000);
    await db.setupDatabase();
    await db.query(EXTRA_CREDITS);
    await db.query(EXTRA_DEBITS);
    await db.query(EXTRA_ESCROWS);
    await db.query(EXTRA_FEES);
    ({ explorer, configInfo } = await createApp());
    database = explorer.db;
    util     = database.util;
});

after(async function () {
    this.timeout(10000);
    await db.teardownDatabase();
});

describe('getActionData page preload: golden parity', function () {
    this.timeout(60000);

    let baseline = new Map();
    let batched  = new Map();

    before(async function () {
        // Baseline: the pre-change path, one cold getActionData per index with no
        // preload argument at all.
        database._actionDataCache.clear();
        for (const idx of ACTION_INDEXES) {
            database._actionDataCache.clear();
            baseline.set(idx, await database.getActionData(cfg(), idx));
        }
        // Batched: the page path, cold cache, preload built for the whole set.
        database._actionDataCache.clear();
        batched = await database.getActionDataBatch(cfg(), ACTION_INDEXES.slice());
        database._actionDataCache.clear();
    });

    it('resolves every seeded action through the batch path', function () {
        expect(batched.size).to.equal(ACTION_INDEXES.length);
        for (const idx of ACTION_INDEXES)
            expect(batched.has(idx), 'missing action_index ' + idx).to.be.true;
    });

    it('emits byte-identical payloads for every action, key order included', function () {
        for (const idx of ACTION_INDEXES) {
            const a = util.jsonStringify(baseline.get(idx));
            const b = util.jsonStringify(batched.get(idx));
            expect(b, 'payload drift at action_index ' + idx).to.equal(a);
        }
    });

    it('preserves per-index ledger-effect row ORDER, not just row membership', function () {
        // Membership-only equality would pass a grouping bug that reordered rows,
        // so assert the ordered projection of each effect array explicitly.
        const seen = { credits: 0, debits: 0, escrows: 0 };
        for (const idx of ACTION_INDEXES) {
            for (const key of ['credits', 'debits', 'escrows']) {
                const before = baseline.get(idx)[key];
                const after  = batched.get(idx)[key];
                if (before === null) {
                    expect(after, key + ' appeared at action_index ' + idx).to.equal(null);
                    continue;
                }
                seen[key] += before.length;
                expect(after.length, key + ' length at action_index ' + idx).to.equal(before.length);
                for (let i = 0; i < before.length; i++) {
                    expect(Object.keys(after[i]), key + ' key order at ' + idx + '#' + i)
                        .to.deep.equal(Object.keys(before[i]));
                    expect(util.jsonStringify(after[i]), key + ' row ' + i + ' at action_index ' + idx)
                        .to.equal(util.jsonStringify(before[i]));
                }
            }
        }
        // The fixture must actually exercise multi-row groups, or this test is vacuous.
        expect(seen.credits, 'fixture seeded too few credits').to.be.greaterThan(8);
        expect(seen.debits,  'fixture seeded too few debits').to.be.greaterThan(8);
        expect(seen.escrows, 'fixture seeded too few escrows').to.be.greaterThan(4);
    });

    it('carries the fee row through the preload unchanged', function () {
        let withFee = 0;
        for (const idx of ACTION_INDEXES) {
            const before = baseline.get(idx).fee;
            const after  = batched.get(idx).fee;
            expect(util.jsonStringify(after), 'fee drift at action_index ' + idx)
                .to.equal(util.jsonStringify(before));
            if (before !== null && before !== undefined) withFee++;
        }
        expect(withFee, 'fixture seeded no fee rows').to.be.greaterThan(0);
    });

    it('stops scaling the shared-leg query count with the page size', async function () {
        // The finding is about total DB work, so measure it, and measure it against a
        // control that REPRODUCES the original failure: without a control, a green
        // number here only certifies that the harness never entered the path.
        // _buildActionPreload returning null is exactly the pre-change code (every
        // preload read in getActionData falls back to its single-index query).
        const realQuery   = database.doQuery.bind(database);
        const realPreload = database._buildActionPreload.bind(database);
        let count = 0;
        database.doQuery = async function (...args) { count++; return realQuery(...args); };

        const countPage = async (indexes) => {
            database._actionDataCache.clear();
            count = 0;
            await database.getActionDataBatch(cfg(), indexes.slice());
            return count;
        };

        try {
            // Control: the fan-out this finding filed.
            database._buildActionPreload = async () => null;
            const controlPage = await countPage(ACTION_INDEXES);
            const controlOne  = await countPage([ACTION_INDEXES[0]]);
            const controlPer  = (controlPage - controlOne) / (ACTION_INDEXES.length - 1);

            // Fixed: the same page through the real preload.
            database._buildActionPreload = realPreload;
            const fixedPage = await countPage(ACTION_INDEXES);
            const fixedOne  = await countPage([ACTION_INDEXES[0]]);
            const fixedPer  = (fixedPage - fixedOne) / (ACTION_INDEXES.length - 1);

            // The control must show the filed behaviour, or this test proves nothing.
            expect(controlPer, 'control did not reproduce the per-action fan-out')
                .to.be.greaterThan(3);
            // Each action carried its own type + up to 3 effect + fee + tx queries.
            expect(controlPage, 'control page query count too low to be the filed path')
                .to.be.greaterThan(90);

            // Fixed: the shared legs are 6 for the WHOLE page, so what still scales is
            // only the per-handler detail queries.
            expect(fixedPer, 'shared legs still fan out per action').to.be.lessThan(3);
            expect(fixedPage, 'page still runs O(actions x queries)').to.be.lessThan(controlPage / 2);
        } finally {
            database.doQuery            = realQuery;
            database._buildActionPreload = realPreload;
            database._actionDataCache.clear();
        }
    });
});
