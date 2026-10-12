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
 * Unit tests for attestBatchColumnsPresent (src/db/shared.js): the schema probe
 * that decides whether attestation reads project the batch columns. A probe that
 * succeeds is cached; a probe that throws must not be mistaken for an old schema.
 */

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');

const warnings = [];
const { attestBatchColumnsPresent } = proxyquire('../../../../src/db/shared.js', {
    '../observability': { getLogger: () => ({ warn: (code, meta) => warnings.push({ code, meta }) }) }
});

// The six columns the two indexer batch migrations add, in the probe's own order.
const COLUMNS = [
    'batch_action_index', 'batch_window_start', 'batch_window_end', 'batch_row_count',
    'batch_chunk_index', 'batch_total_chunks'
];

// A db double whose doQuery answers from a queue of results, each a row list or an Error.
function fakeDb(answers) {
    const db = { calls: 0 };
    db.doQuery = async () => {
        const next = answers[Math.min(db.calls, answers.length - 1)];
        db.calls++;
        if (next instanceof Error) throw next;
        return next.map((name) => ({ COLUMN_NAME: name }));
    };
    return db;
}

describe('attestBatchColumnsPresent', function () {
    const config = { coin: 'X' };
    beforeEach(() => { warnings.length = 0; });

    it('caches a probe that finds every batch column', async function () {
        const db = fakeDb([COLUMNS]);
        expect(await attestBatchColumnsPresent(db, config)).to.equal(true);
        expect(await attestBatchColumnsPresent(db, config)).to.equal(true);
        expect(db.calls).to.equal(1);
    });

    it('caches a confirmed absence within the TTL and reports it once', async function () {
        const db = fakeDb([COLUMNS.slice(0, 5)]);
        expect(await attestBatchColumnsPresent(db, config)).to.equal(false);
        expect(await attestBatchColumnsPresent(db, config)).to.equal(false);
        expect(db.calls).to.equal(1);
        expect(warnings.map((w) => w.code)).to.deep.equal(['ATTEST_BATCH_COLUMNS_ABSENT']);
        expect(warnings[0].meta.missing).to.deep.equal([COLUMNS[5]]);
    });

    it('does not cache a failed probe as absence, so the next request probes again', async function () {
        const db = fakeDb([new Error('connection lost'), COLUMNS]);
        expect(await attestBatchColumnsPresent(db, config)).to.equal(false);
        expect(db.attestBatchColumnMemo.X).to.equal(undefined);
        expect(await attestBatchColumnsPresent(db, config)).to.equal(true);
        expect(db.calls).to.equal(2);
    });

    it('warns about failed probes at most once per TTL', async function () {
        const db = fakeDb([new Error('timeout')]);
        expect(await attestBatchColumnsPresent(db, config)).to.equal(false);
        expect(await attestBatchColumnsPresent(db, config)).to.equal(false);
        expect(db.calls).to.equal(2);
        expect(warnings.map((w) => w.code)).to.deep.equal(['ATTEST_BATCH_PROBE_FAILED']);
    });
});
