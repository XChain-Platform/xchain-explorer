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
 *
 * XChain Explorer - WHERE clauses for consensus and lifecycle lists
 *
 ********************************************************************/

'use strict';

const { sourceAddressClause } = require('./where_source_lanes.js');  // indexed action-source predicate where the reader joins a2 on the action source

function protocolLifecycleClause(db, config, sql){
    let type = config.data.type;
    if(type=='block')   sql += ' AND a1.block_index=?';
    if(type=='address') sql += sourceAddressClause(config);
    return sql;
}

function rollcallsClause(db, config, sql){
    let type = config.data.type;
    if(type=='block')   sql += ' AND m.block_index=?';
    if(type=='address') sql += sourceAddressClause(config);
    return sql;
}

function xexecsClause(db, config, sql){
    if(config.data.type=='block') sql += ' AND m.block_index=?';
    return sql;
}

function xbridgesClause(db, config, sql){
    let type = config.data.type;
    if(type=='block')   sql += ' AND m.block_index=?';
    if(type=='address') sql += ' AND (a2.address=? OR xd.address=? OR bs.dest_address=?)';
    if(type=='token')   sql += ' AND (xt.tick=? OR bs.tick=?)';
    return sql;
}

const PROTOCOL_CLAUSE_BUILDERS = {
    getRollcalls:   rollcallsClause,
    getXexecs:      xexecsClause,
    getBetExpires:  protocolLifecycleClause,
    getBetCancels:  protocolLifecycleClause,
    getBetEdits:    protocolLifecycleClause,
    getBetResolves: protocolLifecycleClause,
    getXbridges:    xbridgesClause
};

module.exports = { PROTOCOL_CLAUSE_BUILDERS };
