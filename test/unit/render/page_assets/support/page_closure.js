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
 * Which scripts a page's code reaches.
 *
 * Starting from a page's inline scripts, follow every global it reads to the
 * script that declares it, then that declaration's own reads, until nothing new
 * turns up. A script on the path also brings its load-time reads. Vendored
 * libraries are not parsed: the table below says what each one provides.
 *********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { scanScript } = require('./global_scan.js');

const CONTENT = path.join(__dirname, '..', '..', '..', '..', '..', 'src', 'content');

// Vendored libraries by mount path: the globals, plugin methods and DOM
// attributes each provides, the files that must come with it, and the globals
// it reads while it loads (a jQuery plugin needs jQuery already there).
const JQ = ['id:jQuery'];
const LIBRARIES = {
    '/js/jquery.min.js':               { provides: ['id:$', 'id:jQuery'] },
    '/js/bootstrap.bundle.min.js':     { provides: ['id:bootstrap'] },
    '/js/jquery.dataTables.js':        { provides: ['.DataTable', '.dataTable'], needs: JQ },
    '/js/moment.min.js':               { provides: ['id:moment'] },
    '/js/livestamp.min.js':            { provides: ['.livestamp', '@data-livestamp'], with: ['/js/moment.min.js'],
                                         needs: ['id:jQuery', 'id:moment'] },
    '/js/numeral.js':                  { provides: ['id:numeral'] },
    '/js/math.min.js':                 { provides: ['id:math'] },
    '/js/chart.umd.js':                { provides: ['id:Chart'],
                                         with: ['/js/chartjs-adapter-moment.js', '/js/chartjs-chart-financial.js', '/js/moment.min.js'] },
    '/js/chartjs-adapter-moment.js':   { provides: [], needs: ['id:Chart', 'id:moment'] },
    '/js/chartjs-chart-financial.js':  { provides: [], needs: ['id:Chart'] },
    '/js/jquery.qrcode.min.js':        { provides: ['.qrcode'], needs: JQ },
    '/js/throttle-debounce-fn.min.js': { provides: ['.throttle', '.debounce'], needs: JQ },
    '/js/highlight.min.js':            { provides: ['id:hljs'] },
    '/js/swagger-ui-bundle.js':        { provides: ['id:SwaggerUIBundle'] },
    '/js/swagger-ui-standalone-preset.js': { provides: ['id:SwaggerUIStandalonePreset'] }
};

// Dual-mode files read these behind a Node check; no browser script declares them.
const NODE_NAMES = ['module', 'require', 'exports', 'process', 'global', '__dirname'];

let builtinCache = null;
function builtins(){
    if(builtinCache) return builtinCache;
    const names = new Set(NODE_NAMES);
    const { window } = new JSDOM('');
    for(let o = window; o; o = Object.getPrototypeOf(o))
        Object.getOwnPropertyNames(o).forEach((n) => names.add(n));
    Object.getOwnPropertyNames(globalThis).forEach((n) => names.add(n));
    window.close();
    builtinCache = names;
    return names;
}

const scanCache = new Map();
function scanFile(url){
    if(scanCache.has(url)) return scanCache.get(url);
    const scan = scanScript(fs.readFileSync(path.join(CONTENT, url), 'utf8'));
    scanCache.set(url, scan);
    return scan;
}

/**
 * Index every provider of every token across `urls`. A global several files
 * declare is a registry each one adds to (the datatable row handlers) or a
 * fallback a later file replaces, so a reader of it needs all of them.
 */
function providerIndex(urls){
    const index = new Map();
    for(const url of urls){
        const lib = LIBRARIES[url];
        const tokens = lib ? lib.provides : [...scanFile(url).provides.keys()].map((n) => 'id:' + n);
        // A component registers under its directory name.
        const component = /^\/components\/([a-z-]+)\/init\.js$/.exec(url);
        if(component) tokens.push('component:' + component[1]);
        for(const t of tokens){
            if(!index.has(t)) index.set(t, []);
            index.get(t).push(url);
        }
    }
    return index;
}

