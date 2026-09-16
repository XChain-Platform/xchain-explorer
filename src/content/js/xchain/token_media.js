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
 * xchain.js
 *
 * Custom javascript for xchain explorer
 */

// Handle getting record type from array
function getArrayItemByType(arr, type){
    rec = false;
    arr.forEach(function(item){
        if(item.type==type && !isNull(item))
            rec = item
    });
    return rec;
}

// Handle loading remote image icon. Sets the IMG src directly so any
// image URL works (ipfs gateway, arweave, imgur, etc.). The previous
// /relay-based path only worked for .json/.png/arweave.net URLs and
// silently no-op'd on everything else. The IMG's error handler in
// token.html falls back to default.png if the URL fails to load.
function displayTokenIcon(image){
    if(image)
        $('#tokenIcon').attr('src', image);
}

// Wrap attacker-controlled custom token HTML in a minimal document for the
// sandboxed (no allow-same-origin) #customContentViewer iframe, loaded via
// srcdoc. The iframe runs in an opaque origin so this content cannot reach the
// explorer's cookies/storage/DOM; a tiny shim posts its rendered height back to
// the parent (one-way) for auto-resize. (Replaces the old same-origin
// resizeIframe(), which only worked because the iframe was NOT sandboxed.)
function buildSandboxedContentDoc(html){
    // The shim reports on load, on the frame's own resize (a width change reflows
    // the content), on a bounded set of timers for late layout, and through a
    // ResizeObserver on <body> so media that sizes itself after metadata arrives
    // (a <video>) still gets reported. Identical consecutive readings are dropped.
    var shim = '<scr' + 'ipt>(function(){var last=null;'
        + 'function post(){try{var h=document.documentElement.scrollHeight;'
        + 'if(h===last)return;last=h;'
        + 'parent.postMessage({type:"xchain-iframe-height",height:h},"*");}catch(e){}}'
        + 'window.addEventListener("load",post);'
        + 'window.addEventListener("resize",post);'
        + '[100,250,500,1000,2000].forEach(function(t){setTimeout(post,t);});'
        + 'if(window.ResizeObserver){try{new ResizeObserver(post).observe(document.body);}catch(e){}}'
        + '})();</scr' + 'ipt>';
    return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
        + String(html) + shim + '</body></html>';
}

// Decide whether a height reported by the sandboxed custom-content iframe gets
// applied, and to what. The frame reports document.documentElement.scrollHeight,
// which for content sized in % or vh IS the frame's own viewport: applying a report
// resizes the frame, the frame's resize event reports the new viewport, and honouring
// that echo grew the frame without bound (a token whose custom HTML is a
// height:100% div climbed by 16px per echo, several thousand pixels a second,
// pushing every section below it off the page). Rules:
//   - apply exactly what was reported: scrollHeight already includes the body
//     margins, so the old "+16" was a double count and the loop's step size;
//   - ignore an echo of the height already applied (within a pixel of rounding);
//   - clamp to a floor and a ceiling;
//   - stop after a bounded number of applied changes per load, so content that
//     sizes itself relative to the viewport plus a constant cannot walk the frame
//     up a pixel at a time either.
// Pure over `state` ({height, applied}, reset per load) so it is unit-testable
// without layout; the caller owns the DOM write.
var CUSTOM_CONTENT_MIN_HEIGHT  = 50;
var CUSTOM_CONTENT_MAX_HEIGHT  = 20000;
var CUSTOM_CONTENT_MAX_RESIZES = 25;
function customContentHeightToApply(state, reported){
    if(typeof reported !== 'number' || !isFinite(reported)) return null;
    if(state.applied >= CUSTOM_CONTENT_MAX_RESIZES) return null;
    var next = Math.round(Math.min(Math.max(reported, CUSTOM_CONTENT_MIN_HEIGHT), CUSTOM_CONTENT_MAX_HEIGHT));
    if(state.height !== null && Math.abs(next - state.height) < 2) return null;
    state.height = next;
    state.applied++;
    return next;
}

// Handle updating a table row with data removing the row
function updateTokenTableRow(id=null, value=false, html=false){
    if(id){
        var el = $(id);
        if(el){
            // Update element with value if we have one
            if(value && !isNull(value)){
                if(html){
                    el.html(html);
                } else {
                    el.text(value);
                }
                // Set flags to indicate if we found token info
                XC.tokenInfoFound     = true;
                XC.someTokenInfoFound  = true;
            } else {
                el.parent().remove();
            }
        }
    }
}

