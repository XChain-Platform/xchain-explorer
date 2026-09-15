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
 * XChain Explorer - the data read a route named
 *
 * One call into the database reader the matched route names, and the two ways it
 * can fail: a parameter the reader declined to bind, which is the caller's fault
 * and answers 400, and a read that genuinely failed, which answers 500 rather than
 * letting an outage read as an empty ledger.
 *
 ********************************************************************/

'use strict';

// Module-scope logger, not a method on the class these stages serve: the failed-query line
// reaches the shipper api.js installs, exactly as it did inline.
const { getLogger } = require('../../observability');
const log = getLogger();

/**
 * Run the reader this request resolved to, recording either its rows or its failure.
 */
async function loadData(explorer, req, st){
    let response = st.response;
    try {
        [st.data, st.total] = await explorer.db.getData(st.cfg);
    } catch(e){
        if(e && e.name === 'DbInputError'){
            // The CALLER's parameter was malformed, not the service: a
            // reader declined to bind it (db/index.js DbInputError)
            // rather than let MariaDB coerce it and answer with the
            // wrong record. Matched on `name` rather than instanceof so
            // a stubbed db module in tests behaves the same way.
            st.badParam   = true;
            response.code = 400;
            response.json = { error: e.message, code: e.code || 'INVALID_PARAMETER' };
        } else {
            // A read that genuinely failed (DB outage / rejected query)
            // throws (db/index.js DbQueryError, M-4); answer 5xx instead of a
            // misleading empty 200. A successful empty SELECT does not
            // throw and still returns 200 with total:0.
            log.error('PROCESS_REQUEST_QUERY_FAILED', { path: req.path, err: e && e.message ? e.message : e });
            st.dbError    = true;
            response.code = 500;
            response.json = { error: 'A database error occurred while serving this request.', code: 'DB_ERROR' };
        }
    }
}

module.exports = { loadData };
