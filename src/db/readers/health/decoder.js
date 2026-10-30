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
 * XChain Explorer - the decoder tip and mempool reads
 *
 * One part of src/db/readers/health.js (the entry composes it through
 * composeReaderParts). Everything read from the decoder service rather than
 * from this instance's own tables: its tip, a block time by height, the
 * coin-code parse those calls take, the mempool snapshot, count and feed, and the
 * row decoding that turns a raw mempool row into the segments an address
 * filter matches against.
 *
 * They are one part because they share the failure mode: the decoder is a
 * remote dependency, and every method here has to answer with something
 * usable when it is unreachable rather than propagate the error.
 *
 * Authored as a class body whose prototype is exported, like every other
 * family under src/db/: `this` is the Database instance at call time, and the
 * methods reach Database.prototype non-enumerable, by descriptor.
 *
 ********************************************************************/

'use strict';

const DecoderConnector = require('../../../connectors/decoder.js');
const { DbQueryError } = require('../../shared.js');

// Structured logging. Cached at require time: getLogger() resolves lazily on
// every call, so this reaches the real shipper once api.js has run
// installObservability and falls through to bare console.* before that.
const { getLogger } = require('../../../observability');
const log = getLogger();

// A node mempool count older than this reads as unknown rather than current.
const NODE_MEMPOOL_MAX_AGE_MS = 2 * 60 * 1000;
const mempoolTtl = (db) => parseInt(db.configInfo.env.MEMPOOL_COUNT_CACHE_MS, 10) || 15000;
const mempoolWindow = (limit) => Math.max(1, Math.min(Number(limit) || 200, 500));
function decoderMempoolUrl(db, code, parsed){ return DecoderConnector.resolveDecoderUrl(parsed && parsed.coin, parsed && parsed.network, (db.decoderApiUrl || {})[code] || null); }
// Whether a configured endpoint answered in shape, so the colocated decoder DB is no fallback.
function endpointOwnsMempool(db, code, parsed){ const state = (db._mempoolApiCache || {})[code]; return Boolean(decoderMempoolUrl(db, code, parsed)) && !(state && state.malformed); }
function ageNodeMempoolCount(snapshot, now){
    if(!snapshot || !Object.prototype.hasOwnProperty.call(snapshot, 'node_updated_at')) return snapshot;
    const updatedAt = Number(snapshot.node_updated_at); return Number.isFinite(updatedAt) && updatedAt > 0 && now - updatedAt < NODE_MEMPOOL_MAX_AGE_MS ? snapshot : Object.assign({}, snapshot, { node_tx_count: null });
}
// Build the cached snapshot from a reply. A present but non-positive read_ok_at (a decoder with no DB yet) or a stale
// reply without one has no good read behind it; only a reply lacking the property (an older decoder) is stamped now.
function snapshotValue(reply, now){
    const reportedOkAt = Number(reply.read_ok_at), reported = Object.prototype.hasOwnProperty.call(reply, 'read_ok_at'), okAt = Number.isFinite(reportedOkAt) && reportedOkAt > 0 ? reportedOkAt : (reported || reply.stale === true ? null : now);
    const value = { node_tx_count: typeof reply.node_tx_count === 'number' && reply.node_tx_count >= 0 ? reply.node_tx_count : null, total: Number(reply.total) || 0, rows: reply.rows, read_ok_at: okAt };
    if(Object.prototype.hasOwnProperty.call(reply, 'node_updated_at')) value.node_updated_at = reply.node_updated_at; return { okAt, value: ageNodeMempoolCount(value, now) };
}

