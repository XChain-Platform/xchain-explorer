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
 *  display leg. A LIST edit writes the resulting membership under the
 * EDIT's own action_index and never touches the parent's rows, so a list read
 * by its CREATE index returns create-time membership forever. The indexer's
 * read path now resolves the edit chain's head; the explorer has to show the
 * same membership or its LIST page contradicts the gate the chain enforces -
 * and that page is exactly where a betting market's ALLOW_LIST link lands.
 *
 * Two properties are load-bearing here and neither is visible by reading the
 * query: the flag day is evaluated against the TIP (below it consensus still
 * reads the create's rows, so the explorer must not advertise the new rule),
 * and the response must never be memoized (see the state/LRU case below).
 */

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const activation = require('../../src/list_edit_resolution_activation.js');

const Database = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

// A database whose doQuery answers from a table of [matcher, rows] pairs and
// records every call, so a test can assert what was NOT queried as well as what
// came back. Anything unmatched returns [] rather than throwing, which keeps a
// missing stub visible as an empty result instead of a crash trace.
function makeDb(routes, tip) {
    const db = new Database(mockExplorer);
    db.calls = [];
    db.doQuery = async (config, sql, args) => {
        db.calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), args });
        for (const [match, rows] of routes) {
            if (match.test(String(sql).replace(/\s+/g, ' '))) return rows(args);
        }
        return [];
    };
    db.getMaxBlockIndex = async () => tip;
    return db;
}

const ROOT = 100;     // the LIST create every consumer pins
const EDIT = 140;     // a later, valid edit carrying the resulting membership

// lists rows: the create carries a NULL parent, each edit names the list it edits.
const LISTS = {
    [ROOT]: { action_index: ROOT, list_action_index: null },
    [EDIT]: { action_index: EDIT, list_action_index: ROOT },
};

// Both resolution steps are batched (one query per hop for a whole set of lists,
// one grouped query for their heads), so the fixtures answer the IN-list forms
// and echo which row belongs to which list.
function listRoutes(headRows, itemRows) {
    return [
        [/FROM lists WHERE action_index IN/,       (a) => a.map((i) => LISTS[i]).filter(Boolean)],
        [/FROM lists l .*l\.list_action_index IN/,  (a) => headRows.map((r) => ({ root: a[0], head: r.action_index }))],
        [/FROM list_items l1/,                     (a) => itemRows(a[0])],
    ];
}

