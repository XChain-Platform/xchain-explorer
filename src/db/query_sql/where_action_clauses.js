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
 * XChain Explorer - WHERE clauses for the action, history, market and token lists
 *
 * One part of src/db/query_sql.js: the clause builders for the families that
 * read the actions/transactions/blocks chain, plus the GENERIC clause every
 * method without a builder of its own falls through to (the address/block/
 * contract/token/name lanes). Each builder takes the anchor the entry resolved
 * and returns the whole WHERE text for its method, so the SQL a method emits is
 * still read in one place.
 *
 * Plain functions, not a class body: they take the Database as their first
 * argument (`db`) for this.util, and nothing here reaches Database.prototype.
 *
 ********************************************************************/

'use strict';

function historyClause(db, config, sql){
    let type = config.data.type;
    // Only the address/token feeds drive off mappings_actions (alias m); the
    // all-activity and per-block feeds drive off `actions` itself (alias a1),
    // so their anchor names a1. See getHistoryData for why: mappings_actions
    // only carries actions that moved an address/tick ledger, so anchoring the
    // unfiltered feed on it silently drops every consensus action.
    if(type=='address'){
        sql += ' AND m.type_id=2 AND m.id=?';
    } else if(type=='token'){
        sql += ' AND m.type_id=1 AND m.id=?';
    } else {
        sql = 'a1.action_index IS NOT NULL';
        if(type=='block')
            sql += ' AND b1.block_index=?';
    }
    return sql;
}

// Every market predicate matches on COALESCE(ticker, coin), not on the ticker
// alone: the native side of a token/native pair has no index_tickers row, so
// t1.tick is NULL there and a bare `t1.tick=?` can never match the coin symbol
// the caller asked for. The readers join c1/c2 (index_coins) for exactly this.
function marketClause(db, config, sql){
    sql += ` AND ((COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?) OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?))`;
    return sql;
}

function marketsClause(db, config, sql){
    if(config.data.type=='token')
        sql += ` AND (COALESCE(t1.tick, c1.coin)=? OR COALESCE(t2.tick, c2.coin)=?)`;
    return sql;
}

function marketOrdersClause(db, config, sql){
    let method = config.data.method;
    sql += ` AND ((COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?) OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?))`;
    if(!db.util.isNull(config.data.search3)){
        if(method=='getMarketHistory'){
            sql += ' AND (a2.address=? OR a3.address=?)';
        } else {
            sql += ' AND a2.address=?';
        }
    }
    return sql;
}

// getTokens is the one builder that does not answer for every request it is
// called on: only the token/subtoken searches have a clause of their own, and
// every other type takes the generic lanes below, exactly as the else-if chain
// this table replaces fell past a `method=='getTokens' && type` guard.
function tokensClause(db, config, sql){
    if(['token','subtoken'].includes(config.data.type))
        return sql + ' AND t3.tick LIKE ?';
    return genericClause(db, config, sql);
}

function collectiblesClause(db, config, sql){
    let type = config.data.type;
    // M5.1's classification lives HERE, not in the reader, so it binds the COUNT
    // query as well as the row query: a filter applied only in the reader's row
    // SELECT would page a gallery whose `total` counted every token on the chain.
    // decimals=0 AND lock_max_supply=1 is the ISSUE-field definition of a
    // collectible (indivisible, ceiling frozen); both columns are indexed. It is
    // not invented here: it is the SAME rule the client already ships as
    // isNftToken (src/content/js/formatters.js), which itself mirrors
    // sdk.nft.isNft, so the gallery classifies exactly what the token page's own
    // NFT badge classifies rather than introducing a second definition.
    sql += ' AND m.decimals=0 AND m.lock_max_supply=1';
    if(type=='block')   sql += ' AND b1.block_index=?';
    if(type=='address') sql += ' AND a2.address=?';
    return sql;
}

