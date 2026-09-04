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

// The one IPFS gateway this service resolves ipfs: through, root-addressed
// (`<gateway><hash>`, no /ipfs/ path segment). Held as a constant because the
// page must agree with it: content/js/xchain.js resolves ipfs: descriptions and
// rewrites ipfs:// image entries against the SAME gateway, and a page pointed at
// a different one renders an icon the downloader failed to fetch, or backs the
// icons row off to permanently-failed while the page renders fine. Changing the
// gateway is a two-file change, here and there.
const IPFS_GATEWAY = 'https://ipfsc.crystalsuite.com/';

// The `action:` on-chain TIS reference grammar, written once in a dialect both
// consumers read: this file compiles it as a JS regex, and the icon worker embeds
// the same source text in a SQL REGEXP (the one-shot re-stale in
// IconDownloader._discover). Plain capture groups rather than `(?:`, so the one
// string is legal to both engines; the language it matches is exactly the page's
// actionRefToRawPath regex.
//
// Shared rather than copied because the two have to agree or the worker LOOPS: a
// re-stale predicate wider than this grammar (a bare `LIKE 'action:%'`) selects
// rows whose description resolves to no source at all, and those land straight
// back on _processToken's terminal ok-with-no-icon state, to be re-staled again
// on the next cycle, forever (#5290).
//
// CASE IS SPELT OUT, never delegated to a case-folding operator on either side,
// and that is the load-bearing property. The obvious spelling - a lower-case
// pattern read by JS under /i and by SQL under LOWER() - silently makes the two
// engines accept DIFFERENT languages, because /i and LOWER() are different
// functions. JS's non-unicode /i canonicalises via toUpperCase and leaves U+0130
// (LATIN CAPITAL LETTER I WITH DOT ABOVE) alone, while MariaDB's utf8mb4 LOWER()
// applies the Unicode simple mapping and folds U+0130 to plain 'i'. So `ACTİON:12`
// resolved to null here and MATCHED there: selected for re-stale, resolvable by
// nobody, re-staled forever, and mintable by anyone, since token descriptions are
// attacker-controlled on-chain data. Swept on MariaDB 10.11 and 11.4 against a
// real utf8mb4 column, U+0130 is the ONLY codepoint in all of Unicode whose
// LOWER() output is one of this grammar's letters (#5290).
//
// With the classes explicit there is no folding operator left to disagree about:
// no /i here, and the worker matches under CONVERT(... USING binary) so the SQL
// side is ASCII-exact too. Adding a letter to this pattern means adding BOTH its
// cases; a bare letter would silently become case-sensitive on both sides.
const ACTION_REF_PATTERN =
    '^[Aa][Cc][Tt][Ii][Oo][Nn]:(([Bb][Tt][Cc]|[Ll][Tt][Cc]|[Dd][Oo][Gg][Ee]):)?([0-9]+)$';
const ACTION_REF_RE      = new RegExp(ACTION_REF_PATTERN);

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
 *   { scheme: 'action', coin: 'BTC'|null, index: '<action_index>' }
 *
 * The `action` descriptor is the odd one out: it carries no URL, because the
 * bytes are not on the network at all. They are the FILE action's stored bytes in
 * the colocated decoder DB, the same bytes the token page fetches same-origin
 * from /{COIN}/api/file/{index}/raw. The caller reads them (IconDownloader), not
 * this classifier, which still makes no calls of any kind.
 */
