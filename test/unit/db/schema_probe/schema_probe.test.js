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
const sinon      = require('sinon');

const {
    SCHEMA_PROBE_TTL_MS,
    tablesPresent,
    columnsPresent,
    setTablesAbsent,
    setColumnsAbsent,
    isMissingTableError,
    isUnknownColumnError
} = require('../../../../src/db/schema_probe.js');

let db, config, now;

beforeEach(function(){
    db = { doQuery: sinon.stub() };
    config = { coin: 'BTC' };
    now = 1000;
    sinon.stub(Date, 'now').callsFake(() => now);
});

afterEach(function(){
    sinon.restore();
});

function tableRows(...names){
    return names.map(TABLE_NAME => ({ TABLE_NAME }));
}

function columnRows(...names){
    return names.map(COLUMN_NAME => ({ COLUMN_NAME }));
}

describe('schema table probes', function(){
    it('exports the schema probe TTL', function(){
        expect(SCHEMA_PROBE_TTL_MS).to.equal(60000);
    });

    it('queries for every table and reports whether all were found', async function(){
        db.doQuery.onFirstCall().resolves(tableRows('a'));
        db.doQuery.onSecondCall().resolves(tableRows('a', 'b'));

        expect(await tablesPresent(db, config, ['a', 'b'])).to.equal(false);
        now += SCHEMA_PROBE_TTL_MS + 1;
        expect(await tablesPresent(db, config, ['a', 'b'])).to.equal(true);
        expect(db.doQuery.firstCall.args[2]).to.deep.equal(['a', 'b']);
        expect(db.doQuery.firstCall.args[1]).to.include('information_schema.TABLES');
        expect(db.doQuery.callCount).to.equal(2);
    });

    it('memoizes positive answers for either table order', async function(){
        db.doQuery.resolves(tableRows('a', 'b'));

        expect(await tablesPresent(db, config, ['a', 'b'])).to.equal(true);
        expect(await tablesPresent(db, config, ['a', 'b'])).to.equal(true);
        expect(await tablesPresent(db, config, ['b', 'a'])).to.equal(true);
        expect(db.doQuery.callCount).to.equal(1);
    });

    it('memoizes negative answers only inside the TTL', async function(){
        db.doQuery.onFirstCall().resolves(tableRows('a'));
        db.doQuery.onSecondCall().resolves(tableRows('a', 'b'));

        expect(await tablesPresent(db, config, ['a', 'b'])).to.equal(false);
        now += SCHEMA_PROBE_TTL_MS - 1;
        expect(await tablesPresent(db, config, ['a', 'b'])).to.equal(false);
        now += 2;
        expect(await tablesPresent(db, config, ['a', 'b'])).to.equal(true);
        expect(db.doQuery.callCount).to.equal(2);
    });
});

describe('schema table probe isolation', function(){
    it('returns true without caching when the table query rejects', async function(){
        db.doQuery.onFirstCall().rejects(new Error('unavailable'));
        db.doQuery.onSecondCall().resolves(tableRows('a', 'b'));

        expect(await tablesPresent(db, config, ['a', 'b'])).to.equal(true);
        expect(await tablesPresent(db, config, ['a', 'b'])).to.equal(true);
        expect(db.doQuery.callCount).to.equal(2);
    });

    it('keeps table memos separate for each coin', async function(){
        db.doQuery.resolves(tableRows('a', 'b'));

        await tablesPresent(db, config, ['a', 'b']);
        await tablesPresent(db, { coin: 'LTC' }, ['a', 'b']);
        await tablesPresent(db, config, ['a', 'b']);
        expect(db.doQuery.callCount).to.equal(2);
    });

    it('lets an absent marker bypass the table query', async function(){
        setTablesAbsent(db, config, ['a', 'b']);

        expect(await tablesPresent(db, config, ['b', 'a'])).to.equal(false);
        expect(db.doQuery.called).to.equal(false);
    });
});

