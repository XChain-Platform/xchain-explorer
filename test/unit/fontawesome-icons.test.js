'use strict';

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
 * Font Awesome icon coverage.
 *
 * The explorer self-hosts Font Awesome FREE (the @fortawesome/fontawesome-free
 * npm package, mounted at /fontawesome), so every icon class the UI uses must
 * resolve in the Free build, the shipped v4 compatibility shims, or the local
 * glyphs in content/css/xchain.css. A name that resolves nowhere renders as an
 * empty box on every deployment, silently: nothing 404s and nothing logs. This
 * is also the guard that keeps Pro-only icon names (which render only on a
 * paid CDN kit this codebase no longer uses) from creeping back into templates.
 *
 * Run: npm test
 **********************************************************************/

const { expect } = require('chai');
const fs         = require('fs');
const path       = require('path');

const CONTENT = path.join(__dirname, '..', '..', 'src', 'content');
const FA_DIR  = path.dirname(require.resolve('@fortawesome/fontawesome-free/package.json'));

// Layout/behaviour utility classes: part of Font Awesome's API but not icon
// names, so they have no glyph selector to resolve against.
const STRUCTURAL = new Set([
    'fa-lg', 'fa-xs', 'fa-sm', 'fa-1x', 'fa-2x', 'fa-3x', 'fa-4x', 'fa-5x',
    'fa-fw', 'fa-ul', 'fa-li', 'fa-border', 'fa-pull-left', 'fa-pull-right',
    'fa-spin', 'fa-pulse', 'fa-stack', 'fa-stack-1x', 'fa-stack-2x', 'fa-inverse',
    'fa-rotate-90', 'fa-rotate-180', 'fa-rotate-270',
    'fa-flip-horizontal', 'fa-flip-vertical',
    'fa-solid', 'fa-regular', 'fa-light', 'fa-brands', 'fa-duotone'
]);

// Every .fa-* selector a stylesheet defines (icon glyphs, aliases, shims).
function selectorNames(cssFile){
    const css = fs.readFileSync(cssFile, 'utf8');
    return new Set([...css.matchAll(/\.(fa-[a-z0-9-]+)(?=[:,{\s.])/g)].map(m => m[1]));
}

// Every fa-* token the UI's own markup and scripts use. Vendored third-party
// js is excluded: only files this repo authors can introduce icon names.
function usedNames(){
    const files = fs.readdirSync(path.join(CONTENT, 'html'))
        .filter(f => f.endsWith('.html'))
        .map(f => path.join(CONTENT, 'html', f));
    files.push(path.join(CONTENT, 'js', 'xchain.js'));
    files.push(path.join(CONTENT, 'js', 'xchain-ws.js'));

    const used = new Map();
    for(const file of files){
        const text = fs.readFileSync(file, 'utf8');
        for(const m of text.matchAll(/fa-[a-z0-9-]+/g)){
            if(!used.has(m[0])) used.set(m[0], []);
            const where = used.get(m[0]);
            if(where.length < 3) where.push(path.basename(file));
        }
    }
    return used;
}

describe('Font Awesome icon coverage (self-hosted Free build)', () => {

    const free  = selectorNames(path.join(FA_DIR, 'css', 'all.css'));
    const shims = selectorNames(path.join(FA_DIR, 'css', 'v4-shims.css'));
    const local = selectorNames(path.join(CONTENT, 'css', 'xchain.css'));

    it('ships the stylesheets and webfonts the template links', () => {
        for(const f of ['css/all.min.css', 'css/v4-shims.min.css',
                        'webfonts/fa-solid-900.woff2', 'webfonts/fa-regular-400.woff2',
                        'webfonts/fa-brands-400.woff2', 'webfonts/fa-v4compatibility.woff2'])
            expect(fs.existsSync(path.join(FA_DIR, f)), f).to.equal(true);
    });

    it('links the self-hosted build, not a CDN kit', () => {
        const template = fs.readFileSync(path.join(CONTENT, 'html', 'template.html'), 'utf8');
        expect(template).to.include('/fontawesome/css/all.min.css');
        expect(template).to.include('/fontawesome/css/v4-shims.min.css');
        expect(template).to.not.match(/fontawesome-kit|kit\.fontawesome\.com|ka-[fp]\.fontawesome\.com/);
    });

    it('every icon class the UI uses resolves in Free, the v4 shims, or xchain.css', () => {
        const unresolved = [];
        for(const [name, where] of usedNames()){
            if(STRUCTURAL.has(name)) continue;
            if(free.has(name) || shims.has(name) || local.has(name)) continue;
            // A token ending in '-' is a runtime-composed prefix (xchain.js
            // builds 'fa-xchain-' + coin + '-' + network); it counts as
            // resolved when local selectors exist under that prefix.
            if(name.endsWith('-') && [...local].some(l => l.startsWith(name))) continue;
            unresolved.push(`${name} (${where.join(', ')})`);
        }
        expect(unresolved, 'icon classes with no glyph in the shipped stylesheets:\n  '
            + unresolved.join('\n  ')).to.deep.equal([]);
    });
});
