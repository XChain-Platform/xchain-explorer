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
 *
 * Guard: the live feed's since-queries stay unfiltered. ChangeDetector holds
 * its cursor at the last row a fetch returns whenever that row is below the
 * tip it read (ws/change_detector/bet_latches.js nextCursor), and treats a
 * fetch that comes back short of the tip as a rollback inside the poll
 * (ws/change_detector/rollback.js noteShortFetch). Both rest on one fact:
 * every index between the cursor and MAX(action_index) or MAX(block_index) is
 * a row these queries return. A WHERE term that filtered rows out (a type,
 * a status, a source), an INNER join that dropped some, or a GROUP BY or
 * DISTINCT that merged them would hold the cursor below a filtered tip row for
 * good, and run a fork search on every poll. This test fails if the WHERE
 * clause of readActionsSinceRows (behind getActionsSince) or of getBlocksSince
 * ever holds more than the cursor bounds, or the row-dropping shapes appear.
 *
 ********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

// The statement each call sends, with whitespace collapsed.
async function statementOf(call) {
    const util = new Utility();
    const db   = new Database({ configInfo: createConfigInfoStub(), util });
    const seen = [];
    sinon.stub(db, 'doQuery').callsFake(async (config, query) => { seen.push(query.replace(/\s+/g, ' ').trim()); return []; });
    await call(db, makeConfig({ coin: 'BTC' }));
    expect(seen.length, 'the reader sent no statement').to.be.greaterThan(0);
    return seen[0];
}

// The outer statement's WHERE clause: the text between its last WHERE and ORDER BY
// (a correlated count in the select list carries a WHERE of its own, earlier on).
function whereOf(sql) {
    const order = sql.search(/ ORDER BY /i);
    const where = sql.slice(0, order).toUpperCase().lastIndexOf(' WHERE ');
    if (order < 0 || where < 0) throw new Error('no WHERE ... ORDER BY in: ' + sql);
    return sql.slice(where + 7, order).trim();
}

// Shapes that drop or merge rows without a WHERE term.
function rowDroppingShapes(sql) {
    const found = [];
    if (/\bHAVING\b/i.test(sql)) found.push('HAVING');
    if (/\bGROUP BY\b/i.test(sql)) found.push('GROUP BY');
    if (/\bDISTINCT\b/i.test(sql)) found.push('DISTINCT');
    for (const m of sql.matchAll(/(\S+)\s+JOIN\b/gi)) {
        const kind = m[1].toUpperCase();
        if (kind === 'LEFT') continue;
        found.push(kind === 'INNER' || kind === 'CROSS' || kind === 'RIGHT' ? kind + ' JOIN' : 'JOIN');
    }
    return found;
}

describe('live feed since-queries stay unfiltered (WS-02 cursor guard)', function () {
    afterEach(() => sinon.restore());

    it('getActionsSince (readActionsSinceRows) filters on the cursor alone', async function () {
        const sql = await statementOf((db, cfg) => db.getActionsSince(cfg, 5n, 100));
        expect(whereOf(sql)).to.equal('a1.action_index > ?');
        expect(rowDroppingShapes(sql)).to.deep.equal([]);
    });

    it('the catch-up form adds only its inclusive upper bound', async function () {
        const sql = await statementOf((db, cfg) => db.getActionsSince(cfg, 5n, 100, 9n));
        expect(whereOf(sql)).to.equal('a1.action_index > ? AND a1.action_index <= ?');
        expect(rowDroppingShapes(sql)).to.deep.equal([]);
    });

    it('getBlocksSince filters on the cursor alone', async function () {
        const sql = await statementOf((db, cfg) => db.getBlocksSince(cfg, 5, 100));
        expect(whereOf(sql)).to.equal('b1.block_index > ?');
        expect(rowDroppingShapes(sql)).to.deep.equal([]);
    });

    it('the guard itself sees a filter, an inner join and a merge', function () {
        expect(() => whereOf('SELECT 1 FROM t')).to.throw();
        expect(whereOf('SELECT a FROM actions a1 WHERE a1.action_index > ? AND a1.action_id <> 7 ORDER BY a1.action_index'))
            .to.not.equal('a1.action_index > ?');
        expect(rowDroppingShapes('SELECT DISTINCT a FROM x INNER JOIN y ON 1 JOIN z ON 1 LEFT JOIN w ON 1 GROUP BY a'))
            .to.deep.equal(['GROUP BY', 'DISTINCT', 'INNER JOIN', 'JOIN']);
    });
});
