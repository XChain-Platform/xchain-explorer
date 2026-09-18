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
 * Unit tests for Database#getToken against BOTH replica schema shapes.
 *
 * The four bridge columns (bridge_chains, min_depth, lock_bridge, bridged) exist
 * only where the indexer's 2026-09-12-token-bridge-fields.sql has been applied.
 * Naming an absent column is MariaDB 1054 for the whole statement, not a null for
 * one field, so the v0.19.0 explorer answered 500 on every mainnet token route the
 * moment it rolled against replicas that had not taken the migration, and the fleet
 * had to be rolled back to v0.18.0. These tests pin the forward fix: the reader
 * probes the connected schema and projects what that schema actually carries.
 *
 * The doQuery stub here EMULATES the server rather than canning an answer: a
 * statement that names a column the fixture schema does not hold is rejected with a
 * real 1054, exactly as the replica rejects it. That is what makes an assertion here
 * about behaviour and not about a string the reader also writes.
 *
 * Verifies:
 *   - a replica WITH the columns is read exactly as before, all four projected
 *   - a replica WITHOUT them is read successfully, on the pre-bridge projection
 *   - the degraded body OMITS the bridge keys instead of defaulting them, so
 *     locks.bridge is absent rather than a false that claims the policy is unfrozen
 *   - the schema probe is memoized per coin, not repeated per request
 *   - a negative memo expires, so applying the migration heals a live explorer
 *   - a wrong positive (stale memo, failed probe) recovers from the 1054 instead of
 *     letting the route 500, and records the real shape
 *   - a failure that is NOT an unknown column still propagates
 *   - coins do not share a memo
 *
 * The suites are flat rather than nested under one parent because a describe body is
 * a function and CODE-STYLE caps a function at 60 lines.
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../../../src/lib/utility.js');
const { DbQueryError }         = require('../../../../src/db/shared.js');
const { createConfigInfoStub } = require('../../../fixtures/mock-config.js');
const { makeConfig }           = require('../../../fixtures/mock-query-args.js');
const mockResults              = require('../../../fixtures/mock-db-results.js');

