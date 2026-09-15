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

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');

const Utility = require('../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');

const DatabaseReal = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);

// A deliberately NON-DEFAULT page bound, for the same reason the M4 file uses
// one: a method that hardcodes 100 looks correct against the default.
const LIMIT = 25;

function makeDb(){
    return new DatabaseReal({ configInfo, util, hubOperational: null });
}

function cfg(method, search, extras = {}){
    return makeConfig({
        coin: 'BTC',
        type: 'api',
        data: {
            method,
            search,
            type: null,
            sql: {
                order: 'DESC',
                limit: LIMIT,
                apiOffset: 0,
                where: { data: 'm.action_index IS NOT NULL', offset: '', offsetArgs: [] }
            },
            ...extras
        }
    });
}

function flat(sql){
    return String(sql).replace(/\s+/g, ' ').trim();
}

function stubQueries(db, plan = []){
    db.doQuery = sinon.stub().callsFake(async (c, query) => {
        const f = flat(query);
        for(const [needle, rows] of plan)
            if(f.includes(needle)) return rows;
        return [];
    });
    return db;
}

module.exports = { sinon, expect, LIMIT, makeDb, cfg, flat, stubQueries };

require('./db_m5_compositions.test/support/rich_list.js');
require('./db_m5_compositions.test/support/xcall_phases.js');
