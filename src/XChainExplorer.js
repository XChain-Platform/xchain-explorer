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
const path           = require('path');
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
const { renderPlatformSwitcher } = require('./render/platform_links.js');
const listPage         = require('./render/list_page.js');
const componentTpl     = require('./render/component_templates.js');

// The request handler families, each a class body exporting its own prototype.
// installExplorerFamilies copies them onto XChainExplorer.prototype below the
// class; the two helpers are pulled back out by name because they hang off the
// class as statics and api.js reads isPreflightPostRequest from there.
const { installExplorerFamilies } = require('./explorer/install.js');
const { canonicalCheckpointString } = require('./explorer/proofs.js');
const { isPreflightPostRequest, MAX_PREFLIGHT_PARAMS_LENGTH } = require('./explorer/fees_preflight.js');

// The three route tables, joined in declaration order. They are data, so they sit
// beside the handler families rather than inside the method that mounts them.
const { routeTables } = require('./explorer/routes/index.js');

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

// Body-parser ceiling for POST /{COIN}/api/preflight. Above
// MAX_PREFLIGHT_PARAMS_LENGTH (explorer/fees_preflight.js, where the route that
// enforces it lives) because JSON string escaping can inflate a payload before the
// length check there can see it; the real refusal is the character check on the
// decoded value, not this.
const PREFLIGHT_BODY_LIMIT = '1mb';

let slowRequests = 0;