// The generic lanes: every list method without a builder of its own (getBlocks
// excepted, which the entry answers with its anchor alone) narrows by the
// requested TYPE here.
function genericClause(db, config, sql){
    let type   = config.data.type;
    let method = config.data.method;
    if(type=='address'){
        if(['getMessages','getMints','getOrders','getSends','getSweeps','getDispensers','getDispenses'].includes(method)){
            sql += ' AND (a2.address=? OR a3.address=?)';
        } else if(method=='getCoinpayObligations'){
            sql += ' AND (a1.address=? OR a2.address=?)';
        } else {
            sql += ' AND a2.address=?';
        }
    }
    if(type=='block'){
        // coinpay_obligations carries block_index directly and has no
        // blocks join (b1); every other action query resolves the
        // block through its actions/blocks joins. Without this branch
        // the block lane 500s with an unknown-column error (PC-16).
        sql += (method=='getCoinpayObligations') ? ' AND m.block_index=?' : ' AND b1.block_index=?';
    }
    if(type=='destination')
        sql += ' AND a3.address=?';
    if(type=='source')
        sql += ' AND a2.address=?';
    sql = dispenserLaneClause(db, config, sql);
    return entityClause(db, config, sql);
}

// The two dispenser-only lanes, which narrow by a column no other method has.
function dispenserLaneClause(db, config, sql){
    let type   = config.data.type;
    let method = config.data.method;
    // getDispensers only: the oracle lane answers "which dispensers price
    // against this ORACLE_ADDRESS", which is what an oracle operator needs
    // before republishing a quote (PC-30) and who pays them the usage fee.
    // Resolved by subselect rather than through the a5 join the row query
    // uses, because the count query carries no a5.
    if(type=='oracle' && method=='getDispensers')
        sql += ' AND m.oracle_address_id=(SELECT id FROM index_addresses WHERE address=?)';
    // getDispenses only: the fills of ONE dispenser, keyed by the
    // dispenser's own action_index. The address/source lanes answer
    // "fills on this address", which is a different question whenever
    // an address hosts more than one dispenser - the normal case,
    // since dispensers open on their creator's source address. Ticks
    // cannot separate them either (two dispensers can share a pair,
    // and a coin-paid fill carries get_tick NULL).
    if(type=='dispenser' && method=='getDispenses')
        sql += ' AND m.dispenser_action_index=?';
    return sql;
}

// The contract, token and name lanes of the generic clause.
function entityClause(db, config, sql){
    let type   = config.data.type;
    let method = config.data.method;
    if(type=='contract'){
        if(['getContractStakes','getContractUnstakes','getContractDelegations','getSlashEvents'].includes(method))
            sql += ' AND m.target_contract_index=?';
        else if(method=='getContract')
            // The contracts table has no contract_index column; it is keyed by action_index.
            sql += ' AND m.action_index=?';
        else if(method=='getContractState')
            // contract_index filter is applied inside the latest-per-key subquery; no outer clause/arg.
            ;
        else
            sql += ' AND m.contract_index=?';
    }
    if(type=='token'){
        if(method=='getFiles'){
            sql += ' AND m.type_id=1 AND t4.tick=?';
        } else {
            sql += ' AND t3.tick=?';
        }
    }
    // getFiles 'name' mode (spec explorer-coverage-completion M1.7):
    // discovery-by-filename. files.name is a plain VARCHAR column on the base
    // `files` table (not interned like tick/address), and only 'token' routes
    // getFiles to the mappings_files/interned-tick query shape above; every
    // other type (including 'name') keeps the base `files m` FROM-clause where
    // `m` already resolves to `files`, so `m.name` is index-friendly here: an
    // exact-match equality on a plain column, no leading wildcard and no
    // function wrapping the column, so a `files(name)` index (sibling migration
    // in xchain-indexer, out of this surface) can serve it directly.
    if(type=='name' && method=='getFiles')
        sql += ' AND m.name=?';
    // getContracts 'name' mode (spec contract-meta-manifest 2.6): find a
    // contract by a word from its declared name or description. The house
    // filter is a leading-% LIKE, which no index can serve; these two columns
    // are the schema's first FULLTEXT index (meta_search), so this lane uses
    // MATCH ... AGAINST over it instead. The bound term is the SANITIZED one
    // getContracts computes, never the raw path segment: BOOLEAN MODE reads
    // operator characters inside the value.
    if(type=='name' && method=='getContracts')
        sql += ' AND MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)';
    return sql;
}

const ACTION_CLAUSE_BUILDERS = {
    getHistory:       historyClause,
    getMarket:        marketClause,
    getMarkets:       marketsClause,
    getMarketOrders:  marketOrdersClause,
    getOrderbook:     marketOrdersClause,
    getMarketHistory: marketOrdersClause,
    getTokens:        tokensClause,
    getCollectibles:  collectiblesClause
};

module.exports = { ACTION_CLAUSE_BUILDERS, genericClause };
