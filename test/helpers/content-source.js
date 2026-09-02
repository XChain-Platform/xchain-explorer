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
 * Where a suite gets the SHIPPED client source and the SHIPPED page markup,
 * now that neither is one file on disk any more.
 *
 * Two things moved in the component milestone and both broke the same
 * assumption. The cell-rendering helpers left xchain.js for formatters.js, so
 * a suite that slices a function out of "the client source" has to read both.
 * And 76 list pages stopped having a fragment of their own, so a suite that
 * asserts on "the page" has to ask the composer for it rather than the
 * filesystem.
 *
 * Both are answered here rather than in each suite, because the alternative -
 * every suite knowing which of two files a helper ended up in, and which of two
 * places a page comes from - is exactly the knowledge that goes stale.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..', '..');
const HTML_DIR = path.join(ROOT, 'src', 'content', 'html');
const JS_DIR   = path.join(ROOT, 'src', 'content', 'js');

const listPage     = require(path.join(ROOT, 'src', 'list-page.js'));
const componentTpl = require(path.join(ROOT, 'src', 'component-templates.js'));

/**
 * The client source a suite slices shipped functions out of: formatters.js
 * first, then xchain.js, joined exactly as the browser loads them.
 */
function clientSource(){
    return fs.readFileSync(path.join(JS_DIR, 'formatters.js'), 'utf8')
        + '\n'
        + fs.readFileSync(path.join(JS_DIR, 'xchain.js'), 'utf8');
}

/** Just the formatter module, for a suite that wants only the helpers. */
function formatterSource(){
    return fs.readFileSync(path.join(JS_DIR, 'formatters.js'), 'utf8');
}

/**
 * The markup a route serves, whether it comes from a fragment or the composer.
 *
 * @param {string} name  fragment name as the url table still spells it
 */
function pageSource(name){
    const composed = listPage.render(name);
    if(composed !== null) return composed;
    return fs.readFileSync(path.join(HTML_DIR, name), 'utf8');
}

/** True when a route is served by the shared list-page composition. */
function isComposed(name){
    return listPage.has(name);
}

/**
 * The page shell with its chrome filled in - what a browser actually receives,
 * rather than the slot-carrying template on disk. A suite asserting that a nav
 * link exists wants this one.
 */
function shellSource(){
    return componentTpl.chrome(fs.readFileSync(path.join(HTML_DIR, 'template.html'), 'utf8'));
}

/**
 * The action a list page loads.
 *
 * A fragment names it in an inline loadDatatablesData call; a composed page
 * names it in its mount manifest, because the call itself is now the
 * data-table component's business. Both are the page saying which feed it
 * shows, so a suite asserting on that should not have to care which form it
 * is in - which is the whole reason this lives here.
 *
 * @returns {string[]} every action the page loads, in page order
 */
function pageActions(name){
    const src = pageSource(name);
    const manifest = /id="xc-mount-manifest">([\s\S]*?)<\/script>/.exec(src);
    if(manifest){
        const entries = JSON.parse(manifest[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'));
        return entries
            .filter((e) => e.component === 'data-table' && e.props && e.props.action)
            .map((e) => e.props.action);
    }
    return [...src.matchAll(/loadDatatablesData\(\s*XC\.coin\s*,\s*'([a-z_\-]+)'/g)].map((m) => m[1]);
}

/** True when the route serves markup at all, from either source. */
function pageExists(name){
    return isComposed(name) || fs.existsSync(path.join(HTML_DIR, name));
}

/**
 * Load the component library into the shared registry, from scratch.
 *
 * The registry is a module singleton, so a suite that resets it leaves every
 * later suite in the same process with an empty one - and require() will not
 * re-run an init.js it has already cached, so the components never come back.
 * That produced a failure ("no component registered as data-table") whose cause
 * was a different file, which is exactly the kind of cross-suite coupling that
 * gets diagnosed as a real defect. Clearing the cache here makes the load
 * repeatable, and every suite that needs components should come through it.
 *
 * @param {string[]} [only]  component names, or all of them
 */
function loadComponents(only){
    const registry = require(path.join(JS_DIR, 'components.js'));
    registry.reset();
    const dir = path.join(ROOT, 'src', 'content', 'components');
    const names = only || fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory());
    for(const name of names){
        const init = path.join(dir, name, 'init.js');
        delete require.cache[require.resolve(init)];
        require(init);
    }
    return registry;
}

module.exports = {
    clientSource, formatterSource, pageSource, pageActions, isComposed, pageExists,
    shellSource, loadComponents, HTML_DIR, JS_DIR, ROOT
};
