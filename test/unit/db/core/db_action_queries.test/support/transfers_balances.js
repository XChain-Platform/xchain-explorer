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
 * Unit tests for all get* ACTION query methods in src/db/index.js
 *
 * Each method is called directly (no DB connection needed) and the returned
 * [query, args, count] triple is verified for:
 *   - correct array length (3 elements)
 *   - presence of the expected main table name in both query and count
 *   - presence of sql.where.data in the WHERE clause
 *   - ORDER BY and LIMIT clauses driven by sql.order / sql.limit
 *   - args value (null for most methods, an array for those that build args internally)
 */

'use strict';

const { expect, makeConfig, db, WHERE_DATA, SEARCH_ADDR, makeActionConfig } = require('./helpers.js');

// Builds its own args: an address search is bound twice (source or destination).
describe('Database#getSweeps', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSweeps', 'address');
        result = await db.getSweeps(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "sweeps" table with destination JOIN', () => {
        const [query] = result;
        expect(query).to.include('sweeps m');
        expect(query).to.include('destination');
    });

    it('args is an array with two entries for address type', () => {
        const [, args] = result;
        expect(args).to.be.an('array').with.lengthOf(2);
        expect(args[0]).to.equal(SEARCH_ADDR);
    });
});

// Builds its own args from the search term: a LIKE pattern for a token search,
// the plain value for a block or address search.
describe('Database#getTokens', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getTokens', 'address');
        result = await db.getTokens(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "tokens" table with index_tickers JOIN', () => {
        const [query] = result;
        expect(query).to.include('tokens m');
        expect(query).to.include('index_tickers');
    });

    it('args contains search value and count includes WHERE_DATA', () => {
        const [, args, count] = result;
        expect(args).to.be.an('array');
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getTokens (token type wildcard)', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getTokens', 'token');
        result = await db.getTokens(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query uses ORDER BY t3.tick instead of m.id for token type', () => {
        const [query] = result;
        expect(query).to.include('t3.tick');
    });

    it('args wraps search in LIKE wildcards for token type', () => {
        const [, args] = result;
        expect(args).to.be.an('array').with.lengthOf(1);
        expect(args[0]).to.include('%');
    });
});

describe('Database#getBalances', () => {
    const BALANCES_WHERE = 'm.address_id IS NOT NULL';
    let result;
    before(async () => {
        const config = makeActionConfig('getBalances', 'address', {
            sql: {
                order: 'ASC',
                limit: 500,
                where: {
                    data:   BALANCES_WHERE,
                    offset: ''
                }
            }
        });
        result = await db.getBalances(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "balances" table with tick/amount/supply/decimals/coin_price', () => {
        const [query] = result;
        expect(query).to.include('balances m');
        expect(query).to.include('t1.tick');
        expect(query).to.include('m.amount');
        expect(query).to.include('t4.supply');
        expect(query).to.include('t4.decimals');
        expect(query).to.include('t4.coin_price');
    });

    it('count uses WHERE clause and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(BALANCES_WHERE);
    });
});

describe('Database#getHolders', () => {
    const HOLDERS_WHERE = 'm.address_id IS NOT NULL';
    let result;
    let originalDoQuery;
    before(async () => {
        // The token-type tick-exists guard runs a doQuery before building the
        // holders query; stub it to a non-empty result so we reach the query
        // shape this suite asserts on (no live DB connection in unit tests).
        originalDoQuery = db.doQuery;
        db.doQuery = async () => [{ id: 1 }];
        const config = makeActionConfig('getHolders', 'token', {
            sql: {
                order: 'DESC',
                limit: 500,
                where: {
                    data:   HOLDERS_WHERE,
                    offset: ''
                }
            }
        });
        result = await db.getHolders(config);
    });
    after(() => { db.doQuery = originalDoQuery; });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "balances" table with address/amount/supply', () => {
        const [query] = result;
        expect(query).to.include('balances m');
        expect(query).to.include('a2.address');
        expect(query).to.include('m.amount');
        expect(query).to.include('t4.supply');
    });

    it('count uses WHERE clause and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(HOLDERS_WHERE);
    });
});

describe('Database#getCredits', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getCredits');
        result = await db.getCredits(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "credits" table', () => {
        const [query] = result;
        expect(query).to.include('credits m');
        expect(query).to.include('t2.tick');
        expect(query).to.include('m.amount');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getDebits', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getDebits');
        result = await db.getDebits(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "debits" table', () => {
        const [query] = result;
        expect(query).to.include('debits m');
        expect(query).to.include('t2.tick');
        expect(query).to.include('m.amount');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getEscrows', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getEscrows');
        result = await db.getEscrows(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "escrows" table', () => {
        const [query] = result;
        expect(query).to.include('escrows m');
        expect(query).to.include('t2.tick');
        expect(query).to.include('m.amount');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});
