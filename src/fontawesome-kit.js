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
 * XChain Explorer - Font Awesome kit config injection 
 *
 * A Font Awesome kit is loaded by two things: the vendored kit loader
 * (content/js/fontawesome-kit-loader.js) and an account config object,
 * window.FontAwesomeKitConfig, which carries the kit TOKEN. The token is an
 * account-scoped credential and the Pro license flag is an entitlement claim,
 * so neither may live in a public repo: they are supplied per deployment via
 * the environment and injected here, in front of the loader, when
 * /js/fontawesome-kit.js is requested.
 *
 * With no token configured the route serves an inert stub. The UI still
 * renders: the network/coin glyphs in the navbar are local CSS background
 * images (content/css/xchain.css), not kit icons, so only the generic
 * Font Awesome glyphs are missing.
 *
 ********************************************************************/

const fs   = require('fs');
const path = require('path');

const LOADER_FILE = path.join(__dirname, 'content', 'js', 'fontawesome-kit-loader.js');

// Global the vendored loader reads its account config from. Fixed by Font
// Awesome, not by us.
const CONFIG_GLOBAL = 'FontAwesomeKitConfig';

// Kit behaviour flags that are not account-specific and carry no entitlement
// claim. These reproduce the settings the kit was previously published with,
// so a deployment only has to supply the credential half.
const KIT_DEFAULTS = Object.freeze({
    asyncLoading:         { enabled: false },
    autoA11y:             { enabled: true  },
    baseUrl:              'https://ka-p.fontawesome.com',
    baseUrlKit:           'https://kit.fontawesome.com',
    uploadsUrl:           'https://kit-uploads.fontawesome.com',
    detectConflictsUntil: null,
    iconUploads:          {},
    method:               'css',
    minify:               { enabled: true },
    v4FontFaceShim:       { enabled: true },
    v4shim:               { enabled: true },
    v5FontFaceShim:       { enabled: true }
});

const DEFAULT_VERSION = '6.4.0';

// Every operator-supplied value ends up inside a <script> body, so each is
// pinned to a conservative shape rather than trusted and escaped. A value that
// fails its pattern is dropped (with a warning) instead of being sanitised,
// because a malformed kit id is a misconfiguration, not something to guess at.
const TOKEN_RE   = /^[A-Za-z0-9]{6,64}$/;
const ID_RE      = /^[0-9]{1,12}$/;
const VERSION_RE = /^[0-9]{1,3}(\.[0-9]{1,3}){1,2}$/;
const CSS_PATH_RE = /^[A-Za-z0-9._/-]{1,200}$/;

// Font Awesome ships two entitlements. 'free' is the default because a
// deployment that has not stated otherwise has no Pro seat to spend.
const LICENSES = new Set(['free', 'pro']);

function warnOnce(warned, message){
    if(warned.has(message)) return;
    warned.add(message);
    console.warn('[fontawesome-kit] ' + message);
}
const warned = new Set();

/**
 * Read the kit settings out of an environment. Returns null when no usable
 * token is configured, which is the "kit disabled" state.
 */
function readKitSettings(env = process.env){
    const token = (env.EXPLORER_FONTAWESOME_KIT_TOKEN || '').trim();
    if(!token)
        return null;
    if(!TOKEN_RE.test(token)){
        warnOnce(warned, 'EXPLORER_FONTAWESOME_KIT_TOKEN is not a valid kit token; kit disabled');
        return null;
    }

    const settings = { token };

    const id = (env.EXPLORER_FONTAWESOME_KIT_ID || '').trim();
    if(id){
        if(ID_RE.test(id)) settings.id = parseInt(id, 10);
        else warnOnce(warned, 'EXPLORER_FONTAWESOME_KIT_ID is not numeric; ignored');
    }

    const license = (env.EXPLORER_FONTAWESOME_KIT_LICENSE || '').trim().toLowerCase();
    if(license && !LICENSES.has(license))
        warnOnce(warned, 'EXPLORER_FONTAWESOME_KIT_LICENSE must be "free" or "pro"; defaulting to free');
    settings.license = LICENSES.has(license) ? license : 'free';

    const version = (env.EXPLORER_FONTAWESOME_KIT_VERSION || '').trim();
    if(version && !VERSION_RE.test(version))
        warnOnce(warned, 'EXPLORER_FONTAWESOME_KIT_VERSION is not a version string; using ' + DEFAULT_VERSION);
    settings.version = VERSION_RE.test(version) ? version : DEFAULT_VERSION;

    const cssPath = (env.EXPLORER_FONTAWESOME_KIT_CUSTOM_ICONS_PATH || '').trim();
    if(cssPath){
        if(CSS_PATH_RE.test(cssPath)) settings.customIconsCssPath = cssPath;
        else warnOnce(warned, 'EXPLORER_FONTAWESOME_KIT_CUSTOM_ICONS_PATH has unexpected characters; ignored');
    }

    return settings;
}

/**
 * Build the full window.FontAwesomeKitConfig value, or null when disabled.
 */
function buildKitConfig(env = process.env){
    const settings = readKitSettings(env);
    if(!settings) return null;
    return Object.assign({}, KIT_DEFAULTS, settings);
}

// JSON is not a subset of HTML: a "</script" inside any string value would end
// the element early. Escaping the three characters that can start a tag or a
// comment keeps the payload inert wherever it is embedded.
function toScriptSafeJson(value){
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
}

/**
 * The config prologue that runs ahead of the vendored loader. Empty string
 * when no kit is configured.
 */
function renderConfigPrologue(env = process.env){
    const config = buildKitConfig(env);
    if(!config)
        return '';
    return 'window.' + CONFIG_GLOBAL + ' = ' + toScriptSafeJson(config) + ';\n';
}

const DISABLED_STUB =
    '// Font Awesome kit not configured for this deployment.\n' +
    '// Set EXPLORER_FONTAWESOME_KIT_TOKEN (see .env.example) to enable it; the kit\n' +
    '// token is a deploy-time credential and is never committed .\n';

let loaderSource = null;

function readLoader(){
    if(loaderSource === null)
        loaderSource = fs.readFileSync(LOADER_FILE, 'utf8');
    return loaderSource;
}

/**
 * Full body served at /js/fontawesome-kit.js.
 */
function renderKitScript(env = process.env){
    const prologue = renderConfigPrologue(env);
    if(!prologue)
        return DISABLED_STUB;
    return prologue + readLoader();
}

/**
 * Express handler for /js/fontawesome-kit.js. Registered ahead of the /js
 * static mount so the composed script wins over anything on disk.
 */
function serve(req, res){
    let body;
    try {
        body = renderKitScript(process.env);
    } catch (err){
        console.error('[fontawesome-kit] could not render kit script: ', err);
        res.status(500).type('application/javascript').send('// Font Awesome kit unavailable\n');
        return;
    }
    // A configured body carries the kit token, so it is cacheable by the
    // browser that asked for it but never by a shared cache.
    res.set('Cache-Control', body === DISABLED_STUB ? 'public, max-age=3600' : 'private, max-age=300');
    res.type('application/javascript').send(body);
}

// Test hook: the loader is read once and cached for the process lifetime.
function _resetCache(){
    loaderSource = null;
    warned.clear();
}

module.exports = {
    CONFIG_GLOBAL,
    KIT_DEFAULTS,
    DEFAULT_VERSION,
    DISABLED_STUB,
    LOADER_FILE,
    readKitSettings,
    buildKitConfig,
    renderConfigPrologue,
    renderKitScript,
    serve,
    _resetCache
};
