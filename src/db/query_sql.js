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
 * XChain Explorer - the generic query layer
 *
 * Proposal B stage 2: the two entry points every reader goes through (getData
 * for a shaped, cacheable page and getQuery for the raw pair), the WHERE and
 * OFFSET builders they call, and the limit helpers that clamp what a caller may
 * ask for. Nothing here knows what an action, a token or a checkpoint is: the
 * readers hand it a method name and a config and it hands back SQL.
 *
 * The builders are one long switch per concern on purpose. A cursor column or a
 * filter predicate that disagrees with the list query it pages is not a crash,
 * it is a page that silently resets to the newest row, so both live where they
 * can be read against each other.
 *
 * HOW THIS ATTACHES
 *
 * The methods are authored as a class body and exported as that class's
 * prototype, so db/index.js can copy them onto Database.prototype verbatim. Nothing
 * here is ever instantiated: `this` is the Database instance at call time,
 * exactly as it was when these methods sat inline, so every helper
 * (this.doQuery, this.util, this.explorer, ...) resolves the same way and no
 * caller changed. An object literal would have needed a comma between every
 * method, which turns a pure move into a diff nobody can read.
 *
 ********************************************************************/

'use strict';

const { TERMINAL_OFFER_STATUSES } = require('../action-detail/shared.js');

class QueryBuilder {
    /******************************************************************
     * General database functions
     *****************************************************************/

    async getData(config){
        let data  = [];
        let total = null;

        // Short-TTL result cache for the unauthenticated filesort-heavy list paths.
        // getHolders sorts by ABS(amount) on a VARCHAR column,
        // getBalances sorts by tick across a balances/tokens join, and getTokens is a
        // multi-table join whose token/subtoken search is a leading-% LIKE: none of
        // these have an index-only path, so each call to the public /api or /explorer
        // route is a full filesort and a cheap DoS-amplification vector. A small
        // per-request-shape cache collapses a request burst into one query. The key
        // carries the coin's current tip so a cached answer can never outlive the
        // block it was read at (see resultCacheGeneration); the TTL is a ceiling on
        // top of that, and each map is size-capped (oldest-evicted) so the cache
        // itself cannot grow unbounded. The key is built from the raw request
        // inputs (search, type, and every pagination/order query param) BEFORE
        // getQuery derives the SQL, so distinct pages/orders never collide.
        const RESULT_CACHES = {
            getHolders:  ['_holdersCache',  'EXPLORER_HOLDERS_CACHE'],
            getTokens:   ['_tokensCache',   'EXPLORER_TOKENS_CACHE'],
            getBalances: ['_balancesCache', 'EXPLORER_BALANCES_CACHE']
        };
        let cacheName = null;
        let cacheKey  = null;
        if(RESULT_CACHES[config.data.method]){
            let envPrefix;
            [cacheName, envPrefix] = RESULT_CACHES[config.data.method];
            const q = config.data.query || {};
            // Include the per-coin reorg generation (M-3) so a detected reorg
            // makes every pre-reorg result-cache entry unreachable instead of
            // serving reassigned-id rows until the TTL expires, and the coin's
            // current tip so a block that moves the underlying rows does the same
            // A null generation means the tip probe failed; leave
            // cacheKey null so this request neither reads nor writes the cache.
            const gen = await this.resultCacheGeneration(config);
            if(gen === null){
                cacheName = null;
            } else {
                cacheKey = [config.coin, this._reorgGen[config.coin] || 0, gen,
                            config.type, config.data.type, config.data.search,
                            q.page, q.limit, q.sortorder, q.offset, q.start, q.length, q.action].join('|');
                const ttl = parseInt(this.configInfo.env[envPrefix + '_MS'], 10) || 15000;
                if(!this[cacheName]) this[cacheName] = new Map();
                const hit = this[cacheName].get(cacheKey);
                if(hit && (Date.now() - hit.at) < ttl)
                    return [hit.data, hit.total];
            }
        }

        let [query, args, count] = await this.getQuery(config);
        if(typeof query === 'object'){
            data = query;
            if(this.util.isNumeric(count))
                total = count;
        } else {
            // Align the data-WHERE bind args with their placeholders. getQueryWhereSql only
            // adds a data-WHERE placeholder when a TYPE (address/token/block/...) is set, so a
            // pure list-all request (no QUERY and no TYPE) has none. Many action methods still
            // seed args=[config.data.search] (= [undefined] here); that phantom prepends to the
            // offset args, shifting `m.action_index < ?` to bind NULL and returning zero rows.
            // Drop the phantom for pure list-all so only the offset args remain. Typed requests
            // (search and/or a resource type present) keep the method's args, or the
            // single-search fallback.
            //
            // The phantom is dropped by VALUE, not by discarding the whole array: a method can
            // add a placeholder of its own that has nothing to do with search or type, and
            // discarding its args left that placeholder unbound. getCrossChainMatches appends
            // `AND m.network = ?` on every request, so a bare
            // GET /{COIN}/api/cross_chain_matches answered 500 "Parameter at position 1 is not
            // set" on any install with the mandatory checkpoint schema actually configured.
            // On the list-all path the seeded search is null/undefined by construction, so
            // filtering nulls removes exactly the phantom and nothing a method meant to bind.
            let baseArgs;
            let listAll = !config.data.search && !config.data.type;
            if(Array.isArray(args))
                baseArgs = listAll ? args.filter(a => !this.util.isNull(a)) : args;
            else if(listAll)
                baseArgs = [];
            else if(args && typeof args === 'object')
                baseArgs = args;
            else
                baseArgs = this.util.isNull(config.data.search) ? [] : [config.data.search];
            let queryArgs = [...baseArgs];
            let offsetArgs = config.data.sql.where.offsetArgs;
            if(offsetArgs && offsetArgs.length)
                queryArgs.push(...offsetArgs);
            // Append SQL OFFSET for API pagination (page > 1)
            if(config.type == 'api' && config.data.sql.apiOffset > 0){
                query += ' OFFSET ?';
                queryArgs.push(config.data.sql.apiOffset);
            }
            if(query!='')
                data = await this.doQuery(config, query, queryArgs);
            // Count query uses only base args (no offset/limit placeholders)
            if(count){
                let rows = await this.doQuery(config, count, baseArgs);
                total = (rows) ? Number(rows[0].total) : 0;
            }
        }
        // A dispenser list lane with no escrow leaves a client listing
        // dispensers unable to say how full any of them is, so give_escrow
        // comes back with the row and the live remainder is derived here
        // through the same shared method the per-action detail path uses (one
        // batched pass for the whole page, not a query per row).
        if(config.data.method=='getDispensers' && Array.isArray(data) && data.length){
            let idxs   = data.map((r) => r.action_index);
            let escrow = await this.getDispenserEscrowBatch(config, idxs);
            // The row's own `status` is the CREATE action's validity and never
            // moves off 'valid', so a listing could not tell an open dispenser
            // from a cancelled one - and the escrow arithmetic above only nets
            // out fills, so a cancelled/expired dispenser (escrow refunded by
            // the terminal action) kept listing its full balance. Serve the
            // lifecycle beside the validity under the same `current_status` key
            // the detail path uses, and apply the detail path's terminal rule.
            let status = await this.getDispenserCurrentStatusBatch(config, idxs);
            for(let row of data){
                let entry = escrow[String(row.action_index)];
                row.escrow_remaining = (entry) ? entry.escrow_remaining : null;
                row.current_status   = status[String(row.action_index)] || null;
                if(TERMINAL_OFFER_STATUSES.includes(String(row.current_status)))
                    row.escrow_remaining = '0';
            }
        }
        // Contract list rows carry the same identity shape the single-contract route
        // serves: three flat meta_* columns plus the parsed `meta` object. Done here
        // rather than in getContracts because that method returns SQL, not rows.
        if(config.data.method=='getContracts' && Array.isArray(data) && data.length){
            for(let row of data)
                this.attachContractMeta(row);
        }
        // /validators stays the ONE validator table (no second federation-registry
        // page), so every on-chain active-set row also carries the hub registry's view of
        // the same signing pubkey: network addr, served chains, registration status. One
        // registry read serves the whole page, not a lookup per row. A pubkey the hub does
        // not list is 'unregistered'; a deployment with no reachable hub registry leaves
        // all three null, which the page renders as unknown rather than as unregistered.
        if(config.data.method=='getValidators' && Array.isArray(data) && data.length){
            let registry = await this.getFederationRegistry(config);
            for(let row of data){
                let entry = (registry && !this.util.isNull(row.signing_pubkey))
                    ? registry[String(row.signing_pubkey).toLowerCase()]
                    : null;
                row.hub_addr   = (entry) ? entry.addr   : null;
                row.hub_chains = (entry) ? entry.chains : null;
                row.hub_status = (entry) ? entry.status : (registry ? 'unregistered' : null);
            }
        }
        // Populate the result cache. Cap each map and evict the oldest entry on
        // overflow so a flood of distinct ticks/addresses/pages cannot grow the
        // cache without bound.
        if(cacheKey !== null){
            const envPrefix = RESULT_CACHES[config.data.method][1];
            const MAX = parseInt(this.configInfo.env[envPrefix + '_MAX'], 10) || 500;
            if(this[cacheName].size >= MAX)
                this[cacheName].delete(this[cacheName].keys().next().value);
            this[cacheName].set(cacheKey, { at: Date.now(), data, total });
        }
        return [data, total];
    }

