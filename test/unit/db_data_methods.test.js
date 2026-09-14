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
 * Unit tests for data-transformation and query-execution methods in src/db/index.js
 *
 * Covers:
 *   - getData(config)
 *   - getToken(config)
 *   - getBlock(config)
 *   - getAddress(config)
 *   - getNetwork(config)
 *   - getStatus(config)
 *   - getTransaction(config)
 *   - getMempool(config)
 *   - getAddressId(config, address)
 *   - getTickId(config, tick)
 *   - getActionType(config, action_index)
 *   - doQuery(config, query, args)
 */

'use strict';

require('./db_data_methods.test/support/query_execution.js');
require('./db_data_methods.test/support/core_records.js');
require('./db_data_methods.test/support/status.js');
require('./db_data_methods.test/support/tip_freshness.js');
require('./db_data_methods.test/support/tip_freshness_status.js');
require('./db_data_methods.test/support/network.js');
require('./db_data_methods.test/support/token.js');
require('./db_data_methods.test/support/transaction_ids.js');
require('./db_data_methods.test/support/decoder_health.js');
require('./db_data_methods.test/support/contracts.js');
require('./db_data_methods.test/support/controllers_state.js');
