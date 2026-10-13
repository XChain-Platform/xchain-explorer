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
 * XChain Explorer - dropping display-only joins from a list COUNT
 *
 * One part of src/db/query_sql.js: the list readers build their COUNT from the
 * same FROM as their page query, so it carries every LEFT JOIN the page needs
 * only for display columns (memo, status, tx hash, ticker names). On the large
 * coins that FROM costs hundreds of milliseconds per count while the base table
 * counts in a few. pruneCountJoins removes a LEFT JOIN exactly when removing it
 * cannot change the count:
 *
 *   - it is a LEFT JOIN, so it never drops a row of the base table;
 *   - its ON is one equality on a key that is unique in the joined table, so it
 *     never duplicates a row either;
 *   - nothing left in the statement names its alias: not the count expression,
 *     not the WHERE, not the ON of a join that stays.
 *
 * Every INNER JOIN stays, because an inner join can drop rows. Anything the
 * parser does not recognise leaves the statement untouched, which is always
 * correct and only forgoes the saving.
 *
 * Plain functions with no Database dependency.
 *
 ********************************************************************/

'use strict';

// Joined tables whose ON key is unique, per the indexer DDL: the index_* tables
// are keyed by an id PRIMARY KEY, and transactions(tx_index) and
// actions(action_index) carry UNIQUE indexes. blocks(block_index) is a plain
// index and is deliberately absent.
const UNIQUE_JOIN_KEYS = {
    actions:            'action_index',
    transactions:       'tx_index',
    index_actions:      'id',
    index_addresses:    'id',
    index_coins:        'id',
    index_fiats:        'id',
    index_memos:        'id',
    index_mime_types:   'id',
    index_pubkeys:      'id',
    index_statuses:     'id',
    index_tickers:      'id',
    index_transactions: 'id'
};

const HEAD_RE = /^\s*SELECT\s+(count\((?:\*|DISTINCT\s+[\w.]+)\))\s+as\s+total\s+FROM\s+([\w.$]+)\s+(\w+)\s+/i;
const JOIN_RE = /^(INNER|LEFT)\s+JOIN\s+([\w.$]+)\s+(\w+)\s+ON\s*\(/i;
const ON_KEY_RE = /^\s*(\w+)\.(\w+)\s*=\s*([\s\S]+?)\s*$/;

// A comparison on an unqualified column. Its table cannot be read from the text,
// so a WHERE holding one keeps every join.
const BARE_COLUMN_RE = /(?:^|[^\w.'"`])([A-Za-z_]\w*)\s*(?:=|<>|!=|<=|>=|<|>|\s(?:NOT\s+)?(?:IS|IN|LIKE|BETWEEN|REGEXP)\b)/gi;
const SQL_WORDS = new Set(['AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE', 'IS', 'IN', 'LIKE', 'BINARY']);

// Index of the parenthesis closing the one at `open`, skipping quoted text, or
// -1 when the statement ends first.
function closingParen(sql, open){
    let depth = 0;
    let quote = null;
    for(let i = open; i < sql.length; i++){
        const ch = sql[i];
        if(quote){
            if(ch === quote) quote = null;
        } else if(ch === '\'' || ch === '"'){
            quote = ch;
        } else if(ch === '('){
            depth++;
        } else if(ch === ')'){
            depth--;
            if(depth === 0) return i;
        }
    }
    return -1;
}

// Splits a list COUNT into its count expression, base table, joins and WHERE,
// or returns null for any other shape.
function parseCountSql(sql){
    const head = HEAD_RE.exec(sql);
    if(!head) return null;
    let pos = head[0].length;
    const joins = [];
    let m;
    while((m = JOIN_RE.exec(sql.slice(pos)))){
        const open  = pos + m[0].length - 1;
        const close = closingParen(sql, open);
        if(close < 0) return null;
        joins.push({ kind: m[1].toUpperCase(), table: m[2], alias: m[3],
                     on: sql.slice(open + 1, close), text: sql.slice(pos, close + 1) });
        pos = close + 1;
        pos += /^\s*/.exec(sql.slice(pos))[0].length;
    }
    const where = sql.slice(pos);
    if(!/^WHERE\s/i.test(where)) return null;
    return { select: head[1], table: head[2], alias: head[3], joins, where };
}

function namesAlias(text, alias){
    return new RegExp('(?:^|[^\\w.])' + alias + '\\.', 'i').test(text);
}

function hasBareColumn(where){
    for(const m of where.slice(5).matchAll(BARE_COLUMN_RE))
        if(!SQL_WORDS.has(m[1].toUpperCase())) return true;
    return false;
}

// The WHERE shapes the reference scan can read reliably: no subquery (whose
// own names could shadow an outer alias), no quoted identifiers, no UNION.
function whereIsReadable(where){
    return !/\bSELECT\b|\bUNION\b|`/i.test(where) && !hasBareColumn(where);
}

function droppableJoin(join){
    if(join.kind !== 'LEFT' || join.on.includes('?')) return false;
    const key = UNIQUE_JOIN_KEYS[join.table];
    const on  = ON_KEY_RE.exec(join.on);
    if(!key || !on || on[1] !== join.alias || on[2] !== key) return false;
    return !namesAlias(on[3], join.alias) && !/\b(?:AND|OR)\b/i.test(on[3]);
}

// The joins left once every droppable join no remaining text names is removed.
// Repeats until nothing changes, since dropping one join can free the join its
// ON referenced (a2's COALESCE over t1 is what keeps t1).
function keptJoins(parsed){
    let kept = parsed.joins.slice();
    let dropped = true;
    while(dropped){
        dropped = false;
        for(const join of kept){
            if(!droppableJoin(join)) continue;
            const others = [parsed.select, parsed.where].concat(kept.filter(j => j !== join).map(j => j.on));
            if(others.some(text => namesAlias(text, join.alias))) continue;
            kept = kept.filter(j => j !== join);
            dropped = true;
            break;
        }
    }
    return kept;
}

// Returns the COUNT with every count-neutral LEFT JOIN removed, or the input
// string itself when nothing can be removed or the shape is not recognised.
function pruneCountJoins(sql){
    if(typeof sql !== 'string') return sql;
    const parsed = parseCountSql(sql);
    if(!parsed || !whereIsReadable(parsed.where)) return sql;
    const kept = keptJoins(parsed);
    if(kept.length === parsed.joins.length) return sql;
    return ['SELECT ' + parsed.select + ' as total FROM ' + parsed.table + ' ' + parsed.alias]
        .concat(kept.map(j => j.text), [parsed.where]).join(' ');
}

module.exports = { UNIQUE_JOIN_KEYS, parseCountSql, pruneCountJoins };
