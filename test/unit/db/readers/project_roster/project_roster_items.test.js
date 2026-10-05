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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { rosterTickIds } = require('../../../../../src/db/readers/project_roster_items.js');

function compact(sql){
    return String(sql).replace(/\s+/g, ' ').trim();
}

function makeDb({ rows = [], existingIds = [], tickIds = {} }){
    const calls = [];
    return {
        calls,
        async doQuery(config, sql, params){
            const text = compact(sql);
            calls.push({ config, sql: text, params });
            if(text.includes('FROM list_items li')) return rows;
            if(text.startsWith('SELECT id FROM index_tickers WHERE id IN'))
                return params.filter(id => existingIds.includes(id)).map(id => ({ id }));
            throw new Error('Unexpected query: ' + text);
        },
        async getTickId(config, tick){
            calls.push({ config, tick });
            return Object.hasOwn(tickIds, tick) ? tickIds[tick] : null;
        }
    };
}

const CONFIG = { coin: 'DOGE' };

function basicItemTests(){
    it('returns an empty array with a non-enumerable zero item count', async function () {
        const ids = await rosterTickIds(makeDb({}), CONFIG, 41, 'DOGE');

        expect(ids).to.deep.equal([]);
        expect(ids.item_count).to.equal(0);
        expect(Object.keys(ids)).to.deep.equal([]);
        expect(Object.getOwnPropertyDescriptor(ids, 'item_count').enumerable).to.equal(false);
    });

    it('keeps bare and other-chain items on their own ids', async function () {
        const db = makeDb({ rows: [
            { item_id: 7, item_text: 'ABC' },
            { item_id: 8, item_text: 'btc:ABC' }
        ] });

        const ids = await rosterTickIds(db, CONFIG, 41, 'DOGE');

        expect(ids).to.deep.equal([7, 8]);
        expect(db.calls.filter(call => Object.hasOwn(call, 'tick'))).to.deep.equal([]);
    });

    it('resolves an own-chain ticker with a case-insensitive prefix', async function () {
        const db = makeDb({
            rows: [{ item_id: 9, item_text: 'doge:ABC' }],
            tickIds: { ABC: 27 }
        });

        expect(await rosterTickIds(db, CONFIG, 41, 'DOGE')).to.deep.equal([27]);
        expect(db.calls.find(call => call.tick)).to.deep.equal({ config: CONFIG, tick: 'ABC' });
    });
}

function referenceTests(){
    it('keeps only existing numeric ticker references', async function () {
        const rows = [{ item_id: 9, item_text: 'doge:^12' }];
        const existing = makeDb({ rows, existingIds: [12] });
        const missing = makeDb({ rows });

        expect(await rosterTickIds(existing, CONFIG, 41, 'DOGE')).to.deep.equal([12]);
        expect(await rosterTickIds(missing, CONFIG, 41, 'DOGE')).to.deep.equal([]);
        const query = existing.calls.find(call => call.sql.includes('FROM index_tickers'));
        expect(query.params).to.deep.equal([12]);
    });

    it('falls back to ticker lookup for a malformed reference', async function () {
        const db = makeDb({
            rows: [{ item_id: 9, item_text: 'doge:^x' }],
            tickIds: { '^x': 31 }
        });

        expect(await rosterTickIds(db, CONFIG, 41, 'DOGE')).to.deep.equal([31]);
        expect(db.calls.find(call => call.tick).tick).to.equal('^x');
    });

    it('drops a ticker lookup that resolves to null', async function () {
        const db = makeDb({ rows: [{ item_id: 9, item_text: 'doge:MISSING' }] });

        expect(await rosterTickIds(db, CONFIG, 41, 'DOGE')).to.deep.equal([]);
        expect(db.calls.find(call => call.tick).tick).to.equal('MISSING');
    });
}

function deduplicationTests(){
    it('deduplicates resolved ids while counting every roster row', async function () {
        const db = makeDb({
            rows: [
                { item_id: 42, item_text: 'BARE' },
                { item_id: 9, item_text: 'doge:SAME' },
                { item_id: 10, item_text: 'DOGE:SAME' }
            ],
            tickIds: { SAME: 42 }
        });

        const ids = await rosterTickIds(db, CONFIG, 41, 'DOGE');
        expect(ids).to.deep.equal([42]);
        expect(ids.item_count).to.equal(3);
    });
}

describe('rosterTickIds', function () {
    basicItemTests();
    referenceTests();
    deduplicationTests();
});