// Handle updating a token section to display and reset token info found flag
function updateTokenSection(id){
    if(XC.tokenInfoFound){
        let el = $(id);
        if(el){
            el.show();
        }
        // Reset the token info found flag for the next section
        XC.tokenInfoFound = false;
    }
}

// Resolve a DECLARED base ticker (BTC/LTC/DOGE, as an on-chain payload carries it) to
// this deployment's coin id for that chain, keeping the page's network tier: on RDOGE,
// 'LTC' is RLTC and mainnet's prefix is '' by design. A record that declares no coin,
// or one outside the three base chains, falls back to the page coin - which is the
// same-chain assumption every caller of this rule already made explicitly.
function siblingCoin(base){
    // Same network tier as the current page: RBTC + DOGE -> RDOGE, etc.
    var tier = (XC.coin.match(/^([TR])(BTC|LTC|DOGE)$/) || [])[1] || '';
    var m    = (typeof base === 'string') ? base.match(/^(BTC|LTC|DOGE)$/i) : null;
    return m ? (tier + m[1].toUpperCase()) : XC.coin;
}

// Resolve an action reference ("action:<index>" same-chain, or
// "action:<COIN>:<index>" sibling-chain (base ticker, network tier implied
// by the page's chain, same convention as LINK COIN1/COIN2) to this
// explorer's raw FILE path. Returns false for anything else.
function actionRefToRawPath(ref){
    if(typeof ref !== 'string')
        return false;
    var m = ref.match(/^action:(?:(BTC|LTC|DOGE):)?([0-9]+)$/i);
    if(!m)
        return false;
    return '/' + siblingCoin(m[1]) + '/api/file/' + m[2] + '/raw';
}

// Resolve TIS `data_ref` entries across the media arrays. A data_ref of
// "action:<index>" points at an on-chain FILE action; clients prefer it over
// `data` when both are present (Token_Information_Standard.md, File Entry
// Fields). Resolves to the explorer's own raw FILE endpoint. Also guarantees
// every entry carries a string `data` so downstream substring/split calls are
// safe on data_ref-only entries.
function resolveTisDataRefs(o){
    ['images','audio','video','files'].forEach(function(key){
        if(!o[key] || !o[key].length)
            return;
        o[key].forEach(function(item){
            if(!item)
                return;
            var path = (typeof item.data_ref === 'string') ? actionRefToRawPath(item.data_ref) : false;
            if(path)
                item.data = path;
            if(isNull(item.data))
                item.data = '';
        });
    });
    return o;
}

// Lock marker for token-gated TIS entries (`locked: true`). Lets media lists
// render a locked state without fetching the FILE action first.
function lockedContentIcon(item){
    return (item && item.locked) ? '<i class="fa fa-lock pe-1" title="Token-gated content: holders decrypt with their unlock key"></i>' : '';
}

// Pick the entry whose media should display from a TIS media array: prefer the
// named display types (legacy CoinDaddy/TIS type tags), then fall back to the
// first non-locked entry (gated entries are ciphertext and cannot render).
function pickDisplayMedia(arr, types){
    for(var i=0; i<types.length; i++){
        var item = getArrayItemByType(arr, types[i]);
        if(item && !item.locked)
            return item;
    }
    for(var j=0; j<arr.length; j++){
        if(arr[j] && !arr[j].locked)
            return arr[j];
    }
    return false;
}

// The Artwork Information title, in precedence order: the document's top-level
// `title` (what community JSONs write for the piece as a whole), then the first
// display entry carrying a TIS v1.1.0 `title`, then the first entry `name`
// (the filename, the only thing the old code read). Entries come in
// image, audio, video order so a picture's caption wins over a soundtrack's.
// Measured live: a token whose display image came from the legacy image_large field
// (no name) fell through to its audio filename and titled the artwork "BADGUY.mp3".
function resolveArtworkTitle(topTitle, entries){
    var present = function(v){ return v !== undefined && v !== null && String(v).trim() !== ''; };
    if(present(topTitle))
        return String(topTitle);
    var list = entries || [];
    for(var i=0; i<list.length; i++){
        if(list[i] && present(list[i].title))
            return String(list[i].title);
    }
    for(var j=0; j<list.length; j++){
        if(list[j] && present(list[j].name))
            return String(list[j].name);
    }
    return false;
}