describe(': the explorer shows the membership the chain enforces', function () {

    describe('getListRootIndex', function () {

        it('walks an edit up to the create that roots its chain', async function () {
            const db = makeDb(listRoutes([], () => []), 0);
            expect(await db.getListRootIndex({ coin: 'RBTC' }, EDIT)).to.equal(ROOT);
        });

        it('leaves a create where it is: a NULL parent IS the root', async function () {
            const db = makeDb(listRoutes([], () => []), 0);
            expect(await db.getListRootIndex({ coin: 'RBTC' }, ROOT)).to.equal(ROOT);
        });

        it('returns the reference unchanged when it names no list at all', async function () {
            const db = makeDb(listRoutes([], () => []), 0);
            expect(await db.getListRootIndex({ coin: 'RBTC' }, 999999999)).to.equal(999999999);
        });

        it('terminates on a chain that points at itself rather than spinning', async function () {
            // A malformed row is not reachable through list.js today, but the walk
            // is a loop over attacker-influenced ids and must be bounded whatever
            // the table holds.
            const db = makeDb([[/FROM lists WHERE action_index IN/, (a) => a.map((i) => ({ action_index: i, list_action_index: i === 7 ? 8 : 7 }))]], 0);
            expect(await db.getListRootIndex({ coin: 'RBTC' }, 7)).to.be.oneOf([7, 8]);
        });
    });

    describe('getListHeadIndex', function () {

        it('resolves to the newest VALID edit, which holds current membership', async function () {
            const db = makeDb(listRoutes([{ action_index: EDIT }], () => []), 0);
            expect(await db.getListHeadIndex({ coin: 'RBTC' }, ROOT)).to.equal(EDIT);
        });

        it('resolves an EDIT reference to the same head as the create', async function () {
            // Every consumer pins the create, but an operator browsing lands on an
            // edit page; both must describe one list, not two.
            const db = makeDb(listRoutes([{ action_index: EDIT }], () => []), 0);
            expect(await db.getListHeadIndex({ coin: 'RBTC' }, EDIT)).to.equal(EDIT);
        });

        it('falls back to the create when the list has no valid edits', async function () {
            const db = makeDb(listRoutes([], () => []), 0);
            expect(await db.getListHeadIndex({ coin: 'RBTC' }, ROOT)).to.equal(ROOT);
        });
    });

    describe('getListCurrentMembership', function () {

        const members = (rows) => (index) => (index === EDIT ? rows.after : rows.before);
        const ADDRESSES = {
            before: [{ address: 'mMemberA' }, { address: 'mMemberB' }],
            after:  [{ address: 'mMemberB' }],
        };

        it('reports current membership from the edit head on an armed chain', async function () {
            // regtest is armed at genesis, so any tip is above the threshold.
            const db = makeDb(listRoutes([{ action_index: EDIT }], members(ADDRESSES)), 7295);
            const state = await db.getListCurrentMembership({ coin: 'RBTC' }, ROOT, 2);
            expect(state.edit_resolution_active, 'regtest is armed from genesis').to.equal(true);
            expect(state.membership_action_index, 'names the action that set membership').to.equal(EDIT);
            expect(state.current_list, 'the removed member is gone').to.deep.equal(['mMemberB']);
        });

        it('[REGRESSION] does not serve create-time membership once an edit exists', async function () {
            const db = makeDb(listRoutes([{ action_index: EDIT }], members(ADDRESSES)), 7295);
            const state = await db.getListCurrentMembership({ coin: 'RBTC' }, ROOT, 2);
            expect(state.current_list).to.not.include('mMemberA');
        });

        it('stays on the create when the list was never edited', async function () {
            const db = makeDb(listRoutes([], members(ADDRESSES)), 7295);
            const state = await db.getListCurrentMembership({ coin: 'RBTC' }, ROOT, 2);
            expect(state.membership_action_index).to.equal(ROOT);
            expect(state.current_list).to.deep.equal(['mMemberA', 'mMemberB']);
        });

        it('reads tick lists by tick and address lists by address', async function () {
            const ticks = { before: [{ tick: 'BBB' }, { tick: 'AAA' }], after: [{ tick: 'AAA' }] };
            const db = makeDb(listRoutes([], members(ticks)), 7295);
            const state = await db.getListCurrentMembership({ coin: 'RBTC' }, ROOT, 1);
            expect(state.current_list, 'sorted, and read from the tick column').to.deep.equal(['AAA', 'BBB']);
        });

        it('is INERT below the flag day, and reads no items at all', async function () {
            // Mainnet arms at 963000. Below it consensus still gates on the create's
            // rows, so resolving here would show a membership the chain is not
            // applying - the explorer would be the one lying, in the safe direction
            // for nobody.
            const tip = activation.LIST_EDIT_RESOLUTION_ACTIVATION['BTC:mainnet'] - 1;
            const db  = makeDb(listRoutes([{ action_index: EDIT }], members(ADDRESSES)), tip);
            const state = await db.getListCurrentMembership({ coin: 'BTC' }, ROOT, 2);
            expect(state.edit_resolution_active).to.equal(false);
            expect(state.current_list, 'no membership is claimed').to.equal(null);
            expect(state.membership_action_index, 'the pinned action is still the answer').to.equal(ROOT);
            expect(db.calls.filter(c => /list_items/.test(c.sql)).length, 'no item read was issued').to.equal(0);
        });

        it('activates at exactly the flag-day height, not one block later', async function () {
            const tip = activation.LIST_EDIT_RESOLUTION_ACTIVATION['BTC:mainnet'];
            const db  = makeDb(listRoutes([{ action_index: EDIT }], members(ADDRESSES)), tip);
            const state = await db.getListCurrentMembership({ coin: 'BTC' }, ROOT, 2);
            expect(state.edit_resolution_active).to.equal(true);
            expect(state.current_list).to.deep.equal(['mMemberB']);
        });

        it('treats an unrecognized coin code as inactive rather than as mainnet', async function () {
            const db = makeDb(listRoutes([{ action_index: EDIT }], members(ADDRESSES)), 99999999);
            const state = await db.getListCurrentMembership({ coin: 'NOPE' }, ROOT, 2);
            expect(state.edit_resolution_active).to.equal(false);
            expect(state.current_list).to.equal(null);
        });
    });

    describe('the LIST response must never be memoized', function () {

        it('[REGRESSION] a membership block makes the action uncacheable', function () {
            // Membership is recomputed from rows written after the create, so the
            // no-TTL action LRU would freeze it for the life of the process and
            // hide every later edit - the  dispenser failure, re-run on a new
            // field. Carrying it in `state` is what wires it into that guard.
            const db = new Database(mockExplorer);
            const list = { action: 'LIST', action_index: ROOT,
                           state: { edit_resolution_active: true, membership_action_index: EDIT, current_list: ['mMemberB'] } };
            expect(db._isCacheableAction(list)).to.equal(false);
        });

        it('an inert (below flag-day) membership block is uncacheable too', function () {
            // The tip crosses the flag day while the process runs, so an entry
            // cached during the inert window would outlive its own premise.
            const db = new Database(mockExplorer);
            const list = { action: 'LIST', action_index: ROOT,
                           state: { edit_resolution_active: false, membership_action_index: ROOT, current_list: null } };
            expect(db._isCacheableAction(list)).to.equal(false);
        });
    });

    describe('the activation map is vendored, not re-typed', function () {

        it('matches the indexer copy byte for byte', function () {
            // The explorer mirrors a consensus read here. Two copies of a height
            // map drift silently: the explorer would show membership the chain
            // does not gate on, at exactly the boundary where anyone is watching.
            const fs   = require('fs');
            const path = require('path');
            const mine = path.join(__dirname, '..', '..', 'src', 'list_edit_resolution_activation.js');
            const theirs = path.join(__dirname, '..', '..', '..', 'xchain-indexer', 'src', 'list_edit_resolution_activation.js');
            if (!fs.existsSync(theirs)) return this.skip();   // standalone deploy: sibling absent
            expect(fs.readFileSync(mine, 'utf8')).to.equal(fs.readFileSync(theirs, 'utf8'));
        });
    });
});

