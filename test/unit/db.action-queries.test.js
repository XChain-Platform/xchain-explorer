/**
 * Unit tests for all get* ACTION query methods in src/db.js
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

const proxyquire = require('proxyquire');
const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const { createConfigInfoStub } = require('../fixtures/mock-config.js');
const { makeConfig }           = require('../fixtures/mock-query-args.js');

// ---------------------------------------------------------------------------
// Bootstrap: Database instance with no real MariaDB connection
// ---------------------------------------------------------------------------

const configInfo = createConfigInfoStub();
const util       = new Utility(configInfo);
const mockExplorer = { configInfo, util };
const Database = proxyquire('../../src/db.js', { mariadb: { createPool: () => ({}) } });
const db = new Database(mockExplorer);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const WHERE_DATA  = 'm.action_index IS NOT NULL AND a2.address=?';
const SEARCH_ADDR = 'addr1';

/**
 * Build a minimal config suitable for most ACTION query methods.
 * sql.where.data is pre-populated so the method can interpolate it directly.
 */
function makeActionConfig(method, type = 'address', overrides = {}) {
    return makeConfig({
        data: {
            method,
            search: SEARCH_ADDR,
            type,
            sql: {
                order: 'DESC',
                limit: 100,
                where: {
                    data:   WHERE_DATA,
                    offset: ''
                }
            },
            ...overrides
        }
    });
}

// ---------------------------------------------------------------------------
// getAddresses
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getAirdrops
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getBatches
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getBroadcasts
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getCallbacks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getDestroys
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getDispensers  (builds args internally)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getDispenserCancels
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getDispenserCloses
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getDispenserEdits
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getDispenserExpires
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getDispenses  (builds args internally)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getDividends
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getFees
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getFiles  (non-token type path)
// ---------------------------------------------------------------------------

