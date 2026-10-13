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
 * Two panels depend on an index the connected replica may not carry, so both ask
 * the schema probe first instead of letting the statement find out. The contract
 * MATCH needs the FULLTEXT index over (meta_name, meta_description); without it the
 * statement is error 1191, so the panel counts zero and runs nothing. The token
 * panel always matches on the tick through its prefix index, and adds the
 * description prefix only when a B-tree index leads with tokens.description: an
 * unindexed `description LIKE 'x%'` reads every token row on a term that matches
 * nothing, and a LIMIT cannot bound a miss.
 *
 * One part of src/db/readers/action_detail_io.js (the entry composes it through
 * composeReaderParts). Authored as a class body whose prototype is exported,
 * like every other family under src/db/: `this` is the Database instance at
 * call time, and the methods reach Database.prototype non-enumerable, by
 * descriptor.
 *
 ********************************************************************/

'use strict';

const { indexPresent, setIndexAbsent, isMissingFulltextError } = require('../../schema_probe.js');

const CONTRACT_FT_COLUMNS = ['meta_name', 'meta_description'];
const TOKEN_DESC_COLUMNS  = ['description'];

// The token hits, for the caller to bound with its own LIMIT. The tick branch is
// driven from index_tickers by its prefix index and joins tokens on tick_id; it is
// an inner join because a token with no ticker row can never match a tick. The
// description branch exists only when an index serves it. Each UNION member carries
// its own LIMIT, in the caller's order, so the union still holds the first `limit`
// hits overall, and UNION (not UNION ALL) keeps a token that matches both branches
// once, as the single OR did. A count reads ids alone; a page also carries the sort
// key (see searchTokenQuery). Never the TEXT tick itself: a TEXT column in a derived
// table or a sorted join forces an on-disk temporary table.
function tokenHitsQuery(descIndexed, limit, forPage){
    const cols     = forPage ? 't1.id, LEFT(t2.tick, 200) AS tick_key' : 't1.id';
    const orderBy  = forPage ? ' ORDER BY tick_key ASC' : '';
    const tickHits = `SELECT ${cols} FROM index_tickers t2 INNER JOIN tokens t1 ON (t1.tick_id=t2.id) WHERE t2.tick LIKE ?`;
    if(!descIndexed)
        return tickHits + orderBy;
    const descHits = `SELECT ${cols} FROM tokens t1 LEFT JOIN index_tickers t2 ON (t2.id=t1.tick_id) WHERE t1.description LIKE ?`;
    return `(${tickHits}${orderBy} LIMIT ${limit}) UNION (${descHits}${orderBy} LIMIT ${limit})`;
}

// Build bounded panel counts. The contract panel joins the list only when its
// sanitized FULLTEXT term survived and its index exists, so an operator-only term
// or an unindexed replica counts zero contracts without running a match nobody can
// serve.
function searchCountQueries(search, ftTerm, indexes){
    let tokenArgs = indexes.tokenDescription ? [search, search] : [search];
    let byType = {
        address:     { query: `SELECT 1 FROM index_addresses WHERE address LIKE ?`, args: [search] },
        transaction: { query: `SELECT 1 FROM transactions t1 LEFT JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id) WHERE t2.hash LIKE ?`, args: [search] },
        broadcast:   { query: `SELECT 1 FROM broadcasts b LEFT JOIN index_memos m ON (m.id=b.memo_id) WHERE b.message LIKE ? OR m.memo LIKE ?`, args: [search, search] },
        token:       { query: tokenHitsQuery(indexes.tokenDescription, 100, false), args: tokenArgs },
        contract:    { query: `SELECT 1 FROM contracts m WHERE MATCH (m.meta_name, m.meta_description) AGAINST (? IN BOOLEAN MODE)`, args: [ftTerm] }
    };
    if(ftTerm === '' || !indexes.contractFulltext) delete byType.contract;
    return Object.keys(byType).map((type) => ({
        type,
        query: `SELECT COUNT(*) AS count FROM (${byType[type].query} LIMIT 100) bounded_matches`,
        args: byType[type].args
    }));
}

