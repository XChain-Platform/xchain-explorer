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
 * IconResolver
 *
 * Pure description-parsing logic for the icon downloader. Mirrors the
 * priority chain used in content/js/xchain.js so the server-side
 * pipeline picks the same source the asset/token page would.
 *
 * Functions in this file do NOT make network calls; they just classify
 * the description and tell the caller what to fetch (or what inline
 * bytes are already encoded).
 *
 ********************************************************************/

/**
 * Classify a token description into an icon source.
 *
 * Returns an object describing what to fetch (or null if there is
 * nothing fetchable):
 *
 *   { scheme: 'stamp',       data: '<base64 image bytes>' }
 *   { scheme: 'ord',         url:  'https://inscription-decoder.../api/image?...' }
 *   { scheme: 'ipfs',        url:  'https://ipfsc.crystalsuite.com/<hash>' }
 *   { scheme: 'arweave',     url:  'https://arweave.net/<hash>' }    // ar:HASH form
 *   { scheme: 'arweave_url', url:  'https://arweave.net/<hash>' }    // bare https://arweave.net/...
 *   { scheme: 'imgur',       url:  'https://i.imgur.com/<image>' }
 *   { scheme: 'json_url',    url:  'https://.../something.json' }
 *   { scheme: 'image_url',   url:  'https://.../something.png' }
 */
