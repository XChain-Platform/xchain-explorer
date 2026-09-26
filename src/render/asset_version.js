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
 * XChain Explorer - versioned asset URLs
 *
 * Pages load their scripts and stylesheets from the static mounts with no
 * version in the URL, and Cloudflare and browsers keep those for max-age=14400,
 * so after a deploy a changed script could be served stale for up to four hours
 * next to the new page that needs it, and a URL the previous release answered
 * 404 stayed 404 at the edge (seen on the develop-1a3010dd deploy).
 *
 * Each same-origin asset URL on a rendered page gets ?v=<first 10 hex of the
 * file's sha1>. A deploy changes the URL of exactly the files that changed, so
 * nothing needs purging and nothing unchanged is refetched. Release directories
 * carry no .git, so the content itself is the version. Hashes are memoized per
 * path for the life of the process: a deploy is a restart, and the files do not
 * change under a running explorer.
 *
 ********************************************************************/

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { STATIC_DIRECTORIES } = require('../http/static_mounts.js');

const CONTENT_ROOT = path.join(__dirname, '..', 'content');

// Every static mount but themes: content/themes/resolve.js swaps the theme's
// tokens.css <link> at send time by matching its bare href exactly, so a
// versioned theme URL would silently stop the swap. The resolver owns those links.
const VERSIONED_MOUNTS = STATIC_DIRECTORIES.filter((m) => m !== 'themes');

// src="/js/x.js" or href="/css/y.css" on one of those mounts, with no query or
// fragment already on it (an author-versioned URL is left as written).
const ASSET_ATTR = new RegExp(
    '\\b(src|href)="/(' + VERSIONED_MOUNTS.join('|') + ')/([^"?#]+\\.(?:js|css))"', 'g');

const memo = new Map();

// The content version of one mount-relative file, or null when it cannot be read
// (a missing file keeps its bare URL and 404s exactly as it did before).
function fileVersion(root, mount, rel){
    const key = root + '|' + mount + '/' + rel;
    if(memo.has(key)) return memo.get(key);
    let version = null;
    if(!rel.split('/').includes('..')){
        try {
            const bytes = fs.readFileSync(path.join(root, mount, rel));
            version = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 10);
        } catch(e){ version = null; }
    }
    memo.set(key, version);
    return version;
}

/**
 * Stamp every static-mount script and stylesheet URL in `html` with its
 * content version.
 *
 * @param {string} html
 * @param {string} [root]   the content directory the mounts live under
 * @returns {string}
 */
function versionAssetUrls(html, root = CONTENT_ROOT){
    if(typeof html !== 'string') return html;
    return html.replace(ASSET_ATTR, (whole, attr, mount, rel) => {
        const version = fileVersion(root, mount, rel);
        return version ? attr + '="/' + mount + '/' + rel + '?v=' + version + '"' : whole;
    });
}

module.exports = { versionAssetUrls };
