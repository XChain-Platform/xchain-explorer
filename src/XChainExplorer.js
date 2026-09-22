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
 * XChain Explorer - Explorer Class
 * 
 * This file handles starting the explorer, decoding requests, and returning data
 *
 ********************************************************************/

const express        = require('express');
const fs             = require('fs');
const dns            = require('dns');
const axios          = require('axios');
const util           = require('./lib/utility.js');
const database       = require('./db/index.js');
const IconDownloader = require('./icons/downloader.js');
const HubOperationalCache = require('./mirror/operational_cache.js');
const HubMirrorSyncManager = require('./mirror/sync_manager.js');
const ProofServer      = require('./http/proof_server.js');
const rateLimit        = require('express-rate-limit');
const { limitedHandler } = require('./http/rate_limit_log.js');   // limiter counter line, shared with api.js's app-wide limiter

// The request handler families, each a class body exporting its own prototype.
// installExplorerFamilies copies them onto XChainExplorer.prototype below the
// class; the two helpers are pulled back out by name because they hang off the
// class as statics and api.js reads isPreflightPostRequest from there.
const { installExplorerFamilies } = require('./explorer/install.js');
const { canonicalCheckpointString } = require('./explorer/proofs.js');
const { isPreflightPostRequest, MAX_PREFLIGHT_PARAMS_LENGTH } = require('./explorer/fees_preflight.js');

// Every express listener the explorer registers, and the stages one request
// runs through. Both are called with a bag of this file's own module bindings,
// because the suites replace those bindings here (proxyquire) per instance and
// a part that stored them would hand whichever explorer was built last to every
// other one.
const { PREFLIGHT_BODY_LIMIT } = require('./explorer/mount.js');
const { runRequest } = require('./explorer/request/index.js');

// One logger for the whole service: getLogger() resolves to the shipper once api.js
// installs observability, and falls through to bare console before that.
const { getLogger } = require('./observability');
const log = getLogger();

// Every environment read goes through config.js's live read-through view of
// process.env, so config.js stays the one place the gate lets env be read. The
// view is looked up per read from the module rather than this.configInfo, so test
// doubles built from a bare config stub keep working, and so that requiring this
// file never loads config.js, whose SSL probe and log line would otherwise run in
// every tool and suite that never reads a variable.
const configEnv = () => require('./config.js').env;

let slowRequests = 0;

// Lightweight rolling latency reservoir: last 256 request times (ms). The
// window is a power-of-two so the modulo reduces to a bitmask on any engine
// that optimises it. Capped at 256 to keep memory and sort cost negligible
// even at high request rates; large enough for a meaningful p95 reading.
const LATENCY_WINDOW = 256;
const latencyBuf = new Array(LATENCY_WINDOW).fill(0);
let latencyIdx   = 0;   // Next slot to write (circular)
let requestCount = 0;   // Total requests ever served (never resets)

// The rolling latency reservoir and the slow-request counter are read by the two
// statics below, so the recorder that writes them stays in this file with them: a
// part would be one module shared by every explorer the require cache hands out,
// where these counters are per required copy of this file, as they were when
// processRequest incremented them inline.
const stats = {
    // Record this request's latency in the circular buffer so p95 and a
    // total served count are available from ping(). The buffer size is
    // fixed (LATENCY_WINDOW) so memory stays constant at steady state.
    record(time){
        latencyBuf[latencyIdx % LATENCY_WINDOW] = time;
        latencyIdx++;
        requestCount++;
    },
    slow(){ slowRequests++; }
};

class XChainExplorer {

    constructor(app, configInfo){

        // npm_package_* exists only under `npm run`; the container now launches
        // node directly (Dockerfile CMD, exec form, so node is PID 1 and gets
        // SIGTERM). Without this fallback the WebSocket WELCOME frame would
        // report the hardcoded '1.0.0' default (ws/websocket_server.js) to every
        // client instead of the real version. Env stays first so the test
        // launchers that pin it keep deciding.
        this.version = configEnv().npm_package_version || require('../package.json').version;
        this.name    = configEnv().npm_package_name    || require('../package.json').name;

        this.app = app;

        this.configInfo  = configInfo;

        this.util = new util(this.configInfo);

        this.db   = new database(this);

        // SPV light-client proof server (Phase 3): builds read-only Merkle proofs
        // a client verifies locally against a quorum-signed checkpoint's state_root.
        this.proofServer = new ProofServer(this.db);

        // Does two jobs: returns the route table AND registers every express
        // listener that table implies, so the routes exist after this line.
        this.urls = this.setupUrls();

        // Extra headers to return with a response; empty unless a handler adds one.
        this.headers = {};

        // The template every request clones; the fields below are what a handler fills in.
        this.response = {
            head: null, // Placeholder for any custom headers
            html: null, // Placeholder for any HTML content
            json: null, // Placeholder for any JSON content
            time: null, // Placeholder for process request timer
            code: 200   // Placeholder for HTTP response code (Default to status OK response)
        };
    }

