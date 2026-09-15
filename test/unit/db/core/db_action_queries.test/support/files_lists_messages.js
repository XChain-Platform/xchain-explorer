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

// A token search reads the interned mappings_files table, not the base files
// table every other search mode uses.
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

// Both getFiles paths select the gated_files columns, and the wallet reads
// row.gate_min_amount straight off /api/files, so the column name is fixed
// by an already-shipped consumer: an alias here, or a missing column on
// either path, silently degrades a gated file to "no threshold", which the
// wallet reads as an unconditional gate rather than as an error. Pinned on both paths since they are separate SQL
// literals that have drifted out of sync before.

['address', 'token'].forEach((type) => {
    describe(`Database#getFiles (${type} type) gating columns`, () => {
        let query;
        before(async () => {
            const config = makeActionConfig('getFiles', type);
            [query] = await db.getFiles(config);
        });

        it('joins gated_files and selects gate_min_amount beside gate_ticker', () => {
            expect(query).to.include('LEFT  JOIN gated_files');
            expect(query).to.include('gf.gate_ticker');
            expect(query).to.include('gf.gate_min_amount');
        });

        it('selects the threshold unaliased, since the wallet reads gate_min_amount', () => {
            expect(query).to.not.match(/gf\.gate_min_amount\s+as\s+/i);
        });
    });
});

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

// Builds its own args: an address search is bound twice, matching either the
// sender or the destination.
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

// Builds its own args: an address search is bound twice (source or destination).
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