// The decoder DB's action-carrying mempool count, cached; 0 when the DB cannot answer.
async function readDecoderMempoolCount(db, config){
    let dbName = db.decoderDb ? db.decoderDb[config.coin] : null;
    // dbName is config-derived, not client input, but database identifiers
    // can't be bound; restrict to a safe identifier charset before use.
    if(db.util.isNull(dbName) || !/^[A-Za-z0-9_$]+$/.test(dbName)) return 0;
    const ttl = mempoolTtl(db), now = Date.now();
    db._mempoolCountCache = db._mempoolCountCache || {}; const hit = db._mempoolCountCache[config.coin];
    if(hit && (now - hit.t) < ttl) return hit.v;
    try {
        // Action-carrying rows only. mempool_transactions holds a row for
        // EVERY mempool tx the decoder saw, with `data` blanked to '' when
        // the tx carried no valid ACTION (nearly all of them on a public
        // chain), so a bare COUNT(*) publishes the node's whole mempool as
        // the XChain unconfirmed count. Matches what the feed renders,
        // since decodeMempoolRow drops the same rows.
        let query   = 'SELECT COUNT(*) as count FROM `' + dbName + '`.mempool_transactions' +
                      " WHERE data IS NOT NULL AND data != ''";
        let results = await db.doDecoderQuery(config, query, []);
        if (results && results.length && results[0].count !== null){
            const v = Number(results[0].count);
            db._mempoolCountCache[config.coin] = { t: now, v };
            return v;
        }
    } catch(e){
        // Decoder DB unreachable, missing table, or no cross-DB grant: serve the
        // last good count if we have one, else report 0.
        log.warn('DECODER_MEMPOOL_COUNT_UNAVAILABLE', { method: 'getDecoderMempoolCount', coin: config.coin, err: e && e.message ? e.message : e });
    }
    return (hit && hit.v) || 0;
}

// Read the decoder DB's mempool window, throwing when the read fails, so a caller can tell
// a failed read from an empty mempool. [] when no decoder DB is configured for the coin.
async function queryDecoderMempoolRows(db, config, max){
    const dbName = db.decoderDb ? db.decoderDb[config.coin] : null;
    if(db.util.isNull(dbName) || !/^[A-Za-z0-9_$]+$/.test(dbName)) return [];
    const select = (firstSeen) => 'SELECT m.tx_hash AS tx_hash, m.source AS source, m.data AS data' +
        (firstSeen ? ', UNIX_TIMESTAMP(m.first_seen) AS first_seen ' : ' ') + 'FROM `' + dbName + '`.mempool_transactions m ' +
        "WHERE m.data IS NOT NULL AND m.data != '' ORDER BY m.tx_hash LIMIT " + max;
    try {
        // ORDER BY the unique-indexed tx_hash: the table has no primary key
        // and the decoder rewrites it every cycle, so a bare LIMIT returns a
        // scan-order subset that churns between polls. The ws mempool diff
        // and /api/mempool paging both read this window as a stable snapshot.
        // first_seen: UNIX_TIMESTAMP so both paths hand callers the same
        // integer-seconds representation the decoder API serves.
        // Action-carrying rows only (same filter + rationale as
        // getDecoderMempoolCount): an unfiltered window fills all 500 slots
        // with actionless rows on a busy chain and renders an empty feed
        // while real pending actions sit deeper in the table.
        return (await db.doDecoderQuery(config, select(true), [])) || [];
    } catch(e){
        // errno 1054: a decoder DB from before the 2026-08-22-mempool-first-seen
        // migration has no first_seen column. Retry without it (Time renders
        // as absent) instead of blanking the whole feed until the decoder
        // restarts and auto-applies its migration. doQuery wraps the driver
        // error in DbQueryError with the original on `cause`, so check both.
        const errno = (e && e.errno) || (e && e.cause && e.cause.errno);
        if(errno != 1054) throw e;
        return (await db.doDecoderQuery(config, select(false), [])) || [];
    }
}

// The feed's decoder-DB read, stamped only once it returned; null when it failed.
async function readMempoolFeedFromDb(db, config, limit){
    const rows = await db.getDecoderMempoolRows(config, limit, { nullOnFailure: true });
    return rows === null ? null : { rows, read_ok_at: Date.now() };
}

