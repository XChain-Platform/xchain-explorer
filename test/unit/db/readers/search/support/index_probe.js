/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 * The schema index probe as a getSearch doQuery stub sees it. getSearch asks
 * information_schema.STATISTICS which optional indexes the replica carries before
 * it builds a single panel query, so every stub that drives getSearch answers that
 * probe here and hands every other statement to the test's own fake.
 *********************************************************************/

'use strict';

// The contracts FULLTEXT index the indexer declares (contracts.sql meta_search).
const CONTRACT_FULLTEXT_ROWS = [
    { INDEX_NAME: 'meta_search', INDEX_TYPE: 'FULLTEXT', COLUMN_NAME: 'meta_name',        SEQ_IN_INDEX: 1 },
    { INDEX_NAME: 'meta_search', INDEX_TYPE: 'FULLTEXT', COLUMN_NAME: 'meta_description', SEQ_IN_INDEX: 2 }
];

// A B-tree index leading with tokens.description, which the indexer does not declare.
const TOKEN_DESCRIPTION_ROWS = [
    { INDEX_NAME: 'description', INDEX_TYPE: 'BTREE', COLUMN_NAME: 'description', SEQ_IN_INDEX: 1 }
];

// The tokens index that always exists, so a token probe never reads an empty table.
const TOKEN_BASE_ROWS = [
    { INDEX_NAME: 'tick_id', INDEX_TYPE: 'BTREE', COLUMN_NAME: 'tick_id', SEQ_IN_INDEX: 1 }
];

function isIndexProbe(query){
    return /information_schema\.STATISTICS/.test(String(query));
}

// The STATISTICS rows for one probed table under the given index set.
function probeRows(table, indexes){
    if(table === 'contracts') return indexes.contractFulltext ? CONTRACT_FULLTEXT_ROWS : [];
    if(table === 'tokens')    return TOKEN_BASE_ROWS.concat(indexes.tokenDescription ? TOKEN_DESCRIPTION_ROWS : []);
    return [];
}

// Wrap a doQuery fake so the index probe is answered from `indexes` and never
// reaches the fake, which keeps a fake that counts its calls counting panel queries
// only. The default is the indexer's declared schema: the contracts FULLTEXT index
// present, no description index on tokens.
function withIndexProbe(fake, indexes){
    const set = Object.assign({ contractFulltext: true, tokenDescription: false }, indexes || {});
    return async function(config, query, args){
        if(isIndexProbe(query)) return probeRows(args && args[0], set);
        return fake.apply(this, arguments);
    };
}

// The stub's calls with the probe filtered out.
function panelCalls(stub){
    return stub.getCalls().filter(call => !isIndexProbe(call.args[1]));
}

module.exports = { withIndexProbe, panelCalls, isIndexProbe };