// Ask the probe which optional indexes this replica carries. The contract probe is
// skipped when the term sanitized to nothing, since no MATCH would run anyway.
async function searchIndexes(db, config, ftTerm){
    let [contractFulltext, tokenDescription] = await Promise.all([
        ftTerm === '' ? false : indexPresent(db, config, 'contracts', CONTRACT_FT_COLUMNS, true),
        indexPresent(db, config, 'tokens', TOKEN_DESC_COLUMNS, false)
    ]);
    return { contractFulltext, tokenDescription };
}

// A contract MATCH that still raises 1191 means the index went away after the probe
// answered; record that so the next search skips the statement. Any other error,
// and any error from another panel, propagates.
function absorbMissingFulltext(db, config, type, error){
    if(type !== 'contract' || !isMissingFulltextError(error))
        throw error;
    setIndexAbsent(db, config, 'contracts', CONTRACT_FT_COLUMNS, true);
}

async function runSearchCounts(db, config, countQueries){
    let settled = await Promise.allSettled(countQueries.map(q => db.doQuery(config, q.query, q.args)));
    let countResults = [];
    for(let i = 0; i < settled.length; i++){
        let result = settled[i];
        if(result.status === 'fulfilled'){
            countResults.push(result.value);
            continue;
        }
        absorbMissingFulltext(db, config, countQueries[i].type, result.reason);
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
function searchPageArgs(dataType, search, ftTerm, indexes){
    let args  = [search];
    if(dataType=='broadcast' || (dataType=='token' && indexes.tokenDescription))
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

// The token page. Tick-only, it reads straight off the tick prefix index; with the
// description branch, the bounded hit ids are joined back to tokens and tickers for
// the column list and ordered once more, since a UNION carries no order of its own.
// The sort key is LEFT(tick, 200), a VARCHAR the derived table can hold in memory
// and that sorts exactly as tick does, because index_tickers holds tick(200) UNIQUE
// under a binary collation; sorting on the derived table alone also spares the
// outer join a temporary table.
function searchTokenQuery(searchLimit, descIndexed){
    if(!descIndexed)
        return `SELECT
                            t2.tick,
                            t1.description
                        FROM
                            index_tickers t2
                            INNER JOIN tokens t1 ON (t1.tick_id=t2.id)
                        WHERE
                            t2.tick LIKE ?
                        ORDER BY t2.tick ASC
                        LIMIT ` + searchLimit;
    return `SELECT
                            t2.tick,
                            t1.description
                        FROM
                            (${tokenHitsQuery(true, searchLimit, true)}) hits
                            INNER JOIN tokens        t1 ON (t1.id=hits.id)
                            LEFT  JOIN index_tickers t2 ON (t2.id=t1.tick_id)
                        ORDER BY hits.tick_key ASC
                        LIMIT ` + searchLimit;
}

// The two remaining panels, given whatever the LIKE panels resolved to: tokens,
// and contracts through the FULLTEXT match.
function searchNamedQuery(dataType, searchLimit, query, indexes){
    if(dataType=='token')
        query = searchTokenQuery(searchLimit, indexes.tokenDescription);
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

async function runSearchPage(db, config, page, data, total){
    let { dataType, searchLimit, search, ftTerm, indexes } = page;
    let args  = searchPageArgs(dataType, search, ftTerm, indexes);
    let query = searchNamedQuery(dataType, searchLimit, searchLikeQuery(dataType, searchLimit), indexes);
    if(!query)
        return total;
    try {
        let results = await db.doQuery(config, query, args);
        if(results && results.length)
            data.data = results;
    } catch(error){
        absorbMissingFulltext(db, config, dataType, error);
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
        // only operator characters, which leaves the contract total at zero, as does
        // a replica that does not carry the index.
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
        let indexes      = await searchIndexes(this, config, ftTerm);
        let countQueries = searchCountQueries(search, ftTerm, indexes);
        let countResults = await runSearchCounts(this, config, countQueries);
        total = applySearchCounts(data, countQueries, countResults, dataType);
        if(total)
            total = await runSearchPage(this, config, { dataType, searchLimit, search, ftTerm, indexes }, data, total);
        return [data, null, total]
    }
}

module.exports = SearchReaders.prototype;