/**
 * Close over the scripts `roots` reaches.
 *
 * @param {Set<string>} roots       tokens the page's own code reads
 * @param {string[]}    rootFiles   scripts the page always runs whole
 * @param {string[]}    universe    every script that may provide a token, in order
 * @param {Set<string>} [local]     tokens the page's inline scripts declare
 * @returns {{ files: Map<string, string>, unresolved: Set<string> }}
 *   files: each script reached, with the read that first reached it;
 *   via: each token read, with the declaration that read it
 */
function closure(roots, rootFiles, universe, local = new Set()){
    const index = providerIndex(universe);
    const known = builtins();
    const files = new Map();
    const seen = new Map();
    const unresolved = new Set();
    const queue = [...roots].map((t) => [t, 'page']);
    const addFile = (url, why) => {
        if(files.has(url)) return;
        files.set(url, why);
        const lib = LIBRARIES[url];
        if(lib){ (lib.with || []).forEach((w) => addFile(w, url)); return; }
        scanFile(url).load.forEach((t) => queue.push([t, url + ' (load)']));
    };
    rootFiles.forEach((url) => {
        addFile(url, 'root');
        if(LIBRARIES[url]) return;
        for(const [name, body] of scanFile(url).provides)
            body.forEach((t) => queue.push([t, url + ' ' + name]));
    });
    while(queue.length){
        const [token, from] = queue.pop();
        if(seen.has(token)) continue;
        seen.set(token, from);
        const urls = index.get(token);
        if(!urls && local.has(token)) continue;
        if(!urls){
            if(!(token.startsWith('id:') && known.has(token.slice(3)))) unresolved.add(token);
            continue;
        }
        for(const url of urls){
            addFile(url, token + ' <- ' + from);
            if(LIBRARIES[url] || !token.startsWith('id:')) continue;
            const body = scanFile(url).provides.get(token.slice(3));
            if(body) body.forEach((t) => queue.push([t, url + ' ' + token.slice(3)]));
        }
    }
    return { files, unresolved, via: seen };
}

// The components a mount manifest block names.
function manifestComponents(json, out){
    let entries = [];
    try { entries = JSON.parse(json); } catch(e){ entries = []; }
    for(const entry of Array.isArray(entries) ? entries : [])
        if(entry && typeof entry.component === 'string') out.add('component:' + entry.component);
}

/**
 * What a block of page markup's inline scripts read and declare.
 *
 * @returns {{ reads: Set<string>, declares: Set<string>, scripts: Array<{ parse: Set<string>, declares: Set<string> }> }}
 *   reads: every token the inline code reads, mount manifests included;
 *   scripts: per inline script in document order, what it reads while the
 *            parser runs it and what it declares.
 */
function inlineCode(html){
    const out = new Set();
    const local = new Set();
    const scripts = [];
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
    let m;
    while((m = re.exec(html))){
        if(/\bsrc=/.test(m[1])) continue;
        if(/application\/json/.test(m[1])){ manifestComponents(m[2], out); continue; }
        // Server-side slots ({TITLE}, {DATA:name}) hold literals by send time.
        const scan = scanScript(m[2].replace(/\{[A-Z][A-Z_]*(?::[a-z0-9-]+)?\}/g, '0'));
        scan.load.forEach((t) => out.add(t));
        const declares = new Set([...scan.provides.keys()].map((n) => 'id:' + n));
        for(const [name, body] of scan.provides){
            local.add('id:' + name);
            body.forEach((t) => out.add(t));
        }
        scripts.push({ parse: scan.parse, declares });
    }
    // A page's own declarations are not globals another script must provide.
    local.forEach((t) => out.delete(t));
    return { reads: out, declares: local, scripts };
}

/** The src of every external script tag in a block of markup, in order, without ?v=. */
function scriptSrcs(html){
    return [...html.matchAll(/<script\b[^>]*\bsrc="([^"?#]+)[^"]*"[^>]*>/g)].map((m) => m[1]);
}

/** The href of every stylesheet link in a block of markup, in order, without ?v=. */
function styleHrefs(html){
    return [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)]
        .map((m) => (m[0].match(/href="([^"?#]+)/) || [])[1]).filter(Boolean);
}

module.exports = { LIBRARIES, closure, inlineCode, scriptSrcs, styleHrefs, scanFile, CONTENT };