    async getQuery(config){
        let count = '';
        let query = '';
        let args  = null;
        let data  = config.data;
        let q     = (data.query) ? data.query : false;
        let max   = this.getMaxMethodResults(data.method);
        let limit = (q && q.limit && this.util.isInteger(Number(q.limit))) ? q.limit : max;
        limit = Math.max(1, Math.min(Number(limit), max));
        let default_order = (['getBalances'].includes(data.method)) ? 'ASC' : 'DESC';
        let order         = (q && q.sortorder && ['ASC','DESC'].includes(String(q.sortorder).toUpperCase())) ? String(q.sortorder).toUpperCase() : default_order;
        if(config.type=='api'){
            // Use SQL OFFSET for pagination instead of fetching all preceding pages
            let page  = (q && q.page  && this.util.isInteger(Number(q.page)))  ? q.page  : 1;
            page = Math.max(1, Number(page));
            // Cap the API OFFSET the same way the explorer fetch-and-slice path caps
            // `start` (see the 100k ceiling in the explorer branch below). An uncapped
            // OFFSET lets an unauthenticated request with a huge `page` force MariaDB to
            // join/order/skip a full-table row set for a single zero-row page
            // (query-complexity DoS); the list routes are multi-table joins. Deep
            // browsing uses the cursor next/prev path, so a 100k ceiling is invisible
            // to legitimate use while killing the scan blow-up.
            config.data.sql.apiOffset = Math.min((page - 1) * limit, 100000);
        }
        if(config.type=='explorer'){
            let offset = (q.offset) ? q.offset : false;
            let start  = (q.start) ? q.start : 0;
            let length = (q.length) ? q.length : 10;
            let action = (q.action) ? q.action : false;
            // Same Number.isFinite fallback `length` and `total` already carry, and for
            // the same reason: a non-numeric or repeated `?start=` is NaN, Math.max(0,NaN)
            // is NaN, and the fetch-and-slice branch below concatenates it into the LIMIT
            // clause as `LIMIT NaN` (a rejected query, so 5xx on an unauthenticated read
            // route). Fall back to 0, not to the 100000 ceiling: the row slice reads the
            // RAW query.start, so a page fetched for an unusable start is discarded anyway.
            start  = Number(start);
            if(!Number.isFinite(start)) start = 0;
            start  = Math.max(0, start);
            if(!Number.isFinite(Number(length))) length = 10;
            length = Math.max(1, Math.min(Number(length), max));
            if(['getHolders','getBalances'].includes(data.method) && ['prev','last'].includes(action))
                config.data.query.action = config.data.offset.action = action = 'next';
            limit = length;
            if(limit > max)
                limit = max;
            // Size the jump-to-last page from the client's own record total, but clamp
            // it to the same per-method max the branches above enforce. `total` and
            // `start` are raw query-string input, so without the clamp
            // `?action=last&total=1e15` reached the LIMIT clause verbatim (full-table
            // scan on an unauthenticated list route) and a missing, non-numeric, or
            // repeated `total` emitted `LIMIT NaN` as a 500. A real last page never
            // exceeds one page of rows, so the ceiling is invisible to the UI; an
            // unusable total falls back to the already-clamped page length.
            if(action=='last'){
                let tail = Number(config.data.query.total) - Number(start);
                if(Number.isFinite(tail))
                    limit = Math.max(1, Math.min(tail, max));
            }
            // token/subtoken/roster searches paginate by fetch-and-slice (no action_index offsets),
            // so the SQL limit must cover start+length rows. Cap the offset fed to the
            // SQL LIMIT: without a bound, an unauthenticated request with a huge `start`
            // forces MariaDB to scan start+length rows for a single page (query-complexity
            // DoS). Deep browsing uses the cursor next/prev path, not raw offsets, so a
            // 100k ceiling is invisible to legitimate use while killing the scan blow-up.
            if(['getBalances', 'getHolders','getSearch','getProjectTokens'].includes(data.method) ||
                (data.method=='getTokens' && ['token','subtoken'].includes(data.type)))
                limit = this.util.bcadd(Math.min(start, 100000), length);
            if(['prev','last'].includes(action))
                order = 'ASC';
            let [offset1, offset2] = await this.getQueryOffsets(config, offset, limit);
            config.data.offset.start = offset1;
            config.data.offset.stop  = offset2;
            let [offsetSql, offsetArgs] = await this.getQueryOffsetSql(config);
            config.data.sql.where.offset     = offsetSql;
            config.data.sql.where.offsetArgs = offsetArgs;
        }
        config.data.sql.where.data = await this.getQueryWhereSql(config);
        config.data.sql.order = order
        config.data.sql.limit = limit;
        if(typeof this[data.method] === 'function')
            [query, args, count] = await this[data.method](config);
        return [query, args, count];
    }