describe('schema column probes', function(){
    it('queries for every column and reports whether all were found', async function(){
        db.doQuery.onFirstCall().resolves(columnRows('x'));
        db.doQuery.onSecondCall().resolves(columnRows('x', 'y'));

        expect(await columnsPresent(db, config, 't', ['x', 'y'])).to.equal(false);
        now += SCHEMA_PROBE_TTL_MS + 1;
        expect(await columnsPresent(db, config, 't', ['x', 'y'])).to.equal(true);
        expect(db.doQuery.firstCall.args[2]).to.deep.equal(['t', 'x', 'y']);
        expect(db.doQuery.firstCall.args[1]).to.include('information_schema.COLUMNS');
        expect(db.doQuery.callCount).to.equal(2);
    });

    it('memoizes positive answers for either column order', async function(){
        db.doQuery.resolves(columnRows('x', 'y'));

        expect(await columnsPresent(db, config, 't', ['x', 'y'])).to.equal(true);
        expect(await columnsPresent(db, config, 't', ['x', 'y'])).to.equal(true);
        expect(await columnsPresent(db, config, 't', ['y', 'x'])).to.equal(true);
        expect(db.doQuery.callCount).to.equal(1);
    });

    it('memoizes negative answers only inside the TTL', async function(){
        db.doQuery.onFirstCall().resolves(columnRows('x'));
        db.doQuery.onSecondCall().resolves(columnRows('x', 'y'));

        expect(await columnsPresent(db, config, 't', ['x', 'y'])).to.equal(false);
        now += SCHEMA_PROBE_TTL_MS - 1;
        expect(await columnsPresent(db, config, 't', ['x', 'y'])).to.equal(false);
        now += 2;
        expect(await columnsPresent(db, config, 't', ['x', 'y'])).to.equal(true);
        expect(db.doQuery.callCount).to.equal(2);
    });
});

describe('schema column probe isolation', function(){
    it('returns true without caching when the column query rejects', async function(){
        db.doQuery.onFirstCall().rejects(new Error('unavailable'));
        db.doQuery.onSecondCall().resolves(columnRows('x', 'y'));

        expect(await columnsPresent(db, config, 't', ['x', 'y'])).to.equal(true);
        expect(await columnsPresent(db, config, 't', ['x', 'y'])).to.equal(true);
        expect(db.doQuery.callCount).to.equal(2);
    });

    it('keeps column memos separate for each coin', async function(){
        db.doQuery.resolves(columnRows('x', 'y'));

        await columnsPresent(db, config, 't', ['x', 'y']);
        await columnsPresent(db, { coin: 'LTC' }, 't', ['x', 'y']);
        await columnsPresent(db, config, 't', ['x', 'y']);
        expect(db.doQuery.callCount).to.equal(2);
    });

    it('lets an absent marker bypass the column query', async function(){
        setColumnsAbsent(db, config, 't', ['x', 'y']);

        expect(await columnsPresent(db, config, 't', ['y', 'x'])).to.equal(false);
        expect(db.doQuery.called).to.equal(false);
    });

    it('does not answer a table probe from a column memo', async function(){
        setColumnsAbsent(db, config, 't', ['x', 'y']);
        db.doQuery.resolves(tableRows('t'));

        expect(await tablesPresent(db, config, ['t'])).to.equal(true);
        expect(db.doQuery.calledOnce).to.equal(true);
    });
});

describe('schema probe errors', function(){
    it('recognizes missing table errors directly and through a cause', function(){
        expect(isMissingTableError({ errno: 1146 })).to.equal(true);
        expect(isMissingTableError({ code: 'ER_NO_SUCH_TABLE' })).to.equal(true);
        expect(isMissingTableError({ cause: { errno: 1146 } })).to.equal(true);
        expect(isMissingTableError({ cause: { code: 'ER_NO_SUCH_TABLE' } })).to.equal(true);
    });

    it('rejects values that are not missing table errors', function(){
        expect(isMissingTableError({ errno: 1054 })).to.equal(false);
        expect(isMissingTableError({})).to.equal(false);
        expect(isMissingTableError(null)).to.equal(false);
        expect(isMissingTableError(undefined)).to.equal(false);
    });

    it('recognizes unknown column errors directly and through a cause', function(){
        expect(isUnknownColumnError({ errno: 1054 })).to.equal(true);
        expect(isUnknownColumnError({ code: 'ER_BAD_FIELD_ERROR' })).to.equal(true);
        expect(isUnknownColumnError({ cause: { errno: 1054 } })).to.equal(true);
        expect(isUnknownColumnError({ cause: { code: 'ER_BAD_FIELD_ERROR' } })).to.equal(true);
    });

    it('rejects values that are not unknown column errors', function(){
        expect(isUnknownColumnError({ errno: 1146 })).to.equal(false);
        expect(isUnknownColumnError(null)).to.equal(false);
    });
});
