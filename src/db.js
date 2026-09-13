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

const crypto  = require('crypto');
const { extractMethods } = require('./contract-introspect.js');

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
const healthReaders            = require('./db/readers/health.js');
const entityReaders            = require('./db/readers/entities.js');
const actionDetailIoReaders    = require('./db/readers/action_detail_io.js');

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

    /******************************************************************
     * Project Registry queries (protocol/Project_Registry.md)
     *
     * A project's current roster is the TICK-type LIST referenced by
     * the most recent valid LINK targeting one of the project tick's
     * valid ISSUE actions, with BOTH sides on the local chain (LINK
     * skips owner validation when COIN2 is remote, so cross-chain
     * roster links carry no authority). Authority comes from LINK's
     * owner validation at processing time; display only needs
     * status='valid' rows.
     ******************************************************************/

    // Resolve a project tick's current roster. Returns
    // { roster_action_index, membership_action_index, link_action_index, total }
    // or null when the tick has never had an owner-valid roster link.
    //
    // roster_action_index is what the LINK pinned (the list's identity, and the
    // index the UI links to); membership_action_index is the action whose
    // list_items rows are the roster's CURRENT membership. Those differ once the
    // list has been edited, because a LIST edit writes the resulting membership
    // under the EDIT's own action_index and never touches the parent's rows.
    // Every roster consumer below reads members through the membership
    // index, so a project that dropped or added a token shows the roster the
    // chain is enforcing rather than the one it shipped with. Flag-day gated at
    // the tip by _isListEditResolutionActiveAtTip, so below the height the two
    // indexes are equal and the legacy create-index read runs unchanged.
    async getProjectRosterInfo(config, tick){
        let chain = this.baseCoin ? this.baseCoin[config.coin] : null;
        if(this.util.isNull(chain) || this.util.isNull(tick)) return null;
        let query = `SELECT
                        l.action_index       AS link_action_index,
                        l.coin1_action_index AS roster_action_index
                    FROM
                        links l
                        INNER JOIN index_statuses s1 ON (s1.id=l.status_id AND s1.status='valid')
                        INNER JOIN index_coins    c1 ON (c1.id=l.coin1_id AND c1.coin=?)
                        INNER JOIN index_coins    c2 ON (c2.id=l.coin2_id AND c2.coin=?)
                        INNER JOIN issues         i1 ON (i1.action_index=l.coin2_action_index)
                        INNER JOIN index_statuses s2 ON (s2.id=i1.status_id AND s2.status='valid')
                        INNER JOIN index_tickers  t1 ON (t1.id=i1.tick_id AND t1.tick=?)
                        INNER JOIN lists          ls ON (ls.action_index=l.coin1_action_index AND ls.type='1')
                        INNER JOIN index_statuses s3 ON (s3.id=ls.status_id AND s3.status='valid')
                    ORDER BY l.action_index DESC
                    LIMIT 1`;
        let rows = await this.doQuery(config, query, [chain, chain, tick]);
        if(!rows || !rows.length) return null;
        let info = {
            roster_action_index:     Number(rows[0].roster_action_index),
            membership_action_index: Number(rows[0].roster_action_index),
            link_action_index:       Number(rows[0].link_action_index),
            total: 0
        };
        if(await this._isListEditResolutionActiveAtTip(config))
            info.membership_action_index = Number(await this.getListHeadIndex(config, info.roster_action_index));
        let count = await this.doQuery(config, `SELECT count(*) AS total FROM list_items WHERE action_index=?`, [info.membership_action_index]);
        if(count && count.length)
            info.total = Number(count[0].total);
        return info;
    }

    // Projects whose CURRENT roster includes the given tick (the reverse
    // lookup behind the token-page "Official: part of X" banner). A project
    // whose latest roster dropped the tick does not match - which, once
    // edit resolution is live, includes a roster that dropped it by LIST
    // EDIT and not only one replaced by a newer LINK. The edit's membership
    // lives under the EDIT's action_index, so the membership join has to run
    // against each project's resolved chain head, not the index the LINK pinned.
    //
    // That head is per-project, so the membership filter moves out of SQL: the
    // candidate query returns one row per project (exactly the row count the old
    // inner GROUP BY already produced), heads resolve for the whole set in a
    // bounded number of queries, and one final query asks which of those heads
    // list the tick. Below the flag day the original single-query form runs
    // unchanged, because consensus is still reading the pinned create's rows.
    async getTokenProjects(config, tick){
        let chain = this.baseCoin ? this.baseCoin[config.coin] : null;
        if(this.util.isNull(chain) || this.util.isNull(tick)) return [];
        // Latest owner-valid roster LINK per project, newest link first.
        let latestRosterLinks = `FROM (
                        SELECT
                            i1.tick_id,
                            MAX(l.action_index) AS link_action_index
                        FROM
                            links l
                            INNER JOIN index_statuses s1 ON (s1.id=l.status_id AND s1.status='valid')
                            INNER JOIN index_coins    c1 ON (c1.id=l.coin1_id AND c1.coin=?)
                            INNER JOIN index_coins    c2 ON (c2.id=l.coin2_id AND c2.coin=?)
                            INNER JOIN issues         i1 ON (i1.action_index=l.coin2_action_index)
                            INNER JOIN index_statuses s2 ON (s2.id=i1.status_id AND s2.status='valid')
                            INNER JOIN lists          ls ON (ls.action_index=l.coin1_action_index AND ls.type='1')
                            INNER JOIN index_statuses s3 ON (s3.id=ls.status_id AND s3.status='valid')
                        GROUP BY i1.tick_id
                    ) latest
                        INNER JOIN links          lk ON (lk.action_index=latest.link_action_index)`;
        let select = `SELECT
                        t1.tick                AS project,
                        latest.link_action_index,
                        lk.coin1_action_index  AS roster_action_index
                    `;
        if(!(await this._isListEditResolutionActiveAtTip(config))){
            let query = select + latestRosterLinks + `
                        INNER JOIN list_items     li ON (li.action_index=lk.coin1_action_index)
                        INNER JOIN index_tickers  t2 ON (t2.id=li.item_id AND t2.tick=?)
                        INNER JOIN index_tickers  t1 ON (t1.id=latest.tick_id)
                    ORDER BY latest.link_action_index DESC`;
            let rows = await this.doQuery(config, query, [chain, chain, tick]);
            if(!rows || !rows.length) return [];
            return rows.map(r => ({
                project:                 r.project,
                link_action_index:       Number(r.link_action_index),
                roster_action_index:     Number(r.roster_action_index),
                membership_action_index: Number(r.roster_action_index)
            }));
        }
        let candidates = await this.doQuery(config, select + latestRosterLinks + `
                        INNER JOIN index_tickers  t1 ON (t1.id=latest.tick_id)
                    ORDER BY latest.link_action_index DESC`, [chain, chain]);
        if(!candidates || !candidates.length) return [];
        let heads   = await this.getListHeadIndexes(config, candidates.map(r => Number(r.roster_action_index)));
        let rosters = candidates.map(r => ({
            project:                 r.project,
            link_action_index:       Number(r.link_action_index),
            roster_action_index:     Number(r.roster_action_index),
            membership_action_index: Number(heads[String(Number(r.roster_action_index))])
        }));
        let indexes = [...new Set(rosters.map(r => r.membership_action_index))];
        let members = await this.doQuery(config, `SELECT
                        li.action_index
                    FROM
                        list_items    li
                        INNER JOIN index_tickers t2 ON (t2.id=li.item_id AND t2.tick=?)
                    WHERE
                        li.action_index IN (` + indexes.map(() => '?').join(',') + `)
                    GROUP BY li.action_index`, [tick, ...indexes]);
        let listing = {};
        for(let row of (members || [])) listing[String(Number(row['action_index']))] = true;
        return rosters.filter(r => listing[String(r.membership_action_index)] === true);
    }

    /******************************************************************
     * Controller bindings (protocol/Controller_Bound_Tokens.md)
     *
     * token_controllers / address_controllers are append-only bind/unbind
     * event logs. The effective (still-gating) controller for a
     * (subject, action_class) is the latest event by action_index, with a
     * read-time cooldown: a `bind` always gates; an `unbind` gates only while
     * the chain tip is below its cooldown_end_block. This mirrors the indexer's
     * readEffectiveControllerMap / controllerEventIfGating (xchain-indexer
     * src/db.js) so the explorer surfaces exactly what consensus enforces.
     ******************************************************************/

    // Reduce an append-only controller event log (token_controllers /
    // address_controllers) to the array of bindings that are still gating at the
    // chain tip. keyColumn is tick_id / address_id. Returns the shared shape:
    // [{ action_class, contract_index, cooldown_blocks, is_unbind, bind_block, bound_by }].
    async _resolveControllerBindings(config, table, keyColumn, keyValue){
        if(this.util.isNull(keyValue)) return [];
        // token_controllers carries bound_by_id (the token owner who signed the event);
        // address_controllers has no such column so bound_by is NULL for address-scoped bindings.
        let boundBySelect = (table === 'token_controllers')
            ? `,\n                        signer.address AS bound_by`
            : `,\n                        NULL AS bound_by`;
        let boundByJoin = (table === 'token_controllers')
            ? `\n                    LEFT JOIN index_addresses signer ON (signer.id=c.bound_by_id)`
            : '';
        let query = `SELECT
                        c.action_class,
                        c.action_index,
                        c.contract_index,
                        c.is_unbind,
                        c.cooldown_blocks,
                        c.cooldown_end_block,
                        c.block_index` + boundBySelect + `
                    FROM ${table} c` + boundByJoin + `
                    WHERE c.${keyColumn}=?
                    ORDER BY c.action_index ASC`;
        let rows = await this.doQuery(config, query, [keyValue]);
        if(!rows || !rows.length) return [];
        // Latest event per action_class wins (rows are action_index ASC, so the
        // last seen for each class is the highest action_index).
        let latest = new Map();
        for(let row of rows)
            latest.set(row.action_class, row);
        // Read-time cooldown: resolve the chain tip once and gate each unbind.
        let tip = await this.getMaxBlockIndex(config);
        let bindings = [];
        for(let [, row] of latest){
            // controllerEventIfGating: a bind always gates; an unbind gates only
            // while tip < cooldown_end_block (and never when it's NULL).
            if(Number(row.is_unbind) === 1){
                if(this.util.isNull(row.cooldown_end_block)) continue;
                if(Number(tip) >= Number(row.cooldown_end_block)) continue;
            }
            bindings.push({
                action_class:   row.action_class,
                contract_index: Number(row.contract_index),
                cooldown_blocks: Number(row.cooldown_blocks),
                is_unbind:      Number(row.is_unbind),
                bind_block:     Number(row.block_index),
                bound_by:       row.bound_by || null
            });
        }
        return bindings;
    }

    // Controller bindings still gating a token (token-page display surface).
    async getTokenControllerBindings(config, tick){
        let tick_id = await this.getTickId(config, tick);
        return this._resolveControllerBindings(config, 'token_controllers', 'tick_id', tick_id);
    }

    // Controller bindings still gating an address (address-page display surface).
    async getAddressControllerBindings(config, address){
        let address_id = await this.getAddressId(config, address);
        return this._resolveControllerBindings(config, 'address_controllers', 'address_id', address_id);
    }

    // Project detail (API endpoint): project tick + roster metadata + member
    // tokens. Members are capped at 1000 per response; `total` always carries
    // the full roster size.
    async getProject(config){
        let tick = config.data.search;
        let info = await this.getProjectRosterInfo(config, tick);
        if(!info) return [null];
        let query = `SELECT
                        t3.tick,
                        m.supply,
                        m.max_supply,
                        m.decimals,
                        m.lock_max_supply
                    FROM
                        list_items li
                        INNER JOIN tokens        m  ON (m.tick_id=li.item_id)
                        INNER JOIN index_tickers t3 ON (t3.id=m.tick_id)
                    WHERE
                        li.action_index=?
                    ORDER BY t3.tick ASC
                    LIMIT 1000`;
        let rows = await this.doQuery(config, query, [info.membership_action_index]);
        let data = {
            // Echo the tick exactly as it was looked up. Uppercasing it here while the
            // lookup stays case-sensitive means the value handed back does not resolve:
            // feed it into /api/project/{TICK} for any tick that is not already all
            // upper case and the round trip 404s. The roster and /explorer routes were
            // never affected, because neither echoes the tick.
            tick:                    String(tick),
            roster_action_index:     info.roster_action_index,
            membership_action_index: info.membership_action_index,
            link_action_index:       info.link_action_index,
            total:                   info.total,
            members:                 []
        };
        if(rows && rows.length){
            data.members = rows.map(r => ({
                tick:            r.tick,
                supply:          r.supply,
                max_supply:      r.max_supply,
                decimals:        Number(r.decimals),
                lock_max_supply: Number(r.lock_max_supply)
            }));
        }
        return [data];
    }

    // SQL-builder for the explorer roster datatable (token-page "Official
    // Tokens" tab): member tokens of the project's current roster, shaped
    // exactly like getTokens rows.
    async getProjectTokens(config){
        let sql  = config.data.sql;
        let info = await this.getProjectRosterInfo(config, config.data.search);
        // No roster → empty datatable (object query short-circuits getData)
        if(!info) return [[], [], 0];
        let args  = [info.membership_action_index];
        let count = `SELECT
                        count(*) as total
                    FROM
                        tokens m
                        INNER JOIN list_items         li ON (li.item_id=m.tick_id AND li.action_index=?)
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        t3.tick,
                        m.supply,
                        m.max_supply,
                        m.max_mint,
                        m.decimals,
                        m.lock_max_supply,
                        m.lock_mint,
                        m.lock_mint_supply,
                        m.lock_max_mint,
                        m.lock_description,
                        m.lock_sleep,
                        m.lock_callback,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index
                    FROM
                        tokens m
                        INNER JOIN list_items         li ON (li.item_id=m.tick_id AND li.action_index=?)
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY t3.tick ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Resolve the PARENT market for any BET-family action, so a ws lifecycle event can
    // be routed to the `bet_feed:<feed_index>` entity channel. BET is one action name
    // over four formats, so the parent is wherever the action landed:
    //   format 0 (create) -> the feed row itself, whose id IS this action_index
    //   format 2 (place)  -> bets.feed_action_index
    //   formats 1/3 + BET_EXPIRE -> bet_feed_statuses.feed_action_index (the status row
    //   the cancel/resolve/expire wrote). Checked in that order; the first hit wins.
    // Returns null when nothing matches (a rejected BET writes no child row), which the
    // caller treats as non-fatal and emits without a parent index.
    async getBetActionFeedIndex(config, actionIndex) {
        let feed = await this.doQuery(config,
            `SELECT action_index FROM bet_feeds WHERE action_index=? LIMIT 1`, [actionIndex]);
        if (feed && feed.length) return feed[0].action_index;
        let bet = await this.doQuery(config,
            `SELECT feed_action_index FROM bets WHERE action_index=? LIMIT 1`, [actionIndex]);
        if (bet && bet.length && bet[0].feed_action_index != null) return bet[0].feed_action_index;
        let st = await this.doQuery(config,
            `SELECT feed_action_index FROM bet_feed_statuses WHERE action_index=? ORDER BY feed_action_index ASC LIMIT 1`, [actionIndex]);
        if (st && st.length && st[0].feed_action_index != null) return st[0].feed_action_index;
        return null;
    }

    // Feeds whose `closed` deadline latch was stamped above `sinceBlock`, oldest
    // first. This is the ws layer's SECOND cursor and it exists because the latch is
    // the one BET transition with no action row: the end-of-block pass writes
    // bet_feeds.closed_block directly (spec §6), so the ChangeDetector's actions
    // cursor has nothing to see and a subscribed market page never learns that
    // betting closed. closed_block IS the durable record of that write, and
    // it is also what the reorg reset clears, so a rolled-back-then-re-latched feed
    // re-emits naturally.
    // Ordered by closed_block ASC (then action_index) because the caller advances a
    // block-height high-water mark and must be able to stop on a whole-block boundary.
    async getBetFeedsClosedSince(config, sinceBlock, limit) {
        let query = `SELECT
                        m.action_index,
                        m.closed_block,
                        m.deadline,
                        m.expire_at,
                        a2.address as source,
                        pt.tick,
                        fs.status as feed_status
                    FROM
                        bet_feeds m
                        INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers   pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses  fs ON (fs.id=m.feed_status_id)
                    WHERE
                        m.closed_block > ?
                    ORDER BY m.closed_block ASC, m.action_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlock, limit]);
        return results || [];
    }

    // Deployed contracts. Every contract query is an explicit column list, so the
    // four meta_* columns (spec contract-meta-manifest 2.5) are named here as well
    // as on getContract; meta_json is parsed into the nested `meta` object by
    // getData's post-pass, the same shape the single-contract route serves.
    //
    // The `name` lane binds the FULLTEXT term the WHERE clause built (see
    // getQueryWhereSql), which is the one filter on this method whose bind value is
    // not the raw path segment: BOOLEAN MODE reads +, -, *, ", ( ), ~, < > and @ as
    // operators, so an unsanitized term is a query-syntax injection into the search
    // itself. A term left with nothing to match after sanitizing returns the empty
    // page rather than a MATCH that would match everything.
    async getContracts(config){
        let sql   = config.data.sql;
        let args  = null;
        if(config.data.type=='name'){
            let term = this.fulltextTerm(config.data.search);
            if(term === '') return [[], null, 0];
            args = [term];
        }
        let count = `SELECT
                        count(*) as total
                    FROM
                        contracts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.code_hash,
                        m.api_version,
                        m.cooldown_blocks,
                        sd.address as slash_destination,
                        m.meta_name,
                        m.meta_description,
                        m.meta_version,
                        m.meta_json,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contracts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    sd ON (sd.id=m.slash_destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Get single CONTRACT by action_index. Data method (returns [data]): the
    // /api/contract/{idx} route serves a single record, not a datatable (the
    // explorer contract listing uses getContracts). The LEFT JOIN surfaces the
    // contract's permissions manifest (contract_permissions; null when none).
    async getContract(config){
        let data  = null;
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.code,
                        m.code_hash,
                        m.api_version,
                        m.cooldown_blocks,
                        sd.address as slash_destination,
                        m.meta_name,
                        m.meta_description,
                        m.meta_version,
                        m.meta_json,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status,
                        cp.permissions,
                        cp.max_take_bps
                    FROM
                        contracts m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    sd ON (sd.id=m.slash_destination_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                        LEFT  JOIN contract_permissions cp ON (cp.contract_index=m.action_index)
                    WHERE ` + sql.where.data + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            // Permissions manifest (protocol/Controller_Bound_Tokens.md): the
            // declared emission allowlist + per-contract fee cap. permissions is
            // stored as a JSON array (NULL = unrestricted / no manifest); parse
            // it, falling back to null on absence or malformed JSON. max_take_bps
            // is NULL when the global cap applies.
            let permissions = null;
            if(!this.util.isNull(row.permissions)){
                try { permissions = JSON.parse(row.permissions); }
                catch(e){ permissions = null; }
            }
            row.permissions  = permissions;
            row.max_take_bps = this.util.isNull(row.max_take_bps) ? null : Number(row.max_take_bps);
            // Contract identity manifest (spec contract-meta-manifest 2.1): the three
            // extracted columns ride flat beside permissions, and the whole declared
            // object rides nested as `meta`, the way `abi` already does. meta_json
            // holds the isolate's own JSON.stringify bytes; parse it here so no
            // consumer has to (and so a malformed one is null rather than a string).
            this.attachContractMeta(row);
            // action_index stays the driver's BIGINT so utility.jsonStringify emits the
            // exact decimal string openapi's info.description promises; a Number() here
            // collapsed values above 2^53 and made it the one index in this row typed
            // unlike its own block_index (contract standardized in 38cc1d9).
            // The constructor lookup below binds it as a BigInt, never a quoted string,
            // which MariaDB would compare against a BIGINT column as a DOUBLE.
            if(this.util.isNull(row.action_index)) row.action_index = null;

            // Source integrity: the chain carries the source itself, so
            // "verified contract" reduces to hashing what we serve. A mismatch
            // can only mean a corrupted indexer row; surface it, never hide it.
            let computedHash = this.util.isNull(row.code) ? null
                : crypto.createHash('sha256').update(row.code).digest('hex');
            row.code_hash_ok = computedHash !== null && computedHash === row.code_hash;

            // Callable method surface + optional self-declared abi metadata
            // via AST extraction (presentation-only; methods null = shape
            // unrecognized and the UI shows "unknown"; abi null = none
            // declared or malformed, UI falls back to name-only forms).
            // Cache key is the digest WE computed, never the stored code_hash:
            // introspection is a pure function of the code, and a row whose
            // stored hash mismatches its code must not poison (or read) the
            // entry of the code that hash really belongs to.
            let introspected = computedHash === null ? { methods: null, abi: null }
                : this._cacheGet(this._methodsCache, computedHash);
            if(introspected === undefined){
                try {
                    let ex = extractMethods(row.code);
                    introspected = { methods: ex.methods, abi: ex.abi };
                } catch(e){
                    introspected = { methods: null, abi: null };
                }
                this._cacheSet(this._methodsCache, computedHash, introspected);
            }
            row.methods = introspected.methods;
            row.abi     = introspected.abi;

            // Deploy-time constructor arguments: the indexer records the
            // constructor run in contract_executions under the literal method
            // name 'constructor', keyed by the DEPLOY's own action_index.
            try {
                let ctor = await this.doQuery(config,
                    `SELECT input_params FROM contract_executions WHERE action_index=? AND method_name='constructor' LIMIT 1`,
                    [row.action_index]);
                row.constructor_params = (ctor && ctor.length && !this.util.isNull(ctor[0].input_params)) ? String(ctor[0].input_params) : null;
            } catch(e){
                row.constructor_params = null;
            }

            // Feature discovery for the contract page's Read Contract card:
            // mirrors the env gate on POST /{COIN}/api/contract/{idx}/call.
            row.vm_query_enabled = process.env.EXPLORER_VM_QUERY_ENABLED === 'true';

            // Wallet handoff target for the Write Contract card. An explicitly
            // EMPTY EXPLORER_WALLET_URL disables the card, so only default over
            // an unset variable, never over ''.
            row.wallet_url = process.env.EXPLORER_WALLET_URL !== undefined
                ? process.env.EXPLORER_WALLET_URL : 'https://wallet.xchain.io';

            data = row;
        }
        return [data];
    }

    // Turn a contracts row's stored meta_json into the nested `meta` object every
    // contract-bearing response carries, and drop the raw column: a consumer that
    // had to JSON.parse a string field would eventually forget to, and the two
    // forms of the same value on one row is the drift that produces. A row whose
    // meta_json is absent, unparseable, or not a plain object gets meta null; the
    // three flat columns are served exactly as stored (the author's own bytes,
    // hardened at render, never here).
    attachContractMeta(row){
        if(!row || typeof row !== 'object') return row;
        let meta = null;
        if(!this.util.isNull(row.meta_json)){
            try {
                let parsed = JSON.parse(row.meta_json);
                if(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
                    meta = parsed;
            } catch(e){ meta = null; }
        }
        row.meta = meta;
        delete row.meta_json;
        return row;
    }

    // One search row's share of a contract description: enough to tell two hits
    // apart, short enough that a 512-byte description cannot take over the results
    // list. Truncated on characters, not bytes, because the consumer is a table
    // cell. The bytes are otherwise the author's own and are hardened at render,
    // never here.
    _metaSnippet(description){
        const SNIPPET_MAX = 160;
        if(this.util.isNull(description)) return null;
        let s = String(description);
        return (s.length > SNIPPET_MAX) ? s.slice(0, SNIPPET_MAX - 1) + '…' : s;
    }

    // Get a contract's permissions manifest (protocol/Controller_Bound_Tokens.md):
    // the declared emission allowlist + per-contract fee cap, or null when the
    // contract declared no manifest. permissions is a JSON array on the wire
    // (NULL = unrestricted); parse it, falling back to null on malformed JSON.
    async getContractManifest(config, contractIndex){
        if(this.util.isNull(contractIndex)) return null;
        let query = `SELECT permissions, max_take_bps
                     FROM contract_permissions
                     WHERE contract_index=?
                     LIMIT 1`;
        let rows = await this.doQuery(config, query, [contractIndex]);
        if(!rows || !rows.length) return null;
        let row = rows[0];
        let permissions = null;
        if(!this.util.isNull(row.permissions)){
            try { permissions = JSON.parse(row.permissions); }
            catch(e){ permissions = null; }
        }
        return {
            permissions:  permissions,
            max_take_bps: this.util.isNull(row.max_take_bps) ? null : Number(row.max_take_bps)
        };
    }

    async getContractState(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_state cs
                        INNER JOIN (
                            SELECT state_key, MAX(id) as max_id
                            FROM contract_state
                            WHERE contract_index=?
                            GROUP BY state_key
                        ) latest ON (latest.max_id=cs.id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        cs.id,
                        cs.contract_index,
                        cs.state_key,
                        cs.state_value,
                        cs.block_index
                    FROM
                        contract_state cs
                        INNER JOIN (
                            SELECT state_key, MAX(id) as max_id
                            FROM contract_state
                            WHERE contract_index=?
                            GROUP BY state_key
                        ) latest ON (latest.max_id=cs.id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY cs.state_key ASC
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Load a contract's FULL current state in the shape the VM consumes,
    // mirroring the indexer's own loader (xchain-indexer/src/db.js
    // getContractState): latest non-null row per key, values JSON-parsed with
    // raw-string fallback. Null-prototype object so adversarial keys like
    // '__proto__' round-trip instead of hitting the setter. Used only by the
    // read-only simulation endpoint (vm-query.js), not the datatable route.
    //
    // The endpoint is public and the VM's maxStateKeys only bounds NEW writes,
    // not the initial load, so the caller passes hard row/byte caps and a
    // cheap aggregate pre-check refuses oversized state BEFORE the multi-MB
    // row fetch. Throws code 'STATE_TOO_LARGE' past either cap.
    async getContractFullState(config, contractIndex, limits){
        let maxRows  = limits && limits.maxRows  > 0 ? Math.floor(limits.maxRows)  : 10000;
        let maxBytes = limits && limits.maxBytes > 0 ? Math.floor(limits.maxBytes) : 4 * 1024 * 1024;
        let gateQuery = `SELECT COUNT(*) as total_rows, COALESCE(SUM(LENGTH(cs.state_value)), 0) as total_bytes
                     FROM contract_state cs
                     INNER JOIN (
                         SELECT MAX(id) as max_id
                         FROM contract_state
                         WHERE contract_index = ?
                         GROUP BY state_key
                     ) latest ON (cs.id = latest.max_id)
                     WHERE cs.state_value IS NOT NULL`;
        let gate = await this.doQuery(config, gateQuery, [contractIndex]);
        let totalRows  = gate && gate.length ? Number(gate[0].total_rows)  : 0;
        let totalBytes = gate && gate.length ? Number(gate[0].total_bytes) : 0;
        if(totalRows > maxRows || totalBytes > maxBytes){
            let err  = new Error('contract state too large to load for simulation (' + totalRows + ' keys, ' + totalBytes + ' bytes)');
            err.code = 'STATE_TOO_LARGE';
            throw err;
        }
        // LIMIT is belt-and-braces for rows written between the two queries.
        let query = `SELECT cs.state_key, cs.state_value
                     FROM contract_state cs
                     INNER JOIN (
                         SELECT MAX(id) as max_id
                         FROM contract_state
                         WHERE contract_index = ?
                         GROUP BY state_key
                     ) latest ON (cs.id = latest.max_id)
                     WHERE cs.state_value IS NOT NULL
                     LIMIT ` + maxRows;
        let results = await this.doQuery(config, query, [contractIndex]);
        let state = Object.create(null);
        let loadedBytes = 0;
        for(let row of (results || [])){
            // Re-verify the byte budget against the rows actually fetched: the
            // aggregate gate above and this SELECT are two separate queries, so
            // state written between them can push the real payload past the cap
            // the gate approved (TOCTOU). LIMIT bounds row count; this bounds bytes.
            loadedBytes += row.state_value == null ? 0 : Buffer.byteLength(String(row.state_value));
            if(loadedBytes > maxBytes){
                let err  = new Error('contract state exceeded simulation byte budget while loading (>' + maxBytes + ' bytes)');
                err.code = 'STATE_TOO_LARGE';
                throw err;
            }
            try { state[row.state_key] = JSON.parse(row.state_value); }
            catch(e){ state[row.state_key] = row.state_value; }
        }
        return state;
    }

    // Get contract custody balances; custody lives in the standard `balances`
    // table under the contract's derived address C:<CHAIN>:<action_index>.
    async getContractBalance(config){
        let sql     = config.data.sql;
        let chain   = this.baseCoin ? this.baseCoin[config.coin] : null;
        let address = 'C:' + chain + ':' + config.data.search;
        let args    = [address];
        let count = `SELECT
                        count(*) as total
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        t3.tick,
                        m.amount
                    FROM
                        balances m
                        LEFT  JOIN index_tickers   t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_addresses a2 ON (a2.id=m.address_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY t3.tick ASC
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    async getExecutions(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_executions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.caller_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.contract_index,
                        a2.address as caller,
                        m.method_name,
                        m.gas_used,
                        m.gas_limit,
                        m.emitted_count,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contract_executions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.caller_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getExecution(config){
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_executions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.caller_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.contract_index,
                        a2.address as caller,
                        m.method_name,
                        m.input_params,
                        m.gas_used,
                        m.gas_limit,
                        m.emitted_count,
                        m.error_message,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        contract_executions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.caller_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, args, count];
    }

    // Get list of contract emissions (the per-CONTRACT rollup across every EXECUTE call
    // against it). contract_emissions is keyed to the EXECUTION (execution_index = the
    // EXECUTE action's action_index), not to the contract, so reaching contract_index
    // requires joining through contract_executions; block_index lives on
    // contract_executions directly, so the block filter and the timestamp join need no
    // actions/blocks hop. Cursor is m.id: this table's own action_index is nullable for
    // internal emissions (e.g. SLASH), so it cannot page reliably. type in
    // {contract, execution, block}.
    async getEmissions(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        contract_emissions m
                        INNER JOIN contract_executions ce ON (ce.action_index=m.execution_index)
                        INNER JOIN blocks               b1 ON (b1.block_index=ce.block_index)
                        LEFT  JOIN index_statuses        s1 ON (s1.id=ce.status_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.id,
                        m.execution_index,
                        ce.contract_index,
                        m.position,
                        m.emitted_action,
                        m.action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        s1.status
                    FROM
                        contract_emissions m
                        INNER JOIN contract_executions ce ON (ce.action_index=m.execution_index)
                        INNER JOIN blocks               b1 ON (b1.block_index=ce.block_index)
                        LEFT  JOIN index_statuses        s1 ON (s1.id=ce.status_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.id ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getDeposits(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        deposits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.contract_index,
                        a2.address as source,
                        t3.tick,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        deposits m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    async getWithdrawals(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        withdrawals m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.contract_index,
                        a2.address as source,
                        t3.tick,
                        m.amount,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        withdrawals m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=m.source_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_tickers      t3 ON (t3.id=m.tick_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
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

    // Get list of ATTEST actions from the consolidated `attests` table. Lists both
    // v0 (request) and v1 (response) rows; `version` + request/response status let
    // the UI tell them apart. type in {address, block, contract}.
    //
    // The block is resolved off the ACTION's own block_index and `transactions` is a
    // LEFT join, the tx-less-safe shape getHistory already uses. A mirror-applied
    // ATTEST v1 response is a system-synthesized action with a real action_index and
    // block_index but a NULL tx_index and no transactions row (attest-response-mirror
    // spec §4.4), so the older INNER chain through t1 made every such response
    // VANISH from this list rather than render incompletely. tx_hash and tx_index
    // come back NULL for those rows, which is what they are.
    async getAttestations(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        attests m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        // The block is resolved off the ACTION's own block_index and `transactions` is a
        // LEFT join, the tx-less-safe shape getHistory already uses. A mirror-applied
        // ATTEST v1 response is a system-synthesized action with a real action_index and
        // block_index but a NULL tx_index and no transactions row (attest-response-mirror
        // spec §4.4), so the older INNER chain through t1 made every such response
        // VANISH from this list rather than render incompletely. tx_hash and tx_index
        // come back NULL for those rows, which is what they are.
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.version,
                        m.request_id,
                        m.provider_id,
                        m.contract_index,
                        a2.address as source,
                        fp.address as fee_payer,
                        m.gas_escrow,
                        m.fee_amount,
                        ft.tick as fee_tick,
                        m.request_status,
                        m.response_status,
                        m.payload,
                        m.response_payload,
                        m.callback_params_json,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        attests m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    fp ON (fp.id=m.fee_payer_id)
                        LEFT  JOIN index_tickers      ft ON (ft.id=m.fee_tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // List VOTE governance polls (polls table, one row per VOTE v0 create-poll action).
    // Joins the actions/transactions/blocks chain like getAttestations; filter by
    // block / tick (electorate token) / poll_status / source creator (see the
    // getQueryWhereSql getPolls branch). tick + source resolve through index tables.
    async getPolls(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        polls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT  JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        pt.tick,
                        m.end_block,
                        m.options,
                        m.max_selections,
                        m.tally_mode,
                        m.weight_mode,
                        m.quorum,
                        m.min_voters,
                        m.question,
                        m.poll_status,
                        m.winning_option,
                        m.total_weight,
                        m.total_voters,
                        m.quorum_met,
                        m.min_voters_met,
                        m.deposit_amount,
                        m.callback_contract_index,
                        m.callback_method,
                        m.finalized_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        polls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Open (not yet finalized) polls governed by one token, soonest close first.
    // Backs getToken's open_polls (the token page's Active Governance card).
    // Capped small because it rides the token point-read; full poll history
    // stays on getPolls (the tick/status-filterable list).
    async getTokenOpenPolls(config, tick){
        let query = `SELECT
                        m.action_index,
                        m.question,
                        m.end_block,
                        m.quorum,
                        m.min_voters,
                        m.weight_mode,
                        m.callback_contract_index,
                        m.callback_method
                    FROM
                        polls m
                        INNER JOIN index_tickers pt ON (pt.id=m.tick_id)
                    WHERE
                        pt.tick=?
                        AND m.poll_status='open'
                    ORDER BY m.end_block ASC
                    LIMIT 25`;
        let rows = await this.doQuery(config, query, [tick]);
        return rows || [];
    }

    // Single VOTE poll by its creating action_index (the poll id). Returns the full
    // poll definition + finalization summary (null fields until VOTE v2 finalizes) as a
    // single object (getXcall pattern), with options/callback_params JSON-parsed. The
    // per-option breakdown lives in poll_results (getPollResults); ballots in votes.
    async getPoll(config){
        let data  = null;
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        pt.tick,
                        m.tick_id,
                        m.end_block,
                        m.options,
                        m.max_selections,
                        m.tally_mode,
                        m.weight_mode,
                        m.quorum,
                        m.min_voters,
                        m.min_vote_balance,
                        m.decide_threshold,
                        m.question,
                        m.poll_status,
                        m.winning_option,
                        m.total_weight,
                        m.total_voters,
                        m.quorum_met,
                        m.min_voters_met,
                        m.fail_reason,
                        m.decided_early,
                        m.effective_close_block,
                        m.finalized_action_index,
                        m.resolved_block,
                        m.deposit_amount,
                        dep.address as deposit_address,
                        m.deposit_resolved,
                        m.callback_contract_index,
                        m.callback_method,
                        m.callback_params,
                        m.callback_on,
                        m.gas_escrow,
                        m.callback_delay_blocks,
                        m.callback_execute_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        polls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses    dep ON (dep.id=m.deposit_address_id)
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            // options is a JSON array of option labels; callback_params a JSON array of
            // developer params. Parse both, falling back to the raw string on malformed
            // JSON (mirrors getXcall's params_json / getContract's permissions parse).
            try { row.options = this.util.isNull(row.options) ? [] : JSON.parse(row.options); }
            catch(e){ row.options = row.options; }
            try { row.callback_params = this.util.isNull(row.callback_params) ? null : JSON.parse(row.callback_params); }
            catch(e){ row.callback_params = row.callback_params; }
            data = row;
        }
        return [data];
    }

    // Frozen per-option tally for one poll (poll_results, written by VOTE v2 finalize).
    // Empty until the poll is finalized; ordered by option_index so the caller renders
    // the poll's options in order. No actions chain (keyed by poll_index directly).
    async getPollResults(config){
        let sql   = config.data.sql;
        let count = `SELECT count(*) as total FROM poll_results m WHERE ` + sql.where.data;
        let query = `SELECT
                        m.poll_index,
                        m.option_index,
                        m.total_weight,
                        m.voter_count,
                        m.action_index as finalize_action_index,
                        m.block_index,
                        s1.status
                    FROM
                        poll_results m
                        LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
                    WHERE ` + sql.where.data + `
                    ORDER BY m.option_index ASC`;
        return [query, null, count];
    }

    // List VOTE ballots (votes table, one row per poll+voter+chosen option). Joins the
    // actions/transactions/blocks chain like getAttestations; the voter IS the source
    // (a2). Filter by voter address / poll / block (see getQueryWhereSql getVotes branch).
    async getVotes(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        votes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.poll_index,
                        m.choice,
                        m.share,
                        m.memo,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        votes m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // List BET markets (bet_feeds, one row per BET format 0 create-feed action).
    // Joins the actions/transactions/blocks chain like getPolls; the feed id IS the
    // creating action_index. tick joins index_tickers (pt) on m.tick_id (the wager
    // token); source is the oracle that created the feed (a2 via the action source);
    // status filters the stored feed lifecycle enum through index_statuses (fs).
    // feed_status is STORED rather than derived, so the list never recomputes a
    // close from the wall clock (the §5 backdating property E11 pins).
    async getBetFeeds(config){
        let sql   = config.data.sql;
        let from  = `
                        bet_feeds m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_statuses     fs ON (fs.id=m.feed_status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)`;
        let count = `SELECT count(*) as total FROM ` + from + ` WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        pt.tick,
                        m.label,
                        m.outcomes,
                        m.fee,
                        m.deadline,
                        m.refund_window,
                        m.expire_at,
                        m.min_amount,
                        m.allow_list,
                        m.block_list,
                        fs.status as feed_status,
                        m.closed_block,
                        m.terminal_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM ` + from + `
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // HTTP entry point for one BET market (getPoll pattern: a one-element array
    // whose element is null when there is no such feed). The router's where-builder
    // resolves to `m.action_index IS NOT NULL AND m.action_index=?` for this method
    // (getQueryWhereSql), which is the equality getBetFeedInfo binds directly, so
    // both entry points read the same row through one query body.
    async getBetFeed(config){
        return [await this.getBetFeedInfo(config, config.data.search)];
    }

    // Single BET market by its creating action_index (the feed id), returned as one
    // object with the per-outcome pools, bet counts and the full status timeline
    // attached, or null. DETAILS is returned as the RAW base64 exactly as it landed
    // on the wire plus a decoded `details_json` when it parses; it is never rendered
    // as markup and no URL inside it is ever fetched (§11.1 rendering safety,
    // SSRF-guard stance). Takes the index as an argument rather than off the config
    // so callers holding no router-built config can read it too: the WebSocket
    // bet_feed SNAPSHOT builds `{ coin }` alone. Same shape as getDispenserInfo.
    async getBetFeedInfo(config, actionIndex){
        let data  = null;
        let args  = [actionIndex];
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        pt.tick,
                        m.tick_id,
                        m.label,
                        m.outcomes,
                        m.fee,
                        m.deadline,
                        m.refund_window,
                        m.expire_at,
                        m.min_amount,
                        m.allow_list,
                        m.block_list,
                        m.details,
                        fs.status as feed_status,
                        m.closed_block,
                        m.terminal_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        bet_feeds m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_statuses     fs ON (fs.id=m.feed_status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE m.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            // OUTCOMES is stored as the canonical comma-joined label list. Split it
            // back into an array so the caller renders options in wire order without
            // re-implementing the join rule. Byte-exact uniqueness was enforced at
            // parse, so positions are stable and index-addressable.
            row.outcome_labels = this.util.isNull(row.outcomes) ? [] : String(row.outcomes).split(',');
            // DETAILS rides the wire as base64 and is ATTACKER-CONTROLLED. Decode it
            // for convenience but keep the raw alongside, and fall back to null (never
            // to the raw string) when it is not valid base64 JSON, so a consumer can
            // never mistake un-parsed hostile bytes for a parsed object.
            row.details_json = null;
            if(!this.util.isNull(row.details)){
                try { row.details_json = JSON.parse(Buffer.from(String(row.details), 'base64').toString('utf8')); }
                catch(e){ row.details_json = null; }
            }
            row.pools    = await this.getBetFeedPools(config, row.action_index);
            row.timeline = await this.getBetFeedTimeline(config, row.action_index, row.closed_block);
            // The outcome a finished market resolved to; the feed row itself has none.
            row.winning_outcome = await this.getBetFeedWinningOutcome(config, row.action_index);
            data = row;
        }
        return data;
    }

    // Return the outcome an honoured resolve settled to, else null. Only a valid
    // resolve counts: an invalid row stores the outcome the oracle CLAIMED and settles
    // nothing. Resolve is terminal, so at most one row can apply.
    async getBetFeedWinningOutcome(config, feedIndex){
        let query = `SELECT
                        br.outcome
                    FROM
                        bet_resolves br
                        LEFT JOIN index_statuses bs ON (bs.id=br.status_id)
                    WHERE
                        br.feed_action_index=?
                        AND bs.status='valid'
                    ORDER BY br.action_index DESC
                    LIMIT 1`;
        let rows = await this.doQuery(config, query, [feedIndex]);
        if(!rows || !rows.length || this.util.isNull(rows[0].outcome)) return null;
        return Number(rows[0].outcome);
    }

    // Sum every bet that escrowed; invalid rows escrowed nothing and are the only
    // exclusion. This is a display aggregation, NOT the settlement predicate (which
    // counts open rows alone); no consensus path reads it.
    async getBetFeedPools(config, feedIndex){
        let query = `SELECT
                        m.outcome,
                        count(*) as bet_count,
                        SUM(CAST(m.amount AS DECIMAL(65,18))) as pool
                    FROM
                        bets m
                        LEFT JOIN index_statuses bs ON (bs.id=m.bet_status_id)
                    WHERE
                        m.feed_action_index=?
                        AND bs.status <> 'invalid'
                    GROUP BY m.outcome
                    ORDER BY m.outcome ASC`;
        let rows = await this.doQuery(config, query, [feedIndex]) || [];
        // Trim the 18-place tail a DECIMAL sum leaves on a token with fewer decimals.
        // Display only; no consensus path reads this.
        return rows.map(r => ({ outcome: Number(r.outcome),
                                bet_count: Number(r.bet_count),
                                pool: this.trimAmountTail(r.pool) }));
    }

    // Status timeline for one feed. bet_feed_statuses is action-scoped, so it carries
    // create / resolve / resolved_void / cancel / expire but deliberately NOT the
    // 'closed' latch, which has no causing action (see bet_feed_statuses.sql). The
    // explorer SYNTHESIZES that entry from the bet_feeds.closed_block stamp, which is
    // the latch's durable record, and marks it synthetic so a consumer can tell it
    // apart from an action-backed row.
    //
    // The block comes from `actions.block_index`, NOT from the action's transaction:
    // BET_EXPIRE is emitted by the end-of-block pass and has no transaction at all
    // (tx_index NULL), so routing the block join through `transactions` used to return
    // NULL for that one status, and because the synthetic-latch insertion below compares
    // block numbers, that NULL also mis-ordered the closed/expired history. The
    // transaction join stays, but only for the tx hash a system action does not have.
    async getBetFeedTimeline(config, feedIndex, closedBlock){
        let query = `SELECT
                        m.action_index,
                        s1.status,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash
                    FROM
                        bet_feed_statuses m
                        LEFT JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT JOIN actions            a1 ON (a1.action_index=m.action_index)
                        LEFT JOIN blocks             b1 ON (b1.block_index=a1.block_index)
                        LEFT JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        LEFT JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                    WHERE m.feed_action_index=?
                    ORDER BY m.action_index ASC`;
        let rows = await this.doQuery(config, query, [feedIndex]) || [];
        rows = rows.map(r => Object.assign({}, r, { synthetic: false }));
        if(!this.util.isNull(closedBlock)){
            let closed = { action_index: null, status: 'closed', block_index: closedBlock,
                           timestamp: null, tx_hash: null, synthetic: true };
            let times  = await this.doQuery(config, `SELECT block_time FROM blocks WHERE block_index=? LIMIT 1`, [closedBlock]);
            if(times && times.length) closed.timestamp = times[0].block_time;
            // Order by block, and place the synthetic latch AFTER any action-backed row
            // in the same block: within a block, user txs process before the latch pass.
            let at = rows.findIndex(r => r.block_index > closedBlock);
            if(at === -1) rows.push(closed); else rows.splice(at, 0, closed);
        }
        return rows;
    }

    // List BET wagers (bets table, one row per BET format 2 place-bet action). Joins
    // the actions/transactions/blocks chain; the bettor IS the source (a2). Filter by
    // bettor address / feed / tick / block / bet status (see getQueryWhereSql getBets).
    async getBets(config){
        let sql   = config.data.sql;
        let from  = `
                        bets m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_tickers      pt ON (pt.id=m.tick_id)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_statuses     bs ON (bs.id=m.bet_status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)`;
        let count = `SELECT count(*) as total FROM ` + from + ` WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        a2.address as source,
                        m.feed_action_index,
                        m.outcome,
                        pt.tick,
                        m.amount,
                        bs.status as bet_status,
                        m.settled_block,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM ` + from + `
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Oracle track record for one address (§11.1). This IS the v0 reputation system:
    // there is no bonding or staking behind it, and the record is PER-ADDRESS, so an
    // oracle can start fresh at any time. Callers MUST surface that caveat; an empty
    // history means unknown, not safe. "Resolved on time" is deliberately absent: a
    // resolve past expire_at is rejected by format 3, so every resolve is in-window
    // by construction and the distinction would be vacuous.
    async getOracleStats(config){
        let args  = [config.data.search];
        let query = `SELECT
                        fs.status as feed_status,
                        count(*)  as feeds
                    FROM
                        bet_feeds m
                        INNER JOIN actions         a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses  fs ON (fs.id=m.feed_status_id)
                    WHERE a2.address=?
                    GROUP BY fs.status`;
        let rows  = await this.doQuery(config, query, args) || [];
        let counts = { open: 0, closed: 0, resolved: 0, resolved_void: 0, cancelled: 0, expired: 0 };
        let total  = 0;
        for(const r of rows){
            if(r.feed_status in counts) counts[r.feed_status] = Number(r.feeds);
            total += Number(r.feeds);
        }
        // Active = still able to take or settle bets. Kept explicit rather than
        // derived by the caller so the market list and the oracle page agree.
        let active = counts.open + counts.closed;
        let fees   = await this.getOracleFeesEarned(config, config.data.search);
        let price  = await this.getOraclePriceRecord(config, config.data.search);
        return [{ address: config.data.search, total_feeds: total, active_feeds: active,
                  counts, fees_earned: fees, price,
                  reputation_caveat: 'Per-address record with no bonding; addresses are free to create, so an empty history means unknown, not safe.' }];
    }

    // PRICE v1 half of the per-address oracle track record. A price publisher is an
    // oracle too, but its rounds land in the hub-mirrored oracle_prices table, not
    // bet_feeds, so the stats above are blind to it and the page reported an active
    // publisher as all zeros. Aggregated per published pair (COIN/TICK/FIAT) with
    // the round counts and publish window; the individual rounds are served by
    // getOraclePrices. Returns null (a "cannot know", distinct from the zero-pair
    // record {total_publishes:0, pairs:[]}) when this node has no co-located hub DB:
    // oracle_prices is mirror-only and the betting record must still answer.
    async getOraclePriceRecord(config, address){
        let src = null;
        try {
            src = this._oracleMirrorSource(config, 'oracle_prices');
        } catch(e) {
            return null;
        }
        let rows = await this.doQuery(config,
            `SELECT
                m.coin,
                m.tick,
                m.fiat,
                count(*) as publishes,
                MIN(m.block_time) as first_publish,
                MAX(m.block_time) as last_publish
            FROM
                ${src.table} m
            WHERE
                m.source_address=?
            GROUP BY m.coin, m.tick, m.fiat
            ORDER BY last_publish DESC`, [address]) || [];
        let record = { total_publishes: 0, pairs: [] };
        for(const r of rows){
            // Counts and epoch times can arrive as BigInt; normalize so the JSON is
            // plain numbers (values are far below 2^53).
            let publishes = Number(r.publishes);
            record.total_publishes += publishes;
            record.pairs.push({
                coin: r.coin, tick: r.tick, fiat: r.fiat, publishes,
                first_publish: this.util.isNull(r.first_publish) ? null : Number(r.first_publish),
                last_publish:  this.util.isNull(r.last_publish)  ? null : Number(r.last_publish)
            });
        }
        return record;
    }

    // What an oracle has actually EARNED, per wager token (§11.1's "fees earned").
    //
    // The earning event is one ledger row and only one: settlement credits the feed
    // source a single amount carrying the FEE percent of the pot PLUS the rounding
    // dust (bet.js, §7), and only on the resolve path - a void, a cancel and an
    // expiry all pay the oracle nothing. So the sum is over `credits` rows attached
    // to a BET resolve action.
    //
    // The identity test is what makes it exact, and it is not decoration: a WINNING
    // BETTOR's payout is also a credit inside that same resolve action, so filtering
    // on the credited address alone would report other people's winnings as this
    // address's fee income the moment it ever bet on someone else's market. Requiring
    // the credited address to BE the address that submitted the resolve excludes them,
    // because format 3 is owner-only and format 2 rejects a bet from the feed source,
    // so within one resolve the oracle is credited exactly once and never as a bettor.
    async getOracleFeesEarned(config, address){
        let query = `SELECT
                        tk.tick,
                        count(*) as resolves,
                        SUM(CAST(c.amount AS DECIMAL(65,18))) as amount
                    FROM
                        credits c
                        INNER JOIN bet_resolves    br ON (br.action_index=c.action_index)
                        INNER JOIN actions         a1 ON (a1.action_index=br.action_index)
                        INNER JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT  JOIN index_addresses ra ON (ra.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_addresses ca ON (ca.id=c.address_id)
                        LEFT  JOIN index_tickers   tk ON (tk.id=c.tick_id)
                    WHERE ca.address=? AND ra.address=?
                    GROUP BY tk.tick
                    ORDER BY tk.tick ASC`;
        let rows = await this.doQuery(config, query, [address, address]) || [];
        // DECIMAL(65,18) sums arrive with an 18-place tail whatever the token's own
        // DECIMALS, so trim it here rather than in each renderer. Display only: no
        // consensus path reads this method.
        return rows.map(r => ({ tick: r.tick, resolves: Number(r.resolves),
                                amount: this.trimAmountTail(r.amount) }));
    }

    // Strip the zero tail a DECIMAL sum leaves behind ('0.175000000000000000' ->
    // '0.175'), leaving a whole number bare ('12.000...' -> '12'). Never touches a
    // significant digit, and returns non-numeric input unchanged.
    trimAmountTail(value){
        if(this.util.isNull(value)) return '0';
        let s = String(value);
        if(!/^-?\d+\.\d+$/.test(s)) return s;
        return s.replace(/0+$/, '').replace(/\.$/, '');
    }

    // List XCALL cross-chain call requests (xcalls table, VM-emitted, read-only).
    // Joins the actions/transactions/blocks chain like getAttestations; filter by
    // block / source contract / request_status (see getQueryWhereSql getXcalls branch).
    async getXcalls(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        xcalls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.version,
                        m.call_id,
                        m.contract_index,
                        a2.address as source,
                        m.target_chain,
                        m.target_contract_index,
                        m.method,
                        m.gas_limit,
                        m.cross_hops,
                        m.callback_method,
                        m.deadline_block,
                        m.request_status,
                        m.result_status,
                        m.resolved_block,
                        m.callback_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        xcalls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // List ANCHOR checkpoint records from anchor_actions. Joins the
    // actions/transactions/blocks chain like getAttestations/getXcalls.
    // type in {block, chain, network, status}.
    //
    // A v0 BUNDLE is N sibling rows sharing one action_index, one per checkpointed
    // chain, each carrying its own chain/block_index/checkpoint_seq/roots. That is
    // exactly why the bundle was stored one row per section: every per-chain reader,
    // this list and its `chain` filter included, keeps working unchanged and simply
    // lists the section rows. section_index is projected so a reader can tell two
    // sections of one bundle apart, and it breaks the ORDER BY tie the shared
    // action_index would otherwise leave to the server.
    async getAnchors(config){
        let sql   = config.data.sql;
        let count = `SELECT
                        count(*) as total
                    FROM
                        anchor_actions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        m.section_index,
                        a1.action_format,
                        m.version,
                        m.chain,
                        m.network,
                        m.block_index,
                        m.block_hash,
                        m.ledger_hash,
                        m.actions_hash,
                        m.contract_hash,
                        m.checkpoint_seq,
                        m.snapshot_block,
                        m.match_batch_seq,
                        m.match_count,
                        m.batch_crc32,
                        m.total_chunks,
                        m.chunk_index,
                        m.state_root,
                        m.state_root_version,
                        m.block_merkle_root,
                        m.block_merkle_version,
                        m.validator_signatures,
                        m.block_index_doge,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        anchor_actions m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + sql.where.offset +`
                    ORDER BY m.action_index ` + sql.order + `, m.section_index ASC
                    LIMIT ` + sql.limit;
        return [query, null, count];
    }

    // Per-block SPV commitments (state_tree_roots), decorated with the covering
    // hub-mirrored state_checkpoints row (if any) and the local ANCHOR action that carried
    // it (if any). The three legs live in three places and are not casually joinable:
    // state_tree_roots is this coin's own indexer DB (no action chain, one row per block,
    // unique on (chain, network, block_index)); state_checkpoints is the co-located
    // hub-mirror schema reached via _checkpointSource, DB-qualified but on the SAME
    // connection pool as the indexer DB (checkpointDb is registered ONLY when it shares
    // host/port/user/pass with that pool), which is exactly what the co-location guarantee
    // is FOR; anchor_actions is this same coin's own local indexer DB, parsed from the
    // DOGE-only ANCHOR action, so on a non-DOGE deployment that leg is structurally always
    // empty - the same limitation getAnchors already carries reading the same table.
    //
    // Both decoration legs are LEFT JOINs correlated on this row's own block_index, so a
    // block with no covering checkpoint yet (normal near the tip: checkpoints cut on a
    // cadence) or no carrying ANCHOR yet (anchoring batches several heights) comes back
    // with those columns NULL rather than the row vanishing. _checkpointSource still
    // throws when this coin has no co-located hub DB configured at ALL, which is a
    // deployment misconfiguration and a different case entirely.
    //
    // Reuses the exact latest-per-height predicate getCheckpoints established rather than
    // a third, differently-bounded checkpoint query, and applies the identical shape to
    // the anchor leg's own latest-checkpoint_seq-per-height lookup.
    async getCommitments(config){
        let sql      = config.data.sql;
        let src      = this._checkpointSource(config);
        let scFilter = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let latest   = this._latestCheckpointPredicate(src, 'sc');
        // anchor_actions.chain/network name the CHECKPOINTED chain (the same convention
        // state_checkpoints uses), not the chain the ANCHOR transaction landed on, so this
        // coin's own (chain, network) identity is the correct filter here too: block_index
        // alone is not unique across chains on the DOGE deployment, where one local table
        // holds commitments for all three.
        let anFilter = ' AND an.chain = ? AND an.network = ?';
        let anLatest = ` AND an.checkpoint_seq = (SELECT MAX(a2.checkpoint_seq) FROM anchor_actions a2
                           WHERE a2.block_index = an.block_index AND a2.chain = ? AND a2.network = ?)`;
        let count = `SELECT
                        count(*) as total
                    FROM
                        state_tree_roots m
                        LEFT JOIN ${src.table} sc ON sc.block_index = m.block_index${scFilter}${latest.sql}
                        LEFT JOIN anchor_actions an ON an.block_index = m.block_index${anFilter}${anLatest}
                    WHERE ` + sql.where.data;
        let query = `SELECT
                        m.block_index,
                        m.balances_root,
                        m.stakes_root,
                        m.state_root,
                        m.block_merkle_root,
                        m.contract_state_root,
                        m.computed_at,
                        sc.checkpoint_seq        AS checkpoint_seq,
                        sc.snapshot_block        AS checkpoint_snapshot_block,
                        sc.created_at            AS checkpoint_created_at,
                        JSON_LENGTH(sc.validator_signatures) AS checkpoint_signer_count,
                        an.action_index          AS anchor_action_index,
                        an.version               AS anchor_version
                    FROM
                        state_tree_roots m
                        LEFT JOIN ${src.table} sc ON sc.block_index = m.block_index${scFilter}${latest.sql}
                        LEFT JOIN anchor_actions an ON an.block_index = m.block_index${anFilter}${anLatest}
                    WHERE ` + sql.where.data + sql.where.offset + `
                    ORDER BY m.block_index ` + sql.order + `
                    LIMIT ` + sql.limit;
        // Left-to-right text order: both JOIN ON clauses (checkpoint filter + latest, then
        // anchor filter + latest), then the WHERE type-bound value, which is present only
        // when type='block' (getData's list-all null filter drops the trailing undefined on
        // a bare request, so the placeholder count still lines up). count and list share
        // IDENTICAL FROM+JOIN text, so this one array binds correctly against both.
        let args = [...src.filterParams, ...latest.params, ...src.filterParams, ...src.filterParams, config.data.search];
        return [query, args, count];
    }

    // Full XCALL lifecycle by call_id: the source request (xcalls) + the target-chain
    // execution outcome (cross_chain_call_executions) + the source-chain callback
    // delivery (cross_chain_call_callbacks). The latter two are null until the call is
    // relayed/executed/delivered. Mirrors getContract's single-item return ([data]);
    // data is null when the call_id is unknown. A call_id can carry more than one
    // xcalls row (rejected attempts index alongside the accepted request), so the
    // read is pinned to the valid row, matching the indexer's authoritative
    // by-call_id lookup; without the status bound the ORDER BY can surface an
    // invalid row as the lifecycle.
    async getXcall(config){
        let data  = null;
        let sql   = config.data.sql;
        let args  = [config.data.search];
        let query = `SELECT
                        a4.action,
                        m.action_index,
                        a1.action_format,
                        m.version,
                        m.call_id,
                        m.contract_index,
                        a2.address as source,
                        m.target_chain,
                        m.target_contract_index,
                        m.method,
                        m.params_json,
                        m.gas_limit,
                        m.cross_hops,
                        m.callback_method,
                        m.callback_params_json,
                        m.deadline_block,
                        m.request_status,
                        m.result_status,
                        m.result_payload,
                        m.resolved_block,
                        m.callback_action_index,
                        b1.block_index,
                        b1.block_time as timestamp,
                        t2.hash as tx_hash,
                        t1.tx_index,
                        s1.status
                    FROM
                        xcalls m
                        INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                        INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                        INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                        LEFT  JOIN index_addresses    a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                        LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                        LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
                    WHERE ` + sql.where.data + ` AND s1.status='valid'
                    ORDER BY m.action_index ` + sql.order + `
                    LIMIT 1`;
        let results = await this.doQuery(config, query, args);
        if(results && results.length){
            let row = results[0];
            // params/callback_params are JSON arrays on the wire; parse, falling back to
            // the raw string on malformed JSON (mirrors getContract's permissions parse).
            try { row.params = this.util.isNull(row.params_json) ? null : JSON.parse(row.params_json); }
            catch(e){ row.params = row.params_json; }
            try { row.callback_params = this.util.isNull(row.callback_params_json) ? null : JSON.parse(row.callback_params_json); }
            catch(e){ row.callback_params = row.callback_params_json; }
            // Target-chain execution outcome (1:1 by call_id; null until executed).
            let exec = await this.doQuery(config,
                `SELECT execute_action_index, result_status, return_payload_b64, gas_used, block_index as execution_block_index
                 FROM cross_chain_call_executions WHERE call_id=? LIMIT 1`, [row.call_id]);
            row.execution = (exec && exec.length) ? exec[0] : null;
            // Source-chain callback delivery (1:1 by call_id; null until delivered).
            let cb = await this.doQuery(config,
                `SELECT result_status as callback_result_status, block_index as callback_block_index
                 FROM cross_chain_call_callbacks WHERE call_id=? LIMIT 1`, [row.call_id]);
            row.callback_delivery = (cb && cb.length) ? cb[0] : null;
            data = row;
        }
        return [data];
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

    // ATTEST v2 (expire) mints an action and writes NO ROW, so `attests` names neither
    // side of the pair. The two are correlated POSITIONALLY WITHIN THE BLOCK, which is
    // exact rather than a guess, because the indexer fixes both orders:
    //   - the sweep selects what it expires in ONE deterministic order
    //     (xchain-indexer db.getExpiredAttestationRequests: deadline_block ASC,
    //     action_index ASC) and mints one v2 action per selected request in that loop,
    //     so the v2 action indexes ascend in exactly that order;
    //   - request_status 'expired' is written by that sweep and by NOTHING else (the
    //     v1/v3/v4 response paths write only 'fulfilled' or 'errored'; a retryable
    //     round leaves the request pending), so the two lists cover the same set.
    // Equal length is therefore an INVARIANT, and it is checked rather than assumed:
    // a block where the two disagree yields no link at all, because a rank correlation
    // over unequal lists names the WRONG request, which is worse than naming none.
    //
    // The rank machinery is only load-bearing for a block that expired several requests
    // at once; the common block carries one of each.
    async _correlateAttestationExpiries(config, blockIndex){
        if(this.util.isNull(blockIndex)) return [];
        // Bounded well above the indexer's per-block expiry cap
        // (ATTEST_MAX_EXPIRIES_PER_BLOCK = 25) so a raised cap widens the read instead of
        // silently truncating one list and disabling the correlation.
        let cap = 100;
        let acts = await this.doQuery(config,
            `SELECT
                a1.action_index
            FROM
                actions a1
                INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
            WHERE a1.block_index=? AND a2.action='ATTEST' AND a1.action_format=2
            ORDER BY a1.action_index ASC
            LIMIT ` + cap, [blockIndex]);
        if(!acts || !acts.length) return [];
        let reqs = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.request_id,
                m.provider_id,
                m.contract_index,
                m.callback_method,
                m.deadline_block,
                m.request_status,
                m.resolved_block
            FROM attests m
            WHERE m.version=0 AND m.request_status='expired' AND m.resolved_block=?
            ORDER BY m.deadline_block ASC, m.action_index ASC
            LIMIT ` + cap, [blockIndex]);
        if(!reqs || reqs.length !== acts.length) return [];
        return acts.map((a, i) => ({
            expire_action_index: a.action_index,
            request:             reqs[i]
        }));
    }

    // The v2 expire action that retired one v0 request row, or null when the block's
    // two lists do not line up (see _correlateAttestationExpiries).
    async _resolveAttestationExpireAction(config, request){
        if(!request || String(request.request_status) !== 'expired') return null;
        let pairs = await this._correlateAttestationExpiries(config, request.resolved_block);
        let hit   = pairs.find(p => p.request && String(p.request.request_id) === String(request.request_id));
        return (hit) ? hit.expire_action_index : null;
    }

    // The inverse read, for the ACTION page of a v2: the v0 request this expire retired.
    async resolveAttestationExpireRequest(config, expireActionIndex, blockIndex){
        let pairs = await this._correlateAttestationExpiries(config, blockIndex);
        let hit   = pairs.find(p => Number(p.expire_action_index) === Number(expireActionIndex));
        return (hit) ? hit.request : null;
    }

    // Seed the lifecycle page from a v2 expire's own action_index. Reads the action's
    // block (the expire writes no attests row, so there is nothing else to key on) and
    // hands back the correlated v0 request row.
    async _seedAttestationFromExpireAction(config, actionIndex){
        if(!this.util.isNumeric(actionIndex)) return null;
        let rows = await this.doQuery(config,
            `SELECT
                a1.block_index,
                a1.action_format
            FROM
                actions a1
                INNER JOIN index_actions a2 ON (a2.id=a1.action_id)
            WHERE a1.action_index=? AND a2.action='ATTEST' AND a1.action_format=2
            LIMIT 1`, [Number(actionIndex)]);
        if(!rows || !rows.length) return null;
        return await this.resolveAttestationExpireRequest(config, Number(actionIndex), rows[0].block_index);
    }

    // The system-injected callback EXECUTE for one request.
    //
    // attests.callback_execute_action_index is stamped on the v1 RESPONSE row only
    // (xchain-indexer setAttestationResponseCallbackIndex ... WHERE version = 1), so an
    // EXPIRED request has no stored link anywhere: the v2 sweep injects the expired
    // callback (_injectExpiredCallback) and there is no v1 row to stamp. The execution
    // itself is unambiguous on its own columns: the injected EXECUTE calls the request's
    // OWN contract and callback method with the request_id as its first positional
    // parameter (INPUT_PARAMS is the '|'-joined argument list), and a request id is
    // unique chain-wide, so this identifies exactly the callback for THIS request.
    //
    // The id is re-validated as 64 hex before it reaches the LIKE: a request_id is the
    // only user-influenced part of the pattern and hex carries no % or _ wildcard.
    async _deriveAttestationCallbackExecute(config, request){
        if(!request) return null;
        let requestId = String(request.request_id || '').toLowerCase();
        if(!/^[0-9a-f]{64}$/.test(requestId)) return null;
        if(this.util.isNull(request.contract_index) || this.util.isNull(request.callback_method)) return null;
        let rows = await this.doQuery(config,
            `SELECT
                m.action_index
            FROM contract_executions m
            WHERE m.contract_index=? AND m.method_name=? AND m.input_params LIKE CONCAT(?, '|%')
            ORDER BY m.action_index ASC
            LIMIT 1`, [request.contract_index, request.callback_method, requestId]);
        return (rows && rows.length) ? rows[0].action_index : null;
    }

    // Composed ATTESTATION lifecycle (M4.3). QUERY is EITHER the 64-hex request_id (the
    // correlation key every leg carries) or the action_index of any ATTEST action in the
    // round. A numeric QUERY resolves through getAttestationByActionIndex, the positional-arg
    // point read the WS ChangeDetector already owns: it is REUSED here rather than re-routed
    // or reshaped, because the detector depends on its signature exactly as it stands.
    //
    // WHAT THE SCHEMA FORCED, and it contradicts the obvious reading of the lifecycle:
    // ATTEST v2 (expire) writes NO ROW OF ITS OWN. It is system-synthesized, allocates an
    // action_index with FORMAT 2, and then only FLIPS the v0 request row's request_status to
    // 'expired' and stamps resolved_block (xchain-indexer attest.js _parseExpire). So the
    // expiry leg below is DERIVED from the request row, not selected from a v2 row. The
    // expire ACTION does exist and has a working page, so it is resolved through the
    // in-block correlation above and named here rather than declared unlinkable.
    //
    // Relay legs (ATTEST v3/v4) likewise write ordinary version 0 / version 1 rows carrying
    // origin_chain + origin_action_index, so they arrive in the same request_id read; the
    // relay block below names them rather than issuing a second query for rows that are by
    // construction on ANOTHER chain's indexer DB.
    async getAttestation(config){
        let limit  = this._detailLimit(config);
        let search = config.data.search;
        let requestId = null;
        if(this.util.isNumeric(search)){
            let seed = await this.getAttestationByActionIndex(config, Number(search));
            // A v2 expire has no attests row, so the point read answers nothing for it and
            // the lifecycle page for the expire's own action_index rendered NOT FOUND. The
            // in-block correlation resolves it to the request it retired.
            if(!seed) seed = await this._seedAttestationFromExpireAction(config, Number(search));
            if(!seed) return [null];
            requestId = seed.request_id;
        } else {
            requestId = String(search || '').toLowerCase();
        }
        if(!requestId) return [null];

        // Every leg of one round in one bounded read, oldest first so the caller renders the
        // lifecycle in the order it happened. request_id+version is indexed.
        //
        // `blocks` resolves off the action's own block_index, not the transaction's: a
        // mirror-applied response has an action_index but no transaction row, and routing
        // through t1 left the timestamp NULL for it (attest-response-mirror spec section 4.4).
        let rows = await this.doQuery(config,
            `SELECT
                a4.action,
                m.action_index,
                a1.action_format,
                m.version,
                m.request_id,
                m.provider_id,
                m.contract_index,
                a2.address as source,
                fp.address as fee_payer,
                m.payload,
                m.callback_method,
                m.callback_params_json,
                m.redundancy,
                m.deadline_block,
                m.gas_escrow,
                ft.tick as fee_tick,
                m.fee_amount,
                m.request_status,
                m.resolved_block,
                m.responsible_set_json,
                m.origin_chain,
                m.origin_action_index,
                m.response_hash,
                m.response_payload,
                m.response_status,
                m.meta,
                m.validator_signatures,
                m.callback_execute_action_index,
                m.batch_action_index,
                m.block_index,
                b1.block_time as timestamp,
                t2.hash as tx_hash,
                t1.tx_index,
                s1.status
            FROM
                attests m
                LEFT JOIN actions             a1 ON (a1.action_index=m.action_index)
                LEFT JOIN transactions        t1 ON (t1.tx_index=a1.tx_index)
                LEFT JOIN blocks              b1 ON (b1.block_index=a1.block_index)
                LEFT JOIN index_addresses     a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                LEFT JOIN index_addresses     fp ON (fp.id=m.fee_payer_id)
                LEFT JOIN index_tickers       ft ON (ft.id=m.fee_tick_id)
                LEFT JOIN index_statuses      s1 ON (s1.id=m.status_id)
                LEFT JOIN index_transactions  t2 ON (t2.id=t1.tx_hash_id)
                LEFT JOIN index_actions       a4 ON (a4.id=a1.action_id)
            WHERE m.request_id=?
            ORDER BY m.version ASC, m.action_index ASC
            LIMIT ` + limit, [requestId]);
        if(!rows || !rows.length) return [null];

        let request  = rows.find(r => Number(r.version) === 0) || null;
        let response = rows.find(r => Number(r.version) === 1) || null;
        if(request){
            try { request.callback_params = this.util.isNull(request.callback_params_json) ? null : JSON.parse(request.callback_params_json); }
            catch(e){ request.callback_params = request.callback_params_json; }
            // The responsible set was PINNED as-of the request block; it is the electorate a
            // reader checks the response signatures against, so it is parsed, not echoed raw.
            request.responsible_set = this._parseSignaturesArray(request.responsible_set_json);
        }
        if(response)
            response.quorum_signatures = this._parseSignaturesArray(response.validator_signatures);

        let status = (request) ? request.request_status : null;

        // The stored callback link lives on the v1 RESPONSE row alone, so an EXPIRED
        // request - which has no v1 row at all - reported "no callback execution
        // recorded" while the injected expired-callback EXECUTE sat on chain a couple of
        // indexes away. Derive it for that case, and flag the derivation so the page can
        // say where the link came from instead of implying the indexer stamped it.
        let callbackIndex   = (response) ? response.callback_execute_action_index : null;
        let callbackDerived = false;
        let expireAction    = null;
        if(request && status === 'expired'){
            expireAction = await this._resolveAttestationExpireAction(config, request);
            if(this.util.isNull(callbackIndex)){
                callbackIndex   = await this._deriveAttestationCallbackExecute(config, request);
                callbackDerived = !this.util.isNull(callbackIndex);
            }
        }

        return [{
            query:      config.data.search,
            request_id: requestId,
            provider_id: rows[0].provider_id,
            legs:       rows,
            request:    request,
            response:   response,
            // Derived, because ATTEST v2 persists no ROW. It does mint an ACTION, and
            // expire_action_index names it (null when the block's expire actions and
            // expired requests do not line up). `expired` is the stored terminal state,
            // never a clock comparison against deadline_block: a request past its deadline
            // that the expiry sweep has not reached yet is still 'pending'.
            expiry: {
                request_status:      status,
                deadline_block:      (request) ? request.deadline_block : null,
                resolved_block:      (request) ? request.resolved_block : null,
                expired:             status === 'expired',
                expire_action_index: expireAction
            },
            relay: {
                is_relay:            !!(request && !this.util.isNull(request.origin_chain)),
                origin_chain:        (request) ? request.origin_chain : null,
                origin_action_index: (request) ? request.origin_action_index : null,
                response_relayed:    !!(response && !this.util.isNull(response.origin_action_index))
            },
            callback_execute_action_index: callbackIndex,
            callback_execute_derived:      callbackDerived
        }];
    }

    // Composed ANCHOR detail (M4.5). QUERY is the ANCHOR's action_index, or the DOGE
    // transaction hash it landed in. The two are told apart in JS rather than bound into one
    // OR: action_index is a BIGINT column and a 64-hex hash compared against it is coerced,
    // not matched, so an OR would answer 0 rows for the hash form without erroring.
    //
    // Three legs beyond the payload, and each reads a DIFFERENT source:
    //   - the covering hub-mirror state_checkpoints row, through the SAME correlated
    //     latest-checkpoint_seq-per-height predicate getCheckpoints/getCommitments use
    //     (_latestCheckpointPredicate), never a fourth differently-bounded variant;
    //   - the publisher ELECTION, from capability_snapshots at this anchor's snapshot_block.
    //     That table is CHAIN-AGNOSTIC (no chain/network columns; its key is
    //     snapshot_block+capability+signing_pubkey+source), so src.filter/filterParams are
    //     deliberately NOT bound to it;
    //   - the reward-attestation trail, from anchor_reward_attestations, which IS
    //     chain-scoped (chain/network are in uq_reward_tuple), so the same src.filter IS
    //     bound there, first, exactly as getAnchorRewardAttestations binds it.
    // Getting that asymmetry backwards yields a query that is silently wrong rather than one
    // that errors, in whichever direction the blanket rule was applied.
    //
    // archive_b64 is never selected. It is a MEDIUMTEXT gzip chunk with nothing legible in
    // it; its LENGTH and crc32 are what a reader can actually check an archive against.
    async getAnchor(config){
        let limit  = this._detailLimit(config);
        let search = config.data.search;
        let numeric   = this.util.isNumeric(search);
        let predicate = numeric ? 'm.action_index=?' : 't2.hash=?';
        let key       = numeric ? Number(search) : String(search || '').toLowerCase();
        let rows = await this.doQuery(config,
            `SELECT
                a4.action,
                m.action_index,
                m.section_index,
                a1.action_format,
                m.version,
                m.chain,
                m.network,
                m.block_index,
                m.block_hash,
                m.ledger_hash,
                m.actions_hash,
                m.contract_hash,
                m.checkpoint_seq,
                m.snapshot_block,
                m.state_root,
                m.state_root_version,
                m.block_merkle_root,
                m.block_merkle_version,
                m.match_batch_seq,
                m.match_count,
                m.batch_crc32,
                m.total_chunks,
                m.chunk_index,
                CHAR_LENGTH(m.archive_b64) as archive_b64_length,
                m.validator_signatures,
                m.publisher,
                m.publisher_attestations,
                m.block_index_doge,
                b1.block_time as timestamp,
                t2.hash as tx_hash,
                t1.tx_index,
                s1.status
            FROM
                anchor_actions m
                INNER JOIN actions            a1 ON (a1.action_index=m.action_index)
                INNER JOIN transactions       t1 ON (t1.tx_index=a1.tx_index)
                INNER JOIN blocks             b1 ON (b1.block_index=t1.block_index)
                LEFT  JOIN index_statuses     s1 ON (s1.id=m.status_id)
                LEFT  JOIN index_transactions t2 ON (t2.id=t1.tx_hash_id)
                LEFT  JOIN index_actions      a4 ON (a4.id=a1.action_id)
            WHERE ` + predicate + `
            ORDER BY m.action_index DESC, m.section_index ASC
            LIMIT 1`, [key]);
        if(!rows || !rows.length) return [null];
        let row = rows[0];
        row.validator_signatures   = this._parseSignaturesArray(row.validator_signatures);
        // The v4/v5/v6 XANCPUB tail is RAW WIRE transport, not the quorum-verified subset
        // (anchor_actions.sql), so it is parsed for display and named as attestations to
        // re-verify, never presented as a verified quorum.
        row.publisher_attestations = this._parseSignaturesArray(row.publisher_attestations);

        // A v0 ANCHOR is a BUNDLE: one action carrying every checkpointed chain, stored as
        // N sibling rows sharing one action_index at section_index 0..N-1. Each row holds
        // its OWN chain, block_index, checkpoint_seq, roots and validator signatures; the
        // bundle-level fields (version, network, publisher, publisher_attestations, status,
        // txid, the DOGE block it landed in) are denormalized identically onto every row,
        // which is why the spine above can serve as the header no matter which section it
        // matched. Archive rows (v1/v2) and every retired per-chain version stay at
        // section_index 0, so they take no second query at all.
        //
        // snapshot_block on the header is the BUNDLE's block, the MAX over the sections: a
        // chain that lagged rides at its own older SECTION_SNAPSHOT_BLOCK, but the election
        // and the publisher attestation were both drawn at the MAX. Reading section 0's
        // block as the bundle's would look the electorate up at the wrong height.
        row.sections      = [];
        row.section_count = 1;
        if(Number(row.version) === 0){
            let sections = await this.doQuery(config,
                `SELECT
                    m.section_index,
                    m.chain,
                    m.network,
                    m.block_index,
                    m.block_hash,
                    m.ledger_hash,
                    m.actions_hash,
                    m.contract_hash,
                    m.checkpoint_seq,
                    m.snapshot_block,
                    m.state_root,
                    m.state_root_version,
                    m.block_merkle_root,
                    m.block_merkle_version,
                    m.validator_signatures,
                    s1.status
                FROM
                    anchor_actions m
                    LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
                WHERE m.action_index=?
                ORDER BY m.section_index ASC
                LIMIT ` + limit, [Number(row.action_index)]) || [];
            row.sections = sections.map(s => {
                s.validator_signatures = this._parseSignaturesArray(s.validator_signatures);
                return s;
            });
            if(row.sections.length){
                row.section_count = row.sections.length;
                let blocks = row.sections
                    .map(s => this.util.isNull(s.snapshot_block) ? null : Number(s.snapshot_block))
                    .filter(v => v !== null);
                if(blocks.length) row.snapshot_block = Math.max(...blocks);
            }
        }

        // Continuation chunks (v2) share the archive batch id. Bounded: a large archive
        // splits into as many chunks as it needs, so this list has no natural ceiling.
        let chunks = [];
        if(!this.util.isNull(row.match_batch_seq))
            chunks = await this.doQuery(config,
                `SELECT
                    m.action_index,
                    m.version,
                    m.chunk_index,
                    m.total_chunks,
                    CHAR_LENGTH(m.archive_b64) as archive_b64_length,
                    m.block_index_doge,
                    s1.status
                FROM
                    anchor_actions m
                    LEFT JOIN index_statuses s1 ON (s1.id=m.status_id)
                WHERE m.match_batch_seq=?
                ORDER BY m.chunk_index ASC
                LIMIT ` + limit, [row.match_batch_seq]) || [];

        let src         = this._checkpointSource(config);
        let scFilter    = src.filter.replace(/\b(chain|network)\b/g, 'sc.$1');
        let latest      = this._latestCheckpointPredicate(src, 'sc');
        // The anchor names the CHECKPOINTED height on the CHECKPOINTED chain, which is what
        // state_checkpoints is keyed by too, so this coin's own (chain, network) identity is
        // the right filter here (the same reasoning getCommitments' anchor leg carries).
        //
        // A BUNDLE carries several chains at once, so the height to look up is THIS coin's
        // own section, not whichever section the spine happened to match. Keying a
        // chain-filtered mirror query by another chain's height cannot error: it returns
        // zero rows, and the page then reads a perfectly good bundle as uncovered.
        let localSection = row.sections.find(s =>
            String(s.chain || '').toUpperCase() === String(src.filterParams[0] || '').toUpperCase()) || null;
        let coveredHeight = localSection ? localSection.block_index : row.block_index;
        row.local_section_index = localSection ? localSection.section_index : null;
        let checkpoint = [];
        if(!this.util.isNull(coveredHeight))
            checkpoint = await this.doQuery(config,
                `SELECT
                    sc.chain, sc.network, sc.block_index, sc.block_hash, sc.ledger_hash,
                    sc.actions_hash, sc.contract_hash, sc.checkpoint_seq, sc.snapshot_block,
                    sc.state_root, sc.state_root_version, sc.block_merkle_root,
                    sc.block_merkle_version, sc.validator_signatures, sc.created_at
                FROM ${src.table} sc
                WHERE sc.block_index = ?${scFilter}${latest.sql}
                LIMIT 1`, [Number(coveredHeight), ...src.filterParams, ...latest.params]) || [];

        // Publisher election. capability_snapshots is CHAIN-AGNOSTIC: no chain/network
        // filter is bound, matching getCapabilitySnapshots. 'oracle_publish' is the
        // capability the publisher election draws its set from.
        let electorate = [];
        if(!this.util.isNull(row.snapshot_block))
            electorate = await this.doQuery(config,
                `SELECT
                    m.signing_pubkey,
                    m.amount,
                    m.source
                FROM ${src.capTable} m
                WHERE m.snapshot_block=? AND m.capability=?
                ORDER BY m.id ASC
                LIMIT ` + limit, [Number(row.snapshot_block), 'oracle_publish']) || [];

        // Reward trail. CHAIN-SCOPED, so filterParams lead. Correlated on the mined DOGE
        // txid this anchor landed in, OR on the table's own natural key minus publisher
        // (snapshot_block + the round this anchor closed: checkpoint_seq for a checkpoint
        // anchor, match_batch_seq for an archive one, the SNAPSHOT BLOCK itself for a v0
        // bundle, whose single anchor_bundle reward is keyed round_reference =
        // SNAPSHOT_BLOCK rather than to any one section's checkpoint_seq).
        let outerFilter = src.filter.replace(/\b(chain|network)\b/g, 'm.$1');
        let rounds = [row.checkpoint_seq, row.match_batch_seq,
                      (Number(row.version) === 0) ? row.snapshot_block : null]
            .filter(v => !this.util.isNull(v)).map(v => Number(v));
        let rewardWhere = 'm.doge_anchor_txid=?';
        let rewardArgs  = [...src.filterParams, row.tx_hash];
        if(rounds.length && !this.util.isNull(row.snapshot_block)){
            rewardWhere += ` OR (m.snapshot_block=? AND m.round_reference IN (${rounds.map(() => '?').join(',')}))`;
            rewardArgs.push(Number(row.snapshot_block), ...rounds);
        }
        let rewards = await this.doQuery(config,
            `SELECT
                m.id,
                m.chain,
                m.network,
                m.reward_type,
                m.round_reference,
                m.snapshot_block,
                m.publisher,
                m.reward_amount,
                m.doge_anchor_txid,
                m.created_at
            FROM ${src.rewardTable} m
            WHERE 1=1` + outerFilter + ` AND (` + rewardWhere + `)
            ORDER BY m.id DESC
            LIMIT ` + limit, rewardArgs) || [];

        row.chunks             = chunks;
        row.checkpoint         = (checkpoint.length) ? this._normalizeCheckpointRows(checkpoint)[0] : null;
        row.publisher_election = electorate;
        row.reward_attestations = rewards;
        return [row];
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

    // XCALL phase transitions latched since the cursor's block (spec
    // explorer-coverage-completion M5.4). This is the XCALL analogue of
    // getBetFeedsClosedSince and exists for the same reason: the transition that ends a
    // call's life on the SOURCE chain - request_status going pending -> completed - is a
    // direct status write performed by the callback interlock, with NO action row of its
    // own for the ChangeDetector's actions cursor to find. `resolved_block` is the height
    // at which that write happened, so it is the cursor column.
    //
    // Expired calls are included even though XCALL v2 does mint an action row: the v2
    // action is a SEPARATE xcalls row (version 2) whose action name is XCALL, so a
    // subscriber filtering on the phase events would otherwise see completions but not
    // expiries, which is the asymmetry that makes a live timeline wrong rather than
    // merely incomplete. The event carries `synthetic` so a consumer can tell which of
    // the two had a causing action.
    // Current phase of ONE cross-chain call, for the WS `xcall` channel's SNAPSHOT
    // frame (spec explorer-coverage-completion M5.4). Sibling of getBetFeedInfo /
    // getDispenserInfo: a plain (config, key) point read that the WS server can call
    // without assembling a request config. Null when this chain has no row for the
    // call_id, which is a normal answer on the TARGET chain of a call.
    //
    // Pinned to the VALID row for the same reason getXcall is: a call_id can carry
    // more than one xcalls row (a rejected attempt indexes alongside the accepted
    // request), and a snapshot built from an invalid row would open the subscription
    // on a lifecycle that never happened.
    async getXcallInfo(config, callId){
        let rows = await this.doQuery(config,
            `SELECT
                m.action_index,
                m.version,
                m.call_id,
                m.contract_index,
                a2.address as source,
                m.target_chain,
                m.target_contract_index,
                m.method,
                m.gas_limit,
                m.deadline_block,
                m.request_status,
                m.result_status,
                m.resolved_block,
                m.callback_action_index,
                m.block_index,
                s1.status
            FROM
                xcalls m
                LEFT JOIN actions         a1 ON (a1.action_index=m.action_index)
                LEFT JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                LEFT JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                LEFT JOIN index_statuses  s1 ON (s1.id=m.status_id)
            WHERE m.call_id=? AND s1.status='valid'
            ORDER BY m.action_index DESC
            LIMIT 1`, [callId]);
        return (rows && rows.length) ? rows[0] : null;
    }

    async getXcallPhasesSince(config, sinceBlockIndex, limit){
        let query = `SELECT
                        m.action_index,
                        m.call_id,
                        m.version,
                        m.contract_index,
                        m.target_chain,
                        m.target_contract_index,
                        m.method,
                        m.request_status,
                        m.result_status,
                        m.resolved_block,
                        m.callback_action_index,
                        m.deadline_block,
                        a2.address as source,
                        s1.status
                    FROM
                        xcalls m
                        LEFT JOIN actions         a1 ON (a1.action_index=m.action_index)
                        LEFT JOIN transactions    t1 ON (t1.tx_index=a1.tx_index)
                        LEFT JOIN index_addresses a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT JOIN index_statuses  s1 ON (s1.id=m.status_id)
                    WHERE
                        m.resolved_block > ?
                        AND m.request_status IN ('completed','expired')
                        AND s1.status='valid'
                    ORDER BY m.resolved_block ASC, m.action_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlockIndex, limit]);
        return results || [];
    }

    async getAttestationsSince(config, sinceBlockIndex, limit){
        let query = `SELECT
                        m.action_index,
                        m.version,
                        m.request_id,
                        m.provider_id,
                        m.contract_index,
                        m.request_status,
                        m.response_status,
                        m.payload,
                        m.callback_params_json,
                        a2.address as source,
                        fp.address as fee_payer,
                        m.block_index,
                        s1.status
                    FROM
                        attests m
                        LEFT JOIN actions             a1 ON (a1.action_index=m.action_index)
                        LEFT JOIN transactions        t1 ON (t1.tx_index=a1.tx_index)
                        LEFT JOIN index_addresses     a2 ON (a2.id=COALESCE(a1.source_id, t1.source_id))
                        LEFT JOIN index_addresses     fp ON (fp.id=m.fee_payer_id)
                        LEFT JOIN index_statuses      s1 ON (s1.id=m.status_id)
                    WHERE
                        m.block_index > ?
                    ORDER BY m.action_index ASC
                    LIMIT ?`;
        let results = await this.doQuery(config, query, [sinceBlockIndex, limit]);
        return results || [];
    }

    async getAttestationByActionIndex(config, action_index){
        let query = `SELECT
                        m.action_index, m.version, m.request_id, m.provider_id, m.contract_index,
                        m.request_status, m.response_status, m.payload, m.callback_params_json, m.block_index,
                        fp.address as fee_payer
                    FROM attests m
                        LEFT JOIN index_addresses fp ON (fp.id=m.fee_payer_id)
                    WHERE m.action_index=?
                    LIMIT 1`;
        let results = await this.doQuery(config, query, [action_index]);
        return (results && results.length) ? results[0] : null;
    }

}

// The families that have moved out under proposal B are attached here, after the
// class exists. Order is irrelevant: mixinReaders refuses a collision rather than
// letting require order decide a winner.
mixinReaders(Database.prototype, connectionMethods, queryBuilder,
    actionListReaders, marketReaders, stakingGovernanceReaders, checkpointReaders,
    entityReaders, actionDetailIoReaders, healthReaders);

module.exports = Database;
module.exports.DbQueryError = DbQueryError;
module.exports.DbInputError = DbInputError;
module.exports.ACTION_SUMMARY_FIELDS = ACTION_SUMMARY_FIELDS;
module.exports.MUTABLE_ACTION_FIELDS = MUTABLE_ACTION_FIELDS;