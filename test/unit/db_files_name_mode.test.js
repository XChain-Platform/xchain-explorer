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
 * Unit tests for db.js#getFiles' M1.7 'name' query mode (spec
 * explorer-coverage-completion): exact-match discovery-by-filename
 * lookup on the plain (non-interned) files.name column.
 *
 * Tests:
 *   - getQueryWhereSql: the 'name' predicate it adds
 *   - getFiles: the query shape 'name' resolves to (the base `files` table,
 *     same as block/address/list-all -- NOT the interned mappings_files/tick
 *     join 'token' uses), and that gated-file columns are unchanged
 */

'use strict';

const proxyquire = require('proxyquire');
const sinon      = require('sinon');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

const Database = proxyquire('../../src/db.js', {
    mariadb: { createPool: () => ({}) }
});

function makeDb() {
    const configInfo = createConfigInfoStub();
    const util        = new Utility(configInfo);
    return new Database({ configInfo, util });
}

function cfg(method, type, extras = {}) {
    return makeConfig({ data: { method, type, ...extras } });
}

describe('Database#getQueryWhereSql: getFiles type=name (M1.7)', () => {
    let db;
    before(() => { db = makeDb(); });

    it('appends an exact-match predicate on the plain files.name column', async () => {
        const sql = await db.getQueryWhereSql(cfg('getFiles', 'name'));
        expect(sql).to.equal('m.action_index IS NOT NULL AND m.name=?');
    });

    it('is index-friendly: no leading wildcard, no function wrapping the column', async () => {
        const sql = await db.getQueryWhereSql(cfg('getFiles', 'name'));
        expect(sql).to.not.match(/LIKE/i);
        expect(sql).to.not.match(/UPPER\(|LOWER\(|TRIM\(/i);
    });

    it('the name lane is getFiles-only: another method with type=name gets no clause', async () => {
        const sql = await db.getQueryWhereSql(cfg('getIssues', 'name'));
        expect(sql).to.equal('m.action_index IS NOT NULL');
    });
});

describe('Database#getFiles: type=name query shape (M1.7)', () => {
    let db;
    beforeEach(() => { db = makeDb(); });
    afterEach(() => { sinon.restore(); });

    function filesConfig(type, search) {
        return makeConfig({
            data: {
                method: 'getFiles',
                search,
                type,
                sql: {
                    order: 'DESC',
                    limit: 100,
                    where: { data: 'm.action_index IS NOT NULL AND m.name=?', offset: '' }
                }
            }
        });
    }

    it('routes to the base `files` table, not the interned mappings_files/token join', async () => {
        const [query] = await db.getFiles(filesConfig('name', 'artwork.png'));
        // \b requires a non-word char before 'files', so this does not also match
        // the 'files' inside 'mappings_files' (word char '_' immediately before it).
        expect(query).to.match(/\bfiles m\b/);
        expect(query).to.not.include('mappings_files');
    });

    it('returns the same gated-file columns as every other mode (no new disclosure)', async () => {
        const [query] = await db.getFiles(filesConfig('name', 'artwork.png'));
        expect(query).to.include('gf.gate_ticker');
        expect(query).to.include('gf.gate_min_amount');
        expect(query).to.include('gf.encryption_method');
        expect(query).to.include('gf.key_hash');
        expect(query).to.include('m.name');
    });

    it('block/address/list-all modes are unaffected (same query shape as before)', async () => {
        const [blockQuery]   = await db.getFiles(filesConfig('block', '500'));
        const [addressQuery] = await db.getFiles(filesConfig('address', 'addr1'));
        expect(blockQuery).to.match(/\bfiles m\b/);
        expect(addressQuery).to.match(/\bfiles m\b/);
    });

    it('type=token still routes to the interned mappings_files join (unchanged)', async () => {
        const [query] = await db.getFiles(filesConfig('token', 'XCHAIN'));
        expect(query).to.include('mappings_files');
    });
});
