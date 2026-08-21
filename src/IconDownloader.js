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
 * IconDownloader
 *
 * Optional in-process worker that downloads, resizes, and caches icon
 * images for the tokens visible in this explorer instance. Driven by
 * the per-indexer-DB `icons` table and the priority chain in
 * IconResolver.
 *
 * The `icons` table itself is created automatically by xchain-indexer
 * at startup. Operator opt-in on the explorer side via config.json:
 * iconDownload.enabled = true. The operator must additionally grant
 * the explorer's MySQL user write access on the `icons` table in each
 * indexer database. Requires ImageMagick `convert` on the host PATH.
 *
 * SANCTIONED SHARED-WRITE EXCEPTION (#3752):
 * The explorer is otherwise a strictly read-only consumer of the
 * indexer-owned databases. This worker is the one explicitly-sanctioned
 * exception: it issues INSERT IGNORE / UPDATE against the
 * indexer-owned `icons` table (via netInfo.database.indexer), so the
 * explorer's DB user requires an INSERT + UPDATE grant on that table.
 * This is intentional, not a boundary violation: icon-download state
 * (fetch attempts, hashes, retry timers) is explorer-side bookkeeping
 * that happens to live in the indexer schema for colocation. Relocating
 * icon-state ownership into the indexer (so the explorer reverts to
 * pure read-only) is a tracked POST-LAUNCH follow-up, not done here.
 * The write sites below are marked SHARED-WRITE so the exception stays
 * auditable; do NOT add new explorer writes to indexer-owned tables.
 *
 ********************************************************************/

const axios   = require('axios');
const crypto  = require('crypto');
const fs      = require('fs');
const fsp     = require('fs/promises');
const os      = require('os');
const path    = require('path');
const dns     = require('dns');
const netmod  = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { makeSafeLookup, isPrivateAddress } = require('./ssrf-guard');
// execFile, not exec: both subprocesses below are handed attacker-influenced
// input (a tmp path this process chose, and image bytes from an on-chain
// description). Without a shell there is no word-splitting to escape, and,
// more importantly for the hang below, Node's `timeout` signals the binary
// itself rather than an intervening /bin/sh that could leave the real process
// orphaned and still grinding.
const execFileAsync = promisify(execFile);

const {
    resolveDescriptionToSource,
    selectIconUrlFromCip25Json,
    // The resolver's own `action:` grammar, borrowed as SQL-REGEXP source by the
    // one-shot re-stale in _discover so that predicate can never select a row this
    // module cannot resolve.
    ACTION_REF_PATTERN,
} = require('./IconResolver');
// The same decompression the live /{COIN}/api/file/{index}/raw route applies
// (XChainExplorer.processFileRawRequest), so an `action:` FILE resolves to the
// identical bytes the token page renders from. Contractually non-throwing: it
// reports storedForm rather than handing back partial output.
const compression = require('./compression.js');

// Shared SSRF lookup shim: rejects fetches whose hostname resolves to a
// private/internal/metadata address. Built once at module load.
const SAFE_LOOKUP = makeSafeLookup(dns);

const DEFAULTS = {
    enabled:         false,
    intervalMinutes: 15,
    batchSize:       50,
    fetchTimeoutMs:  5000,
    maxBytes:        5 * 1024 * 1024,
    iconSize:        64,
    requestDelayMs:  200,
    maxAttempts:     4,
    recursionLimit:  2,
    convertBin:      '/usr/bin/convert',
    // Wall-clock ceiling on each subprocess. maxBytes caps the DOWNLOAD, never
    // the DECODE, so a well-formed ~5MB raster declaring enormous dimensions
    // still costs ImageMagick minutes of grinding. runOnce holds the _running
    // re-entrancy guard for the whole pass, so one such image would otherwise
    // stall the icon pipeline for every coin and network until the process is
    // restarted. On expiry Node SIGKILLs the child and _writeIcon fails the row
    // into the normal backoff path.
    convertTimeoutMs: 20000,
    // ImageMagick pixel-cache ceilings, passed as -limit on every invocation.
    // The service ships no policy.xml, so these argv limits are the only bound
    // on IM's allocation: a 5MB PNG declaring 50000x50000 decodes to tens of
    // gigabytes of pixel buffer otherwise. disk 0 makes the overflow fail fast
    // instead of thrashing a temp file. Only memory/map/disk are used because
    // they exist in every IM6 and IM7 build; an unrecognized -limit resource
    // type aborts the conversion, which would take every icon down with it.
    convertMemoryLimit: '256MiB',
    convertMapLimit:    '256MiB',
    convertDiskLimit:   '0',
};

// Raster formats only. SVG is deliberately absent: these bytes come from
// on-chain token descriptions (anyone can ISSUE a token with any description),
// _writeIcon hands them to ImageMagick `convert`, and IM's SVG renderer
// dereferences external references (xlink:href, XML entities, nested image
// URLs). Those fetches leave `convert`, not the axios client below, so they
// never pass SAFE_LOOKUP or _rejectPrivateLiteral: an SVG naming
// http://169.254.169.254/ is an egress this pipeline's SSRF guard cannot see,
// and no ImageMagick policy.xml ships with this service to disable the coders.
// The trade is that a token whose only icon is an SVG gets no rendered icon.
const ALLOWED_MIME = new Set([
    'image/png','image/jpeg','image/jpg','image/gif','image/webp',
]);

const NETWORKS = ['mainnet','testnet','regtest'];

class IconDownloader {

    constructor(explorer){
        this.explorer = explorer;
        this.util     = explorer.util;
        this.timer    = null;
        this._running = false;       // re-entrancy guard
        this._stop    = false;
        this.cfg      = Object.assign({}, DEFAULTS);   // overwritten by start()

        this.iconRoot = path.resolve(path.join(__dirname, 'content/icons'));
    }

    /******************************************************************
     * Lifecycle
     *****************************************************************/

    async start(){
        // Pull the iconDownload block out of the live config so changes to
        // config.json get picked up on the next process restart.
        const cfgRoot = await this.explorer.configInfo.getConfig();
        const userCfg = (cfgRoot && cfgRoot.iconDownload) || {};
        this.cfg      = Object.assign({}, DEFAULTS, userCfg);

        if(!this.cfg.enabled){
            return;
        }
        const intervalMs = Math.max(1, this.cfg.intervalMinutes) * 60 * 1000;
        // Run once on startup, then every intervalMs
        setImmediate(() => { this.runOnce().catch(e => this._logErr('initial run', e)); });
        this.timer = setInterval(() => {
            this.runOnce().catch(e => this._logErr('scheduled run', e));
        }, intervalMs);
        this._log(`started (interval: ${this.cfg.intervalMinutes}min, batchSize: ${this.cfg.batchSize}, iconSize: ${this.cfg.iconSize}px)`);
    }

    stop(){
        this._stop = true;
        if(this.timer){
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /******************************************************************
     * Top-level pass: iterate every configured (coin, network) pair
     *****************************************************************/

    async runOnce(){
        if(this._running){
            this._log('previous run still in progress, skipping tick');
            return;
        }
        this._running = true;
        try {
            const flavors = await this._listFlavors();
            for(const flavor of flavors){
                if(this._stop) break;
                try {
                    await this._processFlavor(flavor);
                } catch (e){
                    this._logErr(`flavor ${flavor.coin}/${flavor.network}`, e);
                }
            }
        } finally {
            this._running = false;
        }
    }

    /**
     * Build the list of (coin, network) pairs the explorer is configured
     * for that have an indexer DB and a matching pool.
     */
    async _listFlavors(){
        const out = [];
        const pools = (this.explorer.db && this.explorer.db.pools) || null;
        if(!pools) return out;

        const cfg = await this.explorer.configInfo.getConfig();
        if(!cfg) return out;

        for(const coin of Object.keys(cfg)){
            const info = cfg[coin];
            // Skip top-level non-coin keys (COIN_NETWORKS, COIN_AVAILABLE, API, etc.)
            if(!info || typeof info !== 'object') continue;
            for(const net of NETWORKS){
                const netInfo = info[net];
                if(!netInfo || !netInfo.database || !netInfo.database.indexer) continue;
                let poolKey = coin;
                if(net === 'testnet') poolKey = 'T' + coin;
                if(net === 'regtest') poolKey = 'R' + coin;
                const pool = pools[poolKey] && pools[poolKey].pool;
                if(!pool) continue;
                out.push({ coin, network: net, poolKey, pool });
            }
        }
        return out;
    }

    /******************************************************************
     * Per-flavor pass: discovery + queue drain
     *****************************************************************/

    async _processFlavor(flavor){
        const conn = await flavor.pool.getConnection();
        try {
            // Discovery: insert new tokens, mark stale ones
            await this._discover(conn);
            // Process: drain a batch
            // Order: never-checked first (newest tokens at the front so
            // freshly-minted ones get icons within minutes instead of waiting
            // behind the initial-backfill queue), then re-evaluate
            // already-checked rows from oldest to newest.
            const rows = await conn.query(
                `SELECT i.id           AS icon_id,
                        i.token_id     AS token_id,
                        i.attempts     AS attempts,
                        t.description  AS description,
                        idx.tick       AS tick
                 FROM icons i
                 JOIN tokens          t   ON t.id        = i.token_id
                 JOIN index_tickers   idx ON idx.id      = t.tick_id
                 WHERE i.status IN ('pending','stale')
                   AND (i.next_retry_at IS NULL OR i.next_retry_at <= NOW())
                 ORDER BY i.last_checked_at IS NULL DESC,
                          CASE WHEN i.last_checked_at IS NULL THEN i.token_id END DESC,
                          i.last_checked_at ASC
                 LIMIT ?`,
                [this.cfg.batchSize]
            );

            if(!rows.length){
                this._log(`[${flavor.coin}/${flavor.network}] queue empty`);
                return;
            }
            this._log(`[${flavor.coin}/${flavor.network}] processing ${rows.length} row(s)`);
            for(const row of rows){
                if(this._stop) break;
                await this._processToken(conn, flavor, row);
                await sleep(this.cfg.requestDelayMs);
            }
        } finally {
            await conn.release();
        }
    }

    /**
     * Insert any tokens missing an icons row (status=pending), and mark
     * stale any whose description has drifted from the last hash we
     * processed. NULL-safe via the `<=>` operator.
     */
    async _discover(conn){
        // SHARED-WRITE EXCEPTION (#3752): these statements write the indexer-owned
        // `icons` table. This is the sanctioned exception to the explorer's read-only
        // boundary and requires an INSERT + UPDATE grant on the indexer DB's icons
        // table. Tracked post-launch follow-up: move icon-state ownership to the indexer.
        // (a) New tokens: INSERT IGNORE on UNIQUE token_id
        await conn.query(
            `INSERT IGNORE INTO icons (token_id, description_hash, status)
             SELECT t.id, MD5(t.description), 'pending'
             FROM tokens t`
        );

        // (b) Changed descriptions
        await conn.query(
            `UPDATE icons i
             JOIN tokens t ON t.id = i.token_id
             SET i.status = 'stale',
                 i.description_hash = MD5(t.description),
                 i.next_retry_at = NULL
             WHERE NOT (MD5(t.description) <=> i.description_hash)`
        );

        // (c) Re-stale the tokens the resolver gives up on without this branch. Absent
        // the `action:` scheme here, an on-chain TIS description resolves to no source
        // and is marked ok-with-no-icon, which is TERMINAL: (b) only re-evaluates when
        // the description CHANGES, and these descriptions are usually description-locked,
        // so the fix would be invisible on every token that already has a row.
        //
        // The predicate is the RESOLVER'S OWN grammar (ACTION_REF_PATTERN), never a
        // prefix test. That is what makes this one-shot rather than a permanent write
        // loop on the indexer-owned table: a description merely starting with `action:`
        // (`action:foo`, `action:BTC:`, `action:12a`) resolves to NOTHING, so
        // _processToken marks it ok-with-no-icon again, which is precisely the state this
        // statement selects, and a wider predicate would re-stale it on every cycle for as
        // long as the token exists - mintable by anyone who can issue a token with such a
        // description (#5290). Every description this predicate CAN select resolves to an
        // `action` source, and from there the row can only leave with an icon_hash or, on
        // any read failure, as 'failed' in the retry backoff; neither is re-selectable. So
        // after one pass this matches nothing.
        //
        // CONVERT(... USING binary) is what holds that invariant, and it is not
        // decoration. Sharing the pattern text is NOT by itself enough to keep the two
        // engines agreeing: the first cut of this statement wrapped the column in LOWER()
        // to emulate a JS /i, and LOWER() is not /i. MariaDB's utf8mb4 LOWER() folds
        // U+0130 to plain 'i' where JS leaves it alone, so `ACTİON:12` matched HERE and
        // resolved to null THERE - selected, unresolvable, re-staled forever, and mintable,
        // since descriptions are attacker-controlled on-chain data. Dropping to a binary
        // collation removes the engine's case-folding from the comparison entirely, and
        // ACTION_REF_PATTERN spells both cases of every letter out, so what matches here is
        // the ASCII language and nothing else. Swept on MariaDB 10.11 and 11.4 against a
        // real utf8mb4 tokens.description: every Unicode scalar value at each grammar slot,
        // zero non-ASCII selections, and every string this does select resolves.
        //
        // Do NOT reintroduce LOWER(), and do not "simplify" this to a COLLATE clause:
        // tokens.description is utf8mb4 in the indexer DDL while the surrounding tables are
        // utf8mb3, so a named `COLLATE utf8_bin` is a charset error waiting for whichever
        // deployment has the other one. CONVERT-to-binary is charset-agnostic.
        //
        // Residual slack, both in the SAFE direction (SQL may select a little LESS than the
        // resolver accepts, never more): SQL TRIM() strips only spaces where String#trim()
        // strips all whitespace, and MariaDB's PCRE `$` also matches before one trailing
        // newline, which the resolver's own .trim() removes before it ever matches.
        //
        // Cost: unlike a `LIKE 'action:%'`, a REGEXP over a wrapped column cannot use an
        // index on t.description, but the icons-side conjuncts already reduce this to the
        // handful of rows still sitting at ok-with-no-icon, and after the first pass the
        // statement updates nothing at all.
        // SHARED-WRITE EXCEPTION (#3752): UPDATE on the indexer-owned `icons` table.
        await conn.query(
            `UPDATE icons i
             JOIN tokens t ON t.id = i.token_id
             SET i.status = 'stale',
                 i.attempts = 0,
                 i.next_retry_at = NULL
             WHERE i.status = 'ok'
               AND i.icon_hash IS NULL
               AND CONVERT(TRIM(t.description) USING binary) REGEXP '${ACTION_REF_PATTERN}'`
        );
    }

    /******************************************************************
     * Process a single icons row.
     *****************************************************************/

    async _processToken(conn, flavor, row){
        const tick = row.tick;
        const desc = row.description;
        const iconDir  = path.join(this.iconRoot, flavor.coin, flavor.network);
        const iconPath = path.join(iconDir, tick + '.png');
        const descHash = md5(desc == null ? '' : desc);

        const src = resolveDescriptionToSource(desc);
        if(!src){
            await this._markOk(conn, row.icon_id, null, null, null, descHash);
            this._log(`    - ${tick}: no icon source`);
            return;
        }

        let bytes;
        try {
            bytes = await this._fetchSourceBytes(src, this.cfg.recursionLimit, flavor);
        } catch (e){
            await this._markFailure(conn, row.icon_id, row.attempts + 1, truncate(e.message, 255));
            this._log(`    ✗ ${tick} (${src.scheme}): ${e.message}`);
            return;
        }

        if(!bytes || bytes.length === 0){
            await this._markFailure(conn, row.icon_id, row.attempts + 1, 'empty body');
            this._log(`    ✗ ${tick} (${src.scheme}): empty body`);
            return;
        }

        const sourceHash = md5(bytes);

        let iconHash;
        try {
            await fsp.mkdir(iconDir, { recursive: true });
            iconHash = await this._writeIcon(bytes, iconPath);
        } catch (e){
            // Stamp descriptions are immutable: if the decoded bytes aren't a
            // usable image, retrying won't help; mark terminal as no-icon-source.
            if(src.scheme === 'stamp'){
                await this._markOk(conn, row.icon_id, null, null, null, descHash);
                this._log(`    - ${tick}: stamp bytes are not a usable image`);
                return;
            }
            await this._markFailure(conn, row.icon_id, row.attempts + 1, truncate(e.message, 255));
            this._log(`    ✗ ${tick} (${src.scheme}): convert failed (${e.message})`);
            return;
        }
        if(!iconHash){
            if(src.scheme === 'stamp'){
                await this._markOk(conn, row.icon_id, null, null, null, descHash);
                this._log(`    - ${tick}: stamp bytes are not a usable image`);
                return;
            }
            await this._markFailure(conn, row.icon_id, row.attempts + 1, 'image conversion failed');
            return;
        }

        await this._markOk(conn, row.icon_id, src.url || null, sourceHash, iconHash, descHash);
        this._log(`    ✓ ${tick} <- ${src.scheme}`);
    }

    /******************************************************************
     * Resolver-aware fetch. May recurse for json_url -> image_url.
     *
     * `flavor` is the (coin, network, poolKey) pair the row belongs to. Only the
     * `action` scheme needs it, because that scheme's bytes are read from a
     * colocated decoder DB rather than fetched over the network; every other
     * branch ignores it, and it rides through the recursion so a TIS document
     * reached from one flavor resolves its nested refs against the same one.
     *****************************************************************/

    async _fetchSourceBytes(src, depth, flavor){
        if(depth < 0) throw new Error('recursion limit hit');

        switch(src.scheme){
            case 'action': {
                const bytes = await this._fetchActionFileBytes(src, flavor);
                // An on-chain TIS document, or the image itself. Same order the
                // json_url branch below uses: try JSON, fall back to raw bytes and
                // let _writeIcon sniff the type out of them.
                let json = null;
                try { json = JSON.parse(bytes.toString('utf8')); } catch (e) {}
                if(json && typeof json === 'object'){
                    const picked = selectIconUrlFromCip25Json(json);
                    if(!picked) throw new Error('action: JSON has no usable image');
                    // A TIS entry's image is normally inline base64 rather than a URL,
                    // so decode it here. The ord branch does the same for the same
                    // reason; the generic URL lanes cannot fetch a data: URL at all.
                    const inline = /^data:[^;,]*;base64,(.*)$/i.exec(picked);
                    if(inline){
                        const buf = Buffer.from(inline[1], 'base64');
                        if(!buf.length) throw new Error('action: empty after base64 decode');
                        return buf;
                    }
                    let next = resolveDescriptionToSource(picked);
                    if(!next) next = { scheme: 'image_url', url: picked };
                    return await this._fetchSourceBytes(next, depth - 1, flavor);
                }
                return bytes;
            }

            case 'stamp': {
                const buf = Buffer.from(src.data, 'base64');
                if(!buf.length) throw new Error('stamp: empty after base64 decode');
                return buf;
            }

            case 'ord': {
                const resp = await this._httpFetch(src.url);
                let json;
                try { json = JSON.parse(resp.body.toString('utf8')); }
                catch (e) { throw new Error('ord: bad decoder JSON from ' + src.url + ': ' + e.message + ' | head=' + resp.body.toString('utf8').slice(0, 80)); }
                const data = json && json.images && json.images[0] && json.images[0].data;
                if(typeof data !== 'string')
                    throw new Error('ord: missing images[0].data');
                const m = /^data:[^;]+;base64,(.*)$/.exec(data);
                if(!m) throw new Error('ord: data URL not base64');
                const buf = Buffer.from(m[1], 'base64');
                if(!buf.length) throw new Error('ord: empty after base64 decode');
                return buf;
            }

            case 'json_url':
            case 'arweave':
            case 'arweave_url':
            case 'ipfs': {
                // Could be JSON (CIP25/TIS) or a direct image. Don't trust
                // the Content-Type header (IPFS gateways routinely serve
                // content as text/plain regardless of the actual bytes).
                const resp = await this._httpFetch(src.url);

                // Try JSON parse first
                let json = null;
                try { json = JSON.parse(resp.body.toString('utf8')); } catch (e) {}
                if(json && typeof json === 'object'){
                    const picked = selectIconUrlFromCip25Json(json);
                    if(!picked) throw new Error(`${src.scheme}: JSON has no usable image`);
                    let next = resolveDescriptionToSource(picked);
                    if(!next) next = { scheme: 'image_url', url: picked };
                    return await this._fetchSourceBytes(next, depth - 1, flavor);
                }

                // Not JSON: return raw bytes; _writeIcon sniffs MIME from
                // the bytes themselves and rejects anything that isn't an
                // allowed image type.
                return resp.body;
            }

            case 'imgur':
            case 'image_url':
            default: {
                const resp = await this._httpFetch(src.url);
                const mime = (resp.mime || '').toLowerCase();
                if(!mime.startsWith('image/'))
                    throw new Error(`${src.scheme}: not an image (got '${mime}')`);
                return resp.body;
            }
        }
    }

    /******************************************************************
     * Read an `action:` FILE's bytes from the colocated decoder DB.
     *
     * This is the one source in the pipeline that opens no socket: the bytes are
     * the ones the token page fetches same-origin from
     * /{COIN}/api/file/{index}/raw, and this reads them the way that route does
     * (getGatedFileRaw first, then getFileRaw, then resolveServedBytes). No
     * network means no SSRF surface, so _rejectPrivateLiteral has nothing to
     * relax.
     *
     * EVERY failure here THROWS, deliberately. The caller turns a throw into
     * _markFailure, which retries with backoff; the alternative shape - answering
     * "no source" - lands in _markOk and is TERMINAL until the (usually
     * description-locked) description changes. A decoder DB that is briefly
     * unreachable, or a FILE this node has not indexed yet, must not permanently
     * mark a token icon-less, and getFileRaw answers null for a miss and for an
     * unreachable decoder DB alike, so a null can never be read as a verdict.
     *****************************************************************/

    async _fetchActionFileBytes(src, flavor){
        if(!flavor || !flavor.poolKey)
            throw new Error('action: no flavor context to resolve the FILE against');
        const db = this.explorer && this.explorer.db;
        if(!db || typeof db.getFileRaw !== 'function')
            throw new Error('action: explorer DB layer unavailable');

        // Same rule the page's actionRefToRawPath applies: a sibling-chain ref names a
        // BASE ticker and inherits THIS flavor's network tier (T testnet, R regtest),
        // because a ref is only ever emitted alongside the chain it was written on.
        let poolKey = flavor.poolKey;
        if(src.coin){
            const tier = (/^([TR])(?:BTC|LTC|DOGE)$/.exec(flavor.poolKey) || [])[1] || '';
            poolKey = tier + src.coin;
        }
        const pools = db.pools || {};
        if(!pools[poolKey])
            throw new Error('action: no pool configured for ' + poolKey + ' on this instance');

        const config = { coin: poolKey, data: {} };
        // Token-gated FILEs are stored as AES-GCM ciphertext and only a key holder can
        // read them, so there is no icon to render. Thrown rather than marked no-source
        // so the row lands in the normal backoff and retires as 'failed' after
        // maxAttempts, instead of taking the terminal path a transient miss shares.
        const gated = await db.getGatedFileRaw(config, src.index);
        if(gated && gated.length && gated[0] && gated[0].raw_data)
            throw new Error('action: FILE ' + poolKey + ':' + src.index + ' is token-gated ciphertext');

        const file = await db.getFileRaw(config, src.index);
        if(!file || !file.raw_data)
            throw new Error('action: FILE ' + poolKey + ':' + src.index +
                ' has no readable bytes here (unknown action, or decoder DB unreachable)');

        const served = await compression.resolveServedBytes(file.raw_data, file.data);
        // storedForm means the bytes are NOT the original file (a lying COMPRESSION
        // field, a corrupt stream, or the ratio guard). The route hands those to a
        // client under a header; an icon renderer has nothing to do with them.
        if(served.storedForm)
            throw new Error('action: stored bytes are not the original file (' +
                String(served.error || 'UNKNOWN') + ')');
        return served.bytes;
    }

    // The egress-policy gate for this pipeline: both checks an icon URL must pass
    // before a socket opens, and again on every redirect hop.
    //
    // SSRF: the dns.lookup shim (SAFE_LOOKUP) only fires for DNS-name hosts; Node's
    // net.connect skips a custom `lookup` when the host is an IP literal, so a URL
    // like http://169.254.169.254/x.json or http://127.0.0.1:6379/x.png would bypass
    // the shim and connect straight to an internal/metadata address. Check literal
    // hosts against the canonical classifier before connecting (and again on each
    // redirect hop, since a Location: can also point at a literal IP).
    //
    // WEB PORTS ONLY: the same rule /relay enforces (processRelayRequest), for the
    // same reason and over the same class of attacker-written URLs. Token icons
    // live on ordinary web servers, so nothing legitimate needs another port,
    // while an unrestricted port turns this fetch into a probe for services
    // (databases, admin panels) sitting on a PUBLIC address, which is exactly what
    // the private-range check above lets through. The probe's result is readable:
    // the icons row keeps status and last_error.
    _rejectPrivateLiteral(rawUrl){
        let parsed;
        try { parsed = new URL(rawUrl); }
        catch(_){ return; } // malformed URL: axios/URL will reject it downstream
        const host = parsed.hostname.replace(/^\[|\]$/g, '');
        if(netmod.isIP(host) && isPrivateAddress(host)){
            const e = new Error('Destination is a non-permitted address');
            e.code = 'RELAY_DENIED';
            throw e;
        }
        // Read the port the way /relay does: empty means the protocol's default.
        const port = (parsed.port === '') ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port;
        if(!['80', '443'].includes(port)){
            const e = new Error('Destination port is not permitted');
            e.code = 'RELAY_DENIED';
            throw e;
        }
    }

    async _httpFetch(url){
        this._rejectPrivateLiteral(url);
        let resp;
        try {
            resp = await axios.get(url, {
                responseType:     'arraybuffer',
                timeout:          this.cfg.fetchTimeoutMs,
                maxContentLength: this.cfg.maxBytes,
                maxRedirects:     3,
                // SSRF guard: icon source URLs come from on-chain token
                // descriptions (fully attacker-controlled: anyone can ISSUE a
                // token with any description), so this fetch must refuse to
                // connect to private/internal/metadata addresses. The lookup
                // shim validates the address axios is about to connect to and,
                // because follow-redirects reuses these options, re-validates
                // every DNS-name redirect hop. beforeRedirect additionally
                // re-checks a literal-IP redirect target (which the shim skips).
                lookup:           SAFE_LOOKUP,
                beforeRedirect:   (options) => { this._rejectPrivateLiteral(options.href || (options.protocol + '//' + options.hostname)); },
                headers: { 'User-Agent': 'xchain-icon-downloader/1.0' },
                validateStatus: s => s >= 200 && s < 300,
            });
        } catch (e){
            if(e.response){
                throw new Error(`HTTP ${e.response.status}`);
            }
            throw new Error(e.code || e.message || 'fetch failed');
        }
        const body = Buffer.isBuffer(resp.data) ? resp.data : Buffer.from(resp.data);
        const mime = (resp.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        return { status: resp.status, mime, body };
    }

    /******************************************************************
     * Image conversion: write source bytes to a tmp file, run ImageMagick
     * convert to produce a NxN PNG at iconPath, return md5 of result.
     *****************************************************************/

    async _writeIcon(bytes, iconPath){
        const tmp = path.join(os.tmpdir(), 'iconw_' + process.pid + '_' + crypto.randomBytes(4).toString('hex'));
        await fsp.writeFile(tmp, bytes);

        let mime;
        try { mime = await sniffMime(tmp, this.cfg.convertTimeoutMs); }
        catch (e){
            await safeUnlink(tmp);
            throw new Error('mime sniff failed');
        }
        if(!ALLOWED_MIME.has(mime)){
            await safeUnlink(tmp);
            throw new Error(`unsupported mime '${mime}'`);
        }

        // GIF/WebP: pick the first frame so animated/multi-page sources don't break the resize
        const needsFirstFrame = (mime === 'image/gif' || mime === 'image/webp');
        const srcArg          = needsFirstFrame ? `${tmp}[0]` : tmp;
        const size            = this.cfg.iconSize;

        // -limit precedes the input on purpose: ImageMagick applies settings in
        // command-line order, so a limit placed after the filename does not bound
        // the read that allocates the pixel cache.
        const convertArgs = [
            '-limit', 'memory', String(this.cfg.convertMemoryLimit),
            '-limit', 'map',    String(this.cfg.convertMapLimit),
            '-limit', 'disk',   String(this.cfg.convertDiskLimit),
            srcArg,
            '-resize', `${size}x${size}!`,
            '-format', 'png',
            iconPath,
        ];

        try {
            await execFileAsync(this.cfg.convertBin, convertArgs, {
                timeout:    this.cfg.convertTimeoutMs,
                killSignal: 'SIGKILL',
            });
        } catch (e){
            await safeUnlink(tmp);
            // A timeout kill leaves stderr empty and the message unhelpful, so name
            // it: the row's last_error is the only place this is visible.
            const killed = (e.killed === true || e.signal === 'SIGKILL');
            throw new Error('convert failed: ' + (killed
                ? `timed out after ${this.cfg.convertTimeoutMs}ms`
                : (e.stderr || e.message || '')));
        }
        await safeUnlink(tmp);

        try {
            const buf = await fsp.readFile(iconPath);
            return md5(buf);
        } catch (e){
            return null;
        }
    }

    /******************************************************************
     * State updates
     *****************************************************************/

    async _markOk(conn, iconId, sourceUrl, sourceHash, iconHash, descHash){
        // SHARED-WRITE EXCEPTION (#3752): UPDATE on the indexer-owned `icons` table.
        // Sanctioned write outside the explorer read-only boundary; needs an UPDATE
        // grant on the indexer DB. Icon-state ownership relocation is a post-launch follow-up.
        await conn.query(
            `UPDATE icons SET
                 status='ok', attempts=0, last_error=NULL, next_retry_at=NULL,
                 source_url=?, source_hash=?, icon_hash=?, description_hash=?, last_checked_at=NOW()
             WHERE id=?`,
            [sourceUrl, sourceHash, iconHash, descHash, iconId]
        );
    }

    async _markFailure(conn, iconId, attempts, errMsg){
        // SHARED-WRITE EXCEPTION (#3752): UPDATE on the indexer-owned `icons` table.
        // Sanctioned write outside the explorer read-only boundary; needs an UPDATE
        // grant on the indexer DB. Icon-state ownership relocation is a post-launch follow-up.
        if(attempts >= this.cfg.maxAttempts){
            await conn.query(
                `UPDATE icons SET status='failed', attempts=?, last_error=?,
                                  next_retry_at=NULL, last_checked_at=NOW()
                 WHERE id=?`,
                [attempts, errMsg, iconId]
            );
        } else {
            const sec = backoffSeconds(attempts);
            await conn.query(
                `UPDATE icons SET status='failed', attempts=?, last_error=?,
                                  next_retry_at=DATE_ADD(NOW(), INTERVAL ? SECOND),
                                  last_checked_at=NOW()
                 WHERE id=?`,
                [attempts, errMsg, sec, iconId]
            );
        }
    }

    /******************************************************************
     * Logging helpers
     *****************************************************************/

    _log(msg){
        const ts = new Date().toISOString();
        console.log(`[${ts}] [icon-downloader] ${msg}`);
    }

    _logErr(where, err){
        const ts = new Date().toISOString();
        console.error(`[${ts}] [icon-downloader] error in ${where}:`, err && err.stack ? err.stack : err);
    }
}

/******************************************************************
 * Helpers
 *****************************************************************/

function md5(input){
    return crypto.createHash('md5').update(input).digest('hex');
}

function sleep(ms){
    return new Promise(r => setTimeout(r, ms));
}

function truncate(s, n){
    if(typeof s !== 'string') s = String(s);
    return s.length > n ? s.slice(0, n) : s;
}

async function safeUnlink(p){
    try { await fsp.unlink(p); } catch (e) { /* ignore */ }
}

// MIME sniff via the `file` command (works without adding a dependency).
// Bounded like the conversion below it: `file` reads the same hostile bytes,
// and a sniff that never returns wedges the whole pass just as a hung convert
// does, because runOnce holds _running until _processToken resolves.
async function sniffMime(filePath, timeoutMs){
    const { stdout } = await execFileAsync('file', ['--mime-type', '-b', filePath], {
        timeout:    timeoutMs,
        killSignal: 'SIGKILL',
    });
    return stdout.trim();
}

// 1h, 1d, 7d, then permanent (capped via maxAttempts)
function backoffSeconds(attempts){
    if(attempts <= 1) return 3600;
    if(attempts === 2) return 86400;
    if(attempts === 3) return 7 * 86400;
    return 30 * 86400;
}

module.exports = IconDownloader;
