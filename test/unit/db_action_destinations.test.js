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
 * Unit tests for the confirmed-side destination lookup behind NEW_ACTION:
 * db.getActionsSince's additive `destinations` (spec
 * wallet-unconfirmed-and-sounds M1.4, decision I-46).
 *
 * The bug being fixed: the block-derived actions feed selected no destination
 * column, so NEW_ACTION never carried one, the Broadcaster's destination
 * routing branch was permanently inert, and the wallet's incoming-receipt
 * notification never fired for anyone.
 *
 * Three properties are load-bearing and are what these tests defend:
 *   - the EIGHT families are consulted and `contracts` is NOT (its
 *     slash_destination_id is deploy-time routing config, not a recipient);
 *   - the batch costs a BOUNDED number of queries, not one per action, since
 *     this feed drives a 5s poll;
 *   - a broken lookup degrades to [] and still ships the actions, because an
 *     exception here once killed the whole WS action feed silently.
 *
 * Harness matches test/unit/db.mempool-address-refs.test.js: a Database built
 * with Object.create(Database.prototype) over a stubbed doQuery, no real DB.
 */

'use strict';

const sinon      = require('sinon');
const { expect } = require('chai');
const Database   = require('../../src/db.js');
const Utility    = require('../../src/utility.js');

const cfg = { coin: 'RBTC' };

// The feed query is the only one selecting `FROM actions a1`; every other query
// a getActionsSince call makes is a destination lookup.
const isFeedQuery = (q) => /\bactions a1\b/.test(q);

// `destHandler(query, args)` answers every destination lookup: return rows, or
// throw to simulate a failing/missing table.
function mkDb(actionRows, destHandler) {
    const db  = Object.create(Database.prototype);
    db.util   = new Utility();
    db.calls  = [];
    db.doQuery = sinon.stub().callsFake(async (config, query, args) => {
        db.calls.push({ query, args });
        if (isFeedQuery(query)) return actionRows;
        return destHandler ? destHandler(query, args) : [];
    });
    return db;
}

const destQueries = (db) => db.calls.filter(c => !isFeedQuery(c.query)).map(c => c.query);

// A DbQueryError-shaped wrapper: doQuery rethrows with its OWN code and puts the
// driver's error on .cause, so a check that only reads the top-level error never
// matches a real one.
function wrapped(code, errno) {
    const cause = Object.assign(new Error('driver said no'), { code: code, errno: errno });
    return Object.assign(new Error('SQL query failed: driver said no'),
        { name: 'DbQueryError', code: 'DB_ERROR', cause: cause });
}

// Rows as the destination union returns them: one row per (action, destination).
const destRow = (action_index, destination) => ({ action_index, destination });