class HealthDecoderReaders {
    // Get the decoder-tip reference for a coin: the highest block the decoder has
    // *processed* for it. The explorer reads the indexer DB, whose MAX(block_index)
    // is the indexer's own position; the decoder DB's MAX(block_index) is the
    // decoder's position. Comparing the two yields the indexer->decoder lag, which
    // is what lets /api/status distinguish a stalled indexer from a healthy one.
    // NOTE: this is NOT the coin node's chain tip; the explorer never talks to a
    // coin node, so a decoder lagging the chain node is invisible here; that gap is
    // surfaced by the decoder's own health() JSON-RPC. Reuses the indexer connection
    // pool via a database-qualified query (the decoder DB is on the same server) and
    // returns null when the decoder DB name is unknown or the query fails, so status
    // degrades to "no tip" rather than erroring.
    async getDecoderTip(config) {
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return null;
        // dbName originates from hub/explorer config, not client input, but it is
        // interpolated into the query (database identifiers can't be bound), so
        // restrict it to a safe identifier charset before use.
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return null;
        try {
            let query   = 'SELECT MAX(block_index) as max_index FROM `' + dbName + '`.blocks';
            let results = await this.doDecoderQuery(config, query, []);
            if (results && results.length && results[0].max_index !== null)
                return Number(results[0].max_index);
        } catch(e){
            // Decoder DB unreachable, missing, or no cross-DB grant: omit the tip.
            log.warn('DECODER_TIP_UNAVAILABLE', { method: 'getDecoderTip', coin: config.coin, err: e && e.message ? e.message : e });
        }
        return null;
    }

    // Read the decoder's recorded block_time for ONE height. Exists to answer a
    // question tip_future_seconds structurally cannot: that field is derived from
    // the newest block the indexer has already COMMITTED, which is by definition
    // past-dated, so it reads 0 during the exact condition it looks like it would
    // reveal. The block that decides whether the indexer is waiting or wedged is
    // the NEXT one (last_block + 1), which only the decoder DB has, because the
    // indexer has not committed it yet. Same degradation contract as
    // getDecoderTip: null when the DB name is unknown, unsafe, or the read fails.
    async getDecoderBlockTime(config, height) {
        let dbName = this.decoderDb ? this.decoderDb[config.coin] : null;
        if(this.util.isNull(dbName)) return null;
        if(!/^[A-Za-z0-9_$]+$/.test(dbName)) return null;
        if(!Number.isFinite(Number(height))) return null;
        try {
            let query   = 'SELECT block_time FROM `' + dbName + '`.blocks WHERE block_index = ? LIMIT 1';
            let results = await this.doDecoderQuery(config, query, [Number(height)]);
            if (results && results.length && results[0].block_time !== null)
                return Number(results[0].block_time);
        } catch(e){
            log.warn('DECODER_BLOCK_TIME_UNAVAILABLE', { method: 'getDecoderBlockTime', coin: config.coin, height, err: e && e.message ? e.message : e });
        }
        return null;
    }

    // Split a route code (TBTC / RDOGE / BTC) into { coin, network } using the
    // loaded config's COIN_PREFIXES/COIN_NETWORKS. Returns null when the code
    // doesn't parse (config momentarily unavailable, or an unknown base coin).
    async parseCoinCode(code){
        try {
            let full     = await this.configInfo.getConfig();
            let networks = full['COIN_NETWORKS'] || {};
            let prefixes = full['COIN_PREFIXES'] || { mainnet: '', testnet: 'T', regtest: 'R' };
            let upper    = String(code || '').toUpperCase();
            // Non-empty prefixes (T/R) first so 'TBTC' isn't read as a mainnet
            // coin named 'TBTC' (same rule as getStatus's parseCode).
            for(let network in prefixes){
                let p = prefixes[network];
                if(p && upper.startsWith(p)){
                    let base = upper.slice(p.length);
                    if(networks[base]) return { coin: base, network };
                }
            }
            if(networks[upper]) return { coin: upper, network: 'mainnet' };
        } catch(e){ /* fall through to null */ }
        return null;
    }

