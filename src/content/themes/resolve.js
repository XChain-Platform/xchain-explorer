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
 * XChain Explorer - theme resolution
 *
 ********************************************************************/

'use strict';

const fs   = require('fs');
const path = require('path');

const THEMES_DIR    = __dirname;
const COOKIE_NAME   = 'xc_theme';
const HARD_FALLBACK = 'classic';
const THEME_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const TOKENS_LINK_RE = /<link[^>]*href="\/themes\/classic\/tokens\.css"[^>]*>/;

function validThemeName(name){
    return typeof name === 'string' && THEME_NAME_RE.test(name);
}

function readThemeJson(themesDir, name){
    if(!validThemeName(name)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(themesDir, name, 'theme.json'), 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch(_){
        return null;
    }
}

function hasTokens(themesDir, name){
    try {
        return fs.statSync(path.join(themesDir, name, 'tokens.css')).isFile();
    } catch(_){
        return false;
    }
}

function resolveChain(themesDir, name){
    const seen = new Set();
    const chain = [];
    let current = name;

    while(current){
        if(!validThemeName(current) || seen.has(current) || !hasTokens(themesDir, current))
            return null;
        seen.add(current);

        const metadata = readThemeJson(themesDir, current);
        if(!metadata) return null;
        chain.unshift(current);

        if(metadata.extends === undefined || metadata.extends === null || metadata.extends === '')
            current = null;
        else if(validThemeName(metadata.extends))
            current = metadata.extends;
        else
            return null;
    }

    return chain.length ? chain : null;
}

function readCookie(cookieHeader, name){
    if(!cookieHeader) return null;
    for(const part of String(cookieHeader).split(';')){
        const separator = part.indexOf('=');
        if(separator === -1 || part.slice(0, separator).trim() !== name) continue;
        const value = part.slice(separator + 1).trim();
        try {
            return decodeURIComponent(value);
        } catch(_){
            return value;
        }
    }
    return null;
}

function tokensHrefs(chain){
    return chain.map((name) => '/themes/' + name + '/tokens.css');
}

function resolveForRequest(options){
    const opts = options || {};
    const themesDir = opts.themesDir || THEMES_DIR;
    const onFallback = typeof opts.onFallback === 'function' ? opts.onFallback : () => {};
    const queryTheme = typeof opts.queryTheme === 'string' ? opts.queryTheme.trim() : '';
    const cookieTheme = readCookie(opts.cookieHeader, COOKIE_NAME);
    const requested = queryTheme || (cookieTheme && cookieTheme.trim()) || null;
    const defaultTheme = typeof opts.defaultThemeName === 'string' && opts.defaultThemeName.trim()
        ? opts.defaultThemeName.trim()
        : HARD_FALLBACK;

    let chain = requested ? resolveChain(themesDir, requested) : null;
    if(requested && !chain)
        onFallback(requested, defaultTheme);

    if(!chain){
        chain = resolveChain(themesDir, defaultTheme);
        if(!chain && defaultTheme !== HARD_FALLBACK){
            onFallback(defaultTheme, HARD_FALLBACK);
            chain = resolveChain(themesDir, HARD_FALLBACK);
        }
    }

    if(!chain) chain = [HARD_FALLBACK];
    return {
        name: chain[chain.length - 1],
        chain,
        hrefs: tokensHrefs(chain)
    };
}

function applyToHtml(html, options){
    const theme = resolveForRequest(options);
    const links = theme.hrefs.map((href) =>
        '<link type="text/css"  rel="stylesheet" href="' + href + '">'
    ).join('\n    ');
    return html.replace(TOKENS_LINK_RE, () => links);
}

module.exports = {
    THEMES_DIR,
    COOKIE_NAME,
    HARD_FALLBACK,
    readThemeJson,
    resolveChain,
    readCookie,
    tokensHrefs,
    resolveForRequest,
    applyToHtml
};
