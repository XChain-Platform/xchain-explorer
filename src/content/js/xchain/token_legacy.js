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
 * token_legacy.js
 *
 * Custom javascript for xchain explorer
 */

// Handle converting any legacy JSON to use the XChain Token Information Standard standard
// https://github.com/XChain-Platform/xchain-documentation/blob/master/protocol/token-information-standard.md
function legacyJsonToXChainTIS(o){
    var json = {},
        ipfs = /^ipfs:\/\//i,
        ar   = /^ar:/i,
        o    = (o) ? o : {};
    // Classify before the icon/gateway rewrites below touch the input.
    var legacy = tokenLegacy_isLegacy(o);
    // Map a top-level "icon" field (a common typo for "image" in community
    // JSONs) onto image so the rest of the pipeline picks it up.
    if(o.icon)
        o.image = o.icon;
    // Replace any ipfs:// urls with the URL provided by Shaban of Spells of Genesis
    if(ipfs.test(o.image))
        o.image = 'https://ipfsc.crystalsuite.com/' + String(o.image).replace(ipfs,'');
    // Replace any ar: urls with the arweave.net gateway
    if(ar.test(o.image))
        o.image = 'https://arweave.net/' + String(o.image).replace(ar,'');
    tokenLegacy_mapDetails(o, json, legacy);
    tokenLegacy_mapMedia(o, json, ipfs, ar);
    tokenLegacy_addDescriptionUrls(o, json);
    tokenLegacy_finalize(o, json);
    return json;
}

// Report whether a document carries a legacy-format field that TIS never declares.
function tokenLegacy_isLegacy(o){
    var keys = ['asset','token','icon','image','image_large','image_large_hd','image_title','pgpsig',
                'category','subcategory','category_custom','website_alternate1','website_alternate2'];
    if(typeof o !== 'object' || o === null)
        return false;
    if(typeof o.audio === 'string' || typeof o.video === 'string')
        return true;
    return Object.keys(o).some(function(k){
        return keys.indexOf(k) !== -1 || /^(contact_|website_social_)/.test(k);
    });
}

// Map identity and contact metadata in one bounded pass.
function tokenLegacy_mapDetails(o, json, legacy){
    // Pass basic token info fields forward.
    ['token','description','image','website','pgpsig','name'].forEach(function(name){ if(o[name]) json[name]=o[name]; });
    // Forward the piece's top-level display title from a legacy document only
    // (TIS declares no top-level title, so a native document titles from its entries).
    if(legacy && o.title)
        json.title = o.title;
    // Owner fields
    json.owner = {};
    if(o.owner)
        ['name','title','organization'].forEach(function(name){ if(o.owner[name]) json.owner[name]=o.owner[name]; });
    // Contacts Data
    json.contacts = (typeof o.contacts === 'object') ? o.contacts : [];
    if(o.contact_address_line_1)
        json.contacts.push({ type: 'address', data: o.contact_address_line_1 + ' ' + o.contact_address_line_2 + ', ' +  o.contact_city + ', ' +  o.contact_state_province + ' ' +  o.contact_postal_code + ' ' + o.contact_country });
    if(o.contact_email1)
        json.contacts.push({ type: 'email', data: o.contact_email1 });
    if(o.contact_email2)
        json.contacts.push({ type: 'email', data: o.contact_email2 });
    if(o.contact_phone)
        json.contacts.push({ type: 'phone', data: o.contact_phone });
    if(o.contact_fax)
        json.contacts.push({ type: 'fax', data: o.contact_fax });
    if(o.website_alternate1)
        json.contacts.push({ type: 'url', data: o.website_alternate1 });
    if(o.website_alternate2)
        json.contacts.push({ type: 'url', data: o.website_alternate2 });
    // Category Data
    json.categories = (typeof o.categories === 'object') ? o.categories : [];
    if(o.category)
        json.categories.push({ type: 'main', data: o.category });
    if(o.subcategory)
        json.categories.push({ type: 'sub', data: o.subcategory });
    if(o.category_custom)
        json.categories.push({ type: 'other', data: o.category_custom });
    // Social Media
    json.social = (typeof o.social === 'object') ? o.social : [];
    if(o.website_social_facebook)
        json.social.push({ type: 'facebook', data: o.website_social_facebook });
    if(o.website_social_github)
        json.social.push({ type: 'github', data: o.website_social_github });
    if(o.website_social_twitter)
        json.social.push({ type: 'twitter', data: o.website_social_twitter });
    if(o.website_social_reddit)
        json.social.push({ type: 'reddit', data: o.website_social_reddit });
    if(o.website_social_linkedin)
        json.social.push({ type: 'linkedin', data: o.website_social_linkedin });
}