describe('db.getActionsSince destinations (M1.4)', () => {

    it('attaches a single SEND destination to its action', async () => {
        const db = mkDb(
            [{ action_index: 501n, action: 'SEND', source: 'srcAddr' }],
            () => [destRow(501n, 'destAddr')]);

        const rows = await db.getActionsSince(cfg, 500n, 100);

        expect(rows).to.have.lengthOf(1);
        expect(rows[0].destinations).to.deep.equal(['destAddr']);
    });

    it('yields ALL destinations of a MULTI-OUTPUT send, deduped when one repeats', async () => {
        // sends.action_index is a NON-unique index: one SEND action, several rows.
        const db = mkDb(
            [{ action_index: 501n, action: 'SEND', source: 'srcAddr' }],
            () => [
                destRow(501n, 'destA'),
                destRow(501n, 'destB'),
                destRow(501n, 'destA')   // same recipient paid twice
            ]);

        const rows = await db.getActionsSince(cfg, 500n, 100);

        expect(rows[0].destinations).to.deep.equal(['destA', 'destB']);
    });

    it('gives an action with no destination an EMPTY ARRAY, never null and never a missing key', async () => {
        const db   = mkDb([{ action_index: 700n, action: 'BURN', source: 'srcAddr' }], () => []);
        const rows = await db.getActionsSince(cfg, 500n, 100);

        expect(rows[0]).to.have.property('destinations');
        expect(rows[0].destinations).to.deep.equal([]);
    });

    it('resolves the two odd join keys: slash_events.execution_index and capability_slash_events.slash_action_index', async () => {
        // Neither table HAS an action_index column, so joining them on one matches
        // nothing at all and fails silently. Assert both the SQL and the result.
        const db = mkDb(
            [{ action_index: 900n, action: 'EXECUTE', source: 'srcAddr' },
             { action_index: 901n, action: 'SLASH',   source: 'srcAddr' }],
            () => [destRow(900n, 'treasuryA'), destRow(901n, 'treasuryB')]);

        const rows = await db.getActionsSince(cfg, 500n, 100);
        const sql  = destQueries(db).join('\n');

        expect(sql).to.match(/m\.execution_index\s+IN/);
        expect(sql).to.match(/m\.slash_action_index\s+IN/);
        expect(sql).to.include('slash_events m');
        expect(sql).to.include('capability_slash_events m');
        expect(rows[0].destinations).to.deep.equal(['treasuryA']);
        expect(rows[1].destinations).to.deep.equal(['treasuryB']);
    });

    it('consults all EIGHT destination-bearing families', async () => {
        const db = mkDb([{ action_index: 501n, action: 'SEND', source: 'srcAddr' }], () => []);
        await db.getActionsSince(cfg, 500n, 100);
        const sql = destQueries(db).join('\n');

        for (const table of ['sends', 'sweeps', 'dispenses', 'mints', 'messages',
                             'fees', 'slash_events', 'capability_slash_events'])
            expect(sql, table).to.include(table + ' m');
    });

    it('never consults `contracts` (slash_destination_id is deploy routing config, not a recipient)', async () => {
        const db = mkDb([{ action_index: 501n, action: 'DEPLOY', source: 'srcAddr' }], () => []);
        await db.getActionsSince(cfg, 500n, 100);
        const sql = destQueries(db).join('\n');

        // `contracts m` and the column itself: re-adding the family fails here.
        expect(sql).to.not.include('contracts m');
        expect(sql).to.not.include('slash_destination_id');
    });

    it('costs a BOUNDED number of queries for a batch of N actions, not N', async () => {
        const actions = [];
        for (let i = 0; i < 40; i++) actions.push({ action_index: BigInt(600 + i), action: 'SEND', source: 'srcAddr' });
        const db = mkDb(actions, () => [destRow(600n, 'destAddr')]);

        await db.getActionsSince(cfg, 500n, 100);

        // One feed read plus ONE destination round trip for the whole batch.
        expect(db.doQuery.callCount).to.equal(2);
        expect(destQueries(db)).to.have.lengthOf(1);
    });

    it('binds the IN list from the batch actually FETCHED (once per family)', async () => {
        const db = mkDb(
            [{ action_index: 501n, action: 'SEND', source: 's' },
             { action_index: 502n, action: 'SEND', source: 's' }],
            () => []);

        await db.getActionsSince(cfg, 500n, 100);
        const call = db.calls.filter(c => !isFeedQuery(c.query))[0];

        // 2 action indexes x 8 families, and nothing but those indexes.
        expect(call.args).to.have.lengthOf(16);
        expect(call.args.slice(0, 2)).to.deep.equal([501n, 502n]);
        expect(new Set(call.args.map(String))).to.deep.equal(new Set(['501', '502']));
    });

    it('issues NO destination query at all for an empty batch', async () => {
        const db   = mkDb([], () => { throw new Error('must not be called'); });
        const rows = await db.getActionsSince(cfg, 500n, 100);

        expect(rows).to.deep.equal([]);
        expect(destQueries(db)).to.have.lengthOf(0);
        expect(db.doQuery.callCount).to.equal(1);
    });

    it('issues no destination query for a batch whose rows carry NO action_index', () => {
        // Second guard on the same property: an `IN ()` with no bound values is a
        // syntax error, so the lookup must be skipped on the index list too, not
        // only on the row count.
        const db = mkDb([{ action: 'SEND', source: 'srcAddr' }], () => { throw new Error('must not be called'); });

        return db.getActionsSince(cfg, 500n, 100).then((rows) => {
            expect(rows[0].destinations).to.deep.equal([]);
            expect(destQueries(db)).to.have.lengthOf(0);
        });
    });

    it('still DELIVERS the actions when the destination lookup THROWS, with destinations []', async () => {
        // The scar this guards: an enrichment exception leaves the feed returning
        // [] every poll while the cursor advances past actions nobody ever sees.
        const db = mkDb(
            [{ action_index: 501n, action: 'SEND', source: 'srcAddr' },
             { action_index: 502n, action: 'SEND', source: 'srcAddr' }],
            () => { throw wrapped('ER_BAD_FIELD_ERROR', 1054); });

        const rows = await db.getActionsSince(cfg, 500n, 100);

        expect(rows).to.have.lengthOf(2);
        expect(rows[0].action).to.equal('SEND');
        expect(rows[0].destinations).to.deep.equal([]);
        expect(rows[1].destinations).to.deep.equal([]);
    });

    it('a MISSING table costs only its own family: the other seven still resolve', async () => {
        const db = mkDb(
            [{ action_index: 501n, action: 'SEND', source: 'srcAddr' }],
            (query) => {
                if (query.includes('capability_slash_events m')) throw wrapped('ER_NO_SUCH_TABLE', 1146);
                if (query.includes('sends m')) return [destRow(501n, 'destAddr')];
                return [];
            });

        const rows = await db.getActionsSince(cfg, 500n, 100);

        expect(rows[0].destinations).to.deep.equal(['destAddr']);
    });

    it('QUARANTINES only the missing family, so the next poll is back to one query', async () => {
        const db = mkDb(
            [{ action_index: 501n, action: 'SEND', source: 'srcAddr' }],
            (query) => {
                if (query.includes('capability_slash_events m')) throw wrapped('ER_NO_SUCH_TABLE', 1146);
                return [];
            });

        await db.getActionsSince(cfg, 500n, 100);   // discovers it: 1 union + 8 retries
        db.calls = [];
        db.doQuery.resetHistory();
        await db.getActionsSince(cfg, 500n, 100);

        const after = destQueries(db);
        expect(after).to.have.lengthOf(1);
        expect(after[0]).to.not.include('capability_slash_events');
        expect(after[0]).to.include('sends m');
    });

    it('does NOT quarantine a family on a transient (non-schema) failure', async () => {
        let fail = true;
        const db = mkDb(
            [{ action_index: 501n, action: 'SEND', source: 'srcAddr' }],
            (query) => {
                if (fail) throw wrapped('ER_LOCK_WAIT_TIMEOUT', 1205);
                if (query.includes('sends m')) return [destRow(501n, 'destAddr')];
                return [];
            });

        await db.getActionsSince(cfg, 500n, 100);   // everything fails, nothing quarantined
        fail = false;
        const rows = await db.getActionsSince(cfg, 500n, 100);

        expect(destQueries(db).slice(-1)[0]).to.include('capability_slash_events m');
        expect(rows[0].destinations).to.deep.equal(['destAddr']);
    });

    it('matches destinations to actions across BIGINT / string / number representations', async () => {
        // BIGINT reads back as BigInt on the indexer pool, but a value can reach the
        // map as either side of the join; keying by decimal string is what makes the
        // two agree.
        const db = mkDb(
            [{ action_index: 9007199254740993n, action: 'SEND', source: 'srcAddr' }],
            () => [destRow('9007199254740993', 'destAddr')]);

        const rows = await db.getActionsSince(cfg, 0n, 100);

        expect(rows[0].destinations).to.deep.equal(['destAddr']);
    });

    it('drops destination rows for actions outside the batch instead of inventing entries', async () => {
        const db = mkDb(
            [{ action_index: 501n, action: 'SEND', source: 'srcAddr' }],
            () => [destRow(501n, 'destAddr'), destRow(999n, 'strayAddr')]);

        const rows = await db.getActionsSince(cfg, 500n, 100);

        expect(rows).to.have.lengthOf(1);
        expect(rows[0].destinations).to.deep.equal(['destAddr']);
    });
});
