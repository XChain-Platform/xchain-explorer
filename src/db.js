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
 * XChain Explorer - Database Class
 * 
 * This file handles connecting to databases and running SQL queries
 *
 ********************************************************************/

// Module-level bindings the extracted modules share with this one. They cannot
// ride on a module's own export, which is a prototype mixinReaders copies whole:
// an extra key there would arrive on Database.prototype as a method. The two
// field lists and the two error classes are re-exported below under their
// original names, which is how every caller already reaches them.
const { ACTION_SUMMARY_FIELDS, MUTABLE_ACTION_FIELDS,
    DbQueryError, DbInputError } = require('./db/shared.js');

// The families extracted out of this file so no single module holds every query.
// Each module is authored as a class body and exports that class's prototype, so
// the methods arrive with `this` still bound to the Database instance and no call
// site moved.
const connectionMethods        = require('./db/connection.js');
const queryBuilder             = require('./db/query_sql.js');
const actionListReaders        = require('./db/readers/action-lists.js');
const marketReaders            = require('./db/readers/markets.js');
const stakingGovernanceReaders = require('./db/readers/staking-governance.js');
const checkpointReaders        = require('./db/readers/checkpoints.js');
const entityReaders            = require('./db/readers/entities.js');
const actionDetailIoReaders    = require('./db/readers/action_detail_io.js');
const healthReaders            = require('./db/readers/health.js');
const projectReaders           = require('./db/readers/projects.js');
const contractReaders          = require('./db/readers/contracts.js');
const pollBetReaders           = require('./db/readers/polls_bets.js');
const xcallReaders             = require('./db/readers/xcall.js');

// Copies an extracted reader family onto Database.prototype. Object.assign cannot
// do this: a class method is non-enumerable, so assign would copy nothing. Copying
// the descriptor also keeps getters and arity intact.
//
// A collision throws rather than resolving by require order, because the loser
// would vanish silently and the page it serves would start answering with another
// family's SQL.
function mixinReaders(target, ...sources){
    for(let source of sources){
        for(let name of Object.getOwnPropertyNames(source)){
            if(name=='constructor') continue;
            if(Object.prototype.hasOwnProperty.call(target, name))
                throw new Error('db.js reader mixin collision: ' + name + ' is defined twice');
            Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source, name));
        }
    }
}

// An ACTION's source is `actions.source_id`, never `transactions.source_id`. The two agree
// for every user action, and DISAGREE for a VM emission: the indexer stores the emitting
// contract's derived address on the action row (xchain-indexer db.js createActionIndex,
// execute.js processEmission) while the transaction still belongs to the human who sent the
// EXECUTE. Reading the transaction there renders a real address that is the WRONG one, which
// no reader can catch by eye. Every query below therefore resolves source through
// COALESCE(<actions alias>.source_id, t1.source_id); the fallback covers system/synthetic
// actions (expiries, completion UNSTAKEs), which are created with no SOURCE at all.
class Database {