    async getQueryWhereSql(config){
        // The base predicate is a WHERE ANCHOR: callers append ` AND ...`
        // fragments, so the clause always needs a first term. On mappings_actions
        // and mappings_files action_index is declared NOT NULL, so that anchor is
        // deliberately always-true and filters nothing; the address_id and
        // block_index branches below anchor on nullable columns and do drop
        // orphan rows. Do not read either as a state filter.
        let sql    = `m.action_index IS NOT NULL`;
        let type   = config.data.type;
        let method = config.data.method;
        // Contract custody lives in the standard `balances` table keyed by the
        // contract's derived address C:<CHAIN>:<action_index> (the legacy
        // contract_balances table was removed), so filter by that address like a
        // normal balance lookup. Early-return so the type=='contract' branch
        // below doesn't append a contract_index clause balances has no column for.
        if(method=='getContractBalance')
            return `m.address_id IS NOT NULL AND a2.address=?`;
        if(['getBalances','getHolders'].includes(method))
            sql = `m.address_id IS NOT NULL`;
        if(['getBlocks','getBlock'].includes(method))
            sql = `b1.block_index IS NOT NULL`;
        if(method=='getTransaction')
            sql = `m.tx_index IS NOT NULL`;
        // contract_state is queried via the `cs` alias (+ a latest-per-key subquery
        // that already filters by contract_index); it has no `m` table.
        if(method=='getContractState')
            sql = `cs.id IS NOT NULL`;
        if(['getMarket','getMarkets'].includes(method))
            sql = `m.id IS NOT NULL`;
        // validator_rewards is the per-round accrual ledger; no action_index, keyed by m.id
        if(method=='getValidatorRewards')
            sql = `m.id IS NOT NULL`;
        // slash_events has no action_index; its PK is m.id
        if(method=='getSlashEvents')
            sql = `m.id IS NOT NULL`;
        // capability_slash_events has no action_index of its own; its PK is m.id
        if(method=='getCapabilitySlashEvents')
            sql = `m.id IS NOT NULL`;
        // price_snapshots is a materialized consensus-round table with no action_index; its PK is m.id
        if(method=='getPriceSnapshots')
            sql = `m.id IS NOT NULL`;
        // contract_emissions carries no reliable action_index of its own (it is nullable
        // for internal emissions such as SLASH, which move ledger state without minting a
        // new on-wire action); its PK is m.id
        if(method=='getEmissions')
            sql = `m.id IS NOT NULL`;
        // attest_validator_stats is an upsert-incremented counter rollup with no
        // action_index; it gained a surrogate m.id (xchain-indexer migration
        // 2026-08-19-attest-validator-stats-surrogate-id) precisely so it could be paged
        // on a monotonic AND unique cursor, since last_updated_block ties whenever a
        // whole ATTEST responsible set misses in one block
        if(method=='getAttestValidatorStats')
            sql = `m.id IS NOT NULL`;
        // cross_chain_matches is a standalone mirror of the hub's match table with no action_index; its PK is m.id
        if(method=='getCrossChainMatches')
            sql = `m.id IS NOT NULL`;
        // oracle_prices is the hub-mirrored user-published oracle row table; no action_index, keyed by m.id
        if(method=='getOraclePrices')
            sql = `m.id IS NOT NULL`;
        // state_checkpoints is the hub-mirrored quorum-signed checkpoint table; no
        // action_index, keyed by m.id (the cursor used for paging is m.block_index,
        // set separately in getQueryOffsetSql; this anchor only opens the WHERE clause).
        if(method=='getCheckpoints')
            sql = `m.id IS NOT NULL`;
        // capability_snapshots is the hub-mirrored historical electorate (which signing
        // keys carried which stake weight at a snapshot block); no action_index, keyed by m.id
        if(method=='getCapabilitySnapshots')
            sql = `m.id IS NOT NULL`;
        // anchor_reward_attestations is the hub-mirrored quorum-attested ANCHOR publisher
        // reward record; no action_index, keyed by m.id
        if(method=='getAnchorRewardAttestations')
            sql = `m.id IS NOT NULL`;
        // state_tree_roots is the indexer-local per-block SPV commitment row; no
        // action_index, keyed by m.id (the paging cursor is m.block_index, set separately
        // in getQueryOffsetSql, same shape as getCheckpoints)
        if(method=='getCommitments')
            sql = `m.id IS NOT NULL`;
        // co-located hub capability/governance tables; no action_index, keyed by m.id
        if(['getValidatorCapabilities','getGovernanceProposals','getGovernanceVotes'].includes(method))
            sql = `m.id IS NOT NULL`;
        // reorg_attestations is the hub-mirrored cross-chain reorg record; no action_index,
        // keyed by m.id (same PK-cursor shape as the three tables above)
        if(method=='getReorgs')
            sql = `m.id IS NOT NULL`;
        // slash_proposals is the hub-owned federation slash-evidence table; no
        // action_index, keyed by m.id (same PK-cursor shape as the tables above)
        if(method=='getSlashProposals')
            sql = `m.id IS NOT NULL`;
        // co-located hub operational tables (p2p_peers/consensus_state/configs/telemetry_pings); keyed by m.id
        if(['getPeers','getConsensusState','getConfigs','getTelemetryPings'].includes(method))
            sql = `m.id IS NOT NULL`;
        if(method=='getHistory'){
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
        // Every market predicate matches on COALESCE(ticker, coin), not on the ticker
        // alone: the native side of a token/native pair has no index_tickers row, so
        // t1.tick is NULL there and a bare `t1.tick=?` can never match the coin symbol
        // the caller asked for. The readers join c1/c2 (index_coins) for exactly this.
        } else if(method=='getMarket'){
            sql += ` AND ((COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?) OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?))`;
        } else if(method=='getMarkets'){
            if(type=='token')
                sql += ` AND (COALESCE(t1.tick, c1.coin)=? OR COALESCE(t2.tick, c2.coin)=?)`;
        } else if(['getMarketOrders','getOrderbook','getMarketHistory'].includes(method)){
            sql += ` AND ((COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?) OR (COALESCE(t1.tick, c1.coin)=? AND COALESCE(t2.tick, c2.coin)=?))`;
            if(!this.util.isNull(config.data.search3)){
                if(method=='getMarketHistory'){
                    sql += ' AND (a2.address=? OR a3.address=?)';
                } else {
                    sql += ' AND a2.address=?';
                }
            }
        } else if(method=='getTokens' && ['token','subtoken'].includes(type)){
            sql += ' AND t3.tick LIKE ?';
        } else if(method=='getSlashEvents'){
            // slash_events has no actions/transactions chain; join directly via m.block_index
            // and resolve type=address through the staker's pubkey (signing_pubkey_id).
            if(type=='block')    sql += ' AND m.block_index=?';
            if(type=='contract') sql += ' AND m.target_contract_index=?';
            if(type=='address')  sql += ` AND m.signing_pubkey_id IN (
                SELECT DISTINCT signing_pubkey_id FROM contract_stakes
                WHERE source_id = (SELECT id FROM index_addresses WHERE address=?)
            )`;
        } else if(method=='getCapabilitySlashEvents'){
            // capability_slash_events joins blocks directly; filter by block, capability engine, or pubkey.
            if(type=='block')      sql += ' AND m.block_index=?';
            if(type=='capability') sql += ' AND m.capability=?';
            if(type=='pubkey')     sql += ' AND pk.pubkey=?';
            if(type=='address')    sql += ' AND sub.address=?';
        } else if(method=='getFullNodeVerifications'){
            // full_node_verifications joins the actions/transactions/blocks chain via
            // m.action_index (one row per verified validator). Filter on the verdict's own
            // block (m.block_index), the challenge epoch (m.epoch_height), the verified
            // signing pubkey (pk), or the staking source address (a3, joined on m.source_id).
            if(type=='block')   sql += ' AND m.block_index=?';
            if(type=='epoch')   sql += ' AND m.epoch_height=?';
            if(type=='pubkey')  sql += ' AND pk.pubkey=?';
            if(type=='address') sql += ' AND a3.address=?';
        } else if(method=='getPriceSnapshots'){
            // price_snapshots is a standalone table; filter on its own columns directly
            if(type=='pair')   sql += ' AND m.coin_pair=?';
            if(type=='round')  sql += ' AND m.round_number=?';
            if(type=='status') sql += ' AND m.status=?';
        } else if(method=='getOraclePrices'){
            // oracle_prices is a standalone hub-mirror table; filter on its own columns
            if(type=='token')   sql += ' AND m.tick=?';
            if(type=='address') sql += ' AND m.source_address=?';
        } else if(method=='getAttestValidatorStats'){
            // attest_validator_stats is a standalone counters table; filter on its own
            // unique-key columns directly. No 'block' type: last_updated_block is a
            // mutable "most recently touched" stamp, not a stable per-row block identity,
            // so filtering on it would answer a question that drifts under the caller.
            if(type=='pubkey')   sql += ' AND m.validator_pubkey=?';
            if(type=='provider') sql += ' AND m.provider_id=?';
        } else if(method=='getValidatorCapabilities'){
            if(type=='capability') sql += ' AND m.capability=?';
            if(type=='pubkey')     sql += ' AND m.signing_pubkey=?';
        } else if(method=='getCapabilitySnapshots'){
            // capability_snapshots is the historical electorate: which signing keys
            // carried which stake weight for a capability at a given snapshot block.
            // 'block' answers the row's core question (electorate AT block N);
            // 'capability' and 'pubkey' narrow the other two axes.
            if(type=='block')      sql += ' AND m.snapshot_block=?';
            if(type=='capability') sql += ' AND m.capability=?';
            if(type=='pubkey')     sql += ' AND m.signing_pubkey=?';
        } else if(method=='getGovernanceProposals'){
            if(type=='status')    sql += ' AND m.status=?';
            if(type=='parameter') sql += ' AND m.parameter=?';
            if(type=='proposal')  sql += ' AND m.proposal_id=?';
        } else if(method=='getGovernanceVotes'){
            if(type=='proposal') sql += ' AND m.proposal_id=?';
            if(type=='voter')    sql += ' AND m.voter_pubkey=?';
        } else if(method=='getPeers'){
            // p2p_peers is a hub-local operational table; filter on its own columns.
            if(type=='validator') sql += ' AND m.validator_id=?';
        } else if(method=='getConsensusState'){
            // consensus_state is a key/value table; filter by key_name.
            if(type=='key') sql += ' AND m.key_name=?';
        } else if(method=='getConfigs'){
            // configs is the hub config oracle store (coin/network/module/param);
            // filter by coin or module.
            if(type=='coin')   sql += ' AND m.coin=?';
            if(type=='module') sql += ' AND m.module=?';
        } else if(method=='getTelemetryPings'){
            // telemetry_pings is anonymous xchain-node telemetry; filter by event
            // type, anonymous install UUID, or country.
            if(type=='event')   sql += ' AND m.event=?';
            if(type=='install') sql += ' AND m.install_id=?';
            if(type=='country') sql += ' AND m.country=?';
        } else if(method=='getPolls'){
            // polls (VOTE v0) joins the actions/transactions/blocks chain (b1 via t1) like
            // getAttestations. tick joins index_tickers (pt) on m.tick_id; source is the poll
            // creator (a2 via the action source); status filters the poll lifecycle enum directly.
            if(type=='block')  sql += ' AND b1.block_index=?';
            if(type=='tick')   sql += ' AND pt.tick=?';
            if(type=='status') sql += ' AND m.poll_status=?';
            if(type=='source') sql += ' AND a2.address=?';
        } else if(method=='getPoll'){
            // single poll keyed by its creating action_index (the poll id)
            sql += ' AND m.action_index=?';
        } else if(method=='getPollResults'){
            // poll_results is keyed by poll_index (the poll's creating action_index); the frozen
            // per-option tally has no actions chain of its own to filter on.
            sql += ' AND m.poll_index=?';
        } else if(method=='getVotes'){
            // votes (VOTE v1 ballots) joins the actions/transactions/blocks chain; the voter IS
            // the source that cast the ballot (a2 via the action source), so address filters on a2.
            if(type=='address') sql += ' AND a2.address=?';
            if(type=='poll')    sql += ' AND m.poll_index=?';
            if(type=='block')   sql += ' AND b1.block_index=?';
        } else if(method=='getVoteDelegations'){
            // vote_delegations (VOTE v3 liquid democracy) joins the actions/transactions/
            // blocks chain via m.action_index like getContractDelegations. tick resolves
            // through index_tickers (t3) on m.tick_id; delegator/delegate resolve through
            // index_addresses (dgr/dg) on delegator_address_id/delegate_address_id. The
            // latest-active-per-key exclusion lives in getVoteDelegations' own SQL (a
            // correlated MAX), not here: this branch only narrows by the requested TYPE.
            if(type=='tick')      sql += ' AND t3.tick=?';
            if(type=='delegator') sql += ' AND dgr.address=?';
            if(type=='delegate')  sql += ' AND dg.address=?';
            if(type=='block')     sql += ' AND b1.block_index=?';
        } else if(method=='getBetFeeds'){
            // bet_feeds (BET format 0) joins the actions/transactions/blocks chain like
            // getPolls. tick joins index_tickers (pt) on the wager token; source is the
            // oracle that created the feed (a2 via the action source); status filters the
            // STORED feed lifecycle enum through index_statuses (fs), never a clock
            // recomputation. 'address' is an alias of 'source' here because a feed has
            // exactly one participating address of its own (the oracle); bettors are
            // reachable via getBets(feed).
            if(type=='block')   sql += ' AND b1.block_index=?';
            if(type=='token')   sql += ' AND pt.tick=?';
            if(type=='status')  sql += ' AND fs.status=?';
            if(type=='source')  sql += ' AND a2.address=?';
            if(type=='address') sql += ' AND a2.address=?';
        } else if(method=='getBetFeed'){
            // single market keyed by its creating action_index (the feed id)
            sql += ' AND m.action_index=?';
        } else if(method=='getBets'){
            // bets (BET format 2 ballots-equivalent) joins the actions/transactions/blocks
            // chain; the bettor IS the source that placed the wager (a2 via the action source).
            // 'feed' filters to one market, matching getVotes' 'poll'.
            if(type=='address') sql += ' AND a2.address=?';
            if(type=='feed')    sql += ' AND m.feed_action_index=?';
            if(type=='token')   sql += ' AND pt.tick=?';
            if(type=='status')  sql += ' AND bs.status=?';
            if(type=='block')   sql += ' AND b1.block_index=?';
        } else if(['getCrossChainMatches','getCrossChainSettlements'].includes(method)){
            // standalone mirror tables (no actions/transactions chain); filter on
            // their own columns directly. matches carry snapshot_block (the
            // BTC-anchored quorum block); settlements carry the local block_index.
            if(type=='match')  sql += ' AND m.match_id=?';
            if(type=='block')  sql += (method=='getCrossChainSettlements') ? ' AND m.block_index=?' : ' AND m.snapshot_block=?';
            if(type=='status' && method=='getCrossChainMatches') sql += ' AND m.status=?';
        } else if(method=='getReorgs'){
            // reorg_attestations is a hub-mirrored, cross-chain table; the mandatory
            // per-coin chain scope is appended separately in getReorgs (matching
            // getCrossChainMatches' network filter above), so this branch only narrows
            // WITHIN that scope. 'block' reuses the platform-wide block-height type name
            // (reorg_height IS a block height).
            if(type=='status') sql += ' AND m.status=?';
            if(type=='block')  sql += ' AND m.reorg_height=?';
        } else if(method=='getSlashProposals'){
            // Platform-global table (no chain axis), so these are the only two
            // filters, and they mirror the hub RPC's two server-side filters exactly
            // so neither transport has to post-filter. No 'block' type: round_number
            // is an oracle round (or an attestation pseudo-round), not a block height,
            // and QUERY_DESC['block'] reads 'block height'.
            if(type=='status') sql += ' AND m.status=?';
            if(type=='pubkey') sql += ' AND m.validator_pubkey=?';
        } else if(method=='getEmissions'){
            // contract_emissions carries no contract_index of its own (it is reachable
            // only by joining through contract_executions on execution_index), so
            // contract/block filter the joined `ce` alias. block_index lives on
            // contract_executions directly, which is why this does NOT reuse the generic
            // b1.block_index branch below (that one assumes an actions/blocks join this
            // method does not make). 'execution' filters contract_emissions' own indexed
            // execution_index column.
            if(type=='contract')  sql += ' AND ce.contract_index=?';
            if(type=='execution') sql += ' AND m.execution_index=?';
            if(type=='block')     sql += ' AND ce.block_index=?';
        } else if(method=='getCollectibles'){
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
        } else if(method=='getXcalls'){
            // xcalls joins the actions/transactions/blocks chain (b1 alias); filter on its own columns.
            // contract = the source contract that emitted the call (contract_index, now indexed).
            if(type=='block')    sql += ' AND b1.block_index=?';
            if(type=='contract') sql += ' AND m.contract_index=?';
            if(type=='status')   sql += ' AND m.request_status=?';
        } else if(method=='getAnchors'){
            // anchor_actions joins the actions/transactions/blocks chain (b1 via t1); filter on its own columns.
            if(type=='block')   sql += ' AND b1.block_index=?';
            if(type=='chain')   sql += ' AND m.chain=?';
            if(type=='network') sql += ' AND m.network=?';
            if(type=='status')  sql += ' AND s1.status=?';
        } else if(method=='getAnchorRewardAttestations'){
            // anchor_reward_attestations is a standalone hub-mirror table (no actions/
            // transactions chain); filter on its own columns. 'anchor' answers "the rewards
            // behind THIS ANCHOR transaction"; 'block' matches the table's own
            // idx_snapshot_block (network, snapshot_block) key; 'pubkey' narrows to one
            // elected publisher's reward history.
            if(type=='anchor')  sql += ' AND m.doge_anchor_txid=?';
            if(type=='block')   sql += ' AND m.snapshot_block=?';
            if(type=='pubkey')  sql += ' AND m.publisher=?';
        } else if(method=='getCommitments'){
            // state_tree_roots has no actions/transactions/blocks chain; filter on its own
            // column directly, matching getAnchors/getCrossChainMatches above.
            if(type=='block') sql += ' AND m.block_index=?';
        } else if(method=='getXcall'){
            // single-call lifecycle keyed by the deterministic 64-hex call_id
            sql += ' AND m.call_id=?';
        } else if(!['getBlocks'].includes(method)){
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
        }
        return sql;
    }


