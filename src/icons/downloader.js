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
 * The write sites live in src/db/icons.js and are marked SHARED-WRITE so the
 * exception stays auditable; do NOT add new explorer writes to indexer-owned
 * tables.
 *
 ********************************************************************/

const axios   = require('axios');
const fs      = require('fs');
const fsp     = require('fs/promises');
const path    = require('path');
const dns     = require('dns');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { makeSafeLookup } = require('../http/ssrf_guard');
// The SQL this class runs (the sanctioned shared-write exception below) lives
// under src/db/, where SQL belongs; see that file for the statements.
const iconsDb = require('../db/icons.js');
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
    // one-shot re-stale in discover so that predicate can never select a row this
    // module cannot resolve.
    ACTION_REF_PATTERN,
} = require('./resolver');
// The fetch path and the image store live in downloader/. Their functions take
// this instance and the stubbable modules required above as arguments, so the
// methods below stay the class's surface and a suite's stub still reaches them.
const iconFetch = require('./downloader/fetch.js');
const iconStore = require('./downloader/store.js');
const { md5 } = iconStore;
const DEFAULTS  = require('./downloader/defaults.js');

// One logger for the whole service: getLogger() resolves to the shipper once api.js
// installs observability, and falls through to bare console before that. Named
// logger here because this class already has log() and logErr() helper methods.
const { getLogger } = require('../observability');
const logger = getLogger();

// Shared SSRF lookup shim: rejects fetches whose hostname resolves to a
// private/internal/metadata address. Built once at module load.
const SAFE_LOOKUP = makeSafeLookup(dns);

const FETCH_DEPS = { axios, SAFE_LOOKUP, resolveDescriptionToSource, selectIconUrlFromCip25Json };
const STORE_DEPS = { fsp, execFileAsync };

const NETWORKS = ['mainnet','testnet','regtest'];

class IconDownloader {

