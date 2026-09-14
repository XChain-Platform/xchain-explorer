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
 * Unit tests for the M5 data layer (spec explorer-coverage-completion rows
 * 32/33/35): getCollectibles' classification, getRichList's composition, and
 * the two XCALL phase reads behind the WS channel.
 *
 * The same builder-vs-composition split db.m4-compositions.test.js documents
 * applies here, and this file spans BOTH kinds, so it uses both idioms:
 *
 *  - getCollectibles is a BUILDER. It returns [query, args, count] and getData
 *    is the executor, so `doQuery.called` inside it is vacuous. What is pinned
 *    instead is the TEXT of the two queries it returns and, crucially, that the
 *    classification predicate reaches the COUNT query as well as the row query:
 *    a classification applied to only one of them pages a gallery whose total
 *    counts every token on the chain.
 *
 *  - getRichList, getXcallInfo and getXcallPhasesSince run their own reads and
 *    return values directly, so doQuery is stubbed and every query and arg
 *    array is captured.
 *
 * The properties these tests exist to protect, each of which is a way the
 * surface could be wrong while looking right:
 *
 *  1. A rich list that divides by MAX supply rather than circulating supply
 *     understates every holder's share, and the page would still render.
 *  2. A percentage that cannot be computed must come back null, never 0: a 0
 *     tells the reader the largest holder owns none of the token.
 *  3. Ranks must carry the page offset, or page 2 restarts at rank 1 and two
 *     different addresses both render as "#1 holder".
 *  4. The XCALL phase cursor must bind the VALID row only, and must carry both
 *     terminal statuses: a cursor that emits completions but not expiries makes
 *     a live timeline that silently stalls on every expired call.
 */

'use strict';

const { sinon, expect, LIMIT, makeDb, cfg, flat, stubQueries } = require('../db_m5_compositions.test.js');

/* ------------------------------------------------------------------ *
 * Row 35: the XCALL phase reads behind the WS channel
 * ------------------------------------------------------------------ */

describe('M5.4 XCALL phase reads (spec row 35)', function () {

    const CALL = 'c'.repeat(64);

    it('cursors on resolved_block, the height with no action row behind it', async function () {
        const db = stubQueries(makeDb(), []);
        await db.getXcallPhasesSince({ coin: 'BTC' }, 900, 50);
        const q = flat(db.doQuery.firstCall.args[1]);
        expect(q).to.include('m.resolved_block > ?');
        expect(q).to.include('ORDER BY m.resolved_block ASC');
        expect(db.doQuery.firstCall.args[2]).to.deep.equal([900, 50]);
    });

    it('carries BOTH terminal statuses, so expiries are not silently dropped', async function () {
        // A cursor that emits completions but not expiries makes a live timeline
        // that stalls forever on every call that timed out.
        const db = stubQueries(makeDb(), []);
        await db.getXcallPhasesSince({ coin: 'BTC' }, 0, 10);
        expect(flat(db.doQuery.firstCall.args[1]))
            .to.include("m.request_status IN ('completed','expired')");
    });

    it('binds the VALID row only, matching the indexer authoritative read', async function () {
        // A call_id can carry more than one xcalls row; an invalid one shadowing
        // the real request is the defect row 56 fixed on the detail path.
        const db = stubQueries(makeDb(), []);
        await db.getXcallPhasesSince({ coin: 'BTC' }, 0, 10);
        expect(flat(db.doQuery.firstCall.args[1])).to.include("s1.status='valid'");
    });

    it('getXcallInfo point-reads one call by id, valid row only, bounded to one row', async function () {
        const db = stubQueries(makeDb(), [['FROM xcalls m', [{ call_id: CALL, request_status: 'pending' }]]]);
        const row = await db.getXcallInfo({ coin: 'BTC' }, CALL);
        expect(row.call_id).to.equal(CALL);
        const q = flat(db.doQuery.firstCall.args[1]);
        expect(q).to.include('m.call_id=?');
        expect(q).to.include("s1.status='valid'");
        expect(q).to.include('LIMIT 1');
        expect(db.doQuery.firstCall.args[2]).to.deep.equal([CALL]);
    });

    it('getXcallInfo answers null for a call this chain has no row for', async function () {
        // The normal answer on the TARGET chain of a call, not an error.
        const db = stubQueries(makeDb(), []);
        expect(await db.getXcallInfo({ coin: 'BTC' }, CALL)).to.equal(null);
    });
});
