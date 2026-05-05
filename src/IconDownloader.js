/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
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
 ********************************************************************/

const axios   = require('axios');
const crypto  = require('crypto');
const fs      = require('fs');
const fsp     = require('fs/promises');
const os      = require('os');
const path    = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const { resolveDescriptionToSource, selectIconUrlFromCip25Json } = require('./IconResolver');

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
};

const ALLOWED_MIME = new Set([
    'image/png','image/jpeg','image/jpg','image/gif','image/webp','image/svg+xml',
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
        // (a) New tokens — INSERT IGNORE on UNIQUE token_id
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
            bytes = await this._fetchSourceBytes(src, this.cfg.recursionLimit);
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
            // usable image, retrying won't help — mark terminal as no-icon-source.
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
     *****************************************************************/

    async _fetchSourceBytes(src, depth){
        if(depth < 0) throw new Error('recursion limit hit');

        switch(src.scheme){
            case 'stamp': {
                const buf = Buffer.from(src.data, 'base64');
                if(!buf.length) throw new Error('stamp: empty after base64 decode');
                return buf;
            }

            case 'ord': {
                const resp = await this._httpFetch(src.url);
                let json;
                try { json = JSON.parse(resp.body.toString('utf8')); }
                catch (e) { throw new Error('ord: bad decoder JSON'); }
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
                // the Content-Type header — IPFS gateways routinely serve
                // content as text/plain regardless of the actual bytes.
                const resp = await this._httpFetch(src.url);

                // Try JSON parse first
                let json = null;
                try { json = JSON.parse(resp.body.toString('utf8')); } catch (e) {}
                if(json && typeof json === 'object'){
                    const picked = selectIconUrlFromCip25Json(json);
                    if(!picked) throw new Error(`${src.scheme}: JSON has no usable image`);
                    let next = resolveDescriptionToSource(picked);
                    if(!next) next = { scheme: 'image_url', url: picked };
                    return await this._fetchSourceBytes(next, depth - 1);
                }

                // Not JSON — return raw bytes; _writeIcon sniffs MIME from
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

    async _httpFetch(url){
        let resp;
        try {
            resp = await axios.get(url, {
                responseType:     'arraybuffer',
                timeout:          this.cfg.fetchTimeoutMs,
                maxContentLength: this.cfg.maxBytes,
                maxRedirects:     3,
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
        try { mime = await sniffMime(tmp); }
        catch (e){
            await safeUnlink(tmp);
            throw new Error('mime sniff failed');
        }
        if(!ALLOWED_MIME.has(mime)){
            await safeUnlink(tmp);
            throw new Error(`unsupported mime '${mime}'`);
        }

        // GIF/SVG/WebP: pick the first frame so animated/multi-page sources don't break the resize
        const needsFirstFrame = (mime === 'image/gif' || mime === 'image/svg+xml' || mime === 'image/webp');
        const srcArg          = needsFirstFrame ? `${tmp}[0]` : tmp;
        const size            = this.cfg.iconSize;

        try {
            await execAsync(`${shellEscape(this.cfg.convertBin)} ${shellEscape(srcArg)} -resize ${size}x${size}! -format png ${shellEscape(iconPath)}`);
        } catch (e){
            await safeUnlink(tmp);
            throw new Error('convert failed: ' + (e.stderr || e.message || ''));
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
        await conn.query(
            `UPDATE icons SET
                 status='ok', attempts=0, last_error=NULL, next_retry_at=NULL,
                 source_url=?, source_hash=?, icon_hash=?, description_hash=?, last_checked_at=NOW()
             WHERE id=?`,
            [sourceUrl, sourceHash, iconHash, descHash, iconId]
        );
    }

    async _markFailure(conn, iconId, attempts, errMsg){
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

function shellEscape(s){
    return `'${String(s).replace(/'/g, "'\\''")}'`;
}

async function safeUnlink(p){
    try { await fsp.unlink(p); } catch (e) { /* ignore */ }
}

// MIME sniff via the `file` command — works without adding a dependency
async function sniffMime(filePath){
    const { stdout } = await execAsync(`file --mime-type -b ${shellEscape(filePath)}`);
    return stdout.trim();
}

// 1h, 1d, 7d (then permanent — capped via maxAttempts)
function backoffSeconds(attempts){
    if(attempts <= 1) return 3600;
    if(attempts === 2) return 86400;
    if(attempts === 3) return 7 * 86400;
    return 30 * 86400;
}

module.exports = IconDownloader;
