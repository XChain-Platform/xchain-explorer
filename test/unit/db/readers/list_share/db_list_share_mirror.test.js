/*********************************************************************
 * GENERATED
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
 **********************************************************************/

'use strict';

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility = require('../../../../../src/lib/utility.js');
const { createConfigInfoStub } = require('../../../../fixtures/mock-config.js');
const { LIST } = require('../../../../../src/action-detail/misc.js');

const Database = proxyquire('../../../../../src/db/index.js', {
    './connection.js': proxyquire('../../../../../src/db/connection.js', { mariadb: { createPool: () => ({}) } })
});

function makeDb(handler){
    const configInfo = createConfigInfoStub();
    const db = new Database({ configInfo, util: new Utility(configInfo) });
    db.getListRootIndex = async () => 100;
    db.doQuery = async (config, sql, args) => handler(String(sql).replace(/\s+/g, ' ').trim(), args);
    return db;
}

describe('getListShareMirrorInfo', function () {
    it('returns the home list and current contiguous version for a mirror', async function () {
        const calls = [];
        const db = makeDb((sql, args) => {
            calls.push({ sql, args });
            if(sql.includes('FROM list_share_mirrors'))
                return [{ home_chain: 'DOGE', home_list_index: 202 }];
            if(sql.includes('FROM bridge_settlements'))
                return [{ version: 3 }];
            return [];
        });

        expect(await db.getListShareMirrorInfo({ coin: 'BTC' }, 140)).to.deep.equal({
            home_chain: 'DOGE', home_list_index: 202, version: 3
        });
        expect(calls[0].args).to.deep.equal([100]);
        expect(calls[1].args).to.deep.equal(['DOGE', 202]);
        expect(calls[1].sql).to.include("kind='list'");
    });

    it('returns null for a local list and does not count settlements', async function () {
        let countQueries = 0;
        const db = makeDb((sql) => {
            if(sql.includes('FROM bridge_settlements')) countQueries++;
            return [];
        });

        expect(await db.getListShareMirrorInfo({ coin: 'BTC' }, 100)).to.equal(null);
        expect(countQueries).to.equal(0);
    });

    it('returns null when the replica does not have the mirror table', async function () {
        const db = makeDb(() => {
            const cause = Object.assign(new Error('missing table'), { errno: 1146 });
            throw Object.assign(new Error('query failed'), { cause });
        });

        expect(await db.getListShareMirrorInfo({ coin: 'BTC' }, 100)).to.equal(null);
    });

    it('adds mirror provenance to the LIST dynamic state response', async function () {
        const mirror = { home_chain: 'DOGE', home_list_index: 202, version: 3 };
        const db = {
            getListCurrentMembership: async () => ({ current_list: ['mAddress'] }),
            getListShareMirrorInfo: async () => mirror
        };
        const data = { type: 2 };

        await LIST.afterQueries({ db, config: { coin: 'BTC' }, action_index: 140 }, data);
        expect(data.state).to.deep.equal({ current_list: ['mAddress'], share_mirror: mirror });
    });
});
