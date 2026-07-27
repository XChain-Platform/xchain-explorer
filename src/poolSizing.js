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
 * XChain Explorer - Per-dbType connection pool sizing
 *
 * setupConnectionPools opens one pool per coin/network for the indexer DB and,
 * when the decoder DB has its own credentials (the xchain-node install shape,
 * which provisions a user per service), a second pool for the decoder DB. The
 * two carry very different loads:
 *
 *   indexer     - every page render: blocks, actions, addresses, balances.
 *   decoder     - status tip, mempool page, raw FILE bytes.
 *   hub-mirror  - the mirror writer's own small pool (hub-mirror-pool.js).
 *
 * The sizes used to be literals in db.js, so an operator whose decoder-backed
 * views (mempool, FILE serving) were queueing behind a 3-connection pool had no
 * knob at all. Each dbType now resolves independently:
 *
 *   1. DB_POOL_SIZE_<DBTYPE>   e.g. DB_POOL_SIZE_INDEXER, DB_POOL_SIZE_DECODER
 *   2. DB_POOL_SIZE            legacy flat value, applies to every dbType
 *   3. the per-dbType default below
 *
 * Budget note: the explorer opens a pool per coin/network, so 9 coin/networks
 * at the indexer default is 90 connections. MAX_POOL_SIZE keeps a mis-set
 * override from multiplying past the server's max_connections.
 *
 ********************************************************************/

const DEFAULT_POOL_SIZE = {
    indexer:      10,
    decoder:      5,
    'hub-mirror': 3
};

const MIN_POOL_SIZE = 1;
const MAX_POOL_SIZE = 50;

function normalizeDbType(dbType){
    return String(dbType || 'indexer').trim().toLowerCase();
}

// `<name>_<DBTYPE>` wins over the bare `<name>`; both must be non-empty to
// count. Dashes in a dbType become underscores so 'hub-mirror' maps to
// DB_POOL_SIZE_HUB_MIRROR.
function readEnvOverride(name, dbType, env){
    let source = env || process.env;
    let suffix = normalizeDbType(dbType).toUpperCase().replace(/-/g, '_');
    let scoped = source[name + '_' + suffix];
    if(scoped !== undefined && String(scoped).trim() !== '') return scoped;
    let flat = source[name];
    if(flat !== undefined && String(flat).trim() !== '') return flat;
    return undefined;
}

function parsePositiveInt(raw){
    if(raw === undefined) return null;
    let parsed = parseInt(raw, 10);
    if(!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
}

// Resolve the connection limit for one dbType. Malformed values fall back to
// the default rather than becoming NaN in the pool config; out-of-range values
// are clamped so no single setting can exhaust the server's connections.
function resolvePoolSize(dbType, env){
    let type   = normalizeDbType(dbType);
    let parsed = parsePositiveInt(readEnvOverride('DB_POOL_SIZE', type, env));
    let wanted = parsed === null ? (DEFAULT_POOL_SIZE[type] || DEFAULT_POOL_SIZE.indexer) : parsed;
    return Math.max(MIN_POOL_SIZE, Math.min(MAX_POOL_SIZE, wanted));
}

// Query timeout, resolvable per dbType with the same precedence.
function resolveQueryTimeout(dbType, env){
    return parsePositiveInt(readEnvOverride('DB_QUERY_TIMEOUT', normalizeDbType(dbType), env)) || 30000;
}

module.exports = {
    DEFAULT_POOL_SIZE,
    MIN_POOL_SIZE,
    MAX_POOL_SIZE,
    normalizeDbType,
    resolvePoolSize,
    resolveQueryTimeout
};