const Database = proxyquire('../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

const configInfo   = createConfigInfoStub();
const util         = new Utility(configInfo);
const mockExplorer = { configInfo, util };

const BRIDGE_COLUMNS = ['bridge_chains', 'min_depth', 'lock_bridge', 'bridged'];

// MariaDB 1054 as it reaches a reader: the driver's error wrapped as the `cause` of
// the DbQueryError doQuery raises.
function unknownColumnError(name){
    const driver = new Error(`Unknown column 't1.${name}' in 'field list'`);
    driver.errno = 1054;
    driver.code  = 'ER_BAD_FIELD_ERROR';
    return new DbQueryError('SQL query failed: ' + driver.message, driver);
}

// Stands in for a replica whose `tokens` table holds exactly `state.columns` of the
// bridge set. The token statement is answered with the fixture row REDUCED to the
// columns it named, because a SELECT returns the fields it asked for and nothing
// else; naming a column the schema lacks is refused the way the server refuses it.
function stubSchema(db, state){
    return sinon.stub(db, 'doQuery').callsFake(async (config, sql) => {
        state.sql.push(sql);
        if(/information_schema\.COLUMNS/i.test(sql)){
            if(state.probeFails) throw new DbQueryError('information_schema refused');
            return state.columns.map(name => ({ COLUMN_NAME: name }));
        }
        if(/FROM\s+tokens t1/.test(sql)){
            if(state.tokenReadFails) throw state.tokenReadFails;
            const named   = BRIDGE_COLUMNS.filter(c => sql.includes('t1.' + c));
            const missing = named.filter(c => !state.columns.includes(c));
            if(missing.length) throw unknownColumnError(missing[0]);
            const row = { ...mockResults.tokenRow()[0] };
            for(const c of BRIDGE_COLUMNS) if(!named.includes(c)) delete row[c];
            return [row];
        }
        return [];
    });
}

// One Database per test, reading a replica of the given shape. `state.sql` collects
// every statement issued, which is how the suites below count round trips.
function makeDb(overrides){
    const state = { sql: [], columns: [], ...overrides };
    const db    = new Database(mockExplorer);
    stubSchema(db, state);
    return { db, state };
}

function cfg(coin = 'BTC'){
    return makeConfig({ coin, data: { method: 'getToken', search: 'XCHAIN' } });
}

const tokenStatements = state => state.sql.filter(s => /FROM\s+tokens t1/.test(s));
const probeStatements = state => state.sql.filter(s => /information_schema\.COLUMNS/i.test(s));
const withBridge      = () => makeDb({ columns: [...BRIDGE_COLUMNS] });
const withoutBridge   = () => makeDb({ columns: [] });

afterEach(() => { sinon.restore(); });

describe('getToken on a replica that HAS the bridge columns (testnet today)', () => {
    it('projects all four bridge columns', async () => {
        const { db, state } = withBridge();
        await db.getToken(cfg());
        const [read] = tokenStatements(state);
        for(const c of BRIDGE_COLUMNS)
            expect(read, c).to.include('t1.' + c);
    });

    it('lands them where the wallet reads them, unchanged', async () => {
        const { db } = withBridge();
        const [data] = await db.getToken(cfg());
        expect(data.info.bridge_chains).to.equal('LTC,DOGE');
        expect(data.info.min_depth).to.equal(6);
        expect(data.info.bridged).to.equal(1);
        expect(data.locks.bridge).to.equal(true);
    });

    it('answers on ONE token statement, with no 1054 recovery in the way', async () => {
        const { db, state } = withBridge();
        await db.getToken(cfg());
        expect(tokenStatements(state).length).to.equal(1);
    });
});

describe('getToken on a replica WITHOUT them (a mainnet DB that never took the migration)', () => {
    it('answers the token instead of failing the route', async () => {
        const { db } = withoutBridge();
        const [data] = await db.getToken(cfg());
        expect(data).to.not.be.null;
        expect(data.info.tick).to.equal('XCHAIN');
        expect(data.supply.current).to.equal('1000000.00000000');
    });

    it('names none of the bridge columns in the statement it runs', async () => {
        const { db, state } = withoutBridge();
        await db.getToken(cfg());
        const [read] = tokenStatements(state);
        for(const c of BRIDGE_COLUMNS)
            expect(read, c).to.not.include('t1.' + c);
    });

    it('takes the pre-bridge projection FIRST, never by recovering from a 1054', async () => {
        const { db, state } = withoutBridge();
        await db.getToken(cfg());
        expect(tokenStatements(state).length).to.equal(1);
    });

    it('OMITS the bridge keys rather than defaulting them to a claim', async () => {
        const { db } = withoutBridge();
        const [data] = await db.getToken(cfg());
        // Absence is the honest answer: nothing was read about this token's bridge
        // state. A null or a false here would be a statement the replica never made,
        // and the wallet acts on locks.bridge===false by offering an edit that a
        // frozen policy forbids.
        expect(Object.hasOwn(data.info, 'bridge_chains')).to.equal(false);
        expect(Object.hasOwn(data.info, 'min_depth')).to.equal(false);
        expect(Object.hasOwn(data.info, 'bridged')).to.equal(false);
        expect(Object.hasOwn(data.locks, 'bridge')).to.equal(false);
    });

    it('leaves every other lock exactly as it read them', async () => {
        const { db } = withoutBridge();
        const [data] = await db.getToken(cfg());
        expect(data.locks).to.deep.equal({
            callback: false, description: false, max_mint: false,
            max_supply: true, mint: false, mint_supply: false, sleep: false
        });
    });
});

describe('getToken schema probe', () => {
    it('is memoized per coin, not run per request', async () => {
        const { db, state } = withBridge();
        await db.getToken(cfg());
        await db.getToken(cfg());
        await db.getToken(cfg());
        expect(probeStatements(state).length).to.equal(1);
        expect(tokenStatements(state).length).to.equal(3);
    });

    it('does not let one coin answer for another', async () => {
        const { db, state } = withBridge();
        await db.getToken(cfg('BTC'));
        await db.getToken(cfg('LTC'));
        expect(probeStatements(state).length).to.equal(2);
    });

    it('re-probes once a negative answer ages out, so a migration heals a live explorer', async () => {
        const { db, state } = withoutBridge();
        const [before] = await db.getToken(cfg());
        expect(Object.hasOwn(before.info, 'bridge_chains')).to.equal(false);
        // The operator applies the migration, and the negative memo ages past its TTL.
        state.columns = [...BRIDGE_COLUMNS];
        db.tokenBridgeColumnMemo.BTC.at = Date.now() - 600000;
        const [after] = await db.getToken(cfg());
        expect(after.info.bridge_chains).to.equal('LTC,DOGE');
        expect(probeStatements(state).length).to.equal(2);
    });

    it('keeps a positive answer without re-asking', async () => {
        const { db, state } = withBridge();
        await db.getToken(cfg());
        db.tokenBridgeColumnMemo.BTC.at = Date.now() - 600000;
        await db.getToken(cfg());
        expect(probeStatements(state).length).to.equal(1);
    });
});

describe('getToken when the schema probe is wrong', () => {
    it('recovers from the 1054 a stale positive memo earns, and records the real shape', async () => {
        const { db, state } = withoutBridge();
        db.tokenBridgeColumnMemo = { BTC: { present: true, at: Date.now() } };
        const [data] = await db.getToken(cfg());
        expect(data.info.tick).to.equal('XCHAIN');
        expect(Object.hasOwn(data.locks, 'bridge')).to.equal(false);
        expect(tokenStatements(state).length).to.equal(2);
        expect(db.tokenBridgeColumnMemo.BTC.present).to.equal(false);
    });

    it('falls back to the full projection when information_schema itself refuses', async () => {
        const { db, state } = makeDb({ columns: [...BRIDGE_COLUMNS], probeFails: true });
        const [data] = await db.getToken(cfg());
        expect(data.info.bridge_chains).to.equal('LTC,DOGE');
        // Nothing is memoized off a failed probe, so the next request asks again.
        await db.getToken(cfg());
        expect(probeStatements(state).length).to.equal(2);
    });

    it('still answers a token when the probe fails against a pre-bridge replica', async () => {
        const { db } = makeDb({ columns: [], probeFails: true });
        const [data] = await db.getToken(cfg());
        expect(data.info.tick).to.equal('XCHAIN');
        expect(Object.hasOwn(data.locks, 'bridge')).to.equal(false);
    });
});

describe('getToken failures that are not a missing column', () => {
    it('propagates a genuine query failure instead of answering a degraded body', async () => {
        const { db, state } = makeDb({
            columns: [...BRIDGE_COLUMNS],
            tokenReadFails: new DbQueryError('Database connection unavailable after 3 retries')
        });
        let raised = null;
        try { await db.getToken(cfg()); } catch(e){ raised = e; }
        expect(raised).to.be.an.instanceOf(DbQueryError);
        expect(tokenStatements(state).length).to.equal(1);
    });
});