// Normalize legacy media collections and their gateway URLs.
function tokenLegacy_mapMedia(o, json, ipfs, ar){
    // Images
    json.images = (typeof o.images === 'object') ? o.images : [];
    // Add 'image' to images array if it does not already exist
    if(o.image){
        var found = false;
        json.images.forEach(function(item){
            if(item.data==o.image)
                found = true;
        });
        if(!found)
            json.images.push({ type: 'icon', data: o.image });
    }
    if(o.image_large)
        json.images.push({ type: 'large', name: o.image_title, data: o.image_large });
    if(o.image_large_hd)
        json.images.push({ type: 'hires', name: o.image_title, data: o.image_large_hd });
    // Loop through images and rewrite any ipfs:// or ar: URLs to gateway URLs
    json.images.forEach(function(item){
        if(ipfs.test(item.data))
            item.data = 'https://ipfsc.crystalsuite.com/' + String(item.data).replace(ipfs,'');
        if(ar.test(item.data))
            item.data = 'https://arweave.net/' + String(item.data).replace(ar,'');
    });
    // Audio
    json.audio = (typeof o.audio === 'object') ? o.audio : [];
    if(o.audio!='' && typeof o.audio === 'string')
        json.audio.push({ type: o.audio.slice(-3), data: o.audio });
    // Video
    json.video = (typeof o.video === 'object') ? o.video : [];
    if(o.video!='' && typeof o.video === 'string')
        json.video.push({ type: o.video.slice(-3), data: o.video });
    // Files
    json.files = (typeof o.files === 'object') ? o.files : [];
    // DNS
    json.dns = (typeof o.dns === 'object') ? o.dns : [];
}

// Classify description URLs into the matching media collections.
function tokenLegacy_addDescriptionUrls(o, json){
    // Handle trying to extact image/video/audio data from the html description
    var urls   = String(o.description).match(/(((https?:\/\/)|(www\.))[^\s]+)/g),
        images = ['gif','jpg','jpeg','gif','png'],
        audios = ['m4a','mp3','wav'],
        videos = ['mp4','mov','wmv'];
    // Loop through any extracted urls and try to detect the content type and add to the appropriate array
    if(urls){
        urls.forEach(function(str){
            var [url, qs] = String(str).split('?'),
                url   = url.replace(/"/g,''),
                arr   = url.split('.'),
                ext   = arr[arr.length-1].toLowerCase(),
                found = false;
            // Extract images
            if(images.indexOf(ext)!=-1 && json.images){
                json.images.forEach(function(item){
                    if(item.data==url)
                        found = true;
                });
                if(!found){
                    var type = (/hires/.test(url)!=-1) ? 'hires' : 'standard';
                    json.images.push({ type: type, data: url });
                }
            }
            // Extract video
            if(videos.indexOf(ext)!=-1 && json.videos){
                json.videos.forEach(function(item){
                    if(item.data==url)
                        found = true;
                });
                if(!found)
                    json.videos.push({ type: ext, data: url });
            }
            // Extract audio
            if(audios.indexOf(ext)!=-1 && json.audio){
                json.audio.forEach(function(item){
                    if(item.data==url)
                        found = true;
                });
                if(!found)
                    json.audio.push({ type: ext, data: url });
            }
        });
    }
}

// Apply optional content and diagnostics after metadata normalization.
function tokenLegacy_finalize(o, json){
    // Pass forward the HTML tag if it exists
    if(o.html)
        json.html = o.html;
    // Token descriptions are untrusted on-chain free text and must NEVER reach an
    // .html() sink: reduce to plain text through the inert stripHtml. A denylist is
    // not an option here, being trivially bypassed (<img onerror>, <svg onload>);
    // rich descriptions, if ever wanted, need a real sanitizer.
    if(json.description){
        json.description = stripHtml(String(json.description)).trim();
    }
    if(XC.debug){
        XCLogger.log('--- Begin JSON ---');
        XCLogger.log(JSON.stringify(json));
        XCLogger.log('--- End JSON ---');

    }
}
