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

require('./db_action_queries.test/support/issuance.js');
require('./db_action_queries.test/support/files_lists_messages.js');
require('./db_action_queries.test/support/orders_swaps.js');
require('./db_action_queries.test/support/transfers_balances.js');
require('./db_action_queries.test/support/pagination.js');
require('./db_action_queries.test/support/attestations_xcalls.js');
