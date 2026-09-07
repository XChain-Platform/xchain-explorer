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
 * component-templates.js
 *
 * Server-side rendering of a component's template.html (spec M2.4).
 *
 * The page shell used to carry its own chrome: a 24KB mega-menu, a search
 * form, a theme switcher and a footer, all inline in template.html. Those are
 * four components now, and the shell holds {NAV} and {FOOTER} where they were.
 * The point is not tidiness. A theme replaces a component by shipping its own
 * template.html under the theme directory, and it can only do that for markup
 * that lives in a component to begin with - chrome inlined in the shell was
 * exactly the markup a second theme most needs to replace (the M5 ruling
 * replaces the mega-menu with a sidebar).
 *
 * Composition is the same string substitution the shell already used for
 * {CONTENT}, and the composed output is byte-identical to the inline version -
 * held there by a test against a committed copy of the pre-extraction shell.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const COMPONENT_DIR = path.join(__dirname, 'content', 'components');

// Component templates are static files read once per process.
const cache = new Map();

function reset(){
    cache.clear();
}

/** Raw template.html for one component. */
function template(name){
    if(cache.has(name)) return cache.get(name);
    const file = path.join(COMPONENT_DIR, name, 'template.html');
    // Resolved and re-checked rather than trusted: `name` is a repo-owned
    // constant today, and this keeps it one even if a caller ever passes a
    // route-derived value.
    if(!path.resolve(file).startsWith(path.resolve(COMPONENT_DIR) + path.sep))
        throw new Error('component name escapes the component directory: ' + name);
    const raw = fs.readFileSync(file, 'utf8');
    cache.set(name, raw);
    return raw;
}

/**
 * Render one component template, substituting {SLOT} placeholders.
 *
 * split/join rather than String.replace: a replacement STRING reads $-sequences
 * ($&, $1, $') as capture-group references, and the markup passing through here
 * contains them. join() has no such dialect, so what goes in is what comes out.
 */
function render(name, slots){
    let out = template(name);
    // Trailing newline is the file's, not the markup's: the shell supplies the
    // line break at its slot.
    out = out.replace(/\n$/, '');
    for(const key of Object.keys(slots || {}))
        out = out.split('{' + key + '}').join(slots[key]);
    return out;
}

/**
 * Fill the page shell's chrome slots.
 *
 * nav nests search-box and theme-toggle, so those render first; {PLATFORM_SWITCHER}
 * is left alone here because the shell fills it from platform_links.js.
 */
function chrome(html){
    const nav = render('nav', {
        SEARCH_BOX:   render('search-box', {}),
        THEME_TOGGLE: render('theme-toggle', {})
    });
    return html
        .replace('{NAV}',    () => nav)
        .replace('{FOOTER}', () => render('footer', {}));
}

module.exports = { template, render, chrome, reset };