    constructor(explorer){
        this.explorer = explorer;
        this.util     = explorer.util;
        this.timer    = null;
        this._running = false;       // re-entrancy guard
        this._stop    = false;
        this.cfg      = Object.assign({}, DEFAULTS);   // overwritten by start()

        this.iconRoot = path.resolve(path.join(__dirname, '../content/icons'));
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
        setImmediate(() => { this.runOnce().catch(e => this.logErr('initial run', e)); });
        this.timer = setInterval(() => {
            this.runOnce().catch(e => this.logErr('scheduled run', e));
        }, intervalMs);
        this.log(`started (interval: ${this.cfg.intervalMinutes}min, batchSize: ${this.cfg.batchSize}, iconSize: ${this.cfg.iconSize}px)`);
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
            this.log('previous run still in progress, skipping tick');
            return;
        }
        this._running = true;
        try {
            const flavors = await this.listFlavors();
            for(const flavor of flavors){
                if(this._stop) break;
                try {
                    await this.processFlavor(flavor);
                } catch (e){
                    this.logErr(`flavor ${flavor.coin}/${flavor.network}`, e);
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
    async listFlavors(){
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

    async processFlavor(flavor){
        const conn = await flavor.pool.getConnection();
        try {
            // Discovery: insert new tokens, mark stale ones
            await this.discover(conn);
            // Reconcile disk against the DB before draining, and never let a
            // reconcile failure cost this flavor its pass.
            try { await this.sweepOrphanIcons(conn, flavor); }
            catch (e){ this.logErr(`sweep ${flavor.coin}/${flavor.network}`, e); }
            // Process: drain a batch. See selectIconBatch (src/db/icons.js)
            // for the ordering and the retry-backoff invariant it depends on.
            const rows = await iconsDb.selectIconBatch(conn, this.cfg.batchSize);

            if(!rows.length){
                this.log(`[${flavor.coin}/${flavor.network}] queue empty`);
                return;
            }
            this.log(`[${flavor.coin}/${flavor.network}] processing ${rows.length} row(s)`);
            for(const row of rows){
                if(this._stop) break;
                await this.processToken(conn, flavor, row);
                await sleep(this.cfg.requestDelayMs);
            }
        } finally {
            await conn.release();
        }
    }

    // Delete the PNGs of tokens this flavor's DB says have NO icon; the two safety
    // rules are on sweepOrphanIcons in downloader/store.js.
    async sweepOrphanIcons(conn, flavor){
        return iconStore.sweepOrphanIcons(this, conn, flavor, STORE_DEPS);
    }

    /**
     * Insert any tokens missing an icons row (status=pending), and mark
     * stale any whose description has drifted from the last hash we
     * processed. NULL-safe via the `<=>` operator.
     */
    async discover(conn){
        // SHARED-WRITE EXCEPTION (#3752): every statement below writes the
        // indexer-owned `icons` table. See src/db/icons.js for the statement
        // text, the (a)/(b)/(c) rationale, and the write-boundary note.
        // (a) New tokens
        await iconsDb.insertMissingIconRows(conn);
        // (b) Changed descriptions
        await iconsDb.markDescriptionChangedIcons(conn);
        // (c) One-shot re-stale for tokens the resolver's ACTION_REF_PATTERN
        // grammar can resolve but this pass has not reached yet (#5290).
        await iconsDb.restaleActionReferencedIcons(conn, ACTION_REF_PATTERN);
    }

    /******************************************************************
     * Process a single icons row.
     *****************************************************************/

    async processToken(conn, flavor, row){
        const tick = row.tick;
        const desc = row.description;
        const iconDir  = path.join(this.iconRoot, flavor.coin, flavor.network);
        const iconPath = path.join(iconDir, tick + '.png');
        const descHash = md5(desc == null ? '' : desc);

        const src = resolveDescriptionToSource(desc);
        if(!src){
            await this.markNoIcon(conn, row.icon_id, iconPath, descHash);
            this.log(`    - ${tick}: no icon source`);
            return;
        }

        let bytes;
        try {
            bytes = await this.fetchSourceBytes(src, this.cfg.recursionLimit, flavor);
        } catch (e){
            await this.markFailure(conn, row.icon_id, row.attempts + 1, truncate(e.message, 255));
            this.log(`    ✗ ${tick} (${src.scheme}): ${e.message}`);
            return;
        }

        if(!bytes || bytes.length === 0){
            await this.markFailure(conn, row.icon_id, row.attempts + 1, 'empty body');
            this.log(`    ✗ ${tick} (${src.scheme}): empty body`);
            return;
        }

        const sourceHash = md5(bytes);

        let iconHash;
        try {
            await fsp.mkdir(iconDir, { recursive: true });
            iconHash = await this.writeIcon(bytes, iconPath);
        } catch (e){
            // Stamp descriptions are immutable: if the decoded bytes aren't a
            // usable image, retrying won't help; mark terminal as no-icon-source.
            if(src.scheme === 'stamp'){
                await this.markNoIcon(conn, row.icon_id, iconPath, descHash);
                this.log(`    - ${tick}: stamp bytes are not a usable image`);
                return;
            }
            await this.markFailure(conn, row.icon_id, row.attempts + 1, truncate(e.message, 255));
            this.log(`    ✗ ${tick} (${src.scheme}): convert failed (${e.message})`);
            return;
        }
        if(!iconHash){
            if(src.scheme === 'stamp'){
                await this.markNoIcon(conn, row.icon_id, iconPath, descHash);
                this.log(`    - ${tick}: stamp bytes are not a usable image`);
                return;
            }
            await this.markFailure(conn, row.icon_id, row.attempts + 1, 'image conversion failed');
            return;
        }

        await this.markOk(conn, row.icon_id, src.url || null, sourceHash, iconHash, descHash);
        this.log(`    ✓ ${tick} <- ${src.scheme}`);
    }

    // Fetch path: see downloader/fetch.js for each step's contract.

    async fetchSourceBytes(src, depth, flavor){
        return iconFetch.fetchSourceBytes(this, src, depth, flavor, FETCH_DEPS);
    }

    async fetchActionFileBytes(src, flavor){
        return iconFetch.fetchActionFileBytes(this, src, flavor);
    }

    rejectPrivateLiteral(rawUrl){
        iconFetch.rejectPrivateLiteral(rawUrl);
    }

    async httpFetch(url){
        return iconFetch.httpFetch(this, url, FETCH_DEPS);
    }

    // Convert source bytes into the NxN PNG at iconPath and answer its md5; see
    // writeIcon in downloader/store.js.
    async writeIcon(bytes, iconPath){
        return iconStore.writeIcon(this, bytes, iconPath, STORE_DEPS);
    }

    /******************************************************************
     * State updates: see downloader/store.js for each statement's note.
     *****************************************************************/

    async markOk(conn, iconId, sourceUrl, sourceHash, iconHash, descHash){
        await iconStore.markOk(conn, iconId, sourceUrl, sourceHash, iconHash, descHash);
    }

    // Terminal "this token has no usable icon": clear the DB metadata AND remove
    // the PNG on disk; see markNoIcon in downloader/store.js for why both halves.
    async markNoIcon(conn, iconId, iconPath, descHash){
        await iconStore.markNoIcon(this, conn, iconId, iconPath, descHash, STORE_DEPS);
    }

    // Record a failed attempt: retire the row at maxAttempts, otherwise schedule
    // the retry; see markFailure in downloader/store.js.
    async markFailure(conn, iconId, attempts, errMsg){
        await iconStore.markFailure(this, conn, iconId, attempts, errMsg);
    }

    /******************************************************************
     * Logging helpers
     *****************************************************************/

    log(msg){
        logger.info('ICON_DOWNLOADER', { msg });
    }

    logErr(where, err){
        logger.error('ICON_DOWNLOADER_FAILED', { where, err: err && err.message ? err.message : err, stack: err && err.stack });
    }
}

/******************************************************************
 * Helpers
 *****************************************************************/

function sleep(ms){
    return new Promise(r => setTimeout(r, ms));
}

function truncate(s, n){
    if(typeof s !== 'string') s = String(s);
    return s.length > n ? s.slice(0, n) : s;
}

module.exports = IconDownloader;
