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
 * XChain Explorer - the one list of file-serving mounts
 *
 * Two surfaces need to agree on "is this request served from disk": the
 * express.static mounts XChainExplorer registers, and the skip predicate the
 * per-IP rate limiter and the global concurrency gate share in api.js. Keeping
 * the list here is what stops them drifting apart.
 *
 * The predicate matches the FIRST PATH SEGMENT against this list, never a file
 * extension. A suffix test describes what a URL looks like, not what serves it,
 * so `/BTC/api/search/needle.png` reads as an image and still routes to the
 * catch-all API handler and its four leading-wildcard COUNT scans - which is
 * how an attacker-chosen suffix bought an unlimited DB-backed query.
 *
 ********************************************************************/

'use strict';

// Directories under src/content/ mounted with express.static, one route each.
const STATIC_DIRECTORIES = [
    'css',
    'fonts',
    'charts',
    'images',
    'json',
    'js',
    // Theme directories: a theme is a folder of static assets under
    // content/themes/<name>/, starting with its tokens.css. Served like any other
    // asset directory, so a skin needs no route of its own and a later composer
    // can resolve names, not paths.
    'themes',
    // Component directories: a component is a folder under
    // content/components/<name>/ holding its template, mount script, stylesheet
    // and declared props. The browser loads the script and the stylesheet
    // directly from here, same as any other asset, so the zero-build ruling
    // holds: nothing bundles these.
    'components'
];

// The mounts the guards exempt. Deliberately NARROWER than the mount list above:
// only the two image mounts a page pulls in a burst are exempt, `/images` from
// express.static and `/icon` from the downloader's own handler. Everything else
// (css, js, fonts, themes, components, fontawesome) counts against both guards,
// which is what ships today - the extension test never matched a .css or a .js -
// so this change only ever REMOVES an exemption and grants no new one. Widening
// it to the whole mount list would take shedding away from paths that have it
// now; that is a deliberate call for whoever wants it, not a side effect here.
const EXEMPT_MOUNTS = ['images', 'icon'];

const EXEMPT_MOUNT_SET = new Set(EXEMPT_MOUNTS);

// True only for a path whose first segment IS one of the exempt mounts. An exact
// segment match rather than a prefix test, so `/imagesXYZ/...` no longer reads as
// `/images`, and a `..` segment anywhere disqualifies the path so a traversal
// attempt cannot borrow a mount's exemption for a deeper route.
function isStaticAssetPath(pathname){
    if(typeof pathname !== 'string' || pathname[0] !== '/') return false;
    const segments = pathname.split('/');
    if(!EXEMPT_MOUNT_SET.has(segments[1])) return false;
    for(let i = 2; i < segments.length; i++)
        if(segments[i] === '..') return false;
    return true;
}

// Express-shaped wrapper: req.path is the pathname with the query string already
// stripped, and is NOT percent-decoded, so an encoded first segment fails the
// match and is limited like any other request (fail closed).
function isStaticAsset(req){
    return isStaticAssetPath(req && req.path);
}

module.exports = { STATIC_DIRECTORIES, EXEMPT_MOUNTS, isStaticAssetPath, isStaticAsset };