function resolveDescriptionToSource(description){
    if(typeof description !== 'string') return null;
    const desc = description.trim();
    if(desc === '') return null;

    // 1. stamp:base64data: embedded image bytes
    if(/^stamp:/i.test(desc)){
        const b64 = desc.replace(/^stamp:/i, '').trim();
        if(b64 === '') return null;
        // Validate that the base64 actually decodes. Corrupt stamps are
        // unrecoverable, so don't waste retry slots on them.
        if(!/^[A-Za-z0-9+/=_-]+$/.test(b64)) return null;
        try {
            const buf = Buffer.from(b64, 'base64');
            if(buf.length === 0) return null;
        } catch (e){
            return null;
        }
        return { scheme: 'stamp', data: b64 };
    }

    // 2. ord:HASH: Ordinals inscription, resolved via the inscription decoder
    if(/^ord:/i.test(desc)){
        let hash = desc.replace(/^ord:/i, '').trim();
        if(hash === '') return null;
        if(hash.length !== 64){
            // Convert from base64 to hex
            const buf = tryBase64Decode(hash);
            if(buf === null || buf.length === 0) return null;
            hash = buf.toString('hex');
        }
        return { scheme: 'ord', url: 'https://inscription-decoder.vercel.app/api/image?type=json&tx=' + hash };
    }

    // 3. ipfs:HASH or ipfs://HASH: IPFS gateway
    if(/^ipfs:/i.test(desc)){
        const hash = desc.replace(/^ipfs:(\/\/)?/i, '').trim();
        if(hash === '') return null;
        return { scheme: 'ipfs', url: 'https://ipfsc.crystalsuite.com/' + hash };
    }

    // 4. ar:HASH: Arweave gateway
    if(/^ar:/i.test(desc)){
        const hash = desc.replace(/^ar:/i, '').trim();
        if(hash === '') return null;
        return { scheme: 'arweave', url: 'https://arweave.net/' + hash };
    }

    // 5. imgur formats. Accepts:
    //   imgur/<image>[;<title>]
    //   imgur.com/<image>
    //   imgur.com/a/<image>           (album short)
    //   imgur.com/gallery/<image>     (gallery short)
    //   https?://imgur.com/<image>
    //   https?://imgur.com/a/<image>
    //   https?://imgur.com/gallery/<image>
    // Direct image URLs at i.imgur.com (https://i.imgur.com/...) are NOT
    // matched here; they fall through to the bare-image-URL branch.
    if(/^(?:https?:\/\/)?imgur(\.com)?\//i.test(desc)){
        const rest = desc.replace(/^(?:https?:\/\/)?imgur(\.com)?\//i, '');
        let name = rest.split(';')[0].trim();
        // Strip imgur path prefixes that point at album/gallery pages so we
        // end up with the bare image code (the album/gallery code usually IS
        // a valid direct image code on i.imgur.com).
        name = name.replace(/^(?:a|gallery)\//i, '');
        if(name === '') return null;
        return { scheme: 'imgur', url: 'https://i.imgur.com/' + name };
    }

    // 6. Pointers to non-image media: can't generate an icon from these
    if(/^(youtube|soundcloud)\//i.test(desc)) return null;

    // 7. Bare arweave URL: strip the legacy /x.json suffix that no longer works
    if(/^https?:\/\/arweave\.net\//i.test(desc)){
        let url = desc.replace(/^(https?:\/\/arweave\.net\/[^\/?#]+)\/x\.json$/i, '$1');
        url = url.split(';')[0];   // strip ;hash suffix if any
        return { scheme: 'arweave_url', url };
    }

    // 8. URL ending in .json (with optional ";<sha256>" attestation suffix)
    if(/\.json($|;|\?|#)/i.test(desc)){
        let url = desc.split(';')[0];
        if(!/^https?:\/\//i.test(url)) url = 'http://' + url;
        return { scheme: 'json_url', url };
    }

    // 9. Bare image URL: recognized by extension on the path component
    if(/^https?:\/\//i.test(desc)){
        const url  = desc.split(';')[0];
        const path = (() => {
            try { return new URL(url).pathname; } catch (e) { return ''; }
        })();
        const dot = path.lastIndexOf('.');
        const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
        if(['png','jpg','jpeg','gif','webp','svg'].includes(ext)){
            return { scheme: 'image_url', url };
        }
    }

    return null;
}

/**
 * Given a parsed CIP25/TIS-style JSON object, return the best image URL
 * for an icon, or null.
 *
 * Pre-step: any top-level "icon" field (a common typo for "image" in
 * community JSONs) is mapped onto "image" so the normal picker chain
 * handles it.
 *
 * Priority chain (smallest icon-shaped sources first; caller resizes down):
 *   1. images[].data where type=='icon' && size=='48x48'
 *   2. images[].data where type=='icon' (any size)
 *   3. top-level "image"           (CIP25 / post-normalization "icon")
 *   4. images[].data where type=='standard'
 *   5. images[].data where type=='large'
 *   6. top-level "image_large"     (legacy)
 *   7. images[].data where type=='hires'
 *   8. top-level "image_large_hd"  (legacy)
 *   9. first images[].data with anything usable
 *
 * Any returned URL is run through rewriteSchemeUrl() to translate
 * ipfs:// or ar: prefixes to gateway URLs.
 */
function selectIconUrlFromCip25Json(json){
    if(json === null || json === undefined) return null;
    if(typeof json !== 'object') return null;

    // Normalize: map a top-level "icon" onto "image". An explicit "icon" field
    // is more specific than "image" when both exist, so it wins.
    const j = (json.icon) ? Object.assign({}, json, { image: json.icon }) : json;

    const images = Array.isArray(j.images) ? j.images : [];

    // 1. 48x48 icon
    for(const img of images){
        if(!img || typeof img !== 'object') continue;
        if(img.type === 'icon' && img.size === '48x48' && img.data)
            return rewriteSchemeUrl(img.data);
    }
    // 2. Any icon
    for(const img of images){
        if(!img || typeof img !== 'object') continue;
        if(img.type === 'icon' && img.data)
            return rewriteSchemeUrl(img.data);
    }
    // 3. Top-level "image"
    if(j.image) return rewriteSchemeUrl(j.image);
    // 4/5. standard / large in images[]
    for(const t of ['standard','large']){
        for(const img of images){
            if(!img || typeof img !== 'object') continue;
            if(img.type === t && img.data) return rewriteSchemeUrl(img.data);
        }
    }
    // 6. Top-level "image_large"
    if(j.image_large)    return rewriteSchemeUrl(j.image_large);
    // 7. hires in images[]
    for(const img of images){
        if(!img || typeof img !== 'object') continue;
        if(img.type === 'hires' && img.data) return rewriteSchemeUrl(img.data);
    }
    // 8. Top-level "image_large_hd"
    if(j.image_large_hd) return rewriteSchemeUrl(j.image_large_hd);
    // 9. First usable images[] entry
    for(const img of images){
        if(!img || typeof img !== 'object') continue;
        if(img.data) return rewriteSchemeUrl(img.data);
    }

    return null;
}

/**
 * Translate ipfs:// and ar: prefixes (which can appear inside CIP25/TIS
 * image-array data fields) to gateway URLs. Pass-through for plain URLs.
 */
function rewriteSchemeUrl(url){
    if(typeof url !== 'string') return null;
    const u = url.trim();
    if(u === '') return null;

    if(/^ipfs:\/\//i.test(u))
        return 'https://ipfsc.crystalsuite.com/' + u.replace(/^ipfs:\/\//i, '');

    if(/^ipfs:/i.test(u))
        return 'https://ipfsc.crystalsuite.com/' + u.replace(/^ipfs:/i, '');

    if(/^ar:/i.test(u))
        return 'https://arweave.net/' + u.replace(/^ar:/i, '');

    return u;
}

/**
 * Best-effort base64 decode. Returns Buffer on success or null on
 * obvious garbage (length not a multiple of 4 after padding, illegal
 * characters, etc.). Used for ord: descriptions where the hash may be
 * either 64-char hex or base64-encoded raw bytes.
 */
function tryBase64Decode(s){
    if(typeof s !== 'string') return null;
    // Buffer.from with 'base64' silently ignores invalid chars, so do a strict check first
    if(!/^[A-Za-z0-9+/=_-]+$/.test(s)) return null;
    try {
        const buf = Buffer.from(s, 'base64');
        if(buf.length === 0) return null;
        return buf;
    } catch (e){
        return null;
    }
}

module.exports = {
    resolveDescriptionToSource,
    selectIconUrlFromCip25Json,
    rewriteSchemeUrl,
};
