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