/*
 * : the same question, asked by the project registry.
 *
 * A project's roster IS a TICK list, pinned by the LINK at its CREATE index, so
 * every roster surface had the create-time-membership bug the LIST page just
 * lost: the "N official tokens" count, the Official Tokens tab, the project
 * detail endpoint, and the reverse "this token is official in X" banner. An
 * owner who edits the roster to drop a token has to see that everywhere, or the
 * explorer certifies a token the attestation no longer covers.
 */

const OTHER_ROOT = 300;   // a second project's roster, never edited

const ROSTER_LISTS = {
    [ROOT]:       { action_index: ROOT,       list_action_index: null },
    [EDIT]:       { action_index: EDIT,       list_action_index: ROOT },
    [OTHER_ROOT]: { action_index: OTHER_ROOT, list_action_index: null },
};

// Route table for the roster surfaces. Order matters: the reverse-lookup
// candidate query embeds "FROM links l INNER JOIN" in its subquery, so its own
// matcher has to come first.
function rosterRoutes(extra) {
    return [
        ...(extra || []),
        [/GROUP BY i1\.tick_id/,                   () => []],
        [/FROM links l INNER JOIN/,                () => [{ link_action_index: 74, roster_action_index: ROOT }]],
        [/FROM lists WHERE action_index IN/,       (a) => a.map((i) => ROSTER_LISTS[i]).filter(Boolean)],
        [/FROM lists l .*l\.list_action_index IN/,  (a) => (a.includes(ROOT) ? [{ root: ROOT, head: EDIT }] : [])],
        // Membership by index: the edited roster holds one token, the create two.
        [/count\(\*\) AS total FROM list_items/,   (a) => [{ total: a[0] === EDIT ? 1 : 2 }]],
    ];
}