    async init(){
        await this.db.init()
        // Hub operational-state reads (validator capabilities, governance) over
        // JSON-RPC with a short TTL cache. Disabled (null connector) when no hub
        // endpoint is configured; db/index.js then falls back to the legacy co-located
        // hub schema read.
        this.hubOperational = new HubOperationalCache(this);
        // Self-synced hub-DB mirror: populates the local
        // checkpoint schema from the hub's snapshot+subscribe feed for every
        // coin/network whose database.checkpoint block sets self_sync. No-op
        // when no self_sync flags are configured.
        this.hubMirrorSync = new HubMirrorSyncManager(this);
        try {
            await this.hubMirrorSync.start();
        } catch (e){
            log.error('HUB_MIRROR_START_FAILED', { err: e && e.message ? e.message : e, stack: e && e.stack });
        }
        // Optional: in-process icon downloader. Opt-in via configInfo.iconDownload.enabled.
        // Requires sql/icons.sql installed in each indexer DB and ImageMagick `convert` on PATH.
        this.iconDownloader = new IconDownloader(this);
        try {
            await this.iconDownloader.start();
        } catch (e){
            log.error('ICON_DOWNLOADER_START_FAILED', { err: e && e.message ? e.message : e, stack: e && e.stack });
        }
    }

    // Build the route table and register the express listeners it implies. The
    // mounting is installed from explorer/mount.js; what this hands it is the
    // four modules the suites replace per instance in THIS file's require map,
    // plus the config-env view every rate-limit ceiling is read through.
    setupUrls(){
        return this.mountRoutes({ express, fs, rateLimit, limitedHandler, configEnv });
    }

    // Last-resort handler for a rejected processRequest promise: the catch-all route
    // is fire-and-forget, so a throw outside its narrow db.getData try/catch would
    // terminate the process under Node's --unhandled-rejections=throw default, a
    // single-request DoS. Degrade to a 500, and stay minimal so it cannot throw.
    sendUnhandled(err, req, res){
        try {
            log.error('PROCESS_REQUEST_UNHANDLED', { path: req && req.path, err: (err && err.message) ? err.message : err });
            if(res && !res.headersSent)
                res.status(500).type('json').send('{"error":"An unexpected error occurred while serving this request.","code":"INTERNAL_ERROR"}');
        } catch(_){ /* nothing more we can safely do */ }
    }

    // Serve one request end to end: match its URL, fetch any data it names, and
    // send back the page or the JSON.
    async processRequest(req, res){
        if(await this.answerActionNotYetIndexed(req, res))
            return;
        return runRequest(this, req, res, { configEnv, stats });
    }

    // An action_index above the highest one this instance has indexed is not a
    // missing action, it is one the indexer has not reached: a client polling
    // for confirmation of a just-broadcast action needs to tell that apart from
    // an index that will never exist, so it gets its own code, the indexed
    // high-water mark, and a Retry-After. An index at or below the mark falls
    // through to the normal not-found answer. Any failure reading the mark
    // falls through too, so this never turns a servable request into an error.
    async answerActionNotYetIndexed(req, res){
        try {
            let m = /^\/([^/]+)\/api\/action\/([0-9]+)\/?$/.exec(String((req && req.path) || ''));
            if(!m) return false;
            let coin = m[1].toUpperCase();
            if(!this.db || !this.db.pools || !this.db.pools[coin] || typeof this.db.getMaxActionIndex !== 'function')
                return false;
            let indexed = await this.db.getMaxActionIndex({ coin, data: {} });
            if(BigInt(m[2]) <= indexed) return false;
            res.set('Retry-After', '5');
            res.set('Content-Type', 'application/json; charset=utf-8');
            res.status(404).send(JSON.stringify({
                error: 'This action has not been indexed yet.',
                code: 'ACTION_NOT_YET_INDEXED',
                indexed_through: indexed.toString()
            }));
            return true;
        } catch(_){
            return false;
        }
    }

