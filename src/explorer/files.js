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
 * XChain Explorer - icon and FILE bytes
 *
 * The two routes that serve bytes off disk or out of the decoder database: token
 * icons from a fixed directory, and FILE action content (token-gated ciphertext
 * or stored, possibly compressed, plain bytes).
 *
 * Authored as a class body and installed onto XChainExplorer.prototype by
 * explorer/install.js, so `this` is the explorer instance at call time.
 *
 ********************************************************************/

'use strict';

const path        = require('path');
const compression = require('../http/compression.js');
const multipart   = require('./multipart_file.js');
const multipartStream = require('./multipart_stream.js');
// Module-scope logger, not a method on the class these parts install onto: every
// log line below reaches the shipper api.js installs, exactly as it did inline.
const { getLogger } = require('../observability');
const log = getLogger();

// The entry file's own `fs`, handed over at install time rather than required
// here. Several suites build the explorer through proxyquire with `fs` replaced in
// XChainExplorer.js's require map; a second require in this file would resolve to
// the real module and quietly escape that stub.
let fs = null;

function useHostBindings(host){
    fs = host.fs;
}

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

// Name a gated FILE's download from the NAME its action carries. gated_files stores
// no name, but every FILE action has one on the SAME action_index's `files` row, which
// getActionData resolves onto `data.name`. A failed or empty lookup serves the
// ciphertext unnamed rather than failing the download.
async function gatedFileDisposition(db, coin, actionIndex){
    try {
        let data = await db.getActionData({ coin, data: {} }, Number(actionIndex));
        return (data && data.name) ? safeAttachmentFilename(String(data.name)) : null;
    } catch(_){
        return null;
    }
}

class FileRoutes {

    // ICON request handler: serves token icons from a fixed directory and refuses
    // any resolved path that escapes it, because the request path reaches here
    // unvalidated. A miss redirects to the default request, which serves the
    // fixed unknown-coin image without re-entering the redirect path.
    async processIconRequest(req, res){
        // '..' because this part sits one directory below the class file the route
        // was written in: the icons still live at src/content/icons.
        const dirPath  = path.resolve(path.join(__dirname, '..', 'content/icons'));
        const fallbackPath = path.resolve(path.join(dirPath, 'default.png'));
        const fallbackImage = path.resolve(path.join(dirPath, '..', 'images', 'coin-unknown-64.png'));
        // req.path is the raw, still-encoded path. The client percent-encodes
        // the tick segment (getTokenIcon), and the downloader names the file
        // after the raw tick, so the segment is decoded before the disk lookup
        // or a tick with '%' or '#' in it never finds its own icon. A path
        // whose encoding does not parse is a miss, not an error page.
        let rel;
        try {
            rel = decodeURIComponent(req.path.replace(/^\/icon/, ''));
        } catch(_){
            return res.redirect(302, '/icon/default.png');
        }
        if(rel.includes('\0'))
            return res.redirect(302, '/icon/default.png');
        const filePath = path.resolve(path.join(dirPath, rel));
        if(!filePath.startsWith(dirPath + path.sep))
            return res.status(403).json({ error: 'Access denied', code: 'PATH_DENIED' });
        if(fs.existsSync(filePath)){
            res.sendFile(filePath);
        } else if(filePath === fallbackPath) {
            if(fs.existsSync(fallbackImage)) return res.sendFile(fallbackImage);
            return res.status(404).json({ error: 'Icon not found', code: 'ICON_NOT_FOUND' });
        } else {
            res.redirect(302, '/icon/default.png');
        }
    }

