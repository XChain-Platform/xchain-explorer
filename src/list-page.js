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
 * list-page.js
 *
 * The shared list-page composition (spec M2.3). 75 near-identical page
 * fragments used to differ only in an icon, a heading, a column set and three
 * SEO strings; they are now 75 entries in content/layouts/list-pages.json,
 * stitched here into content/layouts/list-page.html.
 *
 * The composition is string substitution, the same dialect the shell already
 * uses for {CONTENT} - by ruling, nothing about this milestone introduces a
 * build step or a template engine.
 *
 * Two things are deliberate.
 *
 * The MARKUP this emits is byte-identical to the fragment it replaced, and a
 * unit test holds it to that against a committed copy of every original. That
 * is the only claim worth making about a refactor of 75 live pages: not that it
 * looks right, but that the bytes did not move.
 *
 * The page's behaviour ships as a MOUNT MANIFEST - a JSON block naming the
 * component and its props - rather than as the inline loadDatatablesData call
 * the fragments carried. The manifest is data, so a theme can rewrite the
 * column set without the page emitting different code, and the CSP does not
 * have to be widened for it.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const COLUMNS = require('./content/components/data-table/columns.js');

const LAYOUT_DIR   = path.join(__dirname, 'content', 'layouts');
const LAYOUT_FILE  = path.join(LAYOUT_DIR, 'list-page.html');
const PAGES_FILE   = path.join(LAYOUT_DIR, 'list-pages.json');
const COMPONENT_TEMPLATE = path.join(__dirname, 'content', 'components', 'data-table', 'template.html');

let cache = null;

// Read once and hold. These are static files shipped with the service, and the
// composer is on the request path for every list route.
function load(){
    if(cache) return cache;
    cache = {
        layout:    fs.readFileSync(LAYOUT_FILE, 'utf8'),
        component: fs.readFileSync(COMPONENT_TEMPLATE, 'utf8'),
        pages:     JSON.parse(fs.readFileSync(PAGES_FILE, 'utf8'))
    };
    return cache;
}

// Test seam: drop the cache so a suite can edit a layout and recompose.
function reset(){
    cache = null;
}

/** Every fragment name this composer answers for. */
function pages(){
    return Object.keys(load().pages).sort();
}

/** The config behind one fragment name, or null when the route is not collapsed. */
function config(file){
    const p = load().pages;
    return Object.prototype.hasOwnProperty.call(p, file) ? p[file] : null;
}

function has(file){
    return config(file) !== null;
}

// A JS string literal safe to drop into an inline <script>. JSON.stringify
// handles quoting and control characters; the two extra replacements close the
// only holes that matter inside a script element: a literal "</script>" ends the
// element early, and "<!--" opens an HTML comment the parser then swallows.
// These are repo-owned static strings today, so this is defence in depth rather
// than a live exposure - but a composer that is only safe for its current inputs
// is a trap for whoever adds the next page.
function jsString(value){
    return JSON.stringify(String(value === undefined || value === null ? '' : value))
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e');
}

// The manifest lands inside <script type="application/json">, where the same
// "</script>" hazard applies and nothing else does: the browser parses it as
// text and JSON.parse reads it back.
function jsonBlock(value){
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/** The data-table card markup for one config, at the indentation the page needs. */
function renderCard(cfg){
    return load().component
        .replace('{ICON}',        () => cfg.icon)
        .replace('{HEADING}',     () => cfg.heading)
        .replace('{TABLE}',       () => COLUMNS.renderTable({
            tableClass: cfg.tableClass,
            action:     cfg.action,
            columns:    cfg.columns,
            loading:    cfg.loading
        }))
        // The component template ends with a newline; the layout supplies the
        // one after {CARD}, so drop it rather than emit a blank line the
        // original fragments did not have.
        .replace(/\n$/, '');
}

/** The mount manifest: what the runtime is asked to put on this page. */
function manifest(cfg){
    const props = {
        action:     cfg.action,
        columns:    cfg.columns,
        tableClass: cfg.tableClass,
        loading:    cfg.loading
    };
    if(cfg.query !== undefined) props.query = cfg.query;
    if(cfg.type  !== undefined) props.type  = cfg.type;
    return [{ el: 'datatable-' + cfg.action, component: 'data-table', props }];
}

/**
 * Compose one list page.
 *
 * @param {string} file  the fragment name the url table still points at
 * @returns {string|null} page markup, or null when this route is not collapsed
 */
function render(file){
    const cfg = config(file);
    if(!cfg) return null;
    const d = cfg.pageInfo.description;
    const description = jsString(d[0]) + ' + XC.name + ' + jsString(d[1])
        + ' + XC.network + ' + jsString(d[2]);
    // Replacement FUNCTIONS throughout, for the reason the shell already
    // documents: $-sequences in a replacement string are read as capture-group
    // references, and several descriptions and headings contain them.
    return load().layout
        .replace('{COMMENT}',     () => cfg.comment)
        .replace('{CARD}',        () => renderCard(cfg))
        .replace('{MANIFEST}',    () => jsonBlock(manifest(cfg)))
        .replace('{TITLE}',       () => jsString(cfg.pageInfo.title))
        .replace('{DESCRIPTION}', () => description)
        .replace('{CANONICAL}',   () => jsString(cfg.pageInfo.canonical));
}

/**
 * Splice layout data files into a fragment.
 *
 * A page writes {DATA:<name>} where it wants the contents of
 * content/layouts/<name>.json, and reads it back from the JSON block with
 * JSON.parse. This exists so a page whose behaviour is driven by a layout file
 * does not have to fetch that file over HTTP on every view: action.html needs
 * the 38 per-type detail-card row configs before it can mount anything, and a
 * second request for them would be a render-blocking round trip on the busiest
 * detail page in the explorer.
 *
 * `name` is matched against a strict character class and resolved back under
 * the layouts directory before it is read, so a page cannot name a path.
 */
function dataBlocks(html){
    if(typeof html !== 'string' || html.indexOf('{DATA:') === -1) return html;
    return html.replace(/\{DATA:([a-z0-9-]+)\}/g, (whole, name) => {
        const file = path.join(LAYOUT_DIR, name + '.json');
        if(!path.resolve(file).startsWith(path.resolve(LAYOUT_DIR) + path.sep)){
            console.error('list-page: layout data name escapes the layouts directory: ' + name);
            return '{}';
        }
        let raw;
        try {
            raw = fs.readFileSync(file, 'utf8');
        } catch(e){
            // Loud, and the page gets an empty object rather than the literal
            // placeholder: a page that renders "{DATA:foo}" to a visitor is a
            // worse failure than one whose optional config came back empty.
            console.error('list-page: no layout data file for ' + name + ' (' + e.message + ')');
            return '{}';
        }
        return raw.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').trim();
    });
}

module.exports = { has, config, pages, render, renderCard, manifest, dataBlocks, reset };