    static getSlowRequests() { return slowRequests; }

    // Return p95 latency (ms) and total requests served, derived from the
    // rolling latency buffer. p95 is computed over whichever is smaller: the
    // number of requests ever served or the buffer window, so it is meaningful
    // from the very first request rather than waiting for a full window.
    static getLatencyStats(){
        let n = Math.min(requestCount, LATENCY_WINDOW);
        if(n === 0) return { p95_ms: null, requests_served: 0 };
        // Sort only the slice that has real data; copy so the buffer is untouched.
        let slice = latencyBuf.slice(0, n).sort((a, b) => a - b);
        let p95   = slice[Math.floor(n * 0.95)];
        return { p95_ms: p95, requests_served: requestCount };
    }
}

// The request families arrive on the prototype here rather than in the class body:
// install copies each part's methods across with a collision check, so the class
// stays the entry every requirer already has while the handlers live beside one
// another by subject. `fs`, `axios`, `dns` and the config view travel with them
// because the suites that drive these routes replace those modules in THIS file's
// require map (proxyquire), which a part's own require would escape.
installExplorerFamilies(XChainExplorer.prototype, { fs, axios, dns, configEnv });

// Turn a FILE action's on-chain NAME (protocol/actions/file.md; attacker-controlled,
// since the publisher writes it) into a header-safe Content-Disposition value: CR/LF
// and other control characters are stripped so the name can never inject a second
// header, the ASCII leg escapes the characters that would end the quoted-string early,
// and filename* (RFC 6266/5987) carries the name unmangled for clients that read it.
function safeAttachmentFilename(name){
    let raw = String(name).replace(/[\r\n\x00-\x1f]/g, '').trim();
    if(!raw) return null;
    let ascii = raw.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
    let utf8  = encodeURIComponent(raw).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// The installed FILE-raw handler tags a token-gated response with
// X-XChain-Stored-Form=encrypted before it sends the ciphertext, but that response
// otherwise carries no filename, so it looks like the same opaque octet-stream a
// plaintext download forced to attachment would be. The gated file's own row never
// stored a name (gated_files has no such column), but every FILE action - gated or
// not - has a mandatory NAME field carried on the SAME action_index's `files` row
// (src/explorer/files.js's comment on the gated_files/files split), which the
// existing action-detail pipeline already resolves onto `data.name`
// (src/db/action_detail/misc_sql.js FILE_QUERY, run through db.getActionData).
// Route through that rather than inventing a name: watch for the encrypted marker
// being set, start resolving the real filename at that moment, and hold res.send
// until it lands so Content-Disposition is on the response before anything flushes.
const installedProcessFileRawRequest = XChainExplorer.prototype.processFileRawRequest;
XChainExplorer.prototype.processFileRawRequest = function(req, res){
    let explorer    = this;
    let setHeader   = res.set.bind(res);
    let sendBody    = res.send.bind(res);
    let namePromise = null;
    res.set = function(field, value){
        if(String(field).toLowerCase() === 'x-xchain-stored-form' && value === 'encrypted'){
            let config = { coin: String(req.params.coin || '').toUpperCase(), data: {} };
            namePromise = explorer.db.getActionData(config, Number(req.params.actionIndex))
                .then((data) => (data && data.name) ? String(data.name) : null)
                .catch(() => null);
        }
        return setHeader(field, value);
    };
    res.send = function(body){
        if(!namePromise) return sendBody(body);
        return namePromise.then((name) => {
            let disposition = name ? safeAttachmentFilename(name) : null;
            if(disposition) setHeader('Content-Disposition', disposition);
            return sendBody(body);
        });
    };
    return installedProcessFileRawRequest.call(explorer, req, res);
};

// One export shape: the class is the export and its helpers hang on it, so
// requirers read XChainExplorer.isPreflightPostRequest and the rest as before.
module.exports = Object.assign(XChainExplorer, {
    canonicalCheckpointString,
    isPreflightPostRequest,
    MAX_PREFLIGHT_PARAMS_LENGTH,
    PREFLIGHT_BODY_LIMIT
});
