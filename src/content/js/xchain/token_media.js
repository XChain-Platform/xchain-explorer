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

// Resolve an action reference ("action:<index>" same-chain, or
// "action:<COIN>:<index>" sibling-chain (base ticker, network tier implied
// by the page's chain, same convention as LINK COIN1/COIN2) to this
// explorer's raw FILE path. Returns false for anything else. networkCoin
// (network_coin.js) keeps the page's network: on RDOGE, 'LTC' is RLTC.
function actionRefToRawPath(ref){
    if(typeof ref !== 'string')
        return false;
    var m = ref.match(/^action:(?:(BTC|LTC|DOGE):)?([0-9]+)$/i);
    if(!m)
        return false;
    return '/' + networkCoin(m[1] || XC.coin) + '/api/file/' + m[2] + '/raw';
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

// The Artwork Information title, in precedence order: the top-level `title` a
// converted legacy document carries (legacyJsonToXChainTIS drops it from native
// TIS, which never declares it), then the first display entry carrying a TIS
// v1.1.0 `title`, then the first entry `name` (the filename). Entries come in
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

// True when url is an http(s) string. video/audio are on-chain token metadata
// (attacker-controlled) and the youtube/soundcloud branches below only test
// for a substring, which a "javascript:...//youtube" value also matches; the
// scheme check has to run before that test, not stand in for it.
function isHttpUrl(url){
    return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

// Build and show the video element, gated to an http(s) source: escapeHtml
// alone does not stop a javascript: URI, which does not need any of the five
// characters it escapes, and the youtube test below is a bare substring match
// that a "javascript:...//youtube" value also passes.
function tokenContent_displayVideo(video){
    $('#video-header').show();
    var el  = $('#video-wrapper'),
        arr = video.split('.'),
        ext = arr[arr.length-1].toLowerCase();
    if(!isHttpUrl(video)) return;
    var html;
    if(/youtube/.test(video)){
        el   = $('#video-wrapper-youtube');
        html = '<iframe src="' + escapeHtml(video) + '" frameborder="0" allowfullscreen class="embedded-video"></iframe>';
    } else {
        var type = '';
        if(ext=='mp4') type = 'video/mp4';
        if(ext=='wmv') type = 'video/x-ms-asf';
        if(ext=='mov') type = 'video/quicktime'
        // `video` is an on-chain media URL (attacker-controlled); escape it so it
        // cannot break out of the src attribute. `type` is a fixed constant above.
        html = '<video draggable="false" controls playsinline="" autoplay="" loop="" class="img-fluid img-responsive" width="100%" style="max-width:400px"><source type="' + type+ '" src="' + escapeHtml(video) + '"></video>';
    }
    el.html(html).show();
}

// Build and show the audio element, gated to an http(s) source (same reason
// as tokenContent_displayVideo above).
function tokenContent_displayAudio(audio){
    $('#audio-header').show();
    var el = $('#audio-wrapper');
    if(!isHttpUrl(audio)) return;
    var html;
    if(/soundcloud/.test(audio)){
        el = $('#audio-wrapper-soundcloud');
        html = '<iframe src="https://w.soundcloud.com/player/?url=' + escapeHtml(audio) + '" frameborder="0" allowfullscreen class="soundcloud-audio"></iframe>';
    } else {
        // `audio` is an on-chain media URL (attacker-controlled); escape it.
        html = '<audio src="' + escapeHtml(audio) + '" autoplay="true" controls loop preload></audio>';
    }
    el.html(html).show();
}
