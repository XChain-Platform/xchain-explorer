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
 * Payload-parity coverage for the getActionSummaryData N+1 fix.
 *
 * getActionSummaryData used to enrich each history row with a strictly-serial
 * `await getActionData(...)` per row. It now pre-resolves the DISTINCT action_index
 * set via getActionDataBatch() (bounded concurrency over the SAME getActionData) and
 * reads each row's info from a Map. Because the enrichment source is unchanged, the
 * emitted rows must be byte-for-byte identical to the old per-row path.
 *
 * These tests pin that: a faithful copy of the OLD per-row loop (`oldPath`) is run
 * against the same stubbed getActionData and its output is compared, deep-equal,
 * against the real (new, batched) getActionSummaryData across representative action
 * types (SEND with sends[0] + status fallback, a direct-field type, and a duplicate
 * action_index on the page).
 */

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };
const Database     = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });

// The field set the production projection copies is the shipped list itself
// (db.js exports it), so the reference oldPath below mirrors the pre-refactor loop
// field-for-field without a hand-maintained copy that goes stale when db.js adds
// a field (a verbatim copy here once turned this suite red as a PARITY break when
// `broadcast_fee` landed on the batched side only). What stays pinned is the LOOP
// shape: per-field copy, SEND read through sends[0], sends[0].status fallback.
const detailFields = Database.ACTION_SUMMARY_FIELDS;

// Verbatim copy of the pre-refactor per-row enrichment loop (the "old path").
function oldPath(actions, getActionData) {
    for (let data of actions) {
        let info = getActionData(data.action_index);
        data.status = info.status;
        let details = false;
        for (let name of detailFields) {
            let found  = false;
            let detail = false;
            if (typeof info[name] !== 'undefined') {
                found  = true;
                detail = info[name];
            }
            if (info.action == 'SEND' && info.sends && info.sends.length > 0) {
                found = true;
                detail = info.sends[0][name];
                if (util.isNull(data.status))
                    data.status = info.sends[0]['status'];
            }
            if (found) {
                if (!details)
                    details = {};
                details[name] = detail;
            }
        }
        data.details = details;
    }
    return actions;
}

// Representative getActionData payloads across action types, keyed by action_index.
function fixtureFor(action_index) {
    const idx = Number(action_index);
    if (idx === 1) {
        // SEND with sends[0]; top-level status undefined -> falls back to sends[0].status.
        return {
            action: 'SEND', status: undefined,
            sends: [{ amount: '100', destination: 'addrB', tick: 'DANK', status: 'valid' }],
            source: 'addrA', type: 'SEND'
        };
    }
    if (idx === 2) {
        // Direct-field type with a concrete status.
        return {
            action: 'ORDER', status: 'valid',
            give_tick: 'DANK', get_tick: 'PEPE', give_amount: '5', get_amount: '9',
            order_action_index: 2, source: 'addrC', type: 'ORDER'
        };
    }
    // Sparse action with mostly-absent detailFields and a null status.
    return {
        action: 'ADDRESS', status: null,
        source: 'addrD', type: 'ADDRESS', fee_preference: 1
    };
}

function makeDb() {
    const db = new Database(mockExplorer);
    // getActionData resolves asynchronously in production; the batch loader awaits it.
    db.getActionData = async (config, action_index) => fixtureFor(action_index);
    // The page-level shared-leg prefetch is real DB work that only getActionData
    // consumes, so with getActionData stubbed out it has no reader and would just
    // want a pool this suite has no reason to own. null is the same "no preload"
    // state getActionData already handles for every non-page caller. The
    // prefetch's own payload parity is proved against a real MariaDB in
    // test/integration/action-preload-parity.test.js, never here: this file stubs
    // getActionData, so it can say nothing about getActionData's internals.
    db._buildActionPreload = async () => null;
    // configInfo.getConfig is not exercised by the stubbed getActionData path.
    return db;
}

// Deep clone so old/new paths operate on independent row objects.
function rows() {
    return [
        { action_index: 1, action: 'SEND' },
        { action_index: 2, action: 'ORDER' },
        { action_index: 3, action: 'ADDRESS' },
        { action_index: 1, action: 'SEND' } // duplicate index on the page (distinct-set fetch)
    ];
}

describe('getActionSummaryData: batched fetch is byte-equal to the old per-row path', function () {

    it('produces identical enriched rows (status + details) across action types', async function () {
        const db = makeDb();

        const expected = oldPath(rows(), (idx) => fixtureFor(idx));
        const actual   = await db.getActionSummaryData({ coin: 'DANK' }, rows());

        expect(actual).to.deep.equal(expected);
    });

    it('fetches each distinct action_index exactly once', async function () {
        const db = makeDb();
        const calls = [];
        db.getActionData = async (config, action_index) => {
            calls.push(Number(action_index));
            return fixtureFor(action_index);
        };

        await db.getActionSummaryData({ coin: 'DANK' }, rows());

        // Page has indexes [1,2,3,1] -> distinct fetch set {1,2,3}, one call each.
        expect(calls.slice().sort()).to.deep.equal([1, 2, 3]);
    });

    it('preserves per-row info for duplicate action_index rows', async function () {
        const db = makeDb();
        const out = await db.getActionSummaryData({ coin: 'DANK' }, rows());
        // Rows 0 and 3 share action_index 1 -> identical enriched output.
        expect(out[0].details).to.deep.equal(out[3].details);
        expect(out[0].status).to.equal(out[3].status);
        expect(out[0].status).to.equal('valid'); // sends[0].status fallback
    });
});
