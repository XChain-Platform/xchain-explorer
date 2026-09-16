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
 * XChain Explorer - the data-WHERE builder every reader's filter goes through
 *
 * One part of src/db/query_sql.js (the entry composes it through
 * composeReaderParts). getQueryWhereSql was one long switch per method; it is
 * now a dispatcher over a method-keyed table of clause builders, grouped by
 * family into three sibling files:
 *
 *   - where_anchors.js          the first term of the clause, per method
 *   - where_action_clauses.js   the actions chain: history, markets, tokens,
 *                               and the GENERIC address/block/contract/token
 *                               lanes every method without a builder falls to
 *   - where_mirror_clauses.js   standalone and hub-mirrored tables
 *   - where_vote_clauses.js     polls, votes and bets
 *
 * The dispatch is exactly what the `else if` chain did: a method's own builder
 * answers for it, and only a method with no builder (getBlocks excepted, which
 * has no filter beyond its anchor) takes the generic lanes. A builder is handed
 * the anchor and returns the WHOLE clause, because two methods reassign it
 * rather than append to it.
 *
 * Authored as a class body whose prototype is exported, like every other family
 * under src/db/: `this` is the Database instance at call time.
 *
 ********************************************************************/

'use strict';

const { whereAnchor } = require('./where_anchors.js');
const { ACTION_CLAUSE_BUILDERS, genericClause } = require('./where_action_clauses.js');
const { MIRROR_CLAUSE_BUILDERS } = require('./where_mirror_clauses.js');
const { VOTE_CLAUSE_BUILDERS } = require('./where_vote_clauses.js');

// One lookup over the three family tables. Built once at require time, and by
// Object.assign rather than by three lookups per call, so a method that two
// families both claimed would be visible here as a silent overwrite rather than
// as a resolution that depends on which table is consulted first.
const CLAUSE_BUILDERS = Object.assign({}, ACTION_CLAUSE_BUILDERS,
    MIRROR_CLAUSE_BUILDERS, VOTE_CLAUSE_BUILDERS);

// Read through hasOwnProperty for the same reason whereAnchor does: the method
// name is a plain string off the request, and an inherited Object.prototype key
// must not resolve to something callable.
function clauseBuilder(method){
    return (Object.prototype.hasOwnProperty.call(CLAUSE_BUILDERS, method))
        ? CLAUSE_BUILDERS[method]
        : null;
}

class QueryWhereClauses {
    async getQueryWhereSql(config){
        let method = config.data.method;
        // Contract custody lives in the standard `balances` table keyed by the
        // contract's derived address C:<CHAIN>:<action_index> (the legacy
        // contract_balances table was removed), so filter by that address like a
        // normal balance lookup. Early-return so the type=='contract' branch
        // below doesn't append a contract_index clause balances has no column for.
        if(method=='getContractBalance')
            return `m.address_id IS NOT NULL AND a2.address=?`;
        let sql   = whereAnchor(method);
        let build = clauseBuilder(method);
        if(build)
            return build(this, config, sql);
        // getBlocks is the one list with no filter of its own: its anchor IS the
        // whole clause, which is why the chain this dispatcher replaces excluded
        // it from the generic lanes by name.
        if(['getBlocks'].includes(method))
            return sql;
        return genericClause(this, config, sql);
    }
}

module.exports = QueryWhereClauses.prototype;
