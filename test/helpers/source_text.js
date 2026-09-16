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
 **********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

const PART_ALIASES = {
    'src/XChainExplorer.js': 'src/explorer',
    'src/api.js': 'src/http/api_boot',
    'src/content/js/xchain.js': 'src/content/js/xchain'
};

// A browser family is read in the order the page LOADS it, which is the order
// template.html lists the family's script tags under this URL prefix, not the
// alphabetical order of the directory. The order matters: a suite that takes
// the first match of a same-shaped literal (the XC.query allowlist in params.js
// against the two-element guards in datatable.js and detail_anchor_price.js)
// gets the one the page defines first, as it did when the family was one file.
// Read from the template rather than a hand list so a family file that joins
// the page joins the text, and one the page does not load fails loudly below
// instead of being read as shipped.
const PAGE_LOADED = {
    'src/content/js/xchain.js': '/js/xchain/'
};
const TEMPLATE = path.join(ROOT, 'src', 'content', 'html', 'template.html');

function pageOrder(prefix){
    const html = fs.readFileSync(TEMPLATE, 'utf8');
    const order = [];
    for(const m of html.matchAll(/<script\b[^>]*\ssrc="([^"]+)"/g))
        if(m[1].startsWith(prefix)) order.push(m[1].slice(prefix.length));
    return order;
}

function jsFilesUnder(dir){
    const files = [];
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })){
        const full = path.join(dir, entry.name);
        if(entry.isDirectory()) files.push(...jsFilesUnder(full));
        else if(entry.isFile() && entry.name.endsWith('.js')) files.push(full);
    }
    return files;
}

function partsDir(entryRel){
    if(PART_ALIASES[entryRel]) return path.join(ROOT, PART_ALIASES[entryRel]);
    return path.join(ROOT, entryRel.slice(0, -path.extname(entryRel).length));
}

function srcText(entryRel){
    const entryText = fs.readFileSync(path.join(ROOT, entryRel), 'utf8');
    const dir = partsDir(entryRel);
    if(!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return entryText;
    const parts = jsFilesUnder(dir).sort();
    if(PAGE_LOADED[entryRel]){
        const prefix = PAGE_LOADED[entryRel];
        const order = pageOrder(prefix);
        const rank = (file) => {
            const rel = path.relative(dir, file).split(path.sep).join('/');
            const i = order.indexOf(rel);
            if(i < 0) throw new Error(entryRel + ' part ' + rel + ' is not loaded by template.html under ' + prefix);
            return i;
        };
        parts.sort((a, b) => rank(a) - rank(b));
    }
    const partTexts = parts.map((file) => fs.readFileSync(file, 'utf8'));
    return [entryText, ...partTexts].join('\n');
}

module.exports = { srcText };
