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

describe('Database#getAddresses', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getAddresses');
        result = await db.getAddresses(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query contains table "addresses" and expected JOINs', () => {
        const [query] = result;
        expect(query).to.include('addresses m');
        expect(query).to.include('JOIN actions');
        expect(query).to.include('JOIN transactions');
        expect(query).to.include('JOIN blocks');
        expect(query).to.include('index_addresses');
        expect(query).to.include('index_memos');
    });

    it('count uses same WHERE and args is null', () => {
        const [query, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
        expect(query).to.include('ORDER BY m.action_index DESC');
        expect(query).to.include('LIMIT 100');
    });
});

describe('Database#getAirdrops', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getAirdrops');
        result = await db.getAirdrops(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query contains table "airdrops" and index_tickers JOIN', () => {
        const [query] = result;
        expect(query).to.include('airdrops m');
        expect(query).to.include('index_tickers');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getBatches', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getBatches');
        result = await db.getBatches(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "batches" table', () => {
        const [query] = result;
        expect(query).to.include('batches m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getBroadcasts', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getBroadcasts');
        result = await db.getBroadcasts(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "broadcasts" and selects message/value/fee', () => {
        const [query] = result;
        expect(query).to.include('broadcasts m');
        expect(query).to.include('m.message');
        expect(query).to.include('m.value');
        expect(query).to.include('m.fee');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getCallbacks', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getCallbacks');
        result = await db.getCallbacks(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "callbacks" with two index_tickers JOINs', () => {
        const [query] = result;
        expect(query).to.include('callbacks m');
        // Two ticker joins: t3 (tick_id) and t4 (callback_tick_id)
        expect(query).to.include('t3.id=m.tick_id');
        expect(query).to.include('t4.id=m.callback_tick_id');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getDestroys', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getDestroys');
        result = await db.getDestroys(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "destroys" table', () => {
        const [query] = result;
        expect(query).to.include('destroys m');
        expect(query).to.include('index_tickers');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// getDispensers builds its own args: an address search is bound twice, so it
// matches either the source or the dispenser address.
describe('Database#getDispensers', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getDispensers', 'address');
        result = await db.getDispensers(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "dispensers" with give/get coin JOINs', () => {
        const [query] = result;
        expect(query).to.include('dispensers m');
        expect(query).to.include('index_coins');
        expect(query).to.include('give_tick');
        expect(query).to.include('get_tick');
    });

    it('args is an array with two entries (address search duplicated for address type)', () => {
        const [, args] = result;
        expect(args).to.be.an('array').with.lengthOf(2);
        expect(args[0]).to.equal(SEARCH_ADDR);
        expect(args[1]).to.equal(SEARCH_ADDR);
    });
});

describe('Database#getDispenserCancels', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getDispenserCancels');
        result = await db.getDispenserCancels(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "dispenser_cancels" table', () => {
        const [query] = result;
        expect(query).to.include('dispenser_cancels m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getDispenserCloses', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getDispenserCloses');
        result = await db.getDispenserCloses(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "dispenser_closes" and joins dispensers', () => {
        const [query] = result;
        expect(query).to.include('dispenser_closes m');
        expect(query).to.include('dispensers');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getDispenserEdits', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getDispenserEdits');
        result = await db.getDispenserEdits(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "dispenser_edits" table', () => {
        const [query] = result;
        expect(query).to.include('dispenser_edits m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getDispenserExpires', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getDispenserExpires');
        result = await db.getDispenserExpires(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "dispenser_expires" table', () => {
        const [query] = result;
        expect(query).to.include('dispenser_expires m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// Builds its own args, binding an address search twice like getDispensers above.
describe('Database#getDispenses', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getDispenses', 'address');
        result = await db.getDispenses(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "dispenses" with dispensers JOIN and give/get fields', () => {
        const [query] = result;
        expect(query).to.include('dispenses m');
        expect(query).to.include('dispensers');
        expect(query).to.include('give_coin');
        expect(query).to.include('get_coin');
    });

    it('args is an array with address search (duplicated for address type)', () => {
        const [, args] = result;
        expect(args).to.be.an('array').with.lengthOf(2);
        expect(args[0]).to.equal(SEARCH_ADDR);
    });
});

describe('Database#getDividends', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getDividends');
        result = await db.getDividends(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "dividends" with two ticker JOINs', () => {
        const [query] = result;
        expect(query).to.include('dividends m');
        expect(query).to.include('t3.id=m.tick_id');
        expect(query).to.include('t4.id=m.dividend_tick_id');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

describe('Database#getFees', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getFees');
        result = await db.getFees(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "fees" table', () => {
        const [query] = result;
        expect(query).to.include('fees m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});
