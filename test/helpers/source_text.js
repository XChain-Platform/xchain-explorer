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
    const partTexts = jsFilesUnder(dir).sort().map((file) => fs.readFileSync(file, 'utf8'));
    return [entryText, ...partTexts].join('\n');
}

module.exports = { srcText };
