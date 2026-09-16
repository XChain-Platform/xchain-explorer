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
 * IconDownloader, fetch path
 *
 * Everything between a resolved icon source and its raw bytes: the per-scheme
 * fetch (with its json_url -> image_url recursion), the `action:` FILE read
 * from the colocated decoder DB, and the egress-policy gate every network
 * fetch passes. IconDownloader's methods of the same names delegate here.
 *
 * Every function takes the downloader instance as `dl` and calls back through
 * it (dl.fetchSourceBytes, dl.httpFetch, ...), so a method replaced on an
 * instance is still the one the recursion reaches. `deps` carries the modules
 * the entry requires (axios, its SAFE_LOOKUP shim, the resolver functions):
 * they are handed in rather than required here so a stub a suite installs on
 * src/icons/downloader.js reaches this code as well.
 *
 ********************************************************************/

const netmod  = require('net');
const { isPrivateAddress } = require('../../http/ssrf_guard');
// The same decompression the live /{COIN}/api/file/{index}/raw route applies
// (XChainExplorer.processFileRawRequest), so an `action:` FILE resolves to the
// identical bytes the token page renders from. Contractually non-throwing: it
// reports storedForm rather than handing back partial output.
const compression = require('../../http/compression.js');


/******************************************************************
 * Resolver-aware fetch. May recurse for json_url -> image_url.
 *
 * `flavor` is the (coin, network, poolKey) pair the row belongs to. Only the
 * `action` scheme needs it, because that scheme's bytes are read from a
 * colocated decoder DB rather than fetched over the network; every other
 * branch ignores it, and it rides through the recursion so a TIS document
 * reached from one flavor resolves its nested refs against the same one.
 *****************************************************************/
async function fetchSourceBytes(dl, src, depth, flavor, deps){
    if(depth < 0) throw new Error('recursion limit hit');

    switch(src.scheme){
        case 'action':
            return await fetchActionSource(dl, src, depth, flavor, deps);

        case 'stamp':
            return decodeStampSource(src);

        case 'ord':
            return await fetchOrdSource(dl, src);

        case 'json_url':
        case 'arweave':
        case 'arweave_url':
        case 'ipfs':
            return await fetchDocumentSource(dl, src, depth, flavor, deps);

        case 'imgur':
        case 'image_url':
        default:
            return await fetchImageSource(dl, src);
    }
}

// action: the FILE bytes from the colocated decoder DB, followed as a document.
async function fetchActionSource(dl, src, depth, flavor, deps){
    const { resolveDescriptionToSource, selectIconUrlFromCip25Json } = deps;
    const bytes = await dl.fetchActionFileBytes(src, flavor);
    // An on-chain TIS document, or the image itself. Same order the
    // json_url branch below uses: try JSON, fall back to raw bytes and
    // let writeIcon sniff the type out of them.
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
        return await dl.fetchSourceBytes(next, depth - 1, flavor);
    }
    return bytes;
}

// stamp: the image bytes are inline in the description.
function decodeStampSource(src){
    const buf = Buffer.from(src.data, 'base64');
    if(!buf.length) throw new Error('stamp: empty after base64 decode');
    return buf;
}

// ord: the inscription decoder answers JSON carrying a base64 data URL.
async function fetchOrdSource(dl, src){
    const resp = await dl.httpFetch(src.url);
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

// json_url / arweave / arweave_url / ipfs: a document or a direct image.
async function fetchDocumentSource(dl, src, depth, flavor, deps){
    const { resolveDescriptionToSource, selectIconUrlFromCip25Json } = deps;
    // Could be JSON (CIP25/TIS) or a direct image. Don't trust
    // the Content-Type header (IPFS gateways routinely serve
    // content as text/plain regardless of the actual bytes).
    const resp = await dl.httpFetch(src.url);

    // Try JSON parse first
    let json = null;
    try { json = JSON.parse(resp.body.toString('utf8')); } catch (e) {}
    if(json && typeof json === 'object'){
        const picked = selectIconUrlFromCip25Json(json);
        if(!picked) throw new Error(`${src.scheme}: JSON has no usable image`);
        let next = resolveDescriptionToSource(picked);
        if(!next) next = { scheme: 'image_url', url: picked };
        return await dl.fetchSourceBytes(next, depth - 1, flavor);
    }

    // Not JSON: return raw bytes; writeIcon sniffs MIME from
    // the bytes themselves and rejects anything that isn't an
    // allowed image type.
    return resp.body;
}

// imgur / image_url / anything else: a direct image URL.
async function fetchImageSource(dl, src){
    const resp = await dl.httpFetch(src.url);
    const mime = (resp.mime || '').toLowerCase();
    if(!mime.startsWith('image/'))
        throw new Error(`${src.scheme}: not an image (got '${mime}')`);
    return resp.body;
}

/******************************************************************
 * Read an `action:` FILE's bytes from the colocated decoder DB.
 *
 * This is the one source in the pipeline that opens no socket: the bytes are
 * the ones the token page fetches same-origin from
 * /{COIN}/api/file/{index}/raw, and this reads them the way that route does
 * (getGatedFileRaw first, then getFileRaw, then resolveServedBytes). No
 * network means no SSRF surface, so rejectPrivateLiteral has nothing to
 * relax.
 *
 * EVERY failure here THROWS, deliberately. The caller turns a throw into
 * markFailure, which retries with backoff; the alternative shape - answering
 * "no source" - lands in markOk and is TERMINAL until the (usually
 * description-locked) description changes. A decoder DB that is briefly
 * unreachable, or a FILE this node has not indexed yet, must not permanently
 * mark a token icon-less, and getFileRaw answers null for a miss and for an
 * unreachable decoder DB alike, so a null can never be read as a verdict.
 *****************************************************************/
async function fetchActionFileBytes(dl, src, flavor){
    if(!flavor || !flavor.poolKey)
        throw new Error('action: no flavor context to resolve the FILE against');
    const db = dl.explorer && dl.explorer.db;
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
function rejectPrivateLiteral(rawUrl){
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

// The GET behind every network scheme: the egress gate first, then a bounded
// axios fetch whose lookup and redirect hooks re-apply that gate.
async function httpFetch(dl, url, deps){
    const { axios, SAFE_LOOKUP } = deps;
    dl.rejectPrivateLiteral(url);
    let resp;
    try {
        resp = await axios.get(url, {
            responseType:     'arraybuffer',
            timeout:          dl.cfg.fetchTimeoutMs,
            maxContentLength: dl.cfg.maxBytes,
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
            beforeRedirect:   (options) => { dl.rejectPrivateLiteral(options.href || (options.protocol + '//' + options.hostname)); },
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

module.exports = { fetchSourceBytes, fetchActionFileBytes, rejectPrivateLiteral, httpFetch };
