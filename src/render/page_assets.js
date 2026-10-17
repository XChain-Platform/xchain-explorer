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
 * render/page_assets.js
 *
 * The scripts and stylesheets each page loads.
 *
 * template.html lists every asset any page can use, in the order the
 * libraries need. content/layouts/page-assets.json sorts those URLs into
 * named groups and says which groups each page uses; a composed page keeps
 * the template's tags for its groups and loses the rest, so a page that shows
 * no chart does not download or run the chart stack.
 *
 * Every external script is deferred except the short `blocking` list: jQuery,
 * because every page's inline script calls $(document).ready while the parser
 * runs it, and the first-party chain through xchain.js, because jQuery runs
 * ready handlers in the order they were registered and xchain.js must register
 * the one that sets up XC before any page registers its own. Deferred scripts
 * still run in document order, before DOMContentLoaded and so before any ready
 * handler.
 *
 * A page with no entry gets every group: an unlisted page loses speed, never a
 * library.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', 'content', 'layouts', 'page-assets.json');

let cache = null;

// Read once and hold: a static file shipped with the service, consulted on
// every page request.
function load(){
    if(cache) return cache;
    const raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const owner = new Map();
    for(const [name, group] of Object.entries(raw.groups))
        for(const url of group.assets) owner.set(url, name);
    cache = { raw, owner, blocking: new Set(raw.blocking) };
    return cache;
}

// Test seam: drop the cache so a suite can edit the manifest and reload.
function reset(){
    cache = null;
}

/** The group names a page declares, or null when it declares none. */
function declared(file, isListPage){
    const { raw } = load();
    if(isListPage) return raw.listPage;
    return Object.prototype.hasOwnProperty.call(raw.pages, file) ? raw.pages[file] : null;
}

/**
 * Every group a page loads: core, what it declares, and what those require.
 *
 * @param {string}  file        the fragment name the route resolved to
 * @param {boolean} isListPage  true when the page is composed from list-pages.json
 * @returns {Set<string>}
 */
function groupsFor(file, isListPage){
    const { raw } = load();
    const names = declared(file, isListPage);
    if(names === null) return new Set(Object.keys(raw.groups));
    const out = new Set();
    const visit = (name) => {
        if(out.has(name)) return;
        if(!raw.groups[name]) throw new Error('page-assets.json: unknown group ' + JSON.stringify(name));
        out.add(name);
        (raw.groups[name].requires || []).forEach(visit);
    };
    ['core', ...names].forEach(visit);
    return out;
}

/** The asset URLs a page loads. */
function assetsFor(file, isListPage){
    const { raw } = load();
    const out = new Set();
    for(const name of groupsFor(file, isListPage)) raw.groups[name].assets.forEach((url) => out.add(url));
    return out;
}

const SCRIPT_TAG = /([ \t]*)<script\b([^>]*?)\bsrc="([^"?#]+)"([^>]*)>(\s*<\/script>)([ \t]*\r?\n)?/g;
const STYLE_TAG  = /([ \t]*)<link\b[^>]*\brel="stylesheet"[^>]*>([ \t]*\r?\n)?/g;

/**
 * Drop the grouped assets a page does not load and defer its scripts.
 *
 * Only URLs some group owns are ever dropped, so a script a page fragment
 * carries itself (api.html's Swagger bundle) stays, deferred like the rest.
 *
 * @param {string}  html        the composed page
 * @param {string}  file        the fragment name the route resolved to
 * @param {boolean} isListPage  true when the page is composed from list-pages.json
 * @returns {string}
 */
function selectAssets(html, file, isListPage){
    if(typeof html !== 'string') return html;
    const { owner, blocking } = load();
    const keep = assetsFor(file, isListPage);
    const dropped = (url) => owner.has(url) && !keep.has(url);
    return html
        .replace(STYLE_TAG, (tag) => {
            const href = (/\bhref="([^"?#]+)"/.exec(tag) || [])[1];
            return href && dropped(href) ? '' : tag;
        })
        .replace(SCRIPT_TAG, (tag, indent, before, src, after, close, eol) => {
            if(dropped(src)) return '';
            if(blocking.has(src) || /\bdefer\b/.test(before + after)) return tag;
            return indent + '<script' + before + 'src="' + src + '"' + after + ' defer>' + close + (eol || '');
        });
}

module.exports = { groupsFor, assetsFor, selectAssets, declared, reset, MANIFEST };
