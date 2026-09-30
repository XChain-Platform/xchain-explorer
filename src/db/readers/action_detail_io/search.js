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
 * XChain Explorer - the site search
 *
 * getSearch counts matches per panel and returns the requested panel's rows:
 * bounded prefix lookups for addresses, transactions, broadcasts and tokens, and the
 * FULLTEXT match for contracts.
 *
 * One part of src/db/readers/action_detail_io.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

// Build bounded panel counts. The contract panel joins the list only when its
// sanitized FULLTEXT term survived, so an operator-only term counts zero contracts
// without running a match nobody can bind.
function searchCountQueries(search, ftTerm){
    let byType = {
        address:     { query: `SELECT 1 FROM index_addresses WHERE address LIKE ?`, args: [search] },
        transaction: { query: `SELECT 1 FROM transactions t1 LEFT JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id) WHERE t2.hash LIKE ?`, args: [search] },
        broadcast:   { query: `SELECT 1 FROM broadcasts b LEFT JOIN index_memos m ON (m.id=b.memo_id) WHERE b.message LIKE ? OR m.memo LIKE ?`, args: [search, search] },
        token:       { query: `SELECT 1 FROM tokens t1 LEFT JOIN index_tickers t2 ON (t2.id=t1.tick_id) WHERE t2.tick LIKE ? OR t1.description LIKE ?`, args: [search, search] },
        contract:    { query: `SELECT 1 FROM contracts m WHERE MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)`, args: [ftTerm] }
    };
    if(ftTerm === '') delete byType.contract;
    return Object.keys(byType).map((type) => ({
        type,
        query: `SELECT COUNT(*) AS count FROM (${byType[type].query} LIMIT 100) bounded_matches`,
        args: byType[type].args
    }));
}

function isMissingFulltextIndex(error){
    return error && error.name === 'DbQueryError' &&
        Number(error.cause && error.cause.errno) === 1191;
}

async function runSearchCounts(db, config, countQueries){
    let settled = await Promise.allSettled(countQueries.map(q => db.doQuery(config, q.query, q.args)));
    let countResults = [];
    for(let i = 0; i < settled.length; i++){
        let result = settled[i];
        let query  = countQueries[i];
        if(result.status === 'fulfilled'){
            countResults.push(result.value);
            continue;
        }
        if(query.type !== 'contract' || !isMissingFulltextIndex(result.reason))
            throw result.reason;
        countResults.push([]);
    }
    return countResults;
}

// Fold the counted rows onto the totals block, and return the count for the panel
// the caller asked for.
function applySearchCounts(data, countQueries, countResults, dataType){
    let total = 0;
    for(let i = 0; i < countQueries.length; i++){
        let results = countResults[i];
        let type    = countQueries[i].type;
        if(results && results.length){
            let cnt = Number(results[0].count);
            if(type=='address')     data.totals.addresses    = cnt;
            if(type=='broadcast')   data.totals.broadcasts   = cnt;
            if(type=='contract')    data.totals.contracts    = cnt;
            if(type=='token')       data.totals.tokens       = cnt;
            if(type=='transaction') data.totals.transactions = cnt;
            if(type==dataType)      total = cnt;
        }
    }
    return total;
}

// The bind list for the requested panel: the LIKE pattern once, twice where the
// panel searches two columns, and the FULLTEXT term alone for contracts.
function searchPageArgs(dataType, search, ftTerm){
    let args  = [search];
    if(['broadcast','token'].includes(dataType))
        args.push(search);
    // The contract panel binds the FULLTEXT term, not the LIKE pattern.
    if(dataType=='contract')
        args = [ftTerm];
    return args;
}

// The three LIKE panels. False when the requested panel is not one of them.
function searchLikeQuery(dataType, searchLimit){
    let query = false;
    if(dataType=='address')
        query = `SELECT
                            address
                        FROM
                            index_addresses
                        WHERE
                            address LIKE ?
                        ORDER BY address ASC
                        LIMIT ` + searchLimit;
    if(dataType=='transaction')
        query = `SELECT
                            t2.hash
                        FROM
                            transactions t1
                            LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        WHERE
                            t2.hash LIKE ?
                        ORDER BY t2.hash ASC
                        LIMIT ` + searchLimit;
    if(dataType=='broadcast')
        query = `SELECT
                            b.message,
                            m.memo,
                            b.action_index,
                            s.status
                        FROM
                            broadcasts b
                            LEFT  JOIN index_memos    m ON (m.id=b.memo_id)
                            LEFT  JOIN index_statuses s ON (s.id=b.status_id)
                        WHERE
                            b.message LIKE ? OR
                            m.memo    LIKE ?
                        ORDER BY b.action_index DESC
                        LIMIT ` + searchLimit;
    return query;
}