    // Live mempool snapshot over the decoder's JSON-RPC API (getmempool), the
    // ONLY live-mempool path for an explorer serving from synced replicas:
    // mempool_transactions is deliberately excluded from xchain-sync replication
    // (node-local, non-deterministic), so on a replica deployment the colocated
    // decoder-DB reads below see a permanently empty table. When a decoder API
    // endpoint resolves for the coin (DECODER_API_URL_<COIN>_<NETWORK> >
    // config-derived decoderApiUrl > DECODER_API_URL, same chain as /status's
    // decoder_health), this snapshot is preferred by the mempool readers; a
    // deployment with no endpoint (e.g. a single-box regtest stack whose decoder
    // DB is truly colocated) falls back to the direct DB path unchanged.
    // Cached per coin for MEMPOOL_COUNT_CACHE_MS (default 15s). The decoder never errors
    // a failed read: it answers stale:true with its last window, so a stale reply or a
    // transport failure is served only within two TTLs of the last good read, then null.
    async getDecoderMempoolSnapshot(config){
        const code = config.coin, ttl = mempoolTtl(this), now = Date.now();
        this._mempoolApiCache = this._mempoolApiCache || {};
        const hit = this._mempoolApiCache[code];
        if(hit && (now - hit.t) < ttl) return ageNodeMempoolCount(hit.v, now);
        const url = decoderMempoolUrl(this, code, await this.parseCoinCode(code));
        if(!url) return null;
        try {
            const reply = await new DecoderConnector(url).getmempool(500);
            if(!reply || !Array.isArray(reply.rows)) return (this._mempoolApiCache[code] = { t: now, v: null, okAt: null, malformed: true }).v;
            const { okAt, value } = snapshotValue(reply, now);
            // A stale reply, or one with no good read behind it, never refreshes the cache clock, so the decoder is asked again.
            if(reply.stale === true || okAt === null){ const usable = okAt && (now - okAt) < 2 * ttl ? value : null;
                return (this._mempoolApiCache[code] = { t: now - ttl, v: usable, okAt, stale: true, unavailable: usable === null }).v; }
            return (this._mempoolApiCache[code] = { t: now, v: value, okAt }).v;
        } catch(e){
            log.warn('DECODER_MEMPOOL_UNAVAILABLE', { method: 'getDecoderMempoolSnapshot', code, err: e && e.message ? e.message : e });
            const okAt = hit ? hit.okAt : undefined, stale = Boolean(hit && hit.stale);
            const value = hit && hit.v && Number.isFinite(Number(okAt)) && now - Number(okAt) < 2 * ttl ? ageNodeMempoolCount(hit.v, now) : null;
            return (this._mempoolApiCache[code] = { t: stale ? now - ttl : now, v: value, okAt, stale, unavailable: value === null }).v;
        }
    }

    // The coin node's TOTAL mempool tx count (XChain-carrying or not), from the
    // decoder API snapshot. null when no decoder API is configured/reachable or
    // the decoder hasn't completed a mempool poll yet: the DB paths below cannot
    // know this number (the decoder DB only holds the XChain-carrying subset),
    // so there is deliberately no fallback and callers render null as absent.
    async getNodeMempoolCount(config){
        let snap = await this.getDecoderMempoolSnapshot(config);
        return (snap && typeof snap.node_tx_count === 'number') ? snap.node_tx_count : null;
    }