    /******************************************************************
     * Explorer Paging / Offset specific code
     *****************************************************************/

    // table `m` is a universal reference to the main action table
    async getQueryOffsetSql(config){
        let method = config.data.method;
        let offset = (config.data.offset) ? config.data.offset : false;
        let action = (offset && !this.util.isNull(offset.action)) ? offset.action : false;
        let start  = (offset && !this.util.isNull(offset.start) && this.util.isNumeric(offset.start)) ? this.util.sanitizeInt(offset.start, false) : false;
        let stop   = (offset && !this.util.isNull(offset.stop) && this.util.isNumeric(offset.stop)) ? this.util.sanitizeInt(offset.stop, false) : false;
        if(start === false || stop === false) { /* sanitizeInt handles NaN/Infinity */ }
        let sql    = '';
        let args   = [];
        if(method=='getBlocks')
            stop = false;
        if(action && start !== false){
            // hardcoded whitelist, never from user input
            let field = 'm.action_index';
            if(method=='getBlocks')
                field = 'b1.block_index';
            // getCollectibles is getTokens' filtered sibling and ORDERs BY the same
            // column, so it takes the same cursor: `tokens` has no per-row action_index
            // uniqueness (a re-ISSUE stamps last_action_index, not a new row).
            if(['getTokens','getCollectibles'].includes(method))
                field = 'm.id';
            // state_checkpoints has no action_index, and unlike the id-keyed views below
            // it is not keyed by m.id either: the list ORDERs BY m.block_index (the
            // checkpointed height, one row per height after the MAX(checkpoint_seq)
            // GROUP BY), so the cursor must compare that column, not insertion order.
            // state_tree_roots (getCommitments) has the same shape: no action_index, one
            // row per height, and the list ORDERs BY m.block_index.
            if(['getCheckpoints','getCommitments'].includes(method))
                field = 'm.block_index';
            // id-keyed list views: their main query ORDERs BY m.id (these tables have no
            // action_index cursor column, or a fan-out where action_index is not unique
            // per displayed row), so the paging cursor must compare m.id rather than the
            // default m.action_index. Must stay in lockstep with each method's ORDER BY.
            if(['getSlashEvents','getCapabilitySlashEvents','getOraclePrices',
                'getFullNodeVerifications','getPriceSnapshots','getCrossChainMatches',
                'getValidatorCapabilities','getGovernanceProposals','getGovernanceVotes',
                'getPeers','getConsensusState','getConfigs','getTelemetryPings',
                'getEmissions','getAttestValidatorStats','getCapabilitySnapshots',
                'getAnchorRewardAttestations','getReorgs','getSlashProposals'].includes(method))
                field = 'm.id';
            if(action=='prev'){
                sql = ` AND ` + field + ` > ?`;
                args.push(start);
                if(stop){
                    sql += ` AND ` + field + ` < ?`;
                    args.push(stop);
                }
            } else if(action=='last'){
                sql = ` AND ` + field + ` <= ?`;
                args.push(start);
            } else {
                sql = ` AND ` + field + ` < ?`;
                args.push(start);
                if(stop){
                    sql += ` AND ` + field + ` > ?`;
                    args.push(stop);
                }
            }
        }
        return [sql, args];
    }

