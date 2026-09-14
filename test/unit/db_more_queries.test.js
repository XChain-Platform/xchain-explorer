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
 * Additional unit tests for uncovered methods in src/db/index.js
 *
 * Covers (SQL-builder methods, return [query, args, count]):
 *   - getCoinpays, getCoinpayExpires, getCoinpayObligations
 *   - getMarkets, getMarket, getMarketOrders, getMarketHistory, getOrderbook
 *   - getActions, getAction, getBlocks
 *   - getSearch
 *   - getPublicKey, getTransactionData
 *   - getContracts, getContract, getContractState, getContractBalance
 *   - getExecutions, getExecution, getDeposits, getWithdrawals
 *   - getStakes, getValidators, getPrices, getPriceSnapshots, getDelegations
 *   - getValidatorRewards, getContractStakes, getContractUnstakes, getSlashEvents
 *   - getHistory
 *
 * Covers (helper/detail methods, stub doQuery):
 *   - getMaxBlockIndex, getMaxBlockTime, getMaxActionIndex
 *   - getGatedFileRaw, getBlocksSince, getActionsSince
 *   - getAddressBalances, getTokenInfo, getMarketInfo, getDispenserInfo
 *   - getCoinpayObligation, getOrderMatchSettlement
 *   - getPublicKey, getTransactionData
 *   - getActionFeeData
 *   - getHistoryData (basic)
 *   - getActionSummaryData (basic pass-through)
 *
 * Covers (LRU cache helpers):
 *   - cacheGet, cacheSet
 *
 * Covers (setup helpers):
 *   - init (calls setupConnectionPools)
 *   - setupConnectionPools (basic population)
 *   - getOrderInfo, getOrderEditInfo, getOrderAmountsRemaining, getOrderInfoBatch
 */

'use strict';

require('./db_more_queries.test/cache_and_coinpays.js');
require('./db_more_queries.test/markets_and_actions.js');
require('./db_more_queries.test/blocks_and_search.js');
require('./db_more_queries.test/history_and_files.js');
require('./db_more_queries.test/projects_and_orders.js');
require('./db_more_queries.test/contracts_and_staking.js');
require('./db_more_queries.test/prices_and_query_filters.js');
require('./db_more_queries.test/query_execution.js');
require('./db_more_queries.test/query_branches.js');
require('./db_more_queries.test/query_offsets.js');
require('./db_more_queries.test/query_offsets_more.js');
require('./db_more_queries.test/explorer_paging.js');
require('./db_more_queries.test/action_data_core.js');
require('./db_more_queries.test/action_data_protocol.js');
require('./db_more_queries.test/action_data_extended.js');
require('./db_more_queries.test/staking_and_cross_chain.js');
require('./db_more_queries.test/hub_and_checkpoints.js');