describe(': the project registry shows the roster the chain enforces', function () {

    describe('getProjectRosterInfo', function () {

        it('resolves the roster membership index to the edit-chain head', async function () {
            const db = makeDb(rosterRoutes(), 7295);
            db.baseCoin = { RBTC: 'BTC' };
            const info = await db.getProjectRosterInfo({ coin: 'RBTC' }, 'PROJECTX');
            expect(info.roster_action_index, 'the LINK still pins the list identity').to.equal(ROOT);
            expect(info.membership_action_index, 'members come from the head').to.equal(EDIT);
        });

        it('[REGRESSION] counts the CURRENT roster, not the create-time one', async function () {
            const db = makeDb(rosterRoutes(), 7295);
            db.baseCoin = { RBTC: 'BTC' };
            const info = await db.getProjectRosterInfo({ coin: 'RBTC' }, 'PROJECTX');
            expect(info.total, 'the dropped token is not counted').to.equal(1);
        });

        it('is INERT below the flag day, and resolves no chain at all', async function () {
            const tip = activation.LIST_EDIT_RESOLUTION_ACTIVATION['BTC:mainnet'] - 1;
            const db  = makeDb(rosterRoutes(), tip);
            db.baseCoin = { BTC: 'BTC' };
            const info = await db.getProjectRosterInfo({ coin: 'BTC' }, 'PROJECTX');
            expect(info.membership_action_index).to.equal(ROOT);
            expect(info.total).to.equal(2);
            expect(db.calls.filter((c) => /FROM lists WHERE action_index IN/.test(c.sql)).length,
                   'no chain walk was issued').to.equal(0);
        });
    });

    describe('the roster consumers inherit that one resolution', function () {

        it('getProject reads member tokens from the membership index', async function () {
            const members = [];
            const db = makeDb(rosterRoutes([
                [/FROM list_items li INNER JOIN tokens/, (a) => { members.push(a[0]); return []; }],
            ]), 7295);
            db.baseCoin = { RBTC: 'BTC' };
            const [data] = await db.getProject({ coin: 'RBTC', data: { search: 'PROJECTX' } });
            expect(members, 'the members query ran against the head').to.deep.equal([EDIT]);
            expect(data.membership_action_index).to.equal(EDIT);
            expect(data.roster_action_index, 'the pinned index is still reported').to.equal(ROOT);
        });

        it('getProjectTokens scopes the Official Tokens datatable to the head', async function () {
            const db = makeDb(rosterRoutes(), 7295);
            db.baseCoin = { RBTC: 'BTC' };
            const config = { coin: 'RBTC', data: { search: 'PROJECTX',
                             sql: { where: { data: '1=1', offset: '' }, order: 'ASC', limit: '10' } } };
            const [query, args, count] = await db.getProjectTokens(config);
            expect(args).to.deep.equal([EDIT]);
            expect(query).to.include('li.action_index=?');
            expect(count).to.include('li.action_index=?');
        });
    });

    describe('getTokenProjects (the reverse "official in X" lookup)', function () {

        // Two projects: PROJECTX's roster was edited, OTHER's never was.
        const CANDIDATES = [
            { project: 'PROJECTX', link_action_index: 74, roster_action_index: ROOT },
            { project: 'OTHER',    link_action_index: 60, roster_action_index: OTHER_ROOT },
        ];

        function reverseRoutes(listing) {
            return [
                [/GROUP BY i1\.tick_id/,                    () => CANDIDATES],
                [/FROM lists WHERE action_index IN/,        (a) => a.map((i) => ROSTER_LISTS[i]).filter(Boolean)],
                [/FROM lists l .*l\.list_action_index IN/,   (a) => (a.includes(ROOT) ? [{ root: ROOT, head: EDIT }] : [])],
                [/FROM list_items li INNER JOIN index_tickers t2/, () => listing.map((i) => ({ action_index: i }))],
            ];
        }

        it('[REGRESSION] a roster that edited the token OUT no longer matches', async function () {
            // The create's rows still list the token forever; only the head does not.
            const db = makeDb(reverseRoutes([OTHER_ROOT]), 7295);
            db.baseCoin = { RBTC: 'BTC' };
            const rows = await db.getTokenProjects({ coin: 'RBTC' }, 'TOKENONE');
            expect(rows.map((r) => r.project)).to.deep.equal(['OTHER']);
        });

        it('a roster that edited the token IN matches, naming the edit', async function () {
            const db = makeDb(reverseRoutes([EDIT]), 7295);
            db.baseCoin = { RBTC: 'BTC' };
            const rows = await db.getTokenProjects({ coin: 'RBTC' }, 'TOKENONE');
            expect(rows).to.deep.equal([
                { project: 'PROJECTX', link_action_index: 74, roster_action_index: ROOT, membership_action_index: EDIT },
            ]);
        });

        it('asks the membership question about heads only, never the pinned create', async function () {
            const db = makeDb(reverseRoutes([EDIT]), 7295);
            db.baseCoin = { RBTC: 'BTC' };
            await db.getTokenProjects({ coin: 'RBTC' }, 'TOKENONE');
            const call = db.calls.find((c) => /FROM list_items li INNER JOIN index_tickers t2/.test(c.sql));
            expect(call.args).to.deep.equal(['TOKENONE', EDIT, OTHER_ROOT]);
        });

        it('runs the single-query legacy form below the flag day', async function () {
            const tip = activation.LIST_EDIT_RESOLUTION_ACTIVATION['BTC:mainnet'] - 1;
            const db  = makeDb([[/GROUP BY i1\.tick_id/, () => CANDIDATES]], tip);
            db.baseCoin = { BTC: 'BTC' };
            const rows = await db.getTokenProjects({ coin: 'BTC' }, 'TOKENONE');
            expect(rows.map((r) => r.membership_action_index)).to.deep.equal([ROOT, OTHER_ROOT]);
            const call = db.calls.find((c) => /GROUP BY i1\.tick_id/.test(c.sql));
            expect(call.sql, 'the membership filter is still in SQL').to.match(/INNER JOIN list_items\s+li ON \(li\.action_index=lk\.coin1_action_index\)/);
            expect(db.calls.filter((c) => /FROM lists WHERE action_index IN/.test(c.sql)).length).to.equal(0);
        });
    });
});