// The two remaining panels, given whatever the LIKE panels resolved to: tokens,
// and contracts through the FULLTEXT match.
function searchNamedQuery(dataType, searchLimit, query){
    if(dataType=='token'){
        query = `SELECT
                            t2.tick,
                            t1.description
                        FROM
                            tokens t1
                            LEFT  JOIN index_tickers t2 ON (t2.id=t1.tick_id)
                        WHERE
                            t2.tick        LIKE ? OR
                            t1.description LIKE ?
                        ORDER BY t2.tick ASC
                        LIMIT ` + searchLimit;
    }
    if(dataType=='contract'){
        query = `SELECT
                            m.action_index,
                            m.meta_name,
                            m.meta_version,
                            m.meta_description
                        FROM
                            contracts m
                        WHERE
                            MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)
                        ORDER BY m.action_index DESC
                        LIMIT ` + searchLimit;
    }
    return query;
}

// Reshape contract hits into what the results row navigates by.
function shapeContractHits(db, config, data){
    // A contract hit carries the derived address the reader actually
    // navigates by (C:<CHAIN>:<action_index>, the same derivation
    // getContractBalance uses) and a bounded description snippet: the
    // column holds up to 512 bytes, which is a paragraph in a results row.
    let chain = db.baseCoin ? (db.baseCoin[config.coin] || config.coin) : config.coin;
    data.data = data.data.map((row) => ({
        action_index:     row.action_index,
        contract_address: 'C:' + chain + ':' + row.action_index,
        meta_name:        db.util.isNull(row.meta_name)    ? null : row.meta_name,
        meta_version:     db.util.isNull(row.meta_version) ? null : row.meta_version,
        snippet:          db.metaSnippet(row.meta_description)
    }));
}

async function runSearchPage(db, config, dataType, searchLimit, search, ftTerm, data, total){
    let args  = searchPageArgs(dataType, search, ftTerm);
    let query = searchNamedQuery(dataType, searchLimit, searchLikeQuery(dataType, searchLimit));
    if(!query)
        return total;
    try {
        let results = await db.doQuery(config, query, args);
        if(results && results.length)
            data.data = results;
    } catch(error){
        if(dataType !== 'contract' || !isMissingFulltextIndex(error))
            throw error;
        data.totals.contracts = 0;
        return 0;
    }
    if(dataType=='contract' && Array.isArray(data.data))
        shapeContractHits(db, config, data);
    return total;
}

class SearchReaders {
    async getSearch(config){
        const SEARCH_MIN_LENGTH = 3;
        const SEARCH_MAX_BYTES  = 256;
        const SEARCH_MAX_ROWS   = 100;
        const searchRaw = (config.data.search || '').trim();
        // Keep public search work within the indexed field sizes and URL use case.
        if(searchRaw.length < SEARCH_MIN_LENGTH || Buffer.byteLength(searchRaw, 'utf8') > SEARCH_MAX_BYTES){
            return [{ data: [], totals: { addresses: 0, broadcasts: 0, contracts: 0, tokens: 0, transactions: 0 } }, null, 0];
        }
        let dataType    = config.data.type;
        let search      = this.util.escapeLike(searchRaw) + '%';
        let total       = 0;
        let sql  = config.data.sql;
        const searchLimit = Math.min(Number(sql.limit) || SEARCH_MAX_ROWS, SEARCH_MAX_ROWS);
        // The contract panel is the ONE panel that is not a LIKE (spec 2.6): contracts
        // carry a FULLTEXT index over (meta_name, meta_description), so a name or
        // description word is matched through it rather than by a leading-% scan. Its
        // term is sanitized for BOOLEAN MODE and can come back empty when it contains
        // only operator characters, which leaves the contract total at zero.
        let ftTerm = this.fulltextTerm(searchRaw);
        let data = {
            data: [],
            totals: {
                addresses:    0,
                broadcasts:   0,
                contracts:    0,
                tokens:       0,
                transactions: 0
            },
        };
        let countQueries = searchCountQueries(search, ftTerm);
        let countResults = await runSearchCounts(this, config, countQueries);
        total = applySearchCounts(data, countQueries, countResults, dataType);
        if(total)
            total = await runSearchPage(this, config, dataType, searchLimit, search, ftTerm, data, total);
        return [data, null, total]
    }
}

module.exports = SearchReaders.prototype;