function resolveDescriptionToSource(description){
    if(typeof description !== 'string') return null;
    const desc = description.trim();
    if(desc === '') return null;

    // 0. action:<index> / action:<COIN>:<index>: an on-chain TIS document, the
    // format the platform's own Token_Information_Standard promotes. The token
    // page resolves it live (actionRefToRawPath in content/js/xchain.js), and this
    // file's whole contract is to pick the source that page would, so it has to
    // match the page's regex exactly: same three sibling tickers, same digits-only
    // index, and the sibling coin's network tier supplied by the caller (which
    // knows the flavor) rather than guessed here. Placed FIRST because it is an
    // exact-form match, so no later branch can shadow it. ACTION_REF_RE is the
    // shared grammar the icon worker's re-stale predicate also compiles, so the
    // two can never disagree about what "an action: description" is.
    const act = ACTION_REF_RE.exec(desc);
    if(act)
        return { scheme: 'action', coin: act[2] ? act[2].toUpperCase() : null, index: act[3] };

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
        return { scheme: 'ipfs', url: IPFS_GATEWAY + hash };
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
        // Force https, matching the json branch in content/js/xchain.js, which builds
        // this lane as 'https://' + desc-without-scheme and has no http path at all
        // (its /relay? retry reuses the same https URL). Keeping http made the page
        // and the downloader fetch two different documents for one description, and
        // drove https-only origins to a permanent `failed` icon row for a token whose
        // page renders fine. http-only JSON origins now fail on both sides rather
        // than disagreeing.
        url = 'https://' + url.replace(/^https?:\/\//i, '');
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
 * Priority chain (icon-shaped sources first; caller resizes down). Steps 1-3
 * are the token page's own order (content/js/xchain.js), which this must match
 * or the cached listing icon and the page disagree for a token carrying both
 * sizes. 64x64 leads on both sides because the downloader renders at 64px, so
 * preferring the 48x48 would upscale past a native-size source that is present:
 *   1. images[].data where type=='icon' && size=='64x64'
 *   2. images[].data where type=='icon' && size=='48x48'
 *   3. images[].data where type=='icon' (any size)
 *   4. top-level "image"           (CIP25 / post-normalization "icon")
 *   5. images[].data where type=='standard'
 *   6. images[].data where type=='large'
 *   7. top-level "image_large"     (legacy)
 *   8. images[].data where type=='hires'
 *   9. top-level "image_large_hd"  (legacy)
 *  10. first images[].data with anything usable
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

    // TIS `data_ref` takes precedence over `data` on the same entry ONLY when it is a
    // real action reference, which is what the page does: resolveTisDataRefs
    // (content/js/xchain.js) overwrites `data` only when actionRefToRawPath RESOLVES
    // the ref, and that returns false for anything outside the action: grammar. The
    // spec agrees (token-information-standard.md: data_ref is a reference to an
    // on-chain FILE action by ACTION_INDEX), so a URL-shaped or garbage data_ref is not
    // a ref at all and must leave `data` alone. TIS documents are attacker-supplied
    // on-chain bytes: substituting any non-empty string let a minted token make this
    // downloader cache a different image than the page renders, or drive the row to a
    // permanent `failed` on an unfetchable ref while the page rendered fine.
    // ACTION_REF_RE spells its case classes out rather than using /i (#5290), which is
    // ASCII-exact and therefore equivalent to the page's /i regex over this alphabet.
    // Applied to every JSON lane, not just the action: one, because the page applies it
    // to every TIS document it fetches however it reached it.
    const images = (Array.isArray(j.images) ? j.images : []).map(img => {
        if(!img || typeof img !== 'object') return img;
        if(typeof img.data_ref !== 'string') return img;
        const ref = img.data_ref.trim();
        if(ref === '' || !ACTION_REF_RE.test(ref)) return img;
        return Object.assign({}, img, { data: ref });
    });

    // 1. 64x64 icon (what the page takes first, and the size we render at)
    for(const img of images){
        if(!img || typeof img !== 'object') continue;
        if(img.type === 'icon' && img.size === '64x64' && img.data)
            return rewriteSchemeUrl(img.data);
    }
    // 2. 48x48 icon
    for(const img of images){
        if(!img || typeof img !== 'object') continue;
        if(img.type === 'icon' && img.size === '48x48' && img.data)
            return rewriteSchemeUrl(img.data);
    }
    // 3. Any icon
    for(const img of images){
        if(!img || typeof img !== 'object') continue;
        if(img.type === 'icon' && img.data)
            return rewriteSchemeUrl(img.data);
    }
    // 4. Top-level "image"
    if(j.image) return rewriteSchemeUrl(j.image);
    // 5/6. standard / large in images[]
    for(const t of ['standard','large']){
        for(const img of images){
            if(!img || typeof img !== 'object') continue;
            if(img.type === t && img.data) return rewriteSchemeUrl(img.data);
        }
    }
    // 7. Top-level "image_large"
    if(j.image_large)    return rewriteSchemeUrl(j.image_large);
    // 8. hires in images[]
    for(const img of images){
        if(!img || typeof img !== 'object') continue;
        if(img.type === 'hires' && img.data) return rewriteSchemeUrl(img.data);
    }
    // 9. Top-level "image_large_hd"
    if(j.image_large_hd) return rewriteSchemeUrl(j.image_large_hd);
    // 10. First usable images[] entry
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
        return IPFS_GATEWAY + u.replace(/^ipfs:\/\//i, '');

    if(/^ipfs:/i.test(u))
        return IPFS_GATEWAY + u.replace(/^ipfs:/i, '');

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
    ACTION_REF_PATTERN,
};
