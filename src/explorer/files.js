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
    // unvalidated; a miss redirects to the default so a page never renders a 404
    // image.
    async processIconRequest(req, res){
        // '..' because this part sits one directory below the class file the route
        // was written in: the icons still live at src/content/icons.
        const dirPath  = path.resolve(path.join(__dirname, '..', 'content/icons'));
        const filePath = path.resolve(path.join(dirPath, req.path.replace(/^\/icon/, '')));
        if(!filePath.startsWith(dirPath + path.sep))
            return res.status(403).json({ error: 'Access denied', code: 'PATH_DENIED' });
        if(fs.existsSync(filePath)){
            res.sendFile(filePath);
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
        if(!/^[0-9]+$/.test(String(actionIndex)))
            return res.status(400).json({ error: 'Invalid action_index', code: 'INVALID_ACTION_INDEX' });
        if(!this.db.pools || !this.db.pools[coin])
            return res.status(404).json({ error: 'Unknown coin', code: 'UNKNOWN_COIN' });
        let config = { coin, data: {} };
        let raw  = null;
        let file = null;
        try {
            // Token-gated file first; its stored bytes are served untouched.
            let rows = await this.db.getGatedFileRaw(config, actionIndex);
            if(rows && rows.length > 0) raw = rows[0].raw_data;
            // Nothing gated under that index, so fall through to the plain FILE
            // bytes in the decoder database.
            if(!raw)
                file = await this.db.getFileRaw(config, actionIndex);
        } catch (e) {
            log.error('FILE_RAW_REQUEST_FAILED', { err: e && e.message ? e.message : e, stack: e && e.stack });
            return res.status(500).json({ error: 'Server error', code: 'SERVER_ERROR' });
        }
        if(!raw && !file)
            return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
        // Never let the browser sniff a different content type out of the bytes
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        if(raw){
            // Token-gated: ALWAYS serve the stored ciphertext untouched. If the
            // action declares COMPRESSION=1 it means inflate-AFTER-decrypt
            // (per the file-compression spec §5.4), which only the key holder can
            // do; inflating ciphertext here would be nonsense at best.
            res.set('Content-Type', 'application/octet-stream');
            res.set('X-XChain-Stored-Form', 'encrypted');
            let disposition = await gatedFileDisposition(this.db, coin, actionIndex);
            if(disposition) res.set('Content-Disposition', disposition);
            return res.send(raw);
        }
        return this.sendStoredFileBytes(res, file);
    }

    /**
     * The non-gated half of the FILE route: decide how the stored bytes may be
     * presented, inflate them when the stored form says so, and send.
     *
     * Split out of processFileRawRequest, whose gated half returns before this
     * point; the headers already set there (nosniff, immutable caching) are the
     * caller's, and this adds only what the served form calls for.
     */
    async sendStoredFileBytes(res, file){
        // Non-gated: honor the declared MIME type inline only when it is a
        // well-formed, render-safe media type; anything else (html, svg, xml,
        // scripts, unknown) is forced to download as an opaque attachment.
        let type   = String(file.type || '').toLowerCase();
        let valid  = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type);
        let inline = valid && (
            ((/^(image|audio|video)\//).test(type) && type!='image/svg+xml') ||
            type=='application/pdf' ||
            // On-chain TIS documents (DESCRIPTION = action:<index>) are JSON
            // FILEs fetched same-origin by clients. JSON is render-safe:
            // with nosniff set it can't be coerced into a scriptable type.
            type=='application/json'
        );
        // Transparent decompression (file-compression spec, Part B). COMPRESSION derives
        // from the stored ACTION STRING, never a parsed column (§5.1), and the read is
        // fail-closed: a lying field, a corrupt stream or a tripped 150:1 ratio guard
        // serves the STORED bytes under a header rather than partial output (§5.5).
        let served;
        try {
            served = await compression.resolveServedBytes(file.raw_data, file.data);
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
        if(inline){
            res.set('Content-Type', type);
        } else {
            res.set('Content-Type', 'application/octet-stream');
            res.set('Content-Disposition', 'attachment');
        }
        return res.send(served.bytes);
    }
}

module.exports = { methods: FileRoutes.prototype, useHostBindings, safeAttachmentFilename };
