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
 *
 * XChain Explorer - the Database class's method tables
 *
 * The name lists the list readers and the paging code share: the action tables
 * the list and search readers walk, how each explorer list method pages (from a
 * boundary table, on the preserved client cursor, or by row position), and the
 * per-method page cap. A query family that needs to add a name edits this file
 * rather than the Database class.
 *
 * The constructor copies ACTION_TABLES and CURSOR_PAGED_METHODS per instance, so
 * every Database owns its own array.
 *
 ********************************************************************/

'use strict';

// Tables holding one row per typed action, read as this.actionTables by
// getActionTotals (the per-table network totals) and getBlocks (the per-block
// action counts union).
const ACTION_TABLES = [
    'addresses',
    'airdrops',
    'anchor_actions',
    'batches',
    'broadcasts',
    'callbacks',
    'coinpays',
    'coinpay_expires',
    'coinpay_obligations',
    'destroys',
    'dispensers',
    'dispenses',
    'dividends',
    'files',
    'full_node_verifications',
    'issues',
    'links',
    'lists',
    'messages',
    'mints',
    'orders',
    'order_cancels',
    'order_edits',
    'order_matches',
    'prices',
    'sends',
    'sleeps',
    'swaps',
    'swap_cancels',
    'swap_edits',
    'swap_matches',
    'sweeps'
];

// The table getQueryOffsets reads page boundaries from, per explorer list method.
// Named explicitly: a method absent here pages on the preserved client cursor
// (CURSOR_PAGED_METHODS) or by row position (SLICE_PAGED_METHODS).
const BOUNDARY_TABLE_BY_METHOD = {
    getAddresses: 'addresses', getAirdrops: 'airdrops', getBatches: 'batches',
    getBroadcasts: 'broadcasts', getCallbacks: 'callbacks', getCoinpays: 'coinpays',
    getDestroys: 'destroys', getDispensers: 'dispensers', getDispenses: 'dispenses',
    getDividends: 'dividends', getFiles: 'files', getIssues: 'issues', getLinks: 'links',
    getLists: 'lists', getMessages: 'messages', getMints: 'mints', getOrders: 'orders',
    getPrices: 'prices', getSends: 'sends', getSleeps: 'sleeps', getSwaps: 'swaps',
    getSweeps: 'sweeps', getBlocks: 'blocks', getTokens: 'tokens', getHistory: 'history'
};

// The boundary table for a method, or null when it has none.
function boundaryTable(method){
    return Object.prototype.hasOwnProperty.call(BOUNDARY_TABLE_BY_METHOD, method)
        ? BOUNDARY_TABLE_BY_METHOD[method] : null;
}

// Lists holding several rows per action_index, so a scalar action_index cursor
// would skip the rest of an action split across a page edge; the explorer pages
// them by row position over their total sort order instead.
const MULTI_ROW_METHODS = ['getCredits', 'getDebits', 'getEscrows', 'getVotes', 'getControllers'];

// The most rows one list page returns, per method; the default page size on the API.
const LIST_LIMIT_MAX = { getBalances: 500, getHolders: 500 };

function listLimitMax(method){
    return Object.prototype.hasOwnProperty.call(LIST_LIMIT_MAX, method) ? LIST_LIMIT_MAX[method] : 100;
}

// Explorer lists paged by row position (fetch start+length rows, keep the window).
const SLICE_PAGED_METHODS = ['getBalances', 'getHolders', 'getSearch', 'getProjectTokens',
    ...MULTI_ROW_METHODS];

function escapedListText(expr){
    return `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${expr}, ''),
        '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), CHAR(34), '&quot;'), CHAR(39), '&#39;')`;
}

function listMetaSelect(hasMetas){
    if(!hasMetas) return { joins: '', fields: '', name: 'NULL', description: 'NULL' };
    return {
        joins: `LEFT JOIN list_metas lm ON (lm.action_index=(
                    SELECT MAX(lm2.action_index)
                    FROM list_metas lm2
                        INNER JOIN index_statuses lms2 ON (lms2.id=lm2.status_id)
                    WHERE lm2.list_action_index=COALESCE(m.list_action_index, m.action_index)
                        AND lms2.status='valid'
                ))`,
        fields: 'lm.name AS name, lm.description AS description,',
        name: 'lm.name',
        description: 'lm.description'
    };
}

function listDisplaySelect(config, meta){
    if(config.type !== 'explorer') return { type: 'm.type', edit: 'm.edit' };
    return {
        type: `CONCAT(CASE WHEN ${meta.name} IS NULL OR ${meta.name}=''
                    THEN CONCAT('List #', m.action_index)
                    ELSE ${escapedListText(meta.name)} END, ' (type ', m.type, ')')`,
        edit: escapedListText(meta.description)
    };
}