    /**********************************************************
     * FILE content: GET /{COIN}/api/file/{ACTION_INDEX}/raw
     *
     * Gated FILE returns AES-256-GCM ciphertext (12-byte nonce || 16-byte
     * authentication tag || ciphertext) as octet-stream; holders decrypt
     * client-side with a key delivered over an ECIES MESSAGE. The tag sits
     * BEFORE the ciphertext, matching xchain-sdk/src/actions/gated_file.js and
     * xchain-documentation/protocol/actions/file.md; a decryptor written to
     * the other order fails GCM authentication on every file.
     *
     * Non-gated FILE returns stored decoder-DB bytes, the resolution target
     * for TIS `data_ref` entries. Those bytes are ATTACKER-CONTROLLED, so the
     * declared MIME type is honored INLINE only for safe media types and
     * everything else downloads as an attachment: serving or sniffing
     * text/html from the explorer origin would be stored XSS.
     *
     * Unknown action indexes, or an unreachable decoder DB, return 404.
     *********************************************************/
    async processFileRawRequest(req, res){
        let coin = String(req.params.coin || '').toUpperCase();
        let actionIndex = req.params.actionIndex;
        if(!this.util.isSafeIntegerParam(actionIndex))
            return res.status(400).json({ error: 'Invalid action_index', code: 'INVALID_ACTION_INDEX' });
        if(!this.db.pools || !this.db.pools[coin])
            return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
        try {
            const rangeHeader = req.headers ? req.headers.range : undefined;
            return await this.serveFileRaw({ coin, data: {} }, actionIndex, res, rangeHeader);
        } catch (e) {
            if(res.headersSent || res.destroyed) {
                if(typeof res.destroy === 'function' && !res.destroyed) res.destroy(e);
                return res;
            }
            const status = e instanceof multipart.MultipartFileError ? e.status : 500;
            const code = e instanceof multipart.MultipartFileError ? e.code : 'SERVER_ERROR';
            if(status >= 500)
                log.error('FILE_RAW_REQUEST_FAILED', { err: e && e.message ? e.message : e, stack: e && e.stack });
            const body = { error: e instanceof multipart.MultipartFileError ? e.message : 'Server error', code };
            if(code === 'FILE_INCOMPLETE') {
                body.parts_received = e.parts_received;
                body.total_parts = e.total_parts;
            }
            res.set('Cache-Control', 'no-store');
            return res.status(status).json(body);
        }
    }

    async serveFileRaw(config, actionIndex, res, rangeHeader){
        if(typeof this.db.getMultipartFileRaw === 'function') {
            const multipartFile = await this.db.getMultipartFileRaw(config, actionIndex);
            const refusal = multipart.refusalForMultipart(multipartFile);
            if(refusal) throw refusal;
            if(multipartFile.kind === 'manifest')
                return await this.sendMultipartFileBytes(res, multipartFile, config, rangeHeader);
        }
        const rows = await this.db.getGatedFileRaw(config, actionIndex);
        const raw = rows && rows.length > 0 ? rows[0].raw_data : null;
        const file = raw ? null : await this.db.getFileRaw(config, actionIndex);
        if(!raw && !file)
            return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        if(raw){
            const disposition = await gatedFileDisposition(this.db, config.coin, actionIndex);
            return this.sendGatedFileBytes(res, raw, disposition);
        }
        return this.sendStoredFileBytes(res, file);
    }