    constructor(explorer){
        this.explorer   = explorer;
        this.configInfo = explorer.configInfo
        this.util   = explorer.util;

        this.configInfo.onConfigChanged(()=>{
            this.setupConnectionPools();
        })

        this.transactionConnection = null;

        // LRU caches for frequently-queried immutable lookups
        this._addressIdCache  = new Map();
        // Byte-exact address -> id resolutions (getExactAddressId). Kept apart from
        // _addressIdCache because the two lookups legitimately disagree for the same
        // key: the ci lookup resolves a case variant to the id of the address it
        // resembles, the byte-exact one resolves it to null. One shared cache would
        // let whichever ran first answer for both.
        this._exactAddressIdCache = new Map();
        this._tickIdCache     = new Map();
        this._actionDataCache = new Map();
        // Per-coin reorg generation counter mixed into the id/action cache keys
        // (M-3). The indexer reassigns ^id / action_index values on a reorg, so
        // a pre-reorg cache entry keyed by an index can resolve to a DIFFERENT
        // entity afterward. bumpReorgGeneration() increments the counter on a
        // detected reorg, which changes every future key for that coin and lets
        // the stale entries age out via normal LRU eviction (no full flush, no
        // per-request DB check). _lastTip tracks the last-seen tip per coin so
        // checkReorgAndInvalidate can spot a rewind on the tip-poll loop.
        this._reorgGen = {};
        this._lastTip  = {};
        // Per-coin tip memo backing the getData result-cache generation token.
        // The cached list methods read tables the indexer only rewrites when a
        // block is applied, so the tip height is exactly the generation those
        // results belong to; see _resultCacheGeneration.
        this._tipMemo  = {};
        // AST introspection ({methods, abi} pair) is a pure function of the
        // contract source, and code is immutable once deployed, so cache by
        // the sha256 we compute from the code itself (two deploys of identical
        // source share one entry; the stored code_hash column is unverified).
        this._methodsCache    = new Map();

        this.actionTables = [
            'addresses',
            'airdrops',
            'anchor_actions',
            'batches',
            'broadcasts',
            'callbacks',
            'coinpays',
            'coinpay_expires',
            'coinpay_obligations',
            'destroys',
            'dispensers',
            'dispenses',
            'dividends',
            'files',
            'full_node_verifications',
            'issues',
            'links',
            'lists',
            'messages',
            'mints',
            'orders',
            'order_cancels',
            'order_edits',
            'order_matches',
            'prices',
            'sends',
            'sleeps',
            'swaps',
            'swap_cancels',
            'swap_edits',
            'swap_matches',
            'sweeps'
        ];

        // List views whose backing table name is NOT derivable from the method via
        // the get->lowercase mangle in getQueryOffsets (e.g. getAnchors -> anchor_actions,
        // getSlashEvents -> slash_events, the hub-mirrored governance/match tables). The
        // boundary-discovery query can't run for these, but it doesn't need to: each main
        // list query already orders by and filters on the correct cursor column
        // (getQueryOffsetSql picks m.id vs m.action_index per method). We only need to
        // preserve the inbound client cursor so next/prev advance instead of resetting to
        // the newest page every time.
        // The mangle is `method.toLowerCase().replace('get','')`, which never
        // reinserts an underscore, so EVERY method over a multi-word table name
        // belongs here regardless of which cursor column it uses:
        // getContractDelegations ('contractdelegations' vs contract_delegations)
        // is the standing proof, and it pages on the default action_index cursor.
        this.cursorPagedMethods = [
            'getAnchors','getXcalls','getAttestations','getAttestValidatorStats',
            'getContractStakes','getContractUnstakes','getContractDelegations','getEmissions',
            'getCrossChainSettlements','getCrossChainMatches',
            'getSlashEvents','getCapabilitySlashEvents','getFullNodeVerifications',
            'getPriceSnapshots','getOraclePrices',
            'getValidatorCapabilities','getGovernanceProposals','getGovernanceVotes','getReorgs','getSlashProposals',
            'getPeers','getConsensusState','getConfigs','getTelemetryPings',
            'getPolls','getVotes','getVoteDelegations',
            // BET market/wager lists: getBetFeeds -> bet_feeds and getBets -> bets are
            // not reachable through the get->lowercase table mangle, so they page on the
            // preserved client cursor like the poll family. Both ORDER BY m.action_index,
            // which is getQueryOffsetSql's default cursor field, so no id-keyed entry.
            'getBetFeeds','getBets',
            // The checkpoint-schema family: state_checkpoints, capability_snapshots and
            // anchor_reward_attestations are hub-mirrored and state_tree_roots is
            // indexer-local, and none of the four is reachable through the mangle. They
            // page on the preserved client cursor; getQueryOffsetSql gives getCheckpoints
            // and getCommitments their own m.block_index cursor field below (not m.id),
            // since both lists ORDER BY the committed height.
            'getCheckpoints','getCapabilitySnapshots','getAnchorRewardAttestations','getCommitments',
            // getCollectibles -> 'collectibles' is not a table (the rows are `tokens`
            // filtered by the M5.1 classification), so the get->lowercase mangle cannot
            // find a boundary; it pages on the preserved client cursor over m.id.
            // The gallery is /api-only today (it pages by ?page=, and the cursor path
            // runs for /explorer requests alone), so this entry and its sibling in
            // getQueryOffsetSql are armed rather than exercised: they exist so that
            // registering an /explorer feed later cannot silently page this method on
            // the wrong column, which is the failure the cursor list itself documents.
            'getCollectibles'
        ];

    }