    // Count of unconfirmed (mempool) transactions for this coin: the decoder
    // API snapshot when one resolves (see getDecoderMempoolSnapshot), else the
    // decoder DB's mempool_transactions table. Same access pattern + safety as
    // getDecoderTip (DB-qualified query on the indexer pool; only works when the
    // decoder DB shares the indexer's server/credentials). Returns 0 when the
    // decoder DB isn't reachable so callers always get a usable number.
    // Cached per coin for MEMPOOL_COUNT_CACHE_MS (default 15s, same pattern as
    // getFeeEstimate's _feeCache): the count backs the unauthenticated coin
    // homepage / network stats, and an uncached COUNT(*) on a busy mempool table
    // is a full-scan the public read path can be made to repeat on every hit.
    // A stale prior value is served when the query fails mid-flight.
    async getDecoderMempoolCount(config) {
        const parsed = await this.parseCoinCode(config.coin), snap = await this.getDecoderMempoolSnapshot(config);
        if(snap) return snap.total;
        // A configured endpoint that cannot answer is unknown (null), not the colocated DB's count.
        return endpointOwnsMempool(this, config.coin, parsed) ? null : readDecoderMempoolCount(this, config);
    }

    // Raw unconfirmed (mempool) action rows from the decoder DB. As of the
    // 2026-06-15 mempool-raw-strings migration, mempool_transactions stores the
    // tx hash and source address as raw string columns (tx_hash, source) rather
    // than FK ids into the decoder's index tables, so the row reads directly with
    // no joins. Rows are PRE-VALIDATION: the decoder writes whatever parses out of
    // a mempool tx; the indexer may still reject it at confirmation time.
    // mempool_transactions DOES declare a `destination` column (indexed as
    // mempool_destination) and the decoder binds it on every insert, but the
    // bound value is always NULL: XChainDecoder.parseTransaction's only success
    // return hardcodes destination:null. Destinations live inside the decoded
    // action string (`data`), which callers parse. Do NOT move getMempool's
    // type=address filter onto that index: it would match zero rows. Same
    // access pattern + safety rules as getDecoderMempoolCount. Returns [] when
    // the decoder DB isn't reachable.
    //
    // ENCODING: mempool_transactions.data is a MEDIUMTEXT utf8mb4 column holding
    // the canonical UTF-8 ACTION string ("SEND|0|TICK|..."), the exact same
    // representation the decoder's confirmed-block path writes to
    // transactions.data. It is NOT hex. The decoder pins that contract in
    // test/unit/mempool_payload_representation.test.js (uuid:26220713); this read
    // and decodeMempoolRow below are the other half of it.
    // opts.nullOnFailure answers null for a failed DB read, for a caller that must not read it as empty.
    async getDecoderMempoolRows(config, limit, opts) {
        const max = mempoolWindow(limit), parsed = await this.parseCoinCode(config.coin), snap = await this.getDecoderMempoolSnapshot(config);
        if(snap) return snap.rows.slice(0, max);
        // A configured endpoint that cannot answer is unknown (null), not an empty window.
        if(endpointOwnsMempool(this, config.coin, parsed)) return null;
        try { return await queryDecoderMempoolRows(this, config, max); }
        catch(e){ log.warn('DECODER_MEMPOOL_ROWS_UNAVAILABLE', { method: 'getDecoderMempoolRows', coin: config.coin, err: e && e.message ? e.message : e }); return opts && opts.nullOnFailure ? null : []; }
    }

    // The mempool window the /api/mempool page and the WebSocket diff read, with the time
    // it was read. null when no trustworthy window exists: a configured endpoint past its
    // stale limit, or a decoder DB read that failed, so neither reads as a fresh empty mempool.
    async getDecoderMempoolFeed(config, limit){
        const code = config.coin, parsed = await this.parseCoinCode(code), max = mempoolWindow(limit);
        if(!decoderMempoolUrl(this, code, parsed)) return readMempoolFeedFromDb(this, config, limit);
        const ttl = mempoolTtl(this), snap = await this.getDecoderMempoolSnapshot(config);
        const hit = (this._mempoolApiCache || {})[code], okAt = snap && snap.read_ok_at ? snap.read_ok_at : hit && hit.okAt;
        if(hit && hit.malformed) return readMempoolFeedFromDb(this, config, limit);
        if(!snap || !okAt || (Date.now() - okAt) >= 2 * ttl) return null;
        return { rows: snap.rows.slice(0, max), read_ok_at: okAt };
    }