    async getQueryOffsets(config, offset1, length){
        let offset2  = false;
        let method = config.data.method;
        let type   = config.data.type;
        let offset = (config.data.offset) ? config.data.offset : false;
        let action = (offset && !this.util.isNull(offset.action)) ? offset.action : false;
        let q      = (config.data.query) ? config.data.query : false;
        let table  = false;
        let sql    = false;
        let args   = false;
        let rows   = false;
        let id     = false;
        let where     = '';
        let whereArgs = [];
        let limit  = 1;
        let order  = 'DESC';
        if(['getBalances','getHolders','getTransaction','getSearch','getMarkets','getMarket'].includes(method))
            return [];
        // token/subtoken searches paginate by fetch-and-slice (no action_index offsets)
        if(method=='getTokens' && ['token','subtoken'].includes(type))
            return [];
        // WHICH TABLE getHistory's PAGE BOUNDARY is computed over. This must agree with
        // getHistoryData's own choice, because the number resolved here is the cursor
        // that query then pages on: if the boundary is computed over a narrower set than
        // the list, `action=first` resolves to the newest MAPPED action and the list
        // silently starts BELOW everything above it. That is exactly what happened -
        // the first page of All Activity opened at the newest ledger-moving action and
        // hid every consensus action newer than it, while the row count said they were
        // there. Only the address/token feeds page over mappings_actions (their filter
        // is a lookup INTO it); everything else pages over `actions`.
        let historyMapped = (method=='getHistory' && ['address','token'].includes(type));
        let hCursor = (historyMapped) ? 'm.action_index' : 'a1.action_index';
        let hSource = (historyMapped)
            ? `mappings_actions m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)`
            : `actions a1`;
        if(['address','oracle','token','block'].includes(type)){
            if(type=='address' || type=='oracle')
                sql = `SELECT id FROM index_addresses WHERE address=? LIMIT 1`;
            if(type=='token')
                sql = `SELECT id FROM index_tickers WHERE tick=? LIMIT 1`;
            if(sql){
                rows = await this.doQuery(config, sql, [config.data.search]);
                if(rows.length>0)
                    id = Number(rows[0].id);
            }
            if(type=='address'){
                if(['getMessages','getMints','getSends','getSweeps'].includes(method)){
                    where = ` AND (COALESCE(a1.source_id, t1.source_id)=? OR m.destination_id=?)`;
                    whereArgs.push(id, id);
                } else if(['getTokens'].includes(method)){
                    where = ` AND m.owner_id=?`;
                    whereArgs.push(id);
                } else if(method=='getCoinpayObligations'){
                    where = ` AND (m.payer_address_id=? OR m.payee_address_id=?)`;
                    whereArgs.push(id, id);
                } else if(['getCredits','getDebits','getEscrows'].includes(method)){
                    where = ` AND m.address_id=?`;
                    whereArgs.push(id);
                } else if(['getHistory'].includes(method)){
                    where = ` AND m.type_id=2 AND m.id=?`;
                    whereArgs.push(id);
                } else {
                    // Paging boundaries must filter on the same source the row query joins on
                    // (the ACTION's own source, falling back to the transaction's), or an
                    // emitted action pages differently from how it lists. Every boundary query
                    // below joins `actions a1`, so the alias is always in scope here.
                    where = ` AND COALESCE(a1.source_id, t1.source_id)=?`;
                    whereArgs.push(id);
                }
            } else if(type=='oracle'){
                // Paging boundary for the getDispensers oracle lane. The boundary
                // query joins only m/a1/b1/t1, so filter on the dispenser row's own
                // column rather than the a5 address join the row query uses.
                where = ` AND m.oracle_address_id=?`;
                whereArgs.push(id);
            } else if(type=='block' && !this.util.isNull(config.data.search)){
                where = ` AND b1.block_index=?`;
                whereArgs.push(this.util.sanitizeInt(config.data.search));
            } else if(type=='token'){
                if(['getOrders','getSwaps'].includes(method)){
                    where = ` AND (m.get_tick_id=? OR m.give_tick_id=?)`;
                    whereArgs.push(id, id);
                } else if(['getDispensers','getDispenses'].includes(method)){
                    where = ` AND m.get_tick_id=?`;
                    whereArgs.push(id);
                } else if(['getHistory','getFiles'].includes(method)){
                    where = ` AND m.type_id=1 AND m.id=?`;
                    whereArgs.push(id);
                } else {
                    where = ` AND m.tick_id=?`;
                    whereArgs.push(id);
                }
            }
        }
        table = String(method).toLowerCase().replace('get','');
        if(!this.actionTables.includes(table) && !['blocks','tokens','history','files','markets','market'].includes(table)){
            // The boundary-discovery query below keys off this derived table name, which
            // does not exist for these methods (anchor_actions, slash_events, the hub
            // governance/match mirrors, etc.), so it cannot run. It is not needed: the
            // main list query already filters and orders on the right cursor column. For
            // the known cursor-paged views, pass the inbound client cursor through
            // unchanged (offset1) so next/prev advance; returning [] here discards it and
            // resets every page to the newest rows. Unknown methods keep the old no-op.
            if(this.cursorPagedMethods.includes(method))
                return [offset1, false];
            return [];
        }
        // Does this listing page over BLOCKS rather than over actions? `blocks` is the one
        // table in the allowlist above whose rows are not actions - it carries no
        // action_index at all - so the generic boundary query below, which joins
        // `actions a1 ON (a1.action_index=m.action_index)`, cannot run against it.
        //
        // Keyed on the TABLE being paged, never on `type`. `type` names the FILTER axis, not
        // the thing being listed: a SENDS list filtered by block is still a list of actions.
        // Keying on `type=='block'` got both wrong at once. The blocks LIST page passes no
        // type at all, so it fell through to the generic query and answered 500 DB_ERROR on
        // every coin and every network - `Unknown column 'm.action_index'` - which is what a
        // reader saw as a frozen page. Meanwhile a sends-by-block list, which DOES pass
        // type=='block', took the block-index arithmetic below against an offset that the
        // boundary query had returned as an action_index.
        //
        // Both sites must agree, because the second interprets the number the first returns.
        let pagesOverBlocks = (table === 'blocks');
        if(['first','last'].includes(action)){
            if(action=='first')
                order = 'DESC';
            if(action=='last'){
                order = 'ASC';
                limit = this.util.bcadd(length,1);
            }
            if(pagesOverBlocks){
                sql = `SELECT
                            b1.block_index as offset_index
                        FROM
                            blocks b1
                        WHERE
                            b1.block_index IS NOT NULL
                            ` + where + `
                        ORDER BY b1.block_index ` + order + `
                        LIMIT ` + limit;
            } else if(method=='getTokens'){
                sql = `SELECT
                            m.id as offset_index
                        FROM
                            tokens m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.id ` + order + `
                        LIMIT ` + limit;
            } else if(method=='getHistory'){
                sql = `SELECT
                            ` + hCursor + ` as offset_index
                        FROM
                            ` + hSource + `
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        WHERE
                            ` + hCursor + ` IS NOT NULL
                            ` + where + `
                        ORDER BY ` + hCursor + ` ` + order + `
                        LIMIT ` + limit;
            } else if(method=='getFiles' && type=='token'){
                sql = `SELECT
                            m.action_index as offset_index
                        FROM
                            mappings_files m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
             } else {
                sql = `SELECT
                            m.action_index as offset_index
                        FROM
                            ` + table + ` m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
            }
            rows = await this.doQuery(config, sql, whereArgs.length ? whereArgs : undefined);
            if(rows.length>0){
                for(let row of rows){
                    offset1 = Number(row.offset_index);
                    // Increase/Decrease offset by 1 so latest results are returned
                    if(action=='first')
                        offset1++;
                    if(action=='last')
                        offset--;
                }
            }
        }
        if(offset1){
            // Same predicate as the boundary query above, deliberately: this branch reads
            // offset1 as a BLOCK INDEX, and only the blocks query returns one.
            if(pagesOverBlocks){
                if(action=='last'){
                    offset2 = this.util.bcsub(this.util.bcadd(offset1,1),q.length);
                } else {
                    offset2 = this.util.bcsub(this.util.bcsub(offset1,1),q.length);
                }
            } else {
                limit = this.util.bcadd(length,1);
                order = 'DESC';
                let stopWhereArgs = [...whereArgs];
                if(action && offset1){
                    // getHistory's unmapped feeds have no `m` alias to cursor on, so the
                    // stop predicate names whichever column this method's own query below
                    // selects (hCursor for history, m.action_index for everything else).
                    let stopCursor = (method=='getHistory') ? hCursor : 'm.action_index';
                    if(action=='prev'){
                        where += ' AND ' + stopCursor + ' > ?';
                        stopWhereArgs.push(offset1);
                    } else {
                        where += ' AND ' + stopCursor + ' < ?';
                        stopWhereArgs.push(offset1);
                    }
                }
                if(method=='getHistory'){
                    // Same join shape as getHistoryData and as the first/last boundary
                    // above: blocks INNER-joined on the ACTION's own block_index and
                    // transactions LEFT-joined. Reaching blocks through an INNER-joined
                    // transactions instead would drop every chain-generated action that
                    // has no transaction row, so the stop marker would describe a
                    // shorter list than the one being paged.
                    sql = `SELECT
                            ` + hCursor + ` as offset_index
                        FROM
                            ` + hSource + `
                            INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                            LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        WHERE
                            ` + hCursor + ` IS NOT NULL
                            ` + where + `
                        ORDER BY ` + hCursor + ` ` + order + `
                        LIMIT ` + limit;
            } else if(method=='getFiles' && type=='token'){
                sql = `SELECT
                            m.action_index as offset_index
                        FROM
                            mappings_files m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
                } else {
                    sql = `SELECT
                            m.action_index as offset_index
                        FROM
                            ` + table + ` m
                            INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                            INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                            INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        WHERE
                            m.action_index IS NOT NULL
                            ` + where + `
                        ORDER BY m.action_index ` + order + `
                        LIMIT ` + limit;
                }
                rows = await this.doQuery(config, sql, stopWhereArgs.length ? stopWhereArgs : undefined);
                // Only set the stop offset when we have more data to show
                if(rows.length>0 && rows.length == limit){
                    for(let row of rows)
                        offset2 = Number(row.offset_index);
                }
            }
        }
        return [offset1, offset2];
    }

    getMaxMethodResults(method){
        let methods = {
            getBalances: 500,
            getHolders:  500
        }
        let max = (this.util.isInteger(methods[method])) ? methods[method] : 100;
        return max;
    }

    // Sanitize a search term for MATCH ... AGAINST (? IN BOOLEAN MODE). BOOLEAN MODE
    // gives +, -, ~, <, >, *, ", ( ), and @ operator meaning inside the bound value,
    // so an unsanitized term is a query-language injection into the search (a bare
    // '-foo' means "must NOT contain foo", '@10' is a distance operator, and an odd
    // quote is a syntax error the driver reports as a failed read). Strip them, then
    // hold the term to the same 3-character floor as the LIKE panels: InnoDB's
    // innodb_ft_min_token_size is 3, so a shorter term indexes to nothing anyway.
    // Returns '' when nothing usable survives, which callers answer as no results.
    fulltextTerm(term){
        if(this.util.isNull(term)) return '';
        let out = String(term).replace(/[+\-~<>()"*@]/g, ' ').replace(/\s+/g, ' ').trim();
        return (out.length < 3) ? '' : out;
    }

    // ── M4 composed detail views (spec explorer-coverage-completion, rows 26/28/30/31) ──
    //
    // Four single-record compositions backing the M4 detail pages. They follow
    // getXcall/getPoll: the method runs its own reads and returns [object] (null when the
    // subject does not exist), so getData takes its `typeof query === 'object'` branch and
    // the builder arg-assembly path (baseArgs then offsetArgs, count reusing baseArgs) never
    // applies to them.
    //
    // NONE of them consume config.data.sql.where.data, and that is deliberate rather than an
    // omission. A composition's spine and its sub-lists sit on different tables under
    // different aliases, so one shared WHERE fragment cannot be correct for all of them;
    // each leg carries its own predicate and binds its own args in strict left-to-right
    // text order. The consequence worth knowing: these four need no getQueryWhereSql branch,
    // so a route registered against any TYPE cannot 500 them with an unknown-column error.
    //
    // What they DO take from config.data.sql is `limit`, already clamped to
    // 1..getMaxMethodResults() by getQuery, and EVERY sub-list interpolates it. An unbounded
    // sub-list inside a composition pulls the same whole table a missing LIMIT pulls on a
    // list route; it is only harder to see, because the response looks like one record.
    detailLimit(config){
        let sql = config.data.sql;
        return (sql && this.util.isNumeric(sql.limit)) ? Number(sql.limit) : 100;
    }
}

module.exports = QueryBuilder.prototype;