    // Cross-chain reorg attestations (hub-owned, id-keyed). Primary transport: hub
    // JSON-RPC via HubOperationalCache over the hub's EXISTING unauthenticated
    // getreorghistory RPC, so this row needs no new hub-side surface. Unlike the three
    // tables above (platform-global, no per-chain column), reorg_attestations carries
    // source_chain and getreorghistory returns EVERY chain's history with no server-side
    // chain filter at all, so a per-coin page would otherwise leak another chain's
    // reorgs. Both transports therefore scope to THIS coin's own chain: client-side
    // inside HubOperationalCache.getReorgHistory (the established pattern for a param the
    // hub RPC does not support server-side, see getGovernanceProposals' proposal_id), and
    // via an explicit m.source_chain=? on the co-located leg, matching
    // getCrossChainMatches' mandatory network filter.
    //
    // this.baseCoin[config.coin] (RBTC -> BTC) is the chain source rather than
    // _checkpointSource().chain because it is populated for every configured coin whether
    // or not a co-located checkpoint DB exists, so the RPC-only deployment shape still
    // scopes correctly. A configured-but-unreachable hub still fails loud past the stale
    // ceiling; the co-located read below serves only the no-hub shape.
    // type in {status, block}; 'block' reuses the platform-wide type name (reorg_height IS
    // a block height) rather than inventing 'height'.
    async getReorgs(config){
        let ops   = this.explorer.hubOperational;
        let chain = this.baseCoin ? (this.baseCoin[config.coin] || config.coin) : config.coin;
        if(ops && ops.enabled()){
            let rows = await ops.getReorgHistory({
                chain,
                status:       config.data.type=='status' ? config.data.search : undefined,
                reorg_height: config.data.type=='block'  ? config.data.search : undefined
            });
            if(rows) return this._pageHubOperationalRows(config, rows);
            this._hubOperationalOutage('reorg_attestations');
        }
        let sql = config.data.sql;
        let src = this._hubSource(config, 'reorg_attestations');
        // Mandatory per-coin chain scope, appended AFTER the optional type filter (the
        // same placement getCrossChainMatches uses for its network filter), so the args
        // stay [<type filter?>, chain] in strict left-to-right text order.
        let chainFilter = ' AND m.source_chain=?';
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data + chainFilter;
        let query = `SELECT
                        m.id,
                        m.reorg_id,
                        m.source_chain,
                        m.reorg_height,
                        m.reorg_timestamp,
                        m.affected_chains,
                        m.validator_count,
                        m.status,
                        m.created_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + chainFilter + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        let typeArgs = ['status','block'].includes(config.data.type) ? [config.data.search] : [];
        let args = [...typeArgs, chain];
        return [query, args, count];
    }

    // Federation slash proposals (hub-owned, id-keyed). Primary transport: hub
    // JSON-RPC via HubOperationalCache over the hub's NEW unauthenticated
    // getslashproposals RPC (added for this row alongside the hub-side evidence
    // hashing). Unlike reorg_attestations there is NO chain column and none is
    // missing: the offenses are federation-wide (oracle and attestation rounds are
    // not per-chain, and a signing pubkey is one identity across every chain), so
    // this table is platform-global like validator_capabilities/governance_* and
    // binds no chain filter on either transport. Adding one later would empty this
    // page permanently, since no row can ever carry a chain value to match.
    //
    // Rows with status 'pending' are UNADJUDICATED ACCUSATIONS: SlashDetector
    // records evidence, and only a passed SLASH_PENALTY governance vote moves a row
    // off 'pending' (SlashGovernance.applyFinalized). status is therefore carried on
    // every row and rendered as its own labelled column, never as a row colour.
    //
    // The verbatim `evidence` blob is NEVER served on either leg. The RPC leg gets
    // evidence_hash from the hub (SlashDetector.hashEvidence, sha256 of the stored
    // text, the same digest SlashGovernance's voted evidence hash is built from);
    // the co-located leg computes the identical digest in SQL. Hashing hub-side is
    // the ruling's point: the hub's own POST surface serves this RPC to anyone, so
    // explorer-side redaction alone would leak.
    //
    // A configured-but-unreachable hub fails loud past the stale ceiling
    // (_hubOperationalOutage); the co-located read below serves only the no-hub
    // deployment shape. type in {status, pubkey}, matching the hub RPC's two
    // server-side filters exactly, so neither transport post-filters. No 'block'
    // type: round_number is an oracle round (or an attestation pseudo-round), not a
    // block height.
    async getSlashProposals(config){
        let ops = this.explorer.hubOperational;
        if(ops && ops.enabled()){
            let rows = await ops.getSlashProposals({
                status:           config.data.type=='status' ? config.data.search : undefined,
                validator_pubkey: config.data.type=='pubkey' ? config.data.search : undefined
            });
            if(rows) return this._pageHubOperationalRows(config, rows);
            this._hubOperationalOutage('slash_proposals');
        }
        let sql = config.data.sql;
        let src = this._hubSource(config, 'slash_proposals');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.validator_pubkey,
                        m.offense_type,
                        m.round_number,
                        SHA2(COALESCE(m.evidence,''), 256) AS evidence_hash,
                        m.status,
                        m.created_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // ── Hub operational-state pages (p2p_peers / consensus_state / configs /
    // telemetry_pings). These are hub-LOCAL operational tables with no on-chain
    // action and, unlike validator_capabilities/governance_*, no hub JSON-RPC read
    // surface at all, so they are served ONLY from the co-located hub DB via
    // _hubSource (same host+creds as the indexer pool; #4138), which is therefore
    // mandatory for these four on any install that serves them. That is the reverse
    // of the three RPC-first tables above, where the co-located schema serves only
    // the no-hub shape and a configured-but-down hub fails loud. Each is
    // id-keyed (no action_index), so the paging cursor compares m.id (see
    // getQueryOffsetSql).

    // P2P peer roster the hub gossips with. type in {validator}. id-keyed.
    async getPeers(config){
        let sql = config.data.sql;
        let src = this._hubSource(config, 'p2p_peers');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.addr,
                        m.validator_id,
                        m.last_seen_at,
                        m.is_seed,
                        m.updated_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Hub consensus key/value state. type in {key}. id-keyed.
    async getConsensusState(config){
        let sql = config.data.sql;
        let src = this._hubSource(config, 'consensus_state');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.key_name,
                        m.value,
                        m.updated_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Hub config-oracle parameter store (per coin/network/module). type in {coin, module}.
    // id-keyed.
    async getConfigs(config){
        let sql = config.data.sql;
        let src = this._hubSource(config, 'configs');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.coin,
                        m.network,
                        m.module,
                        m.param_name,
                        m.param_value,
                        m.updated_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Anonymous xchain-node telemetry pings. type in {event, install, country}. id-keyed.
    // Privacy: ip_hash (a keyed HMAC of the source IP) is deliberately NOT selected;
    // only the anonymous install UUID + coarse country/region + software fingerprint
    // are surfaced.
    async getTelemetryPings(config){
        let sql = config.data.sql;
        let src = this._hubSource(config, 'telemetry_pings');
        let count = `SELECT count(*) as total FROM ${src.table} m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.install_id,
                        m.country,
                        m.region,
                        m.node_version,
                        m.os_platform,
                        m.os_release,
                        m.arch,
                        m.docker_version,
                        m.event,
                        m.created_at
                    FROM ${src.table} m
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Composed VALIDATOR detail (M4.1). QUERY is EITHER the Ed25519 signing pubkey or the
    // staking address: both name the same validator in circulation (/validators renders both
    // columns, a hub registry entry is keyed by pubkey, a reward accrual and its COLLECT are
    // keyed by address), so the page answers to either without the caller having to say
    // which it holds.
    //
    // The QUERY is resolved to IDs FIRST, in two unique point reads, and only then does the
    // spine touch `stakes`. The obvious one-query form (`WHERE a3.pubkey=? OR a2.address=?`
    // over the joined aliases) reads correctly and scans the whole stakes table: an OR
    // spanning two different joined tables leaves the optimizer no driving table but `stakes`
    // itself. Resolving first puts the OR on two INDEXED columns of `stakes`
    // (signing_pubkey_id, source_id), which index-merges. The single-predicate list legs
    // below keep the joined-alias form: one null-rejecting equality lets the optimizer
    // convert the LEFT JOIN and drive from the unique index, which an OR does not.
    //
    // Reward accounting is per-ADDRESS, not per-pubkey: validator_rewards accrues to
    // (source_id, signing_pubkey_id) but reward_claims (the COLLECT trail) carries only
    // source_id, so a claimable figure can only be stated for the staking address. Both
    // totals are returned alongside the difference rather than the difference alone, because
    // a negative remainder means ledger drift and has to stay visible instead of clamping.
    //
    // The capability leg follows the established hub DUAL PATH (getValidatorCapabilities):
    // hub JSON-RPC first, the co-located hub schema only on a deployment with no hub
    // endpoint at all, and a CONFIGURED hub unreachable past the stale ceiling throws
    // through _hubOperationalOutage. That throw is not caught here: an outage rendered as
    // "this validator qualified for nothing" is a false claim about consensus state.
    async getValidator(config){
        let limit  = this._detailLimit(config);
        let search = config.data.search;
        let pubkeyRow  = await this.doQuery(config,
            'SELECT id FROM index_pubkeys WHERE pubkey=? LIMIT 1', [search]);
        let addressRow = await this.doQuery(config,
            'SELECT id FROM index_addresses WHERE address=? LIMIT 1', [search]);
        let pubkeyId  = (pubkeyRow  && pubkeyRow.length)  ? Number(pubkeyRow[0].id)  : null;
        let addressId = (addressRow && addressRow.length) ? Number(addressRow[0].id) : null;
        // Neither name exists anywhere on this chain: answer without touching `stakes`.
        if(pubkeyId === null && addressId === null)
            return [null];
        // Only the resolved side is bound, so a QUERY that is unambiguously one form
        // never carries a dead placeholder against the other column's index.
        let idClauses = [];
        let idArgs    = [];
        if(pubkeyId !== null){  idClauses.push('m.signing_pubkey_id=?'); idArgs.push(pubkeyId);  }
        if(addressId !== null){ idClauses.push('m.source_id=?');         idArgs.push(addressId); }
        // Identity spine. status='valid' matches getValidators' own active-set rule, so the
        // page cannot resolve an identity off a rejected STAKE.
        let identity = await this.doQuery(config,
            `SELECT
                a3.pubkey  as signing_pubkey,
                a2.address as source,
                m.action_index as stake_action_index,
                m.version,
                m.activation_block,
                m.deactivation_block,
                m.block_index
            FROM
                stakes m
                LEFT JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE s1.status='valid' AND (` + idClauses.join(' OR ') + `)
            ORDER BY m.action_index DESC
            LIMIT 1`, idArgs);
        if(!identity || !identity.length)
            return [null];
        let row    = identity[0];
        let pubkey = row.signing_pubkey;
        let source = row.source;

        // Active stake: an aggregate over ONE pubkey's rows (signing_pubkey_id is indexed),
        // never a GROUP BY across validators. deactivation_block IS NULL is what "still
        // active" means on this ledger; a superseded row carries the height it stopped at.
        let totals = await this.doQuery(config,
            `SELECT
                count(*) as position_count,
                COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as active_stake
            FROM
                stakes m
                LEFT JOIN index_pubkeys  a3 ON (a3.id=m.signing_pubkey_id)
                LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
            WHERE s1.status='valid' AND a3.pubkey=? AND m.deactivation_block IS NULL`, [pubkey]);

        let stakes = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.version,
                m.amount,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                stakes m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

        let unstakes = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.amount,
                m.cooldown_end_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                unstakes m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

        let delegations = await this.doQuery(config,
            `SELECT
                m.action_index,
                a2.address as source,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                delegations m
                INNER JOIN blocks           b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_addresses  a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys    a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses   s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

        // Key revocations belong with the delegation history rather than in a section of
        // their own: a DELEGATE v2/v3 revocation is the event that ENDS a delegated key's
        // validity, and reading it apart from the delegation it ends inverts the meaning.
        let revocations = await this.doQuery(config,
            `SELECT
                m.action_index,
                a2.address as source,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                stake_key_revocations m
                INNER JOIN blocks           b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_addresses  a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys    a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses   s1 ON (s1.id=m.status_id)
            WHERE a3.pubkey=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [pubkey]);

        // Rotations name BOTH the key they replaced and the key they installed, so this key
        // is on either side of the pair and both are matched. See the frontier note: neither
        // pubkey column is indexed on contract_delegation_rotations today.
        let rotations = await this.doQuery(config,
            `SELECT
                m.id,
                m.target_table,
                m.delegation_action_index,
                m.stake_action_index,
                pp.pubkey as prev_signing_pubkey,
                np.pubkey as new_signing_pubkey,
                m.block_index,
                b1.block_time as timestamp
            FROM
                contract_delegation_rotations m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys pp ON (pp.id=m.prev_signing_pubkey_id)
                LEFT  JOIN index_pubkeys np ON (np.id=m.new_signing_pubkey_id)
            WHERE (pp.pubkey=? OR np.pubkey=?)
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey, pubkey]);

        let rewards = await this.doQuery(config,
            `SELECT
                m.id,
                m.reward_type,
                m.round_reference,
                m.amount,
                m.block_index,
                m.derive_block_index,
                b1.block_time as timestamp
            FROM
                validator_rewards m
                INNER JOIN blocks        b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys a3 ON (a3.id=m.signing_pubkey_id)
            WHERE a3.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        let claimable = await this._collectTrail(config, source, limit);

        // Both slash families. capability_slash_events is the equivocation bond-burn against
        // a CONSENSUS validator (keyed by the signing pubkey directly); slash_events is the
        // contract-stake burn emitted by an EXECUTE (also keyed by the staker's pubkey). One
        // family alone understates exposure, which is why the page carries both. The row
        // shape matches getCapabilitySlashEvents and the address staking panel (slashed
        // key + submitter + destination), so the same slash reads identically wherever
        // it surfaces.
        let capabilitySlashes = await this.doQuery(config,
            `SELECT
                m.id,
                m.slash_action_index,
                a3.pubkey as slashed_pubkey,
                m.capability,
                m.equiv_key,
                m.amount,
                m.bounty_amount,
                m.treasury_amount,
                sub.address as submitter,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                capability_slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   a3  ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_addresses sub ON (sub.id=m.submitter_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE a3.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        let contractSlashes = await this.doQuery(config,
            `SELECT
                m.id,
                m.execution_index,
                m.target_contract_index,
                t3.tick,
                m.amount,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   a3  ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3  ON (t3.id=m.tick_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE a3.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        let nodeproofs = await this.doQuery(config,
            `SELECT
                m.id,
                m.action_index,
                m.challenge_id,
                m.epoch_height,
                m.target_height,
                a3.address as staking_source,
                m.passed,
                m.block_index,
                b1.block_time as timestamp
            FROM
                full_node_verifications m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   pk ON (pk.id=m.signing_pubkey_id)
                LEFT  JOIN index_addresses a3 ON (a3.id=m.source_id)
            WHERE pk.pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        // Attestation quality is keyed by the RAW pubkey string (attest_validator_stats has
        // no index_pubkeys id), one row per provider the validator serves.
        let attestationQuality = await this.doQuery(config,
            `SELECT
                m.id,
                m.validator_pubkey,
                m.provider_id,
                m.fulfilled_count,
                m.missed_count,
                m.slashed_count,
                m.quality_score,
                m.last_updated_block
            FROM
                attest_validator_stats m
            WHERE m.validator_pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);

        let capabilities = await this._validatorCapabilityRows(config, pubkey, limit);

        // The hub registry decorates, never gates: getFederationRegistry returns null when
        // no registry is reachable at all, and null means UNKNOWN, not "unregistered".
        let registry = await this.getFederationRegistry(config);
        let entry    = (registry && pubkey) ? registry[String(pubkey).toLowerCase()] : null;

        return [{
            query:              search,
            signing_pubkey:     pubkey,
            source:             source,
            stake_action_index: row.stake_action_index,
            version:            row.version,
            activation_block:   row.activation_block,
            deactivation_block: row.deactivation_block,
            block_index:        row.block_index,
            registry:           (entry) ? entry : null,
            registry_known:     (registry !== null),
            active_stake:       this.util.bcformat((totals && totals.length) ? totals[0].active_stake : 0, 8),
            position_count:     (totals && totals.length) ? Number(totals[0].position_count) : 0,
            capabilities:       capabilities,
            stakes:             stakes      || [],
            unstakes:           unstakes    || [],
            delegations:        delegations || [],
            revocations:        revocations || [],
            rotations:          rotations   || [],
            rewards:            rewards     || [],
            rewards_total:      claimable.rewards_total,
            collected_total:    claimable.collected_total,
            claimable:          claimable.claimable,
            collects:           claimable.collects,
            capability_slash_events: capabilitySlashes || [],
            slash_events:            contractSlashes   || [],
            nodeproofs:              nodeproofs        || [],
            attestation_quality:     attestationQuality || []
        }];
    }

    // The COLLECT trail for ONE staking address, shared by the validator page and the
    // address staking panel so the two can never disagree about what "claimable" means.
    // Accrual (validator_rewards) minus claims (reward_claims), both summed in SQL over an
    // indexed source_id lookup rather than over a fetched page, because a page-local sum
    // would silently under-report the moment a validator has more rows than one page.
    async _collectTrail(config, source, limit){
        let accrued = await this.doQuery(config,
            `SELECT COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as total
             FROM validator_rewards m
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
             WHERE a2.address=?`, [source]);
        let claimed = await this.doQuery(config,
            `SELECT COALESCE(SUM(CAST(m.amount AS DECIMAL(65,18))),0) as total
             FROM reward_claims m
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
             WHERE s1.status='valid' AND a2.address=?`, [source]);
        let collects = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.amount,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                reward_claims m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [source]);
        // One wire type for all three figures: a fixed-8 decimal STRING, matching how
        // every other XCHAIN amount is serialized. The SQL sums come back at the CAST's
        // 18 decimal places and bcsub returns a mathjs bignumber OBJECT, so both are
        // formatted rather than passed through; an unformatted bignumber serializes as a
        // mathjs envelope, not as a number a page can print.
        let accruedTotal = (accrued && accrued.length) ? accrued[0].total : 0;
        let claimedTotal = (claimed && claimed.length) ? claimed[0].total : 0;
        return {
            rewards_total:   this.util.bcformat(accruedTotal, 8),
            collected_total: this.util.bcformat(claimedTotal, 8),
            claimable:       this.util.bcformat(this.util.bcsub(accruedTotal, claimedTotal, 8), 8),
            collects:        collects || []
        };
    }

    // Per-capability qualification rows for ONE signing pubkey, on the same dual transport
    // getValidatorCapabilities serves the list view over. Kept as its own helper so the
    // composition cannot drift into a second, differently-degrading copy of that rule.
    // The RPC leg filters server-side by signing_pubkey; an EMPTY array back is a legitimate
    // "qualified for nothing", while a null past the stale ceiling is an OUTAGE and throws.
    async _validatorCapabilityRows(config, pubkey, limit){
        let ops = this.explorer ? this.explorer.hubOperational : null;
        if(ops && ops.enabled()){
            let rows = await ops.getValidatorCapabilities({ signing_pubkey: pubkey });
            if(rows) return this._normalizeHubOperationalRows(rows.slice(0, limit));
            this._hubOperationalOutage('validator_capabilities');
        }
        let src  = this._hubSource(config, 'validator_capabilities');
        let rows = await this.doQuery(config,
            `SELECT
                m.id,
                m.signing_pubkey,
                m.capability,
                m.qualified,
                m.self_test_ok,
                m.enabled,
                m.qualified_at_block,
                m.updated_at
            FROM ${src.table} m
            WHERE m.signing_pubkey=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [pubkey]);
        return this._normalizeHubOperationalRows(rows || []);
    }

    // Composed ADDRESS STAKING panel (M4.6). One address, four questions the raw tabs below
    // it cannot answer together: what is staked, what is cooling down and when it matures,
    // what is claimable, and what has been slashed out from under it.
    //
    // Maturity is computed against the indexer's own tip (getMaxBlockIndex), not wall clock,
    // so every explorer host answers identically and the number matches the consensus rule
    // that releases the funds.
    //
    // Slash exposure has to reach the address through the KEYS it staked with, because
    // neither slash table carries an address of the slashed party: capability_slash_events
    // and slash_events both name a signing pubkey. So each family is scoped by the pubkey set
    // this address staked, drawn from the ledger that family actually burns from (`stakes`
    // for the capability family, `contract_stakes` for the contract family). Scoping both
    // from one ledger would over- or under-report, depending which one was picked.
    async getAddressStaking(config){
        let limit   = this._detailLimit(config);
        let address = config.data.search;
        if(this.util.isNull(address)) return [null];
        let tip = await this.getMaxBlockIndex(config);

        let positions = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.version,
                a3.pubkey as signing_pubkey,
                m.target_contract_index,
                t3.tick,
                m.amount,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                contract_stakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

        let capabilityPositions = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.version,
                a3.pubkey as signing_pubkey,
                m.amount,
                m.activation_block,
                m.deactivation_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                stakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

        let cooldowns = await this.doQuery(config,
            `SELECT
                m.action_index,
                a3.pubkey as signing_pubkey,
                m.target_contract_index,
                t3.tick,
                m.amount,
                m.cooldown_end_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                contract_unstakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

        let capabilityCooldowns = await this.doQuery(config,
            `SELECT
                m.action_index,
                a3.pubkey as signing_pubkey,
                m.amount,
                m.cooldown_end_block,
                m.block_index,
                b1.block_time as timestamp,
                s1.status
            FROM
                unstakes m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
                LEFT  JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE a2.address=?
            ORDER BY m.action_index DESC
            LIMIT ` + limit, [address]);

        for(let row of [...(cooldowns || []), ...(capabilityCooldowns || [])]){
            let end = Number(row.cooldown_end_block);
            row.blocks_remaining = Math.max(0, end - tip);
            row.matured          = tip >= end;
        }

        let trail = await this._collectTrail(config, address, limit);
        let rewards = await this.doQuery(config,
            `SELECT
                m.id,
                a3.pubkey as signing_pubkey,
                m.reward_type,
                m.round_reference,
                m.amount,
                m.block_index,
                b1.block_time as timestamp
            FROM
                validator_rewards m
                INNER JOIN blocks          b1 ON (b1.block_index=m.block_index)
                INNER JOIN index_addresses a2 ON (a2.id=m.source_id)
                LEFT  JOIN index_pubkeys   a3 ON (a3.id=m.signing_pubkey_id)
            WHERE a2.address=?
            ORDER BY m.id DESC
            LIMIT ` + limit, [address]);

        // Row shape matches getCapabilitySlashEvents and the validator page's slash
        // leg (slashed key + submitter + destination), so the same slash reads
        // identically wherever it surfaces.
        let capabilitySlashes = await this.doQuery(config,
            `SELECT
                m.id,
                m.slash_action_index,
                pk.pubkey as slashed_pubkey,
                m.capability,
                m.equiv_key,
                m.amount,
                m.bounty_amount,
                m.treasury_amount,
                sub.address as submitter,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                capability_slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   pk  ON (pk.id=m.signing_pubkey_id)
                LEFT  JOIN index_addresses sub ON (sub.id=m.submitter_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE m.signing_pubkey_id IN (
                SELECT s.signing_pubkey_id FROM stakes s
                    INNER JOIN index_addresses sa ON (sa.id=s.source_id)
                WHERE sa.address=?)
            ORDER BY m.id DESC
            LIMIT ` + limit, [address]);

        let contractSlashes = await this.doQuery(config,
            `SELECT
                m.id,
                m.execution_index,
                m.target_contract_index,
                pk.pubkey as slashed_pubkey,
                t3.tick,
                m.amount,
                dst.address as destination,
                m.block_index,
                b1.block_time as timestamp
            FROM
                slash_events m
                INNER JOIN blocks          b1  ON (b1.block_index=m.block_index)
                LEFT  JOIN index_pubkeys   pk  ON (pk.id=m.signing_pubkey_id)
                LEFT  JOIN index_tickers   t3  ON (t3.id=m.tick_id)
                LEFT  JOIN index_addresses dst ON (dst.id=m.destination_id)
            WHERE m.signing_pubkey_id IN (
                SELECT cs.signing_pubkey_id FROM contract_stakes cs
                    INNER JOIN index_addresses sa ON (sa.id=cs.source_id)
                WHERE sa.address=?)
            ORDER BY m.id DESC
            LIMIT ` + limit, [address]);

        return [{
            address:              address,
            chain_tip:            tip,
            positions:            positions           || [],
            capability_positions: capabilityPositions || [],
            cooldowns:            cooldowns           || [],
            capability_cooldowns: capabilityCooldowns || [],
            rewards:              rewards             || [],
            rewards_total:        trail.rewards_total,
            collected_total:      trail.collected_total,
            claimable:            trail.claimable,
            collects:             trail.collects,
            capability_slash_events: capabilitySlashes || [],
            slash_events:            contractSlashes   || []
        }];
    }

}

// The families that have moved out under proposal B are attached here, after the
// class exists. Order is irrelevant: mixinReaders refuses a collision rather than
// letting require order decide a winner.
mixinReaders(Database.prototype, connectionMethods, queryBuilder,
    actionListReaders, marketReaders, stakingGovernanceReaders, checkpointReaders,
    entityReaders, actionDetailIoReaders, healthReaders, projectReaders,
    contractReaders, pollBetReaders, xcallReaders);

module.exports = Database;
module.exports.DbQueryError = DbQueryError;
module.exports.DbInputError = DbInputError;
module.exports.ACTION_SUMMARY_FIELDS = ACTION_SUMMARY_FIELDS;
module.exports.MUTABLE_ACTION_FIELDS = MUTABLE_ACTION_FIELDS;