async function buildListsQuery(db, config, tablesPresent){
    let sql = config.data.sql;
    let meta = listMetaSelect(await tablesPresent(db, config, ['list_metas']));
    let display = listDisplaySelect(config, meta);
    let from = `lists m
                    INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                    INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                    INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                    LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                    LEFT  JOIN index_memos        m1 ON (m1.id=m.memo_id)
                    LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                    LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    LEFT  JOIN index_actions      a3 ON (a3.id=a1.action_id)`;
    let count = `SELECT count(*) as total FROM ` + from + ` WHERE ` + sql.where.data;
    let query = `SELECT
                    a3.action, m.action_index, a1.action_format,
                    ` + display.type + ` AS type,
                    ` + display.edit + ` AS edit,
                    m.list_action_index,
                    ` + meta.fields + `
                    a2.address as source, b1.block_index, b1.block_time as timestamp,
                    t2.hash as tx_hash, t1.tx_index, m1.memo, s1.status
                FROM ` + from + `
                    ` + meta.joins + `
                WHERE ` + sql.where.data + sql.where.offset + `
                ORDER BY m.action_index ` + sql.order + `
                LIMIT ` + sql.limit;
    return [query, null, count];
}

// List views with no BOUNDARY_TABLE_BY_METHOD entry that hold one row per cursor
// value. Each main list query already orders by and filters on its cursor column
// (offset_cursors.js), so getQueryOffsets passes the inbound client cursor through
// and next/prev advance from it.
const CURSOR_PAGED_METHODS = [
    'getAnchors','getXcalls','getAttestations','getAttestValidatorStats',
    'getContractStakes','getContractUnstakes','getContractDelegations','getEmissions',
    'getCrossChainSettlements','getCrossChainMatches',
    'getSlashEvents','getCapabilitySlashEvents','getFullNodeVerifications',
    'getPriceSnapshots','getOraclePrices',
    'getValidatorCapabilities','getGovernanceProposals','getGovernanceVotes','getReorgs','getSlashProposals',
    'getPeers','getConsensusState','getConfigs','getTelemetryPings',
    'getPolls','getVoteDelegations',
    // BET market/wager lists: getBetFeeds (bet_feeds) and getBets (bets) have no
    // boundary table, so they page on the preserved client cursor like the poll
    // family. Both ORDER BY m.action_index,
    // which is getQueryOffsetSql's default cursor field, so no id-keyed entry.
    'getBetFeeds','getBets',
    // The checkpoint-schema family: state_checkpoints, capability_snapshots and
    // anchor_reward_attestations are hub-mirrored and state_tree_roots is
    // indexer-local, and none of the four has a boundary table. They
    // page on the preserved client cursor; getQueryOffsetSql gives getCheckpoints
    // and getCommitments their own m.block_index cursor field below (not m.id),
    // since both lists ORDER BY the committed height.
    'getCheckpoints','getCapabilitySnapshots','getAnchorRewardAttestations','getCommitments',
    // getCollectibles reads `tokens` filtered by the M5.1 classification and has no
    // boundary table; it pages on the preserved client cursor over m.id.
    // The gallery is /api-only today (it pages by ?page=, and the cursor path
    // runs for /explorer requests alone), so this entry and its sibling in
    // getQueryOffsetSql are armed rather than exercised: they exist so that
    // registering an /explorer feed later cannot silently page this method on
    // the wrong column, which is the failure the cursor list itself documents.
    'getCollectibles',
    // getActions reads every action, not one typed table, so it has no boundary
    // table; without this entry the inbound cursor is dropped and page 2 answers
    // no rows. The raw feed ORDERs BY m.action_index, the default.
    'getActions',
    // Typed action lists with one row per action_index and no boundary table entry.
    'getCoinpayExpires','getCoinpayObligations','getContracts','getDeposits','getWithdrawals',
    'getExecutions','getDeployChunks','getFees',
    'getDispenserCancels','getDispenserCloses','getDispenserEdits','getDispenserExpires',
    'getOrderCancels','getOrderEdits','getOrderExpires','getOrderMatches',
    'getSwapCancels','getSwapEdits','getSwapExpires','getSwapMatches',
    'getStakes','getUnstakes','getCollects','getDelegations','getStakeKeyRevocations',
    'getValidators','getValidatorRewards','getMarketHistory'
];

module.exports = { ACTION_TABLES, BOUNDARY_TABLE_BY_METHOD, boundaryTable, MULTI_ROW_METHODS, listLimitMax,
    SLICE_PAGED_METHODS, CURSOR_PAGED_METHODS, buildListsQuery };