// Lightweight rolling latency reservoir: last 256 request times (ms). The
// window is a power-of-two so the modulo reduces to a bitmask on any engine
// that optimises it. Capped at 256 to keep memory and sort cost negligible
// even at high request rates; large enough for a meaningful p95 reading.
const LATENCY_WINDOW = 256;
const latencyBuf = new Array(LATENCY_WINDOW).fill(0);
let latencyIdx   = 0;   // Next slot to write (circular)
let requestCount = 0;   // Total requests ever served (never resets)

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

    // Build the route table and register the express listeners it implies.
    setupUrls(){

        // Every URL the explorer answers. The tables are data and live in
        // src/explorer/routes/; what stays here is the mounting, because the ORDER
        // these listeners register in is what decides which one answers a request,
        // and that order is only visible when the calls sit in one list.
        let urls = routeTables();

        this.mountAssetRoutes(urls);
        this.mountTransactionRedirect();
        this.mountFileRawRoute();
        const feeQuoteLimiter = this.mountFeeQuoteRoutes();
        this.mountPreflightPostRoute();
        this.mountBatchRoutes(feeQuoteLimiter);
        const checkpointListLimiter = this.mountCheckpointRoutes();
        this.mountProofRoutes(checkpointListLimiter);
        this.mountContractCallRoute();
        this.mountCatchAllRoute();

        return urls;
    }

    // The listeners that hand back a file rather than query the database: icons and
    // relayed token content, the OpenAPI document, the Font Awesome package, and one
    // mount per directory in the static table.
    mountAssetRoutes(urls){
        // Listener for icon requests: token icons resolved and cached locally.
        this.app.use('/icon', (req, res) => { this.processIconRequest(req, res); });
        // Listener for relay requests: fetches remote token content on a page's behalf.
        this.app.use('/relay', (req, res) => { this.processRelayRequest(req, res); });

        // Machine-readable API spec (OpenAPI 3.1). Regenerated by docs/openapi.build.js;
        // test/unit/openapi-coverage.test.js keeps it in lockstep with the urls tables.
        this.app.get('/openapi.json', (req, res) => {
            if(!this.openapiSpec)
                this.openapiSpec = fs.readFileSync(path.join(__dirname, '../docs/openapi.json'));
            res.set('Cache-Control', 'public, max-age=3600');
            res.type('application/json').send(this.openapiSpec);
        });

        // Font Awesome Free is self-hosted from the npm package so icons work on
        // every deployment with no CDN, kit token, or per-deploy config. The CSS
        // references ../webfonts/, so both directories mount under /fontawesome.
        // test/unit/fontawesome-icons.test.js keeps template icon names inside
        // the Free set (plus the v4 shims and the local xchain.css glyphs).
        const faDir = path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json'));
        this.app.use('/fontawesome/css',      express.static(path.join(faDir, 'css')));
        this.app.use('/fontawesome/webfonts', express.static(path.join(faDir, 'webfonts')));

        // Listeners for static file requests, one mount per directory in the static table.
        for(let directory of urls['static'])
            this.app.use('/' + directory, express.static(path.join(__dirname, 'content', directory)))
    }

    // The one redirect the explorer serves.
    mountTransactionRedirect(){
        // /{COIN}/tx/{QUERY} is the near-universal convention for a transaction URL and
        // several clients build it that way (the wallet's post-send "view transaction"
        // link among them), but this explorer's only transaction route is
        // /{COIN}/transaction/{QUERY}, so those links 404'd.
        //
        // A 301 rather than serving transaction.html at both paths: one transaction must
        // have ONE canonical URL. Two live paths for the same resource would split it,
        // which matters now that pages emit a real <link rel="canonical">.
        // The querystring is carried across deliberately: setXChainParams() reads ?coin=
        // to resolve which chain the page is for, so dropping it here would silently
        // redirect to a different coin's transaction. Both segments are re-encoded, which
        // also keeps a traversal attempt (..%2F..) inside its path segment.
        this.app.get('/:coin/tx/:query', (req, res) => {
            let target = '/' + encodeURIComponent(req.params.coin) + '/transaction/' + encodeURIComponent(req.params.query);
            let qs     = req.originalUrl.indexOf('?');
            if(qs !== -1)
                target += req.originalUrl.substring(qs);
            res.redirect(301, target);
        });
    }

    mountFileRawRoute(){
        // Raw bytes for a FILE action, registered before the wildcard so the matcher
        // hits it first. Gated files return ciphertext as application/octet-stream for
        // client-side decryption (protocol/token-gated-content.md); non-gated files
        // serve stored bytes inline only for safe media MIME types (nft-standard.md).
        this.app.get('/:coin/api/file/:actionIndex/raw', (req, res) => { this.processFileRawRequest(req, res); });
    }

    // Returns the fee-quote limiter: /feeschedule shares this bucket but registers
    // later, after the batch routes, and moving it forward would change which
    // listener answers first.
    mountFeeQuoteRoutes(){
        // Native-coin fee pre-flight + schedule: thin proxies to the colocated indexer's
        // read-only feequote/feeschedule JSON-RPC, so fee and oracle-price logic stays
        // single-sourced there. Registered before the wildcard so the matcher hits these
        // first. See xchain-documentation/concepts/gas.md (client pre-validation).

        // All three carry a dedicated limiter, not the platform default: each is a
        // JSON-RPC round trip, so an uncapped caller amplifies into a second process.
        // One tier looser than the proof routes, a quote being a lookup rather than a
        // cryptographic recompute.
        //
        // Every limiter below resolves its ceiling, knob name and refusal body into
        // one policy const that is spread into both the limiter and its counter
        // line, so the number an operator reads in the log is the number that
        // actually refused. See src/http/rate_limit_log.js for why the line is throttled.
        const feeQuotePolicy = {
            limit:    parseInt(configEnv().EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM, 10) || 120,
            envVar:   'EXPLORER_FEE_QUOTE_RATE_LIMIT_RPM',
            windowMs: 60 * 1000,
            message:  { error: 'Too many fee requests', code: 'RATE_LIMITED' }
        };
        const feeQuoteLimiter = rateLimit({
            windowMs:        feeQuotePolicy.windowMs,
            limit:           feeQuotePolicy.limit,
            standardHeaders: true,
            legacyHeaders:   false,
            handler:         limitedHandler({ service: 'Explorer', name: 'fee-quote', ...feeQuotePolicy })
        });
        this.app.get('/:coin/api/feequote',    feeQuoteLimiter, (req, res) => { this.processFeeQuoteRequest(req, res); });
        this.app.get('/:coin/api/oraclefeequote', feeQuoteLimiter, (req, res) => { this.processOracleFeeQuoteRequest(req, res); });
        this.app.get('/:coin/api/preflight',   (req, res) => { this.processPreflightRequest(req, res); });

        return feeQuoteLimiter;
    }

    mountPreflightPostRoute(){
        // POST sibling of the same pre-flight, not a second endpoint: identical inputs
        // and verdict, different transport. A GET cannot carry the largest legal input
        // at all, a 250-command BATCH running ~17,500 characters against Node's 16 KiB
        // request line; small actions keep the GET, which stays cacheable.

        // The body parser is mounted per-route because api.js applies a deliberately
        // tight 10kb global json() to everything else, and the limiter is per-route
        // because this is the only unauthenticated explorer surface taking a body
        // this large.
        const preflightPostPolicy = {
            limit:    parseInt(configEnv().EXPLORER_PREFLIGHT_POST_RATE_LIMIT_RPM, 10) || 60,
            envVar:   'EXPLORER_PREFLIGHT_POST_RATE_LIMIT_RPM',
            windowMs: 60 * 1000,
            message:  { error: 'Too many pre-flight requests', code: 'RATE_LIMITED' }
        };
        const preflightPostLimiter = rateLimit({
            windowMs:        preflightPostPolicy.windowMs,
            limit:           preflightPostPolicy.limit,
            standardHeaders: true,
            legacyHeaders:   false,
            handler:         limitedHandler({ service: 'Explorer', name: 'preflight-post', ...preflightPostPolicy })
        });
        // Limiter BEFORE the parser on purpose: a rate-limited caller is refused without
        // the server reading their megabyte first.
        this.app.post('/:coin/api/preflight',
            preflightPostLimiter,
            express.json({ limit: PREFLIGHT_BODY_LIMIT }),
            (req, res) => { this.processPreflightRequest(req, res); });
    }

    mountBatchRoutes(feeQuoteLimiter){
        // Batch reads: one POST answering up to BATCH_ADDRESS_MAX addresses, the shape
        // a multi-address wallet's cold open would otherwise ask for one request at a
        // time (five addresses x three chains was 30 balance reads plus 15 coinpay
        // reads in one minute, all counted separately by every ceiling in front of us).
        //
        // The explorer STILL fans out to the coin's tracker for each /address/ half
        // inside the request, so the fan-out is relocated behind the global 200-request
        // concurrency gate rather than removed: what changes is that the gate and the
        // rate limiter now see one caller-visible request instead of twenty, and the
        // work inside it is capped at BATCH_READ_CONCURRENCY in flight. Both halves are
        // produced by the same dispatcher that answers the per-address GETs (readApi
        // re-drives processRequest), so a batch entry and its GET can never drift.
        //
        // One limiter for both routes on purpose: the wallet's balance beat and its
        // coinpay badge are two callers of one wallet, and a single shared bucket is
        // the honest ceiling on what that wallet costs the origin per minute.
        const batchPolicy = {
            limit:    parseInt(configEnv().EXPLORER_BATCH_RATE_LIMIT_RPM, 10) || 72,
            envVar:   'EXPLORER_BATCH_RATE_LIMIT_RPM',
            windowMs: 60 * 1000,
            message:  { error: 'Too many batch requests', code: 'RATE_LIMITED' }
        };
        const batchLimiter = rateLimit({
            windowMs:        batchPolicy.windowMs,
            limit:           batchPolicy.limit,
            standardHeaders: true,
            legacyHeaders:   false,
            handler:         limitedHandler({ service: 'Explorer', name: 'batch', ...batchPolicy })
        });
        this.app.post('/:coin/api/balances', batchLimiter,
            (req, res) => { this.processBalancesBatchRequest(req, res).catch(err => this.sendUnhandled(err, req, res)); });
        this.app.post('/:coin/api/coinpay_obligations', batchLimiter,
            (req, res) => { this.processCoinpayObligationsBatchRequest(req, res).catch(err => this.sendUnhandled(err, req, res)); });

        this.app.get('/:coin/api/feeschedule', feeQuoteLimiter, (req, res) => { this.processFeeScheduleRequest(req, res); });
    }

    // Returns the checkpoint-list limiter: /checkpoints/range takes the same tier and
    // registers with the proof routes below.
    mountCheckpointRoutes(){
        // Quorum-signed state checkpoints, the light-client verification surface.
        // /checkpoints lists the coin chain's latest; /checkpoint/:blockIndex/verify
        // re-verifies the 2f+1 oracle_publish signatures server-side AND returns what a
        // client needs to verify independently (canonical string, sigs, qualifying set).
        // Spec: xchain-documentation/protocol/actions/anchor.md

        // The list is a hub-mirror scan; verify re-runs Ed25519 once per signature over
        // the qualifying validator set and reads that set's capability snapshot, so it
        // is proof-tier work and takes the tighter of the two caps.
        const checkpointListPolicy = {
            limit:    parseInt(configEnv().EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM, 10) || 120,
            envVar:   'EXPLORER_CHECKPOINT_LIST_RATE_LIMIT_RPM',
            windowMs: 60 * 1000,
            message:  { error: 'Too many checkpoint requests', code: 'RATE_LIMITED' }
        };
        const checkpointListLimiter = rateLimit({
            windowMs:        checkpointListPolicy.windowMs,
            limit:           checkpointListPolicy.limit,
            standardHeaders: true,
            legacyHeaders:   false,
            handler:         limitedHandler({ service: 'Explorer', name: 'checkpoint-list', ...checkpointListPolicy })
        });
        // Verify is 90 rather than the list's 120 because it is the heavier of the
        // pair, and 90 rather than its own former 60 because the wallet's light
        // client issues one /verify per proof job: a five-address wallet's fifteen
        // jobs per session, x2 for the SDK's single retry and x3 for a NAT with
        // three testers, is 90 in the worst minute. The measured wallet profile is
        // the source of that number, not a round guess.
        const checkpointVerifyPolicy = {
            limit:    parseInt(configEnv().EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM, 10) || 90,
            envVar:   'EXPLORER_CHECKPOINT_VERIFY_RATE_LIMIT_RPM',
            windowMs: 60 * 1000,
            message:  { error: 'Too many checkpoint verification requests', code: 'RATE_LIMITED' }
        };
        const checkpointVerifyLimiter = rateLimit({
            windowMs:        checkpointVerifyPolicy.windowMs,
            limit:           checkpointVerifyPolicy.limit,
            standardHeaders: true,
            legacyHeaders:   false,
            handler:         limitedHandler({ service: 'Explorer', name: 'checkpoint-verify', ...checkpointVerifyPolicy })
        });
        this.app.get('/:coin/api/checkpoints', checkpointListLimiter, (req, res) => { this.processCheckpointsRequest(req, res); });
        this.app.get('/:coin/api/checkpoint/:blockIndex/verify', checkpointVerifyLimiter, (req, res) => { this.processCheckpointVerifyRequest(req, res); });
        // Self-synced hub-mirror observability: bootstrap +
        // watermark-lag state per coin, {enabled:false} in externally-maintained mode.
        this.app.get('/:coin/api/hub-mirror/status', (req, res) => { this.processHubMirrorStatusRequest(req, res); });

        return checkpointListLimiter;
    }

    // Built apart from the registrations only so neither half runs past the length
    // limit; the two limiters are constructed at the point they always were, which is
    // what a suite counting limiter construction order sees.
    buildProofLimiters(){
        // SPV light-client proof endpoints (Phase 3, spec §8.1). Read-only: a client
        // recomputes the proof locally and binds it to a quorum-signed checkpoint's
        // committed state_root, never trusting this server's word. Balance, action,
        // validator-set and contract-state proofs plus the checkpoint range are live;
        // contract-state serves a real proof only where the slot is armed at that
        // height, and a typed 409 below it (see the handler).

        // Merkle-proof recompute is CPU-bound per request (it hashes every leaf in the
        // target block), so cap it per-IP well below the platform-wide 1080rpm
        // default, mirroring the VM-call limiter's design.
        //
        // 90, not the former 60: the wallet's balance proof rides this limiter, and a
        // five-address wallet verifies fifteen proofs per session, x2 for the SDK's
        // single retry and x3 for a NAT with three testers. 60 sat below the measured
        // requirement, which only stayed invisible while the bucket keyed on the
        // Cloudflare edge address instead of the client.
        const actionProofPolicy = {
            limit:    parseInt(configEnv().EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM, 10) || 90,
            envVar:   'EXPLORER_ACTION_PROOF_RATE_LIMIT_RPM',
            windowMs: 60 * 1000,
            message:  { error: 'Too many proof requests', code: 'RATE_LIMITED' }
        };
        const actionProofLimiter = rateLimit({
            windowMs:        actionProofPolicy.windowMs,
            limit:           actionProofPolicy.limit,
            standardHeaders: true,
            legacyHeaders:   false,
            handler:         limitedHandler({ service: 'Explorer', name: 'action-proof', ...actionProofPolicy })
        });
        // The validator-set proof is the heaviest endpoint: its handler calls prove
        // once per validator per capability (up to VALIDATOR_QUERY_LIMIT), each a
        // 256-deep SMT descent reading the DB per non-empty level, plus an indexer RPC
        // per capability. Worst case ~2000 descents, so it caps below the action tier.
        const validatorSetProofPolicy = {
            limit:    parseInt(configEnv().EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM, 10) || 30,
            envVar:   'EXPLORER_VALIDATOR_SET_PROOF_RATE_LIMIT_RPM',
            windowMs: 60 * 1000,
            message:  { error: 'Too many proof requests', code: 'RATE_LIMITED' }
        };
        const validatorSetProofLimiter = rateLimit({
            windowMs:        validatorSetProofPolicy.windowMs,
            limit:           validatorSetProofPolicy.limit,
            standardHeaders: true,
            legacyHeaders:   false,
            handler:         limitedHandler({ service: 'Explorer', name: 'validator-set-proof', ...validatorSetProofPolicy })
        });

        return { actionProofLimiter, validatorSetProofLimiter };
    }

    mountProofRoutes(checkpointListLimiter){
        const { actionProofLimiter, validatorSetProofLimiter } = this.buildProofLimiters();
        // The balance proof is the same single-descent SMT shape as the contract-state
        // and locked-balance proofs, so it carries the same cap. The checkpoint range
        // is a bounded mirror read and takes its /checkpoints sibling's looser tier.
        this.app.get('/:coin/api/proof/balance/:address/:tick', actionProofLimiter, (req, res) => { this.processBalanceProofRequest(req, res); });
        this.app.get('/:coin/api/checkpoints/range', checkpointListLimiter, (req, res) => { this.processCheckpointsRangeRequest(req, res); });
        this.app.get('/:coin/api/proof/action/:actionIndex', actionProofLimiter, (req, res) => { this.processActionProofRequest(req, res); });
        this.app.get('/:coin/api/proof/validator-set', validatorSetProofLimiter, (req, res) => { this.processValidatorSetProofRequest(req, res); });
        // Contract-state proofs carry the action-proof limiter rather than running
        // uncapped: the handler is one 256-deep SMT descent (a sequential DB read per
        // non-empty level) plus two point reads, an unauthenticated CPU/IO amplifier
        // of the same class the action-proof cap exists for.
        this.app.get('/:coin/api/proof/contract-state/:contractIndex/:key', actionProofLimiter, (req, res) => { this.processContractStateProofRequest(req, res); });
        // Locked-balance (XCHAIN_ESC) proofs are the same single-descent shape as
        // the contract-state proof and get the same cap for the same reason.
        this.app.get('/:coin/api/proof/locked-balance/:address/:tick', actionProofLimiter, (req, res) => { this.processLockedBalanceProofRequest(req, res); });
    }

    mountContractCallRoute(){
        // Read-only contract simulation (the platform's eth_call): runs a method in a
        // sandboxed xchain-vm against current state and discards all effects.
        // Default-off (EXPLORER_VM_QUERY_ENABLED) and capped far below the global
        // limit, since every call burns real CPU in the VM subprocess.
        const vmQueryPolicy = {
            limit:    parseInt(configEnv().EXPLORER_VM_QUERY_RATE_LIMIT_RPM, 10) || 20,
            envVar:   'EXPLORER_VM_QUERY_RATE_LIMIT_RPM',
            windowMs: 60 * 1000,
            message:  { error: 'Too many simulation requests', code: 'RATE_LIMITED' }
        };
        const vmQueryLimiter = rateLimit({
            windowMs:        vmQueryPolicy.windowMs,
            limit:           vmQueryPolicy.limit,
            standardHeaders: true,
            legacyHeaders:   false,
            handler:         limitedHandler({ service: 'Explorer', name: 'vm-query', ...vmQueryPolicy })
        });
        this.app.post('/:coin/api/contract/:contractIndex/call', vmQueryLimiter, (req, res) => { this.processContractCallRequest(req, res); });
    }

    mountCatchAllRoute(){
        // Catch-all: every request the listeners above did not take lands here,
        // including a static request that found no file.

        // Express 5 / path-to-regexp v8 rejects a bare '*' at startup, and
        // the wildcard MUST be braced ('/{*path}') to match the bare root '/': the
        // unbraced form requires a trailing segment, dropping '/' through to the
        // JSON-RPC router as a -32600.
        this.app.get('/{*path}', (req, res) => { this.processRequest(req, res).catch(err => this.sendUnhandled(err, req, res)); });
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
        let config = await this.configInfo.getConfig()

        let response = structuredClone(this.response);

        // Times the whole request; reported back as response.time.
        let debugTimer = this.util.startTimer();

        let total = null;
        let data  = null;
        // Set when a data read genuinely FAILED (db/index.js now throws a DbQueryError
        // on outage/rejected query instead of swallowing it into an empty set,
        // M-4). Suppresses the empty-result assembly and the NOT_FOUND fallback
        // so the response stays a 5xx rather than a misleading empty 200 / 404.
        let dbError = false;
        // Set when a path parameter is malformed. Like dbError it suppresses the
        // NOT_FOUND fallback below, so a 400 does not get rewritten to a 404 by the
        // empty-result branch.
        let badParam = false;

        // Everything worked out about this request, filled in by the URL match below.
        let cfg = {
            coin: null, // COIN type (BTC, LTC, DOGE)
            type: null, // Request type (html, api, explorer)
            file: null, // File content to return
            data: {
                method: null, // Method to run to get data
                search: null, // Search to pass to method
                type:   null, // Search type to pass to method
                path:   req.path,  // Request URL path
                query:  req.query, // Request Query string parameters
                // SQL query specific information
                sql: {
                    order:  null, // Sort order (ASC, DESC)
                    limit:  null, // Record Limit (LIMIT X)
                    where: {
                        data:       '', // Where data SQL
                        offset:     '', // Where offset SQL
                        offsetArgs: []  // Parameterized offset args
                    }
                },
                // Offset used by explorer for paging (action: first/last/next/prev)
                offset: {
                    action: null, // Action (first, last, next, prev)
                    start:  null, // start value (action_index, etc)
                    stop:   null, // stop value (action_index, etc)
                }
            },
        };

        // Drop the leading and trailing slashes, then split the path into its parts.
        let urlPath = String(req.path).substring(1).replace(/\/$/,'').split('/');

        // Turn the literal string 'null' into a real null, so isNull judges it properly.
        urlPath.forEach(function(value, idx){
            if(String(value).toLowerCase()=='null')
                urlPath[idx] = null;
        });

        // The first part of the path names the COIN (BTC, LTC, DOGE, and their
        // testnet and regtest forms).
        let coin = String(urlPath[0]).toUpperCase();
        if(!this.util.isNull(config['COIN_SUPPORTED'][coin]))
            cfg.coin = coin;

        // The second part says what KIND of request this is; anything else is a page.
        let type = String(urlPath[1]).toLowerCase();
        cfg.type = (['api','explorer'].includes(type) && urlPath.length>2) ? type : 'html';

        // A copy of the path this method may rewrite, as the coin-unavailable
        // redirect below does.
        let requestPath = req.path;

        // validDataRequest is false when the coin is supported but not yet configured in this instance
        let validDataRequest = (!this.util.isNull(config['COIN_SUPPORTED'][coin]) && !this.util.isNull(config['COIN_AVAILABLE'][coin])) ? true : false;

        // Freshness of this coin's indexed tip, read once per request from the
        // 15s cache in db/index.js. A stale tip does NOT refuse the read: the rows are a
        // true record of the chain up to the tip this instance holds, and refusing
        // them turned every indexer stall into a whole-coin blackout that read as
        // the network being down (see staleFailClosed in db/index.js). The snapshot is
        // stamped onto the response instead, and only the EXPLORER_STALE_FAIL_CLOSED
        // opt-in keeps the old 503.
        let freshness = null;
        let tipStale  = false;
        if(validDataRequest && this.db.pools && this.db.pools[coin] && typeof this.db.getCoinFreshness === 'function'){
            freshness = await this.db.getCoinFreshness(coin);
            tipStale  = !!(freshness && freshness.stale);
        } else if(validDataRequest && this.db.pools && this.db.pools[coin] && typeof this.db.isCoinTipStale === 'function'){
            // Unit doubles that stub only the boolean verdict.
            tipStale  = await this.db.isCoinTipStale(coin);
            freshness = { stale: tipStale, tip_block: null, tip_age_seconds: null, replica_halted: null };
        }
        if(tipStale && this.db.staleFailClosed && this.db.staleFailClosed())
            validDataRequest = false;

        // Force /{COIN}/api/status valid so we always return explorer config for that coin
        if(String(urlPath[1]).toLowerCase()=='api' && String(urlPath[2]).toLowerCase()=='status')
            validDataRequest = true;

        // If the COIN is supported but not available, return the 'COIN Unavailable' page
        if(!this.util.isNull(config['COIN_SUPPORTED'][coin]) && this.util.isNull(config['COIN_AVAILABLE'][coin]))
            requestPath = '/coin-unavailable';

        // Set type / file / info config info using url matching
        for(const url in this.urls[cfg.type]){
            let parts      = String(url).substring(1).split('/');
            let match      = false;
            let info       = this.urls[cfg.type][url];
            let searchType = false;

            // Page requests match on the path itself, in three ways.
            if(cfg.type=='html'){
                // The whole path is the route, spelled exactly.
                if(String(requestPath).toLowerCase()==String(url).toLowerCase())
                    match = true;
                // A bare coin home page, /{COIN} and nothing more.
                if(parts.length==1 && urlPath.length==1 && parts[0]=='{COIN}' && !this.util.isNull(cfg.coin))
                    match = true;
                // A coin page named by its second segment, /{COIN}/actions.
                if(parts.length > 1 && parts[1]==String(urlPath[1]).toLowerCase())
                    match = true;
            }

            // Market routes carry the pair in the path, so they match on their own terms.
            if(!match && !this.util.isNull(parts[2]) && parts[2].includes('market') && String(urlPath[2]).toLowerCase().includes('market')){
                if(!this.util.isNull(urlPath[3]))
                    searchType = 'token';
                if(String(urlPath[2]).toLowerCase()=='markets'){
                    match = true;
                } else if(String(urlPath[2]).toLowerCase()=='market'){
                    if(!this.util.isNull(parts[3]) && !this.util.isNull(parts[4]) && !this.util.isNull(urlPath[3]) && !this.util.isNull(urlPath[4])){
                        if(this.util.isNull(parts[5])){
                            if(this.util.isNull(urlPath[5]))
                                match = true;
                        } else {
                            if(parts[5]==String(urlPath[5]).toLowerCase())
                                match = true;

                        }
                    }
                }
                // Carry the extra market search terms forward.
                if(match){
                    cfg.data.search2 = urlPath[4];
                    cfg.data.search3 = urlPath[6];
                }
            // Require the route's segment COUNT to match the request path, so a shorter
            // route cannot swallow a deeper one: /contract/{QUERY} must not match
            // /contract/{QUERY}/state.

            // The 5th-segment literal must match too when the route declares one
            // (.../state vs .../balance): without it, two same-length routes sharing
            // parts[1]/parts[2] are indistinguishable and the first-defined one wins,
            // shadowing the other.
            } else if(!match && parts.length==urlPath.length && parts[1]==String(urlPath[1]).toLowerCase() &&
                parts[2]==String(urlPath[2]).toLowerCase() &&
                (this.util.isNull(parts[4]) || String(parts[4]).startsWith('{') || String(parts[4]).toLowerCase()==String(urlPath[4]).toLowerCase())){
                // An explorer route with no search term of its own.
                if(cfg.type=='explorer' && urlPath.length==3)
                    match = true;
                // Otherwise the 5th segment names the search type, and must be one
                // the route declares.
                if(!match){
                    let infoType = typeof info[1];
                    let search = String(urlPath[4]).toLowerCase();
                    if(infoType=='string')
                        searchType = info[1];
                    if(infoType=='object' && info[1].includes(search))
                        searchType = search;
                    if(searchType || infoType=='undefined')
                        match = true;
                }
            }

            // List-all explorer requests (the home-page tabs) carry no QUERY/TYPE, so the
            // request path is exactly 3 segments (/{COIN}/explorer/{ACTION}) while the route
            // declares optional {QUERY}/{TYPE} placeholders and is longer. The length-equality
            // gate above rejects that pairing, so match it here: action segment lines up and
            // every remaining route segment is a placeholder. Limited to 3-segment paths, so it
            // can't swallow a deeper route (the shadowing case the length check guards against).
            if(!match && cfg.type=='explorer' && urlPath.length==3 &&
                parts[1]==String(urlPath[1]).toLowerCase() &&
                parts[2]==String(urlPath[2]).toLowerCase() &&
                parts.slice(3).every(p => String(p).startsWith('{'))){
                match = true;
            }

            // A matched route fills the request config with what it names.
            if(match){
                if(cfg.type=='html')
                    cfg.file = info;
                if(['api','explorer'].includes(cfg.type)){
                    cfg.data.method = info[0];
                    cfg.data.search = urlPath[3];
                    cfg.data.type   = searchType;
                    // Explorer requests carry the paging position in the query string.
                    if(cfg.type=='explorer'){
                        let q      = (req.query) ? req.query : false;
                        let offset = (q && !this.util.isNull(q.offset)) ? q.offset : false;
                        let action = (q && !this.util.isNull(q.action)) ? q.action : false;
                        cfg.data.offset.start  = offset;
                        cfg.data.offset.action = action;
                    }
                }
                break;
            }
        }

        // With a method named and the coin available, read the data from the database.
        if(!this.util.isNull(cfg.data.method) && validDataRequest){
            // Short token/subtoken search terms force a leading-% LIKE filesort over the
            // whole tokens table (no B-tree path) on every unauthenticated request. Return
            // an empty result before touching the DB, mirroring getSearch's SEARCH_MIN_LENGTH
            // guard.
            const TOKEN_SEARCH_MIN_LENGTH = 3;
            // Cross-chain match rows come from the checkpoint mirror; when a
            // SELF-SYNCED mirror has never bootstrapped, refuse to serve (an
            // empty mirror must read as an outage, not an empty ledger), and
            // otherwise annotate lag. Same gate as the checkpoint routes.
            let mirrorGate = (cfg.data.method === 'getCrossChainMatches') ? this.mirrorGate(cfg.coin) : null;
            // /{COIN}/api/action/{QUERY} binds its path segment against the BIGINT
            // action_index column, and MariaDB coerces the string, so `/api/action/7junk`
            // answered 200 with action 7 and `/api/action/junk` with action 0. Reject the
            // malformed id before the DB call, using the same strict shape and error code
            // as processFileRawRequest below. parseInt/sanitizeInt cannot do this job:
            // parseInt('7junk') is 7, which reproduces the bug in JS.
            if(cfg.data.method === 'getAction' && cfg.data.type === 'action_index' &&
               !/^[0-9]+$/.test(String(cfg.data.search || ''))){
                badParam      = true;
                response.code = 400;
                response.json = { error: 'Invalid action_index', code: 'INVALID_ACTION_INDEX' };
            // /{COIN}/api/checkpoint/{QUERY} binds its path segment via db/index.js's
            // getCheckpoint as Number(config.data.search): a non-numeric segment
            // (e.g. 'zzz-no-such') becomes NaN, which the mariadb driver cannot bind
            // and throws, so the request reached the generic DB_ERROR 500 instead of
            // a clean 404/400 (D-E060). Reject it here, before the DB call, using the
            // same strict shape and the INVALID_BLOCK_INDEX code processCheckpointVerifyRequest
            // already established for a malformed block-index segment.
            } else if(cfg.data.method === 'getCheckpoint' && cfg.data.type === 'block' &&
               !/^[0-9]+$/.test(String(cfg.data.search || ''))){
                badParam      = true;
                response.code = 400;
                response.json = { error: 'Invalid block_index', code: 'INVALID_BLOCK_INDEX' };
            } else if(mirrorGate && mirrorGate.blocked){
                data  = [];
                total = 0;
            } else if(cfg.data.method === 'getTokens' &&
               ['token','subtoken'].includes(cfg.data.type) &&
               String(cfg.data.search || '').trim().length < TOKEN_SEARCH_MIN_LENGTH){
                data  = [];
                total = 0;
            } else {
                try {
                    [data, total] = await this.db.getData(cfg);
                } catch(e){
                    if(e && e.name === 'DbInputError'){
                        // The CALLER's parameter was malformed, not the service: a
                        // reader declined to bind it (db/index.js DbInputError)
                        // rather than let MariaDB coerce it and answer with the
                        // wrong record. Matched on `name` rather than instanceof so
                        // a stubbed db module in tests behaves the same way.
                        badParam      = true;
                        response.code = 400;
                        response.json = { error: e.message, code: e.code || 'INVALID_PARAMETER' };
                    } else {
                        // A read that genuinely failed (DB outage / rejected query)
                        // throws (db/index.js DbQueryError, M-4); answer 5xx instead of a
                        // misleading empty 200. A successful empty SELECT does not
                        // throw and still returns 200 with total:0.
                        log.error('PROCESS_REQUEST_QUERY_FAILED', { path: req.path, err: e && e.message ? e.message : e });
                        dbError       = true;
                        response.code = 500;
                        response.json = { error: 'A database error occurred while serving this request.', code: 'DB_ERROR' };
                    }
                }
            }

            if(!dbError && !badParam){
            let json = {};

            // A numeric total means this is a list of results, so return only the
            // page of them the request asked for.
            if(this.util.isNumeric(total)){
                if(cfg.type=='api'){
                    // How many records were found in all, not just on this page.
                    json.total = total;

                    // Hoist shared fields out of the data array to avoid repeating identical values per row.
                    // Guard against empty data (e.g. unknown tick): data[0] is undefined when
                    // getHolders short-circuits for a nonexistent token.
                    if(cfg.data.method=='getHolders' && data && data.length > 0){
                        let info = data[0];
                        json.tick       = info.tick;
                        json.supply     = info.supply;
                        json.decimals   = info.decimals;
                        json.coin_price = info.coin_price;
                    }
                }
                // The same record count, named the way the explorer's tables expect it:
                // DataTables server-side format (https://datatables.net/manual/server-side#Returned-data)
                if(cfg.type=='explorer'){
                    // DataTables sends back the server's own recordsTotal as ?total= to
                    // avoid a re-count on paging. Validate it: total flows into
                    // getPagingDataResults -> bcsub (mathjs), so an unvalidated non-numeric
                    // override (e.g. ?total=abc) threw a DecimalError outside any try/catch
                    // and crashed the process. Ignore a non-numeric override and keep the
                    // real DB count. Mirrors the isInteger/Number guards on start/limit/length.
                    if(cfg.data.query.total && this.util.isNumeric(cfg.data.query.total))
                        total = Number(cfg.data.query.total)
                    json.recordsTotal    = total;
                    json.recordsFiltered = total;
                }
                json.data  = this.getPagingDataResults(cfg, data, total);
            } else {
                // No total means a single-record read, so the object itself is the answer.
                json = data;
            }

            // Per-method touch-ups to the JSON before it goes out.

            // cfg.data.search is the raw {QUERY} path segment: only echo it back as
            // json.address once it is confirmed address-shaped, so an arbitrary
            // (and possibly script-bearing) path segment never reaches the response.
            if(cfg.data.method=='getBalances')
                json.address = this.util.isAddressLike(cfg.data.search) ? cfg.data.search : null;
            if(cfg.data.method=='getSearch'){
                delete data.data;
                json = Object.assign({}, json, data);
            }

            // Sort the API response and each row's properties alphabetically, so the
            // same query always comes back in the same order.
            if(cfg.type=='api' && !this.util.isNull(json)){
                json = this.util.ksort(json);
                for(let idx in json.data)
                    json.data[idx] = this.util.ksort(json.data[idx]);
            }

            response.json = json;

            if(mirrorGate){
                if(mirrorGate.blocked){
                    response.code = 503;
                    response.json = this.mirrorBlockedBody(mirrorGate.blocked);
                } else if(mirrorGate.annotate){
                    Object.assign(response.json, mirrorGate.annotate);
                }
            }
            }
        }

        // Nothing matched: no file to serve and no method to call, so answer 404.
        if(this.util.isNull(cfg.file) && this.util.isNull(cfg.data.method)){
            cfg.file = '404.html';
            cfg.type = 'html';
            response.code = 404;
        }

        // A data request this instance cannot serve answers 503, service unavailable.
        if(['api','explorer'].includes(cfg.type) && !this.util.isNull(cfg.data.method) && !validDataRequest){
            response.code = 503;
            // Separate code for the freshness gate: a client retrying a COIN_NOT_AVAILABLE
            // is misconfigured, one retrying COIN_DATA_STALE is waiting out an outage.
            response.json = tipStale ? {
                error: 'Indexed data for this coin is stale beyond its maximum tip age; refusing to serve it as current.',
                code: 'COIN_DATA_STALE'
            } : {
                error: 'Explorer not configured to support data requests for this coin.',
                code: 'COIN_NOT_AVAILABLE'
            };
        }

        // No record for a single-resource lookup: return 404 so the HTTP status agrees
        // with the body's NOT_FOUND code and matches the hand-registered routes elsewhere
        // in this service (e.g. :1071, :1133). A 400 made consumers that branch on status
        // (including xchain-sdk) treat "does not exist" as a malformed request. Empty list
        // queries are unaffected (they return 200 with total:0).
        else if(!dbError && !badParam && ['api','explorer'].includes(cfg.type) && this.util.isNull(data) && this.util.isNull(total)){
            response.code = 404;
            response.json = {
                error: 'The requested resource was not found.',
                code: 'NOT_FOUND'
            };
        }

        // Page handler: stitch the page's own content into the shared template.
        if(cfg.type=='html'){
            let htmlDirectory   = path.join(__dirname, 'content/html/')

            let templateFile    = path.join(htmlDirectory, 'template.html');
            let templateExists  = await this.util.fileExists(templateFile);
            let templateContent = (templateExists) ? await this.util.fileGetContents(templateFile) : 'Error loading template file!';

            // A list route no longer has a fragment of its own: 76 near-identical
            // pages collapsed onto the shared list-page composition (spec M2.3),
            // which stitches the same markup from content/layouts/list-pages.json.
            // The url table still names the old fragment, so routes and canonical
            // URLs are untouched; only where the markup comes from changed.
            let htmlContent = listPage.render(cfg.file);

            if(htmlContent === null){
                let htmlFile    = path.join(htmlDirectory, cfg.file);
                let htmlExists  = await this.util.fileExists(htmlFile);
                htmlContent = (htmlExists) ? await this.util.fileGetContents(htmlFile) : 'Error loading html file!';
            }

            // The shell's chrome (nav, search box, theme toggle, footer) is four
            // components now rather than 24KB of inline markup; fill their slots
            // before {CONTENT}, so a component template containing {CONTENT} could
            // never be mistaken for the page's own content slot.
            let pageContent = componentTpl.chrome(templateContent);
            // Layout data a page asks for by name, spliced as a JSON block the
            // page's own script reads back. action.html uses it for the per-type
            // detail-card row configs (spec M2.5): 38 blocks whose row ORDER is
            // now data a theme can resequence, embedded once instead of fetched.
            htmlContent     = listPage.dataBlocks(htmlContent);
            // Use a replacement FUNCTION, not the raw string: String.replace treats $-sequences
            // ($&, $', $`, $1) specially in a string replacement, so any page content containing
            // them (e.g. a "$" in inline JS or a token description) would be mangled or truncated.
            pageContent     = pageContent.replace('{CONTENT}', () => htmlContent);
            // Cross-site navigation for the *.xchain.io family, rendered from the
            // vendored platform-links.json (see src/render/platform_links.js). Same
            // replacement-function reason as {CONTENT}: $-sequences in the markup
            // must not be treated as capture-group references.
            pageContent     = pageContent.replace('{PLATFORM_SWITCHER}', () => renderPlatformSwitcher());

            response.html = pageContent;
        }

        // Total time spent on this request, in milliseconds.
        response.time = this.util.getTimer(debugTimer);

        // Carry that runtime into the JSON response as a readable string.
        if(response.json)
            response.json.runtime = this.util.getTimerString(response.time);

        response.head = structuredClone(this.headers);

        // Freshness marker on every data response for this coin, so a consumer
        // (the SDK, a wallet, the explorer's own pages) can tell served-and-current
        // from served-and-behind without a second request. Headers always; the
        // `freshness` body field only while the coin is stale, so the fresh-path
        // body stays byte-identical to what it was (the same additive convention
        // the WS WELCOME frame uses for its `stale` marker). Skipped on the 503
        // path, whose body is the refusal itself.
        if(['api','explorer'].includes(cfg.type) && freshness && response.json && response.code !== 503){
            response.head['XChain-Freshness'] = freshness.stale ? 'stale' : 'live';
            if(freshness.tip_block !== null && freshness.tip_block !== undefined)
                response.head['XChain-Tip-Block'] = String(freshness.tip_block);
            if(freshness.tip_age_seconds !== null && freshness.tip_age_seconds !== undefined)
                response.head['XChain-Tip-Age-S'] = String(freshness.tip_age_seconds);
            if(freshness.stale && typeof response.json === 'object' && !Array.isArray(response.json))
                response.json.freshness = {
                    stale:           true,
                    tip_block:       freshness.tip_block,
                    tip_age_seconds: freshness.tip_age_seconds,
                    replica_halted:  freshness.replica_halted
                };
        }

        if(configEnv().DEBUG && !this.util.isNull(response.time))
            response.head['XChain-Runtime-Ms'] = response.time;

        if(!this.util.isNull(response.head))
            res.set(response.head);

        res.status(response.code);

        if(!this.util.isNull(response.json)){
            // Explicit header, not res.type('json'): a browser that ever received this
            // body as text/html would let a reflected value execute as markup, so the
            // JSON content type is set directly rather than through a helper whose
            // effect a static analyzer (or a future refactor) could lose track of.
            res.set('Content-Type', 'application/json; charset=utf-8');
            res.send(this.util.jsonStringify(response.json));
        } else if(!this.util.isNull(response.html)){
            res.send(response.html);
        } else {
            res.send('response of last resort...');
        }

        if(!this.util.isNull(response.time)){
            // Record this request's latency in the circular buffer so p95 and a
            // total served count are available from ping(). The buffer size is
            // fixed (LATENCY_WINDOW) so memory stays constant at steady state.
            latencyBuf[latencyIdx % LATENCY_WINDOW] = response.time;
            latencyIdx++;
            requestCount++;
        }

        // Anything slower than 400 milliseconds is logged, and counted for /ping.
        if(response.time > 400){
            slowRequests++;
            log.warn('SLOW_REQUEST', { path: req.path, time: response.time + 'ms' });
        }

        // Debug detail, logged only when the DEBUG environment variable is set.
        // The request config as fields, so the shipper's key redaction applies to the
        // client-supplied query it carries before the record reaches any log sink.
        if(configEnv().DEBUG){
            log.info('REQUEST_CONFIG', { coin: cfg.coin, type: cfg.type, file: cfg.file, data: cfg.data });
        }
    }

    // Walk the rows the database returned and hand back only the ones this
    // request asked to see, honouring its paging position and limit.
    getPagingDataResults(config, data, total){
        let cfg    = config;
        let type   = cfg.type;
        let max    = this.db.getMaxMethodResults(cfg.data.method);
        let q      = (cfg.data && cfg.data.query) ? cfg.data.query : false;
        let start  = (q && q.start  && this.util.isInteger(Number(q.start)))  ? q.start  : 0;
        let limit  = (q && q.limit  && this.util.isInteger(Number(q.limit)))  ? q.limit  : max;
        let length = (q && q.length && this.util.isInteger(Number(q.length))) ? q.length : 10;
        let offset = (cfg.data && cfg.data.offset && !this.util.isNull(cfg.data.offset.start))  ? cfg.data.offset.start  : false;
        let action = (cfg.data && cfg.data.offset && !this.util.isNull(cfg.data.offset.action)) ? cfg.data.offset.action : false;
        let method = cfg.data.method;
        // Cursor-paged list views (anchor_actions, slash_events, the hub mirrors, etc.) carry
        // no server-computed boundary on a jump-to-last: their main query already returns the
        // exact final page (ORDER BY <cursor> ASC LIMIT n), so there is no `offset` to satisfy
        // the keep test below. The `cnt > start` window test then drops every row (cnt is
        // 1-based within the single returned page, never exceeding `start`). Keep all rows in
        // that case, mirroring how the `|| offset` branch keeps a cursor-windowed page.
        let cursorLast = (action=='last') && (this.db.cursorPagedMethods || []).includes(method);

        // Clamp pagination values to safe ranges
        start  = Math.max(0, Number(start));
        limit  = Math.max(1, Math.min(Number(limit), max));
        length = Math.max(1, Number(length));

        // A search wraps its rows one level deeper; page over those rows.
        if(method=='getSearch')
            data = data.data;

        // SQL OFFSET already handled pagination for API requests; return all rows
        if(cfg.type=='api'){
            start = 0;
        }
        // Explorer requests set their own limit from the page length and start position.
        if(cfg.type=='explorer'){
            // Limit results to 100 max (except in special cases where we can not use an offset)
            if(length > 100 && !['getHolders','getBalances','getCredits','getDebits'].includes(cfg.data.method))
                length = 100;
            // Even the offset-exempt methods carry an explicit finite ceiling so one
            // query parameter cannot drive an unbounded DB scan + response serialization;
            // the app-layer invariant no longer rests solely on db/index.js's own clamp.
            else if(length > 10000)
                length = 10000;
            limit = this.util.bcadd(start, length);
        }

        // Placeholder for the results we will actually show
        let show          = [];
        let cnt           = (offset) ? start : 0;
        let count         = 0;
        let count_reverse = 0;

        // Loop through data and determine what to return to use
        for(let idx in data){
            cnt++;
            idx++;

            // Keep track of display count separate from actual count
            count = cnt;

            // Paging backwards returns the rows reversed, so the displayed count
            // has to be worked out from the other end.
            if(['prev','last'].includes(action))
                count = this.util.bcadd(start,this.util.bcsub(data.length, this.util.bcsub(idx, 1)),0);

            // Reverse-count: total minus (count-1), used because latest is first in most cases
            count_reverse = this.util.bcsub(total,this.util.bcsub(count, 1),0);

            // Keep only the rows inside the window this request asked for.
            if((cnt > start && cnt <= limit) || offset || cursorLast){
                let info   = data[idx-1];
                // API requests return each row's fields under their own names.
                if(type=='api'){
                    // Holders: hoist token-level fields to top; pass only address+amount per row
                    if(method=='getHolders'){
                        info = {
                            'address': info.address,
                            'amount':  info.amount
                        };
                    }
                }
                // Explorer requests return an array of fields in the exact order the
                // table's columns are drawn.
                if(type=='explorer'){
                    let status = (info.status=='valid') ? 1 : 0; // 1=valid, 2=invalid
                    let percent = 0;                             // Percentage of total supply
                    let value   = 0;                             // Estimated value
                    let amount  = 0;                             // Amount formatted to correct decimal precision

                    // The token's lock flags, packed into one pipe-joined string.
                    let locks = false;
                    if(['getIssues','getTokens','getProjectTokens'].includes(method)){
                        let arr = [
                            info.lock_max_supply,
                            info.lock_mint,
                            info.lock_mint_supply,
                            info.lock_max_mint,
                            info.lock_description,
                            info.lock_sleep,
                            info.lock_callback
                        ];
                        locks = arr.join('|');
                    }

                    // Per-block action counts, packed into one string rather than sent
                    // as a field each, which keeps a block list small on the wire.
                    let actions = false;
                    if(method=='getBlocks'){
                        let arr = [
                            info.actions.addresses,
                            info.actions.airdrops,
                            info.actions.batches,
                            info.actions.broadcasts,
                            info.actions.callbacks,
                            info.actions.destroys,
                            info.actions.dispensers,
                            info.actions.dispenses,
                            info.actions.dividends,
                            info.actions.files,
                            info.actions.issues,
                            info.actions.links,
                            info.actions.lists,
                            info.actions.messages,
                            info.actions.mints,
                            info.actions.orders,
                            info.actions.order_cancels,
                            info.actions.order_edits,
                            info.actions.order_matches,
                            info.actions.sends,
                            info.actions.sleeps,
                            info.actions.swaps,
                            info.actions.swap_cancels,
                            info.actions.swap_edits,
                            info.actions.swap_matches,
                            info.actions.sweep
                        ];
                        actions = arr.join('|');
                    }

                    // Balance rows carry the amount, its share of total supply, and
                    // an estimated value.
                    if(['getBalances','getHolders'].includes(method)){
                        // Show the amount at the token's own decimal precision.
                        amount  = String(this.util.bcformat(info.amount, info.decimals));
                        percent = String(this.util.bcmul(this.util.bcdiv(info.amount,info.supply, 8), 100, 8));
                        value   = String(this.util.bcmul(info.amount, info.coin_price, 8));
                    }
                    // Build out the correct response array based on method type
                    if(method=='getAddresses')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.fee_preference, info.require_memo, info.dispenser_preference, status, info.action_index];
                    if(method=='getAirdrops')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.memo, status, info.action_index];
                    if(method=='getBalances')
                        info = [count, info.tick, amount, percent, value, null];
                    if(method=='getBatches')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, status, info.action_index];
                    if(method=='getBlocks')
                        info = [info.block_index, info.timestamp, actions, info.block_index];
                    if(method=='getBroadcasts')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.message, info.value, info.fee, status, info.action_index];
                    if(method=='getCallbacks')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.callback_tick, info.callback_amount, status, info.action_index];
                    if(['getCredits','getDebits','getEscrows'].includes(method))
                        info = [count_reverse, info.block_index, info.timestamp, info.address, info.tick, info.amount, info.action, info.action_index];
                    if(method=='getDestroys')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.memo, status, info.action_index];
                    if(method=='getDispensers')
                        // give_ownership sits BEFORE status/action_index so action_index stays LAST
                        // and status second-to-last (the client's length-relative extraction + paging cursor).
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_coin, info.give_tick, info.give_amount, info.get_coin, info.get_tick, info.get_amount, info.give_ownership, status, info.action_index];
                    if(method=='getDispenses')
                        info = [count_reverse, info.block_index, info.timestamp, info.destination, info.give_coin, info.give_tick, info.give_amount, info.get_coin, info.get_tick, info.get_amount, status, info.action_index];
                    if(method=='getDividends')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.dividend_tick, info.amount, status, info.action_index];
                    if(method=='getFees')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.method, info.action, info.action_index];
                    if(method=='getFiles')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.name, info.type, info.title, info.gate_ticker, status, info.action_index];
                    // A validator PRICE on the wire today is a BATCH: one signed action
                    // carrying an hourly window of rounds, whose coin/tick/fiat/value/fee
                    // are NULL by construction (they are the v1 user-oracle columns) and
                    // whose pair_count is NULL too (it would describe one round out of the
                    // window). Carrying only those five is why every validator row rendered
                    // as dashes. The round window (batch_first_round/batch_last_round/
                    // round_count), the round the action is about and the pair counts ride
                    // ahead of status/action_index so the client can describe the batch;
                    // batch_pair_count is the width of the batch's first round, counted by
                    // the feed query rather than shipped as rounds_json (megabytes a page).
                    if(method=='getPrices')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.version, info.coin, info.tick, info.fiat, info.round_number, info.batch_first_round, info.batch_last_round, info.round_count, info.pair_count, (info.batch_pair_count === undefined) ? null : info.batch_pair_count, info.value, info.fee, status, info.action_index];
                    if(method=='getControllers')
                        info = [count_reverse, info.block_index, info.timestamp, info.scope, info.subject, info.action_class, info.contract_index, info.is_unbind, info.cooldown_blocks, info.cooldown_end_block, status, info.action_index];
                    if(method=='getDeployChunks')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.code_hash, info.chunk_index, info.total_chunks, status, info.action_index];
                    if(method=='getHistory')
                        info = [count_reverse, info.block_index, info.timestamp, info.action, info.details, status, info.action_index];
                    // Raw action list: one row per action with its type name and no
                    // per-type detail object. The actions table has no status column,
                    // so the action NAME lands second-to-last and the client keeps
                    // this view in its no-color list. action_index stays LAST
                    // (paging cursor).
                    if(method=='getActions')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.action, info.action_index];
                    if(method=='getHolders')
                        info = [count, info.address, amount, percent, value, null];
                    // transfer (ownership-transfer destination, null for plain issues)
                    // sits BEFORE status/action_index so the client's length-relative
                    // status + paging-offset extraction keeps working
                    if(method=='getIssues')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.max_supply, info.max_mint, locks, info.transfer, status, info.action_index];
                    if(method=='getLinks')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.coin1, info.coin1_action_index, info.coin2, info.coin2_action_index, info.memo, status, info.action_index];
                    if(method=='getLists')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.type, info.edit, status, info.action_index];
                    if(method=='getMarkets')
                        info = [count_reverse, info.tick1, info.tick2, info.tick1_price, info.tick1_ask, info.tick1_bid, info.tick2_24hr_volume, info.tick1_24hr_change, info.id];
                    if(method=='getMarketHistory')
                        info = [count_reverse, info.block_index, info.timestamp, info.type, info.price, info.amount, null, info.action_index];
                    if(method=='getMessages')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.destination, info.plaintext_message, info.encrypted_message, status, info.action_index];
                    // Carry destination in the slot getSends uses, before
                    // status/action_index, so the client's length-relative
                    // status and paging-offset extraction keeps working.
                    if(method=='getMints')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.destination, status, info.action_index];
                    if(method=='getOrders')
                        // give/get_ownership sit BEFORE status/action_index (invariant: action_index LAST).
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_tick, info.give_amount, info.get_tick, info.get_amount, info.give_ownership, info.get_ownership, status, info.action_index];
                    if(method=='getSends')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.amount, info.destination, status, info.action_index];
                    if(method=='getSleeps')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.type, info.tick, info.resume_block, status, info.action_index];
                    if(method=='getSwaps')
                        // give/get_ownership sit BEFORE status/action_index (invariant: action_index LAST).
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.give_tick, info.give_amount, info.get_tick, info.get_amount, info.give_ownership, info.get_ownership, status, info.action_index];
                    // Matched order pairs. A match row names each leg by coin plus the
                    // matched ORDER's action_index and carries no ticks of its own, so
                    // the legs render as action links, not token links. status and
                    // action_index stay LAST (row color + paging cursor).
                    if(method=='getOrderMatches')
                        info = [count_reverse, info.block_index, info.timestamp, info.give_coin, info.give_action_index, info.give_amount, info.get_coin, info.get_action_index, info.get_amount, info.settlement_type, status, info.action_index];
                    // Matched swap pairs: the same two-leg shape minus the amount and
                    // settlement-type columns, which a swap match does not carry.
                    if(method=='getSwapMatches')
                        info = [count_reverse, info.block_index, info.timestamp, info.give_coin, info.give_action_index, info.get_coin, info.get_action_index, status, info.action_index];
                    if(method=='getSweeps')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.destination, info.balances, info.ownerships, info.orders, info.swaps, info.dispensers, status, info.action_index];
                    // NOTE: decimals sits BEFORE the trailing id; the datatables client
                    // uses the LAST element of each row for offset paging (offset_first/
                    // offset_last), so new fields must never displace it. decimals +
                    // locks (lock_max_supply) let the client badge NFT-pattern tokens.
                    if(['getTokens','getProjectTokens'].includes(method))
                        info = [count_reverse, info.block_index, info.timestamp, info.tick, info.supply, info.max_supply, info.max_mint, locks, info.decimals, info.id];
                    // VM / Contract list pages. meta_name rides in the slot AFTER
                    // source: the first four elements are the shared count/block/time/
                    // source cells every list page renders generically, and status +
                    // action_index stay last (row color + paging cursor).
                    if(method=='getContracts')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.meta_name, info.code_hash, info.api_version, info.cooldown_blocks, info.slash_destination, status, info.action_index];
                    if(method=='getExecutions')
                        info = [count_reverse, info.block_index, info.timestamp, info.contract_index, info.caller, info.method_name, info.gas_used, status, info.action_index];
                    // Per-contract emission rollup (contract_emissions joined through
                    // contract_executions). Cursor is m.id: this table's own action_index
                    // is nullable for internal emissions such as SLASH, so it sits with
                    // the id-keyed views.

                    // status is the parent EXECUTE's real valid/invalid state, not a
                    // lifecycle word, and renders as TEXT: coloring an emissions row would
                    // recolor the execution's outcome on a row about something else.
                    if(method=='getEmissions')
                        info = [count_reverse, info.block_index, info.timestamp, info.execution_index, info.contract_index, info.position, info.emitted_action, info.action_index, info.status, info.id];
                    if(['getDeposits','getWithdrawals'].includes(method))
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.contract_index, info.tick, info.amount, status, info.action_index];
                    // Capability staking list pages. The raw stakes page keeps action_index LAST
                    // (paging cursor).
                    if(method=='getStakes')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.version, info.amount, status, info.action_index];
                    // The validators row carries the hub federation registry's addr /
                    // chains / registration-status for the same signing pubkey (db/index.js
                    // getData folds them on), so the on-chain active set and the hub
                    // registry render as ONE table.

                    // Those columns and the activation/deactivation tails all sit BEFORE
                    // status/action_index: the client reads status second-to-last and
                    // action_index last (view link + paging cursor), so nothing may
                    // displace them.
                    if(method=='getValidators')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.version, info.amount, info.hub_addr, info.hub_chains, info.hub_status, info.activation_block, info.deactivation_block, status, info.action_index];
                    if(method=='getDelegations')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, status, info.action_index];
                    if(method=='getValidatorRewards')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.reward_type, info.amount, info.id];
                    // Full-node possession-proof verdict list page. action_index stays LAST
                    // (the datatables client uses it as the paging offset cursor).
                    if(method=='getFullNodeVerifications')
                        info = [count_reverse, info.block_index, info.timestamp, info.signing_pubkey, info.staking_source, info.epoch_height, info.target_height, info.challenge_id, info.passed, info.action_index];
                    // Contract-targeted staking list pages
                    if(method=='getContractStakes')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.target_contract_index, info.tick, info.amount, info.version, status, info.action_index];
                    if(method=='getContractUnstakes')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.target_contract_index, info.tick, info.amount, info.cooldown_end_block, status, info.action_index];
                    if(method=='getSlashEvents')
                        info = [count_reverse, info.block_index, info.timestamp, info.slashed_pubkey, info.target_contract_index, info.tick, info.amount, info.destination, info.execution_index];
                    // Capability staking lifecycle list pages. action_index stays LAST (paging cursor).
                    if(method=='getCollects')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.amount, status, info.action_index];
                    if(method=='getUnstakes')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.amount, info.cooldown_end_block, status, info.action_index];
                    if(method=='getStakeKeyRevocations')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.deactivation_block, status, info.action_index];
                    // Capability equivocation slashes. No own action_index; id is the paging cursor
                    // (LAST), slash_action_index links the view to the SLASH wire action.
                    if(method=='getCapabilitySlashEvents')
                        info = [count_reverse, info.block_index, info.timestamp, info.slashed_pubkey, info.capability, info.amount, info.submitter, info.slash_action_index, info.id];
                    // User token/fiat oracle rows (hub-mirrored, cross-chain). id is the paging cursor
                    // (LAST); block_time + source_chain replace the block/time columns (no local block).
                    if(method=='getOraclePrices')
                        info = [count_reverse, info.block_time, info.source_chain, info.source_address, info.tick, info.fiat, info.value, info.id];
                    // Attestation list page
                    if(method=='getAttestations')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.version, info.provider_id, info.request_id, info.request_status, info.response_status, status, info.action_index, info.payload, info.callback_params_json, info.fee_payer];
                    // Per-validator per-provider ATTEST accountability counters
                    // (indexer-owned, id-keyed: the surrogate id is the paging cursor and
                    // stays LAST).

                    // last_updated_block is the freshness column and lands second-to-last,
                    // where createdRow reads `status` positionally, so attest_validator_stat
                    // sits in the client's no-color list rather than having a numeric height
                    // read as a coloring flag. slashed_count and quality_score are Phase 4
                    // columns, 0 until a producer exists, but stay surfaced.
                    if(method=='getAttestValidatorStats')
                        info = [count_reverse, info.validator_pubkey, info.provider_id, info.fulfilled_count, info.missed_count, info.slashed_count, info.quality_score, info.last_updated_block, info.id];
                    // VOTE poll list page. poll_status (lifecycle enum), end_block (close
                    // height) and callback_contract_index (non-null = binding poll: the
                    // result fires a contract method) are rendered columns; status (0/1
                    // action validity) + action_index stay LAST for the client's generic
                    // row-color + paging-cursor extraction (data[len-2]/data[len-1]).
                    // WINNER: polls.winning_option is an INDEX into the poll's options, so
                    // option 0 is a real winner and only a null means "no outcome recorded".
                    // The query has always selected it and this branch dropped it, leaving
                    // the one field a reader opens a finished poll to see with no column at
                    // all. It rides as the raw index PLUS the label resolved off the stored
                    // options JSON, because the feed carries no options array and a bare
                    // index names nothing to a reader.
                    if(method=='getPolls'){
                        let win = this.util.isNull(info.winning_option) ? null : Number(info.winning_option);
                        if(win !== null && !Number.isFinite(win)) win = null;
                        let winner = null;
                        if(win !== null){
                            let opts = info.options;
                            if(typeof opts == 'string'){
                                // getPolls hands back the stored JSON verbatim; a malformed
                                // blob costs the label, never the index.
                                try { opts = JSON.parse(opts); }
                                catch(_){ opts = null; }
                            }
                            if(Array.isArray(opts) && !this.util.isNull(opts[win]))
                                winner = String(opts[win]);
                        }
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.question, info.poll_status, info.end_block, info.callback_contract_index, win, winner, status, info.action_index];
                    }
                    // VOTE ballot list page. One row per (poll, voter, chosen option); the voter
                    // is the source. action_index stays LAST (paging cursor; links the ballot action).
                    if(method=='getVotes')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.poll_index, info.choice, info.share, status, info.action_index];
                    // VOTE v3 liquid-democracy delegations. The row IS already the live
                    // delegation for its (tick, delegator): getVoteDelegations' correlated MAX
                    // excludes every superseded, re-pointed or cleared row before this runs, so
                    // no further live/revoked filtering happens here. Carries a real 0/1 action
                    // status and an action_index, so it takes the standard colored,
                    // view-button row shape.
                    if(method=='getVoteDelegations')
                        info = [count_reverse, info.block_index, info.timestamp, info.tick, info.delegator, info.delegate, status, info.action_index];
                    // BET market list page. The feed id IS action_index, which stays LAST
                    // (the datatables client uses it as the paging offset cursor). Label is
                    // attacker-controlled and is escaped client-side before it reaches the DOM.
                    if(method=='getBetFeeds')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.tick, info.label, info.feed_status, info.deadline, status, info.action_index];
                    // BET wager list page. One row per placed bet; the bettor is the source.
                    if(method=='getBets')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.feed_action_index, info.outcome, info.tick, info.amount, info.bet_status, status, info.action_index];
                    // XCALL cross-chain call list page (source request rows). action_index stays
                    // LAST (the datatables client uses it as the paging offset cursor).
                    if(method=='getXcalls')
                        info = [count_reverse, info.block_index, info.timestamp, info.contract_index, info.target_chain, info.target_contract_index, info.method, info.request_status, status, info.action_index];
                    // ANCHOR checkpoint list page. action_index stays LAST (paging cursor).
                    if(method=='getAnchors')
                        info = [count_reverse, info.block_index, info.timestamp, info.chain, info.network, info.version, info.checkpoint_seq, info.snapshot_block, info.match_count, status, info.action_index];
                    // Cross-chain DEX match (hub-mirrored, id-keyed). id is the paging cursor (LAST);
                    // snapshot_block is the BTC-anchored quorum block. No status coloring (status is a
                    // word, not 0/1); the render badges it instead.
                    if(method=='getCrossChainMatches')
                        info = [count_reverse, info.snapshot_block, info.network, info.match_id, info.a_chain, info.a_tick, info.a_amount, info.b_chain, info.b_tick, info.b_amount, info.status, info.id];
                    // Quorum-signed state checkpoints (hub-mirrored). No action row and no
                    // 0/1 status, so block_index doubles as the paging cursor (LAST) and the
                    // client renders this action in its no-color list. signer_count is the
                    // signature count the list shows without verifying anything; the verdict
                    // costs an Ed25519 pass per signer and lives behind the detail page's
                    // Verify control instead.
                    if(method=='getCheckpoints')
                        info = [count_reverse, info.block_index, info.created_at, info.checkpoint_seq, info.snapshot_block, info.state_root, info.block_merkle_root, info.signer_count, info.block_index];
                    // Per-block SPV commitments (state_tree_roots, id-keyed - no action_index).
                    // The checkpoint_/anchor_ fields are NULL when this block has no covering
                    // checkpoint yet or no carrying ANCHOR yet, both normal near the tip rather
                    // than errors; the client renders those as a neutral pending badge.
                    // m.block_index doubles as the paging cursor (LAST), same as getCheckpoints.
                    if(method=='getCommitments')
                        info = [count_reverse, info.block_index, info.balances_root, info.stakes_root, info.state_root, info.block_merkle_root, info.contract_state_root, info.checkpoint_seq, info.checkpoint_signer_count, info.anchor_action_index, info.anchor_version, info.block_index];
                    // Quorum-attested ANCHOR publisher rewards (hub-mirrored, id-keyed,
                    // never routed through HubOperationalCache; see checkpointSource).
                    // id is the paging cursor (LAST).

                    // doge_anchor_txid lands second-to-last, so anchor_reward_attestation
                    // sits in the no-color exclusion list: it is the mined DOGE transaction
                    // the reward is proof-bound to, not a status. reward_amount (audit-only)
                    // and publisher_attestations (raw quorum JSON) are not carried.
                    if(method=='getAnchorRewardAttestations')
                        info = [count_reverse, info.created_at, info.chain, info.network, info.reward_type, info.round_reference, info.snapshot_block, info.publisher, info.doge_anchor_txid, info.id];
                    // Capability snapshots: the historical electorate behind those checkpoints
                    // (which signing key carried which stake weight for a capability at a
                    // snapshot block). id is the paging cursor (LAST); source is second-to-last
                    // and carries the staking source the weight groups under (empty before
                    // stake-weighted-quorum activation), not a status, so this action is in the
                    // client's no-color list.
                    if(method=='getCapabilitySnapshots')
                        info = [count_reverse, info.created_at, info.snapshot_block, info.capability, info.signing_pubkey, info.amount, info.source, info.id];
                    // Validator PBFT COIN/FIAT price rounds (hub-mirrored, id-keyed). id is the
                    // paging cursor (LAST); status is a round-lifecycle word, not 0/1, so this
                    // action sits in the client's no-color list.
                    if(method=='getPriceSnapshots')
                        info = [count_reverse, info.block_timestamp, info.reference_block, info.reference_chain, info.coin_pair, info.price, info.validator_count, info.consensus_round, info.status, info.id];
                    // Contract-targeted stake delegations. Carries both a 0/1 action status and
                    // an action_index, so it takes the standard colored-row shape.
                    if(method=='getContractDelegations')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.signing_pubkey, info.target_contract_index, info.tick, info.activation_block, info.deactivation_block, status, info.action_index];
                    // Cross-chain reorg attestations (hub-owned, id-keyed). id is the paging
                    // cursor (LAST); status is a lifecycle word ('confirmed'/'rejected'), not
                    // 0/1, so this action sits in the client's no-color list. reorg_timestamp is
                    // stored in MILLISECONDS by the hub, which the client divides down before
                    // rendering.
                    if(method=='getReorgs')
                        info = [count_reverse, info.reorg_timestamp, info.reorg_height, info.reorg_id, info.affected_chains, info.validator_count, info.status, info.id];
                    // Federation slash proposals (hub-owned, id-keyed). id is the paging
                    // cursor (LAST); evidence_hash is served in place of the verbatim
                    // evidence blob (hashed hub-side; see db/index.js getSlashProposals).

                    // status is a lifecycle word, not 0/1, so this action sits in the
                    // client's no-color list. The exclusion is load-bearing, not
                    // cosmetic: an UNADJUDICATED accusation painted in the failure
                    // colour reads as a verdict.
                    if(method=='getSlashProposals')
                        info = [count_reverse, info.created_at, info.validator_pubkey, info.offense_type, info.round_number, info.evidence_hash, info.status, info.id];
                    // COINPAY settlement records. obligation_action_index links the payment back
                    // to the obligation it discharged; txid/vout name the specific output that
                    // paid THAT obligation, which is why one transaction can appear on several rows.
                    if(method=='getCoinpays')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.obligation_action_index, info.coin_amount, info.txid, info.vout, status, info.action_index];
                    // COINPAY obligations: who owes what native coin, expiring when. The row is
                    // the LATEST status per obligation (the query's MAX(action_index) join), and
                    // coinpay_status is a lifecycle word rather than 0/1, so no color and no
                    // block time column (the obligation is created by a match, not by its own tx).
                    if(method=='getCoinpayObligations')
                        info = [count_reverse, info.block_index, info.payer_address, info.payee_address, info.coin, info.coin_amount, info.expiration, info.coinpay_status, info.action_index];
                    // Protocol-written terminal actions for orders/swaps/dispensers. Each row
                    // is the expire/close action itself plus a pointer at what it retired, so
                    // the pointer sits at slot 4 and status/action_index stay last.
                    if(method=='getOrderExpires')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.order_action_index, status, info.action_index];
                    if(method=='getSwapExpires')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.swap_action_index, status, info.action_index];
                    if(method=='getDispenserExpires')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.dispenser_action_index, status, info.action_index];
                    // DISPENSER_CLOSE also returns the closed dispenser's terms, so both legs
                    // ride along. A native-coin leg carries a null tick with a real coin+amount,
                    // which the client must render unlinked rather than as /token/null.
                    // close_reason ('empty' vs 'cancelled') sits BEFORE status/action_index so
                    // action_index stays LAST (paging cursor) and status second-to-last.
                    if(method=='getDispenserCloses')
                        info = [count_reverse, info.block_index, info.timestamp, info.dispenser_address, info.dispenser_action_index, info.give_coin, info.give_tick, info.give_amount, info.get_coin, info.get_tick, info.get_amount, info.close_reason, status, info.action_index];
                    // COINPAY_EXPIRE has no source of its own (no user transaction writes it),
                    // so slot 3 carries the obligation it closed out instead of an address.
                    if(method=='getCoinpayExpires')
                        info = [count_reverse, info.block_index, info.timestamp, info.obligation_action_index, status, info.action_index];
                    // User-written cancels. The row is the cancel action plus a pointer at
                    // the record it pulled, and its memo: the memo is the only field saying
                    // WHY the owner cancelled, so it is the one column worth the width.
                    if(method=='getOrderCancels')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.order_action_index, info.memo, status, info.action_index];
                    if(method=='getSwapCancels')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.swap_action_index, info.memo, status, info.action_index];
                    if(method=='getDispenserCancels')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.dispenser_action_index, info.memo, status, info.action_index];
                    // User-written edits. An edit exists only for what it CHANGED, so the
                    // amended fields ride along: a null expiration/allow_list/block_list means
                    // the edit left that setting alone, which the client must render as a dash
                    // rather than dropping the column (a DISPENSER_EDIT that moved only escrow
                    // legitimately carries a null expiration). give_escrow is dispenser-only.
                    if(method=='getOrderEdits')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.order_action_index, info.expiration, info.allow_list, info.block_list, info.memo, status, info.action_index];
                    if(method=='getSwapEdits')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.swap_action_index, info.expiration, info.allow_list, info.block_list, info.memo, status, info.action_index];
                    if(method=='getDispenserEdits')
                        info = [count_reverse, info.block_index, info.timestamp, info.source, info.dispenser_action_index, info.give_escrow, info.expiration, info.allow_list, info.block_list, info.memo, status, info.action_index];
                    // Cross-chain settlement leg (local action-chain row; no status column). action_index
                    // is the paging cursor (LAST) and links the local settlement action.
                    if(method=='getCrossChainSettlements')
                        info = [count_reverse, info.block_index, info.timestamp, info.match_id, info.local_action_index, info.action_index];
                    // Hub capability + governance rows (read from the co-located hub DB, id-keyed).
                    // id is the paging cursor (LAST); status/vote are enum words (no 0/1 coloring,
                    // so these methods sit in the no-color list client-side).
                    if(method=='getValidatorCapabilities')
                        info = [count_reverse, info.updated_at, info.signing_pubkey, info.capability, info.qualified, info.self_test_ok, info.enabled, info.qualified_at_block, info.id];
                    if(method=='getGovernanceProposals')
                        info = [count_reverse, info.proposal_id, info.parameter, info.current_value, info.proposed_value, info.status, info.voting_end, info.activation_block, info.proposer_pubkey, info.id];
                    if(method=='getGovernanceVotes')
                        info = [count_reverse, info.created_at, info.proposal_id, info.voter_pubkey, info.vote, info.id];
                    // Hub operational rows (read from the co-located hub DB, id-keyed). id is the
                    // paging cursor (LAST); these have no 0/1 status column, so they sit in the
                    // client-side no-color list.
                    if(method=='getPeers')
                        info = [count_reverse, info.last_seen_at, info.addr, info.validator_id, info.is_seed, info.id];
                    if(method=='getConsensusState')
                        info = [count_reverse, info.updated_at, info.key_name, info.value, info.id];
                    if(method=='getConfigs')
                        info = [count_reverse, info.updated_at, info.coin, info.network, info.module, info.param_name, info.param_value, info.id];
                    if(method=='getTelemetryPings')
                        info = [count_reverse, info.created_at, info.event, info.node_version, info.os_platform, info.arch, info.country, info.region, info.id];
                    if(method=='getSearch'){
                        if(cfg.data.type=='address')
                            info = [count, info.address, null];
                        if(cfg.data.type=='broadcast')
                            info = [count, info.message, info.memo, info.action_index];
                        if(cfg.data.type=='token')
                            info = [count, info.tick, info.description, null];
                        if(cfg.data.type=='transaction')
                            info = [count, info.hash, null];
                        // Contract hits carry the identity a reader searched by: the
                        // declared name, its version, the derived address they navigate
                        // to, and a snippet of the description. action_index rides LAST,
                        // the same paging-cursor position the broadcast panel uses.
                        if(cfg.data.type=='contract')
                            info = [count, info.meta_name, info.meta_version, info.contract_address, info.snippet, info.action_index];
                    }
                }

                show.push(info);

            }
        }

        // Paging backwards built the page in reverse, so flip it back before returning.
        if(['prev','last'].includes(action))
            show = show.reverse();

        return show;
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

// One export shape: the class is the export and its helpers hang on it, so
// requirers read XChainExplorer.isPreflightPostRequest and the rest as before.
module.exports = Object.assign(XChainExplorer, {
    canonicalCheckpointString,
    isPreflightPostRequest,
    MAX_PREFLIGHT_PARAMS_LENGTH,
    PREFLIGHT_BODY_LIMIT
});
