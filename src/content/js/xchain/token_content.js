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
 * token_content.js
 *
 * Custom javascript for xchain explorer
 */

// Handle displaying token content (images, audio, video, etc)
function showTokenContent(json){
    // Convert any legacy formated JSON to the new XChain Token Information Standard (TIS)
    json = legacyJsonToXChainTIS(json);

    // Resolve any on-chain data_ref entries to raw FILE URLs
    json = resolveTisDataRefs(json);

    // Cache JSON so we can easily reference it again when needed
    cachedJson = json;

    // Create short alias to json object
    let o = json;

    // Placeholders to indicate if there is audio/video/image/title content
    var audio = false,
        video = false,
        image = false,
        title = false;
    // The display entry each media section settled on; resolveArtworkTitle reads
    // their title/name fields once all three sections have run.
    var imageItem = false,
        audioItem = false,
        videoItem = false;

    tokenContent_renderMetadata(o);

    [imageItem, image, audioItem, audio] = tokenContent_renderImageAudio(o, imageItem, image, audioItem, audio);

    [videoItem, video, title] = tokenContent_renderVideoFilesDns(o, videoItem, video, imageItem, audioItem, title);

    tokenContent_displayIcon(o);

    [audio, video, image, title] = tokenContent_parseDescription(audio, video, image, title);

    tokenContent_displayArtwork(image, audio, video);

    tokenContent_bindCustomContent(o);

    // Hide the "No additional information is available" section
    if(XC.someTokenInfoFound)
        $('#additionalInfoNotAvailable').hide();
}
// Render descriptive metadata before selecting display media.
function tokenContent_renderMetadata(o){
    // Basic Token Information
    var main  = getArrayItemByType(o.categories, 'main'),
        sub   = getArrayItemByType(o.categories, 'sub'),
        other = getArrayItemByType(o.categories, 'other');
    updateTokenTableRow('#tokenName', o.name);
    // o.website is on-chain token metadata (attacker-controlled). Escape both the
    // href and the visible text so a value like `x" onmouseover="…` or
    // `"><img src=x onerror=…>` cannot break out of the attribute / tag.
    updateTokenTableRow('#tokenWebsite', o.website, '<a href="' + escapeHtml(getValidUrl(o.website)) + '" target="_blank">' + escapeHtml(o.website) + '</a>');
    updateTokenTableRow('#pgpSignature', o.pgpsig);
    updateTokenTableRow('#tokenCategory', main.data);
    updateTokenTableRow('#tokenSubCategory', sub.data);
    updateTokenTableRow('#tokenCategoryOther', other.data);
    updateTokenTableRow('#tokenExtendedDescription', o.description);
    updateTokenSection('#additionalTokenInfo');

    // Owner Information
    updateTokenTableRow('#ownerName', o.owner.name);
    updateTokenTableRow('#ownerTitle', o.owner.title);
    updateTokenTableRow('#ownerOrganization', o.owner.organization);
    updateTokenSection('#ownerInfo');

    // Contacts)
    if(o.contacts.length){
        var table = $('#contactInfo table tbody');
        table.empty();
        o.contacts.slice(0,10).forEach(function(item){
            // item.type/item.data are on-chain token metadata (attacker-controlled);
            // escape both before they reach the .append() HTML sink.
            var type = item.type.toLowerCase(),
                t    = escapeHtml(item.type),
                d    = escapeHtml(item.data),
                html = '<tr><th>' + t + '</th><td>' + d + '</td></tr>';
            if(type=='email')
                html = '<tr><th>' + t + '</th><td><a href="mailto:'+ d + '">' + d + '</a></td></tr>'
            if(type=='phone'||type=='fax')
                html = '<tr><th>' + t + '</th><td><a href="tel:'+ d + '">' + d + '</a></td></tr>'
            if(type=='url')
                html = '<tr><th>' + t + '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + d + '</a></td></tr>'
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#contactInfo');
    }

    // Social Media
    if(o.social.length){
        var table = $('#socialInfo table tbody');
        table.empty();
        o.social.slice(0,10).forEach(function(item){
            // On-chain fields: escape type, href and link text.
            let html = '<tr><th>' + escapeHtml(item.type) + '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#socialInfo');
    }
}
// Render image and audio tables while returning display selections.
function tokenContent_renderImageAudio(o, imageItem, image, audioItem, audio){
    // Images
    if(o.images.length){
        var table = $('#imagesInfo table tbody');
        table.empty();
        o.images.slice(0,10).forEach(function(item){
            if(item.data.substring(0,4)=='data')
                return;
            // On-chain fields: escape type, size, href and link text.
            let html = '<tr><th>' + lockedContentIcon(item) + escapeHtml(item.type);
            if(item.size)
                html += ' (' + escapeHtml(String(item.size)) + ')';
            html += '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#imagesInfo');
        // Extract the display image from the images array; named display types
        // first, then the first non-locked entry (fixes the old `first.data`
        // dereference of a string, which hid the artwork for plain TIS docs
        // whose entries carry MIME types instead of display-type tags)
        imageItem = pickDisplayMedia(o.images, ['large','standard']);
        if(imageItem)
            image = imageItem.data;
    }

    // Audio
    if(o.audio.length){
        var table = $('#audioInfo table tbody');
        table.empty();
        o.audio.slice(0,10).forEach(function(item){
            let html = '<tr><th>' + lockedContentIcon(item) + escapeHtml(item.type) + '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#audioInfo');
        // Extract the display audio from the audio array
        audioItem = pickDisplayMedia(o.audio, ['m4a','mp3','wav']);
        if(audioItem)
            audio = audioItem.data;
    }
    return [imageItem, image, audioItem, audio];
}
// Render remaining collection tables while returning the video selection.
function tokenContent_renderVideoFilesDns(o, videoItem, video, imageItem, audioItem, title){
    // Video
    if(o.video.length){
        var table = $('#videoInfo table tbody');
        table.empty();
        o.video.slice(0,10).forEach(function(item){
            let html = '<tr><th>' + lockedContentIcon(item) + escapeHtml(item.type) + '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#videoInfo');
        // Extract the display video from the videos array
        videoItem = pickDisplayMedia(o.video, ['mp4','mov','wmv']);
        if(videoItem)
            video = videoItem.data;
    }
    title = resolveArtworkTitle(o.title, [imageItem, audioItem, videoItem]);

    // Files
    if(o.files.length){
        var table = $('#fileInfo table tbody');
        table.empty();
        o.files.slice(0,10).forEach(function(item){
            let html = '<tr><th>' + lockedContentIcon(item) + escapeHtml(item.type) + '</th><td><a href="'+ escapeHtml(getValidUrl(item.data)) + '" target="_blank">' + escapeHtml(item.data) + '</a></td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#fileInfo');
    }

    // DNS
    if(o.dns.length){
        var table = $('#dnsInfo table tbody');
        table.empty();
        table.append('<tr><th>Type</th><th>Host</th><th>Value</th></tr>')
        o.dns.slice(0,10).forEach(function(item){
            // On-chain DNS record fields: escape all three.
            var html = '<tr><td>' + escapeHtml(item.type) + '</td><td>' + escapeHtml(item.host) + '</td><td>' + escapeHtml(item.value) + '</td></tr>';
            table.append(html);
            XC.tokenInfoFound = true;
        });
        updateTokenSection('#dnsInfo');
    }
    return [videoItem, video, title];
}
// Select and display the preferred token icon.
function tokenContent_displayIcon(o){
    // Token Icon
    var icon = false;
    if(o.images.length){
        // First try to find 64x64 icon
        o.images.forEach(function(item){
            if(!icon && item.type=='icon' && item.size=='64x64')
                icon = item.data;
        });
        // Failover to try to find 48x48 icon
        o.images.forEach(function(item){
            if(!icon && item.type=='icon' && item.size=='48x48')
                icon = item.data;
        });
        // If we couldn't find an icon, use the first icon in the list
        o.images.forEach(function(item){
            if(!icon && item.type=='icon')
                icon = item.data;
        });
    }
    // Use legacy "image" param if we couldn't find icon in the CIP25 images array
    if(!icon && o.image)
        icon = o.image;
    // Handle displaying token icon image
    if(icon)
        displayTokenIcon(icon);
}

// Resolve fallback media and normalize the artwork title.
function tokenContent_parseDescription(audio, video, image, title){
    // Setup short alias to token description
    var desc = $('#token-description').text();

    // If we do not already have any audio/video/image content defined, check if this is one of the TIS defined formats
    // https://github.com/XChain-Platform/xchain-documentation/blob/master/protocol/token-information-standard.md#supported-token-description-formats
    if(!audio && !video && !image){
        // Cleanup description a bit to remove leading/trailing spaces and some funky characters
        desc = desc.trim().replace('\u001e','');
        if(/^(imgur|youtube|soundcloud)/i.test(desc)){
            // service/info;title format parsing
            var [url, title, xtra] = desc.split(';'),
                [service, code]    = url.split('/'),
                title              = (xtra) ? title + ';' + xtra: title,
                service            = service.toLowerCase();
            // Cleanup some bad formats
            if(service=='imgur.com')
                service = 'imgur';
            // Handle decoding some common characters
            if(title)
                title = title.replace('&#39;',"'");
            if(service=='imgur')
                image = 'https://i.imgur.com/' + code;
            if(service=='youtube')
                video = 'https://www.youtube.com/embed/' + code;
            if(service=='soundcloud')
                audio = 'https://api.soundcloud.com/tracks/' + code;
            if(XC.debug)
                XCLogger.log('service, code, title', service, code, title);
        }
    }

    // Handle processing descriptions that include urls
    if(!audio && !video && !image){
        if(/http/.test(desc) || /i\.imgur\.com/.test(desc)){
            var [url, qs] = desc.split('?'), // Ignore any querystring data
                arr = url.split('.'),
                url = desc,
                ext = arr[arr.length-1].toLowerCase();
            if(url.indexOf('http')==-1)
                url = 'http://' + url;
            // Handle images
            var images = ['gif','jpg','jpeg','gif','png'],
                audios = ['m4a','mp3','wav'],
                videos = ['mp4','mov','wmv'];
            if(images.indexOf(ext)!=-1)
                image = url;
            if(audios.indexOf(ext)!=-1)
                audio = url;
            if(videos.indexOf(ext)!=-1)
                video = url;
        }
    }        

    // If we have a title, display it
    title = (title) ? String(title).replace('&#39;',"'") : null;
    updateTokenTableRow('#artwork-title', title);
    updateTokenSection('#artwork-information');
    return [audio, video, image, title];
}

// Display resolved artwork through its media-specific elements.
function tokenContent_displayArtwork(image, audio, video){
    // If we have any image/audio/video content, display it
    if(image||audio||video){
        if(image){
            $('#artwork-header').show();
            var el = $('#artwork-image');
            // image is derived from on-chain token metadata; only allow http(s)
            // URLs into the src attribute so a javascript:/data: URI can't land there.
            var safeImage = String(image);
            if(safeImage.startsWith('http://') || safeImage.startsWith('https://'))
                // .attr() sets through the DOM API, not markup, so no HTML parser later
                // un-escapes entities the way the video/audio src sinks above rely on.

                // STRIP the tag/attribute-breakout characters rather than entity-escaping
                // them: a real URL is percent-encoded and never carries a literal <, >, "
                // or ' (unlike '&', which separates query params), so a benign URL is
                // unaffected while a payload loses its markup bytes.
                el.attr('src', safeImage.replace(/[<>"']/g, ''));
            el.show();
        }
        if(video) tokenContent_displayVideo(video);
        if(audio) tokenContent_displayAudio(audio);
        // Display the 'Digital Artwork' sections
        XC.tokenInfoFound = true;
        XC.someTokenInfoFound = true;
        updateTokenSection('#digitalArtInfo');
    }
}

// Bind custom content loading and bounded iframe resizing.
function tokenContent_bindCustomContent(o){
    // Display any custom HTML content (with a warning before loading)
    if(o.html && !isNull(o.html)){
        XC.someTokenInfoFound = true;
        $('#custom-content-header').show();
        $('#custom-content-wrapper').show();
        // Handle loading custom content when the user clicks the "Load Content" button.
        // Inject via srcdoc into the sandboxed iframe (it has no allow-same-origin, so
        // el.contents() is cross-origin and unreachable). The content renders in an
        // opaque origin and cannot touch the explorer's cookies/storage/DOM.
        $('#loadCustomContentButton').click(function(){
            $('#customContentWarning').hide();
            var el = $('#customContentViewer');
            // Fresh resize budget per load (see customContentHeightToApply).
            XC.customContentResize = { height: null, applied: 0 };
            el.attr('srcdoc', buildSandboxedContentDoc(cachedJson.html));
            el.show();
        });
        // Auto-resize from the sandboxed iframe's own height reports (postMessage).
        // Bound once; strictly validates the source frame, message type, and a finite
        // numeric height, and does nothing else with the message (no injection/eval).
        // The echo/ceiling/budget guards live in customContentHeightToApply.
        if(!XC.customContentResizeBound){
            XC.customContentResizeBound = true;
            window.addEventListener('message', function(e){
                var iframe = document.getElementById('customContentViewer');
                if(!iframe || e.source !== iframe.contentWindow) return;
                var d = e.data;
                if(!d || d.type !== 'xchain-iframe-height') return;
                if(!XC.customContentResize) XC.customContentResize = { height: null, applied: 0 };
                var next = customContentHeightToApply(XC.customContentResize, d.height);
                if(next !== null)
                    $(iframe).height(next);
            });
        }
    }
}