describe('Database#getFiles (non-token type)', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getFiles', 'address');
        result = await db.getFiles(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "files" table and has name/type/title fields', () => {
        const [query] = result;
        expect(query).to.include('files m');
        expect(query).to.include('m.name');
        expect(query).to.include('m.title');
        expect(query).to.include('index_mime_types');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getFiles  (token type path — uses mappings_files)
// ---------------------------------------------------------------------------

describe('Database#getFiles (token type)', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getFiles', 'token');
        result = await db.getFiles(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "mappings_files" table for token type', () => {
        const [query] = result;
        expect(query).to.include('mappings_files m');
        expect(query).to.include('index_tickers');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getIssues
// ---------------------------------------------------------------------------

describe('Database#getIssues', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getIssues');
        result = await db.getIssues(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "issues" table with lock fields', () => {
        const [query] = result;
        expect(query).to.include('issues m');
        expect(query).to.include('m.lock_max_supply');
        expect(query).to.include('m.lock_mint');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getLinks
// ---------------------------------------------------------------------------

describe('Database#getLinks', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getLinks');
        result = await db.getLinks(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "links" table with index_coins JOINs', () => {
        const [query] = result;
        expect(query).to.include('links m');
        expect(query).to.include('index_coins');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getLists
// ---------------------------------------------------------------------------

describe('Database#getLists', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getLists');
        result = await db.getLists(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "lists" table', () => {
        const [query] = result;
        expect(query).to.include('lists m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getMessages  (builds args internally; address type gets two args)
// ---------------------------------------------------------------------------

describe('Database#getMessages', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getMessages', 'address');
        result = await db.getMessages(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "messages" with plaintext/encrypted fields', () => {
        const [query] = result;
        expect(query).to.include('messages m');
        expect(query).to.include('m.encrypted_message');
        expect(query).to.include('m.plaintext_message');
    });

    it('args is an array with two entries for address type', () => {
        const [, args] = result;
        expect(args).to.be.an('array').with.lengthOf(2);
        expect(args[0]).to.equal(SEARCH_ADDR);
    });
});

// ---------------------------------------------------------------------------
// getMints  (builds args internally)
// ---------------------------------------------------------------------------

describe('Database#getMints', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getMints', 'address');
        result = await db.getMints(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "mints" table with destination JOIN', () => {
        const [query] = result;
        expect(query).to.include('mints m');
        expect(query).to.include('destination');
    });

    it('args is an array with two entries for address type', () => {
        const [, args] = result;
        expect(args).to.be.an('array').with.lengthOf(2);
    });
});

// ---------------------------------------------------------------------------
// getOrders  (builds args internally; address/token types get two args)
// ---------------------------------------------------------------------------

describe('Database#getOrders', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getOrders', 'address');
        result = await db.getOrders(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "orders" with give/get tick+amount fields', () => {
        const [query] = result;
        expect(query).to.include('orders m');
        expect(query).to.include('give_tick');
        expect(query).to.include('get_tick');
        expect(query).to.include('m.give_amount');
        expect(query).to.include('m.get_amount');
    });

    it('args has two entries for address type', () => {
        const [, args] = result;
        expect(args).to.be.an('array').with.lengthOf(2);
    });
});

// ---------------------------------------------------------------------------
// getOrderCancels
// ---------------------------------------------------------------------------

describe('Database#getOrderCancels', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getOrderCancels');
        result = await db.getOrderCancels(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "order_cancels" table', () => {
        const [query] = result;
        expect(query).to.include('order_cancels m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getOrderEdits
// ---------------------------------------------------------------------------

describe('Database#getOrderEdits', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getOrderEdits');
        result = await db.getOrderEdits(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "order_edits" table', () => {
        const [query] = result;
        expect(query).to.include('order_edits m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getOrderExpires
// ---------------------------------------------------------------------------

describe('Database#getOrderExpires', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getOrderExpires');
        result = await db.getOrderExpires(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "order_expires" with orders JOIN', () => {
        const [query] = result;
        expect(query).to.include('order_expires m');
        expect(query).to.include('orders');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getOrderMatches
// ---------------------------------------------------------------------------

describe('Database#getOrderMatches', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getOrderMatches');
        result = await db.getOrderMatches(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "order_matches" with give/get coin JOINs', () => {
        const [query] = result;
        expect(query).to.include('order_matches m');
        expect(query).to.include('give_coin');
        expect(query).to.include('get_coin');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getSends  (builds args internally)
// ---------------------------------------------------------------------------

describe('Database#getSends', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSends', 'address');
        result = await db.getSends(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "sends" table with source/destination/tick', () => {
        const [query] = result;
        expect(query).to.include('sends m');
        expect(query).to.include('destination');
        expect(query).to.include('t3.tick');
    });

    it('args is an array with two entries for address type', () => {
        const [, args] = result;
        expect(args).to.be.an('array').with.lengthOf(2);
        expect(args[0]).to.equal(SEARCH_ADDR);
    });
});

// ---------------------------------------------------------------------------
// getSleeps
// ---------------------------------------------------------------------------

describe('Database#getSleeps', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSleeps');
        result = await db.getSleeps(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "sleeps" table', () => {
        const [query] = result;
        expect(query).to.include('sleeps m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getSwaps  (builds args internally)
// ---------------------------------------------------------------------------

describe('Database#getSwaps', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSwaps', 'address');
        result = await db.getSwaps(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "swaps" with give/get coin and tick fields', () => {
        const [query] = result;
        expect(query).to.include('swaps m');
        expect(query).to.include('give_coin');
        expect(query).to.include('get_coin');
        expect(query).to.include('give_tick');
        expect(query).to.include('get_tick');
    });

    it('args has two entries for address type', () => {
        const [, args] = result;
        expect(args).to.be.an('array').with.lengthOf(2);
    });
});

// ---------------------------------------------------------------------------
// getSwapCancels
// ---------------------------------------------------------------------------

describe('Database#getSwapCancels', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSwapCancels');
        result = await db.getSwapCancels(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "swap_cancels" table', () => {
        const [query] = result;
        expect(query).to.include('swap_cancels m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getSwapEdits
// ---------------------------------------------------------------------------

describe('Database#getSwapEdits', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSwapEdits');
        result = await db.getSwapEdits(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "swap_edits" table', () => {
        const [query] = result;
        expect(query).to.include('swap_edits m');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getSwapExpires
// ---------------------------------------------------------------------------

describe('Database#getSwapExpires', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSwapExpires');
        result = await db.getSwapExpires(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "swap_expires" with swaps JOIN', () => {
        const [query] = result;
        expect(query).to.include('swap_expires m');
        expect(query).to.include('swaps');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getSwapMatches
// ---------------------------------------------------------------------------

describe('Database#getSwapMatches', () => {
    let result;
    before(async () => {
        const config = makeActionConfig('getSwapMatches');
        result = await db.getSwapMatches(config);
    });

    it('returns a 3-element array', () => {
        expect(result).to.be.an('array').with.lengthOf(3);
    });

    it('query references "swap_matches" with give/get coin JOINs', () => {
        const [query] = result;
        expect(query).to.include('swap_matches m');
        expect(query).to.include('give_coin');
        expect(query).to.include('get_coin');
    });

    it('count uses WHERE_DATA and args is null', () => {
        const [, args, count] = result;
        expect(args).to.be.null;
        expect(count).to.include(WHERE_DATA);
    });
});

// ---------------------------------------------------------------------------
// getSweeps  (builds args internally)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getTokens  (builds args internally; uses search term)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getTokens with token type (wildcard search path)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getBalances
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getHolders
// ---------------------------------------------------------------------------

describe('Database#getHolders', () => {
    const HOLDERS_WHERE = 'm.address_id IS NOT NULL';
    let result;
    before(async () => {
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

// ---------------------------------------------------------------------------
// getCredits
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getDebits
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// getEscrows
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Cross-cutting: ORDER BY and LIMIT are interpolated from sql object
// ---------------------------------------------------------------------------

describe('ACTION query methods: sql.order and sql.limit interpolation', () => {
    it('getSends uses sql.order=ASC in ORDER BY clause', async () => {
        const config = makeConfig({
            data: {
                method: 'getSends',
                search: SEARCH_ADDR,
                type:   'address',
                sql: {
                    order: 'ASC',
                    limit: 50,
                    where: { data: WHERE_DATA, offset: '' }
                }
            }
        });
        const [query] = await db.getSends(config);
        expect(query).to.include('ORDER BY m.action_index ASC');
        expect(query).to.include('LIMIT 50');
    });

    it('getAirdrops uses sql.order=DESC in ORDER BY clause', async () => {
        const config = makeConfig({
            data: {
                method: 'getAirdrops',
                search: SEARCH_ADDR,
                type:   'block',
                sql: {
                    order: 'DESC',
                    limit: 25,
                    where: { data: WHERE_DATA, offset: '' }
                }
            }
        });
        const [query] = await db.getAirdrops(config);
        expect(query).to.include('ORDER BY m.action_index DESC');
        expect(query).to.include('LIMIT 25');
    });

    it('getIssues uses sql.limit=10 in LIMIT clause', async () => {
        const config = makeConfig({
            data: {
                method: 'getIssues',
                search: SEARCH_ADDR,
                type:   'address',
                sql: {
                    order: 'DESC',
                    limit: 10,
                    where: { data: WHERE_DATA, offset: '' }
                }
            }
        });
        const [query] = await db.getIssues(config);
        expect(query).to.include('LIMIT 10');
    });
});

// ---------------------------------------------------------------------------
// Cross-cutting: sql.where.offset is appended to query WHERE clause
// ---------------------------------------------------------------------------

describe('ACTION query methods: sql.where.offset appended to query', () => {
    it('getSends appends offset SQL to query WHERE clause', async () => {
        const offset = ' AND m.action_index < 500';
        const config = makeConfig({
            data: {
                method: 'getSends',
                search: SEARCH_ADDR,
                type:   'address',
                sql: {
                    order: 'DESC',
                    limit: 100,
                    where: { data: WHERE_DATA, offset }
                }
            }
        });
        const [query] = await db.getSends(config);
        expect(query).to.include(offset);
    });

    it('getTokens appends offset SQL to query WHERE clause', async () => {
        const offset = ' AND m.id < 200';
        const config = makeConfig({
            data: {
                method: 'getTokens',
                search: SEARCH_ADDR,
                type:   'address',
                sql: {
                    order: 'DESC',
                    limit: 100,
                    where: { data: WHERE_DATA, offset }
                }
            }
        });
        const [query] = await db.getTokens(config);
        expect(query).to.include(offset);
    });

    it('getDispensers does NOT append offset to count query', async () => {
        const offset = ' AND m.action_index < 300';
        const config = makeConfig({
            data: {
                method: 'getDispensers',
                search: SEARCH_ADDR,
                type:   'address',
                sql: {
                    order: 'DESC',
                    limit: 100,
                    where: { data: WHERE_DATA, offset }
                }
            }
        });
        const [, , count] = await db.getDispensers(config);
        // Count queries must NOT include the offset (they count all matching rows)
        expect(count).to.not.include(offset);
    });
});

// ---------------------------------------------------------------------------
// ATTEST queries — payload + callback_params_json projection
//
// The `attests` table stores the full attestation request body in `payload`
// (oracle URL for http_get providers, JSON prompt envelope for llm providers)
// and the developer-supplied callback params in `callback_params_json`. These
// must be present in every attests-reading query so API/WebSocket consumers can
// inspect what an attestation asked for; a regression that drops them from any
// SELECT silently hides the request body from consumers.
// ---------------------------------------------------------------------------

describe('Database#getAttestations exposes payload and callback_params_json', () => {
    it('list query and count select both columns from the attests table', async () => {
        const config = makeActionConfig('getAttestations', 'address');
        const [query, args, count] = await db.getAttestations(config);
        expect(query).to.be.a('string');
        expect(query).to.include('attests m');
        expect(query).to.include('m.payload');
        expect(query).to.include('m.callback_params_json');
        // fee_payer (the gas-billing address) is resolved from fee_payer_id,
        // NOT from source_id (which holds the request-emitting contract address).
        expect(query).to.include('fp.address as fee_payer');
        expect(query).to.include('fp.id=m.fee_payer_id');
        // List + count return the standard [query, null, count] triple.
        expect(args).to.be.null;
        expect(count).to.include('attests m');
    });
});

describe('Database#getAttestationsSince / getAttestationByActionIndex expose payload and callback_params_json', () => {
    let captured;
    let originalDoQuery;

    before(() => {
        originalDoQuery = db.doQuery;
        // Capture the generated SQL without needing a live DB connection.
        db.doQuery = async (config, query) => { captured.push(query); return []; };
    });

    after(() => {
        db.doQuery = originalDoQuery;
    });

    beforeEach(() => { captured = []; });

    it('getAttestationsSince (WebSocket feed) selects both columns', async () => {
        const config = makeActionConfig('getAttestationsSince');
        await db.getAttestationsSince(config, 0, 100);
        expect(captured).to.have.lengthOf(1);
        expect(captured[0]).to.include('attests m');
        expect(captured[0]).to.include('m.payload');
        expect(captured[0]).to.include('m.callback_params_json');
        expect(captured[0]).to.include('fp.address as fee_payer');
        expect(captured[0]).to.include('fp.id=m.fee_payer_id');
    });

    it('getAttestationByActionIndex (single lookup) selects both columns', async () => {
        const config = makeActionConfig('getAttestationByActionIndex');
        await db.getAttestationByActionIndex(config, 1);
        expect(captured).to.have.lengthOf(1);
        expect(captured[0]).to.include('FROM attests');
        expect(captured[0]).to.include('payload');
        expect(captured[0]).to.include('callback_params_json');
        expect(captured[0]).to.include('fp.address as fee_payer');
        expect(captured[0]).to.include('fp.id=m.fee_payer_id');
    });
});