    // Split one decoder mempool row's action string into its parts. The column
    // already holds the canonical UTF-8 ACTION string (see the encoding note on
    // getDecoderMempoolRows), so there is nothing to decode: the wire layout is
    // pipe-joined with the action name first (e.g.
    // SEND|0|TICK|AMOUNT|DESTINATION|MEMO). Returns null on garbage, which also
    // covers the decoder's rejected-ACTION sentinel (an empty string written for
    // a money-bearing tx whose ACTION was invalid or unknown) and any legacy
    // hex-encoded row left behind by an older decoder: neither yields a
    // valid leading action name, so both drop out of the feed rather than
    // rendering as mojibake.
    decodeMempoolRow(row) {
        try {
            if(!row || this.util.isNull(row.data)) return null;
            // Buffer only if a driver hands back the TEXT column as binary.
            let text = Buffer.isBuffer(row.data) ? row.data.toString('utf8') : String(row.data);
            if(!text.length) return null;
            let segments = text.split('|');
            let action = String(segments[0] || '').trim().toUpperCase();
            if(!/^[A-Z_]{2,32}$/.test(action)) return null;
            return {
                tx_hash: row.tx_hash || null,
                source:  row.source || null,
                action:  action,
                data:    text,
                // Unix seconds when the decoder first observed the tx in its
                // node's mempool; null against a pre-first_seen decoder DB.
                first_seen: this.util.isNumeric(row.first_seen) ? Number(row.first_seen) : null
            };
        } catch(e){
            return null;
        }
    }

    // Split a decoded mempool row's action string into its pipe-joined segments.
    // Deliberately layout-free: the field map differs per action family and only
    // SEND has a documented one, so every consumer scans segments instead of
    // reading positions. Returns [] for a row with no action string (the
    // ChangeDetector's removal path carries `data: null` for a row that never
    // decoded), so callers never have to null-check first.
    mempoolSegments(decoded) {
        if(!decoded || this.util.isNull(decoded.data)) return [];
        let text = Buffer.isBuffer(decoded.data) ? decoded.data.toString('utf8') : String(decoded.data);
        return text.split('|');
    }

    // Does this decoded mempool row involve `address`? THE one matcher for
    // "who does this unconfirmed tx affect", shared by the REST prefilter
    // (getMempool TYPE=address) and the WS fan-out (Broadcaster mempool
    // frames). Sharing it is the point: the poll and the live event must never
    // disagree about the parties to a tx, or a wallet sees a pending row that
    // no event ever removes (or the reverse).
    //
    // `addressId` is the address's index id from the cached BYTE-EXACT resolver
    // (getExactAddressId), or null when it has none. Byte-exact is a correctness
    // requirement of this matcher and not a style choice: the ci resolver would
    // hand a case variant the id of the address it resembles, and the `^<id>`
    // branch below would then name it a party to a transaction it has no part in.
    // It is what makes a compacted destination match:
    // the SDK writes destinations as `^<id>` references by default
    // (addressResolver), so without this branch an incoming pending payment to
    // an address that already holds an index id is invisible on both surfaces. Resolution
    // is FORWARD (address -> id) on purpose; no id -> address lookup exists in
    // the explorer and none is needed, since both call sites hold the address.
    //
    // Known false-positive class, accepted: a non-destination segment (a memo)
    // whose text equals the address matches. See the accepted-limitations note
    // in the /api/mempool endpoint header.
    mempoolRowMatchesAddress(decoded, address, addressId) {
        if(!decoded || this.util.isNull(address)) return false;
        let search = String(address);
        if(!search.length) return false;
        if(decoded.source === search) return true;
        let segments = this.mempoolSegments(decoded);
        if(segments.includes(search)) return true;
        if(this.util.isNull(addressId)) return false;
        return segments.includes('^' + String(addressId));
    }
}

module.exports = HealthDecoderReaders.prototype;