    setPlainFilePresentation(res, type){
        type = String(type || '').toLowerCase();
        const valid = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type);
        const inline = valid && (
            ((/^(image|audio|video)\//).test(type) && type !== 'image/svg+xml') ||
            type === 'application/pdf' || type === 'application/json'
        );
        if(inline) {
            res.set('Content-Type', type);
        } else {
            res.set('Content-Type', 'application/octet-stream');
            res.set('Content-Disposition', 'attachment');
        }
    }

    sendMultipartRangeError(res, plan){
        res.set('Content-Range', `bytes */${plan.totalBytes}`);
        res.set('Accept-Ranges', 'bytes');
        res.status(416);
        res.end();
        return res;
    }

    async sendMultipartFileBytes(res, file, config, rangeHeader){
        const preliminaryPlan = multipartStream.planServe(file, rangeHeader);
        await multipartStream.prefetchManifest(this.db, config, file, preliminaryPlan.fromByte || 0);
        const plan = multipartStream.planServe(file, rangeHeader);
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        if(plan.status === 416) return this.sendMultipartRangeError(res, plan);
        if(file.gated) {
            const disposition = file.name ? safeAttachmentFilename(file.name) : null;
            res.set('Content-Type', 'application/octet-stream');
            res.set('X-XChain-Stored-Form', 'encrypted');
            if(disposition) res.set('Content-Disposition', disposition);
        } else if(plan.storedForm) {
            this.setPlainFilePresentation(res, file.type);
        }

        if(plan.storedForm) {
            res.status(plan.status);
            res.set('Accept-Ranges', 'bytes');
            res.set('Content-Length', String(plan.toByte - plan.fromByte + 1));
            if(plan.status === 206)
                res.set('Content-Range', `bytes ${plan.fromByte}-${plan.toByte}/${plan.totalBytes}`);
            await multipartStream.streamParts(this.db, config, file, plan.fromByte, plan.toByte, res);
            res.end();
            return res;
        }

        const inspected = await multipartStream.inspectInflated(this.db, config, file);
        if(res.destroyed) return res;
        if(!inspected.ok) {
            res.set('X-XChain-Stored-Form', 'compressed');
            res.set('X-XChain-Compression-Error', inspected.error);
            res.set('Content-Type', 'application/octet-stream');
            res.set('Content-Disposition', 'attachment');
            res.set('Content-Length', String(file.total_bytes));
            res.set('Accept-Ranges', 'none');
            await multipartStream.streamParts(this.db, config, file, 0, Number(file.total_bytes) - 1, res);
            res.end();
            return res;
        }

        this.setPlainFilePresentation(res, file.type);
        res.set('X-XChain-Compression', 'deflate-raw');
        res.set('X-XChain-Stored-Length', String(file.total_bytes));
        res.set('X-XChain-Original-Length', String(inspected.length));
        res.set('Content-Length', String(inspected.length));
        res.set('Accept-Ranges', 'none');
        if(typeof res.flushHeaders === 'function') res.flushHeaders();
        try {
            await multipartStream.streamInflated(this.db, config, file, res);
        } catch(error) {
            if(typeof res.destroy === 'function') res.destroy(error);
        }
        return res;
    }

    sendGatedFileBytes(res, bytes, disposition){
        res.set('Content-Type', 'application/octet-stream');
        res.set('X-XChain-Stored-Form', 'encrypted');
        if(disposition) res.set('Content-Disposition', disposition);
        return res.send(bytes);
    }

    /**
     * The non-gated half of the FILE route: decide how the stored bytes may be
     * presented, inflate them when the stored form says so, and send.
     *
     * Split out of processFileRawRequest, whose gated half returns before this
     * point; the headers already set there (nosniff, immutable caching) are the
     * caller's, and this adds only what the served form calls for.
     */
    async sendStoredFileBytes(res, file, options = {}){
        // Non-gated: honor the declared MIME type inline only when it is a
        // well-formed, render-safe media type; anything else (html, svg, xml,
        // scripts, unknown) is forced to download as an opaque attachment.
        let type = String(file.type || '').toLowerCase();
        // Transparent decompression (file-compression spec, Part B). COMPRESSION derives
        // from the stored ACTION STRING, never a parsed column (§5.1), and the read is
        // fail-closed: a lying field, a corrupt stream or a tripped 150:1 ratio guard
        // serves the STORED bytes under a header rather than partial output (§5.5).
        let served;
        try {
            served = await compression.resolveServedBytes(file.raw_data, file.data, {
                ...options, fileOrdinal: file.fileOrdinal, fileCount: file.fileCount
            });
        } catch (e) {
            // resolveServedBytes is contractually non-throwing; this is a
            // belt-and-braces guard so a reader bug can never 500 a file route.
            log.warn('FILE_RAW_DECOMPRESSION_GUARD_FAILED', { err: e && e.message ? e.message : e, detail: 'serving stored bytes' });
            served = { bytes: file.raw_data, inflated: false, storedForm: true, error: 'GUARD_FAILURE' };
        }
        if(served.storedForm){
            // The bytes are NOT the original file. Say so explicitly rather than
            // silently handing over deflated garbage the client cannot read.
            res.set('X-XChain-Stored-Form', 'compressed');
            res.set('X-XChain-Compression-Error', String(served.error || 'UNKNOWN'));
            res.set('Content-Type', 'application/octet-stream');
            res.set('Content-Disposition', 'attachment');
            return res.send(served.bytes);
        }
        if(served.inflated){
            // Surface stored vs original size so a client can show the on-chain
            // footprint next to the file size.
            res.set('X-XChain-Compression', 'deflate-raw');
            res.set('X-XChain-Stored-Length', String(served.storedLength));
            res.set('X-XChain-Original-Length', String(served.originalLength));
        }
        this.setPlainFilePresentation(res, type);
        return res.send(served.bytes);
    }
}

module.exports = { methods: FileRoutes.prototype, useHostBindings, safeAttachmentFilename };
