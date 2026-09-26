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
 * token_info.js
 *
 * Custom javascript for xchain explorer
 */

// Render a token's/address's controller bindings (protocol/controller-bound-tokens.md)
// into a table body, revealing the card when at least one binding is gating.
// `controllers` is the API's `controllers` array; bodyId/cardId are element ids.
// Each row: action class, linked guard contract, cooldown, Active/Unbinding badge.
// Render the files a token has LINKed to itself (LINK v0, the NFT pattern) into a table
// body, revealing the card only when the token actually carries one. `files` is getToken's
// linked_files array. A GATED file's bytes need a token balance, so it is labelled rather
// than offered as a raw link that would refuse the reader.
function renderLinkedFiles(files, bodyId, cardId){
    if(!files || !files.length)
        return;
    let html = '';
    files.forEach(function(f){
        let idx   = Number(f.action_index);
        let raw   = f.gated
            ? '<span class="badge text-bg-secondary">gated</span>'
            // The bytes are served from the API route (XChainExplorer.js registers
            // /:coin/api/file/:actionIndex/raw); there is no page-level /file/ route, and
            // linking one 404s with the HTML shell rather than the file.
            : '<a href="/' + XC.coin + '/api/file/' + idx + '/raw" target="_blank">raw bytes</a>';
        // title/name/type are on-chain, author-controlled free text; escape all three
        // (formatLink escapes the title).
        html += '<tr>'
             +  '<td>' + formatLink('/' + XC.coin + '/action/' + idx, nullToBlank(f.title)) + '</td>'
             +  '<td>' + escapeHtml(nullToBlank(f.name)) + '</td>'
             +  '<td>' + escapeHtml(nullToBlank(f.type)) + '</td>'
             +  '<td>' + numeral(Number(f.block_index)).format('0,0') + '</td>'
             +  '<td>' + raw + '</td>'
             +  '</tr>';
    });
    $('#' + bodyId).html(html);
    $('#' + cardId).show();
}

function renderControllerBindings(controllers, bodyId, cardId){
    if(!controllers || !controllers.length)
        return;
    let html = '';
    controllers.forEach(function(c){
        let cls      = escapeHtml(String(c.action_class));
        let contract = formatLink('/' + XC.coin + '/contract/' + Number(c.contract_index), Number(c.contract_index));
        let cooldown = numeral(c.cooldown_blocks).format('0,0') + ' block' + (Number(c.cooldown_blocks)==1 ? '' : 's');
        // is_unbind=1 rows are still gating only during their drop cooldown.
        let badge    = (Number(c.is_unbind)===1)
            ? '<span class="badge text-bg-warning">Unbinding</span>'
            : '<span class="badge text-bg-success text-white">Active</span>';
        html += '<tr><td>' + cls + '</td><td>' + contract + '</td><td>' + cooldown + '</td><td>' + badge + '</td></tr>';
    });
    $('#' + bodyId).html(html);
    $('#' + cardId).show();
}

// Render a token's open governance polls (VOTE v0, poll_status='open') into the
// token page's Active Governance card, revealing it when at least one poll is
// open. Voter apathy is the classic governance attack surface, so open polls
// (binding ones especially: their result fires a contract method) are surfaced
// on the token itself rather than only on the global /polls list.
// `polls` is getToken's open_polls array; bodyId/cardId are element ids.
function renderOpenPolls(polls, bodyId, cardId){
    if(!polls || !polls.length)
        return;
    let html = '';
    polls.forEach(function(p){
        let question = isNull(p.question) ? '-' : escapeHtml(String(p.question));
        let closes   = formatLink('/' + XC.coin + '/block/' + Number(p.end_block), numeral(p.end_block).format('0,0'));
        let binding  = isNull(p.callback_contract_index)
            ? '<span class="badge text-bg-secondary">Advisory</span>'
            : formatLinkHtml('/' + XC.coin + '/contract/' + Number(p.callback_contract_index),
                '<span class="badge text-bg-danger">Binding</span>',
                'Binding poll: finalization calls contract ' + Number(p.callback_contract_index));
        let view     = formatLink('/' + XC.coin + '/action/' + Number(p.action_index), 'view', null, true);
        html += '<tr><td>' + formatLink('/' + XC.coin + '/action/' + Number(p.action_index), Number(p.action_index))
             +  '</td><td>' + question + '</td><td>' + closes + '</td><td>' + binding + '</td><td>' + view + '</td></tr>';
    });
    $('#' + bodyId).html(html);
    $('#' + cardId).show();
}

// Compose project membership and ownership notices together.
function tokenInfo_renderProjectBanners(o){
    // Project registry surfaces (protocol/project-registry.md). Both surfaces
    // render as green banners in #project-banners, the full-width row under
    // the Token Information / Market Information cards.
    let projectBanners = '';
    // projects = registries whose current owner-attested roster includes this
    // token → banner that ALWAYS names the attesting project (the banner's
    // weight comes from the project's identity, never a bare checkmark).
    // Tick names are consensus-restricted but escaped anyway.
    if(o.projects && o.projects.length){
        o.projects.forEach(function(p){
            let name = escapeHtml(p.project);
            projectBanners += '<div class="alert alert-success mb-1" role="alert">'
                 +  '<i class="fa fa-certificate pe-1"></i>This token is an official token in the '
                 +  formatLinkHtml(tokenUrl(XC.coin, p.project), '<b>' + name + '</b>', p.project)
                 +  ' project.'
                 +  '<a href="/' + XC.coin + '/action/' + Number(p.link_action_index) + '" class="float-end small" title="View the on-chain roster attestation">attestation</a>'
                 +  '</div>';
        });
    }
    // registry = this token IS a project with an attested official-token
    // roster → ownership banner linking to the roster, and reveal the
    // Official Tokens tab
    if(o.registry){
        projectBanners += '<div class="alert alert-success mb-1" role="alert">'
             +  '<i class="fa fa-certificate pe-1"></i>This token is the owner of the <b>' + escapeHtml(o.info.tick) + '</b> project. '
             +  '<a href="#" id="registry-link">View its ' + numeral(o.registry.total).format('0,0') + ' official token' + (o.registry.total==1?'':'s') + '</a>.'
             +  '<a href="/' + XC.coin + '/action/' + Number(o.registry.link_action_index) + '" class="float-end small" title="View the on-chain roster attestation">attestation</a>'
             +  '</div>';
        $('#tab-dropdown-project').removeClass('d-none');
    }
    if(projectBanners){
        $('#project-banners').html(projectBanners).removeClass('d-none');
        // The banner's roster link opens the Official Tokens tab
        $('#registry-link').click(function(e){
            e.preventDefault();
            $('#tab-dropdown-project').click();
        });
    }
}

// Render the token summary cards from one consistent snapshot.
function tokenInfo_renderSummary(o, desc, fmtCoin, fmtFiat){
    // Controller bindings (protocol/controller-bound-tokens.md): guard contracts
    // that gate this token's native actions. Hidden until at least one is gating.
    renderControllerBindings(o.controllers, 'token-controllers-body', 'token-controllers-card');

    // Open governance polls over this token. Hidden until at least one is open.
    renderOpenPolls(o.open_polls, 'token-governance-body', 'token-governance-card');

    // Files LINKed to this token (the NFT pattern). The Files tab already lists them, but
    // a reader looking at the info column was told "No additional information is available"
    // beside a token carrying on-chain artwork, so the link had no surface where it counts.
    renderLinkedFiles(o.linked_files, 'token-linked-files-body', 'token-linked-files-card');

    $('#supply').text(formatAmount(o.supply.current));
    $('#max-supply').text(formatAmount(o.supply.max));
    $('#max-mint').text(formatAmount(o.mints.max));
    $('#owner').html(formatLink('/' + XC.coin + '/address/' + o.info.owner, o.info.owner));
    $('#token-description').text(desc);

    // Marketcap and Pricing Information
    $('.xchain-coin').text(o.info.coin);
    $('#market-price-coin').text(numeral(o.market.price).format(fmtCoin));
    $('#market-price-fiat').text(numeral(bcmul(o.market.price, XC.coin_price, 2)).format(fmtFiat));
    $('#market-floor-coin').text(numeral(o.market.floor).format(fmtCoin));
    $('#market-floor-fiat').text(numeral(bcmul(o.market.floor, XC.coin_price, 2)).format(fmtFiat));
    var mcap = bcmul(o.market.price, o.supply.current, 8);
    $('#market-marketcap-coin').text(numeral(mcap).format(fmtCoin));
    $('#market-marketcap-fiat').text(numeral(bcmul(mcap, XC.coin_price, 2)).format(fmtFiat));

    // Callback Token Information
    if(!isNull(o.callback.tick)){
        $('#callback-tick').html(formatLink(tokenUrl(XC.coin, o.callback.tick), o.callback.tick));
        $('#callback-block').html(formatLink('/' + XC.coin + '/block/' + o.callback.block, numeral(o.callback.block).format('0,0')));
        if(o.callback.amount){
            $('#callback-amount').text(formatAmount(o.callback.amount));
            $('#callback-price-coin').text(numeral(bcmul(o.callback.amount, o.callback.price, 8)).format(fmtCoin));
        }
    }

    // Locks 
    $('#lock-max-supply').html(showLockStatus(o.locks.max_supply));
    $('#lock-max-mint').html(showLockStatus(o.locks.max_mint));
    $('#lock-mint').html(showLockStatus(o.locks.mint));
    $('#lock-mint-supply').html(showLockStatus(o.locks.mint_supply));
    $('#lock-description').html(showLockStatus(o.locks.description));
    $('#lock-sleep').html(showLockStatus(o.locks.sleep));
    $('#lock-callback').html(showLockStatus(o.locks.callback));    
}

// Handle displaying token details
function showTokenInfo(){
    // Setup short alias to token info object
    let o = XC.tokenInfo;

    // Setup short alias for token description
    var desc  = o.info.description;

    // Define the various numeral formats to use
    let fmtCoin  = '0,0.00000000',
        fmtFiat  = '0,0.00';

    // Basic Token Information
    $('.xchain-tick').text(o.info.tick);

    tokenInfo_renderProjectBanners(o);

    tokenInfo_renderSummary(o, desc, fmtCoin, fmtFiat);

    let description = tokenInfo_prepareDescription(desc);
    let jsonUrl = tokenInfo_getJsonUrl(description);
    tokenInfo_loadContent(jsonUrl);
}

// Prepare description links and the patterns needed for content loading.
function tokenInfo_prepareDescription(desc){
    // RegExp for pattern matching in description
    let json    = /^(.*).json/i,
        http    = /^http:\/\//,
        https   = /^https:\/\//,
        ord     = /^ord:/i,
        ipfs    = /^ipfs:/i,
        ar      = /^ar:/i,
        arweave = /^https?:\/\/arweave\.net\//i,
        // On-chain TIS document: DESCRIPTION = "action:<index>" (same chain)
        // or "action:<COIN>:<index>" (sibling chain) pointing at a FILE
        // action whose bytes are the TIS JSON
        // (Token_Information_Standard.md, On-Chain Format).
        act     = /^action:(?:(BTC|LTC|DOGE):)?([0-9]+)$/i;

    // Rescue arweave URLs that used the legacy "/x.json" trick (gateway no longer accepts random suffixes)
    if(typeof desc === 'string')
        desc = desc.replace(/^(https?:\/\/arweave\.net\/[^\/?#]+)\/x\.json$/i, '$1');

    // If the file starts with http and end with JSON, then assume it is valid url and link it
    if(json.test(desc)||http.test(desc)||https.test(desc)){
        // arr[0]/arr[1] are user-controlled description text. Escape both the
        // href (against attribute breakout) and the visible text (against tag
        // injection); getValidUrl already constrains the scheme.
        var arr  = desc.split(';'),
            html = '<a href="' + escapeHtml(getValidUrl(arr[0])) + '" target="_blank">' + escapeHtml(arr[0]) + '</a>';
        if(arr[1])
            html += ';' + escapeHtml(arr[1]);
        $('#token-description').html(html);
    }

    // On-chain TIS document pointer: show a link to the FILE action that
    // holds the token's information document (on its own chain for the
    // cross-chain form). Coin + index are regex-validated, so the href is
    // safe by construction.
    if(act.test(desc)){
        var actM    = desc.match(act),
            actCoin = networkCoin(actM[1] || XC.coin);
        $('#token-description').html(
            '<a href="/' + actCoin + '/action/' + actM[2] + '" title="Token information stored on-chain (' + actCoin + ' FILE action ' + actM[2] + ')">'
            + escapeHtml(desc) + '</a>'
        );
    }
    return { desc: desc, json: json, ord: ord, ipfs: ipfs, ar: ar, arweave: arweave, act: act, arr: arr };
}

// Resolve a supported description into its fetch target.
function tokenInfo_getJsonUrl(info){
    let desc = info.desc, json = info.json, ord = info.ord, ipfs = info.ipfs,
        ar = info.ar, arweave = info.arweave, act = info.act, arr = info.arr;
    // Set the full url to get JSON content
    let jsonUrl = false;
    if(act.test(desc)){
        // Same-origin raw FILE bytes from the colocated decoder DB;
        // resolution target for an on-chain TIS document (same- or
        // sibling-chain per the action ref).
        jsonUrl = actionRefToRawPath(desc.trim());
    } else if(json.test(desc) || ipfs.test(desc) || ord.test(desc) || ar.test(desc) || arweave.test(desc)){
        if(ipfs.test(desc)){
            // Same gateway the server resolves ipfs: through (IPFS_GATEWAY in
            // src/icons/resolver.js) and the same one this file already rewrites
            // ipfs:// image entries to below. Pointing the page somewhere else
            // makes it render icons the downloader could not fetch, and vice
            // versa. The optional // is stripped here too, so the ipfs://HASH
            // form does not land as a double-slashed path the gateway 404s.
            jsonUrl = 'https://ipfsc.crystalsuite.com/' + String(desc).replace(/^ipfs:(\/\/)?/i,'');
        } else if(ord.test(desc)){
            var hash = String(desc).replace(ord,'');
            if(hash.length!=64)
                hash = base64ToHex(hash);
            jsonUrl = 'https://inscription-decoder.vercel.app/api/image?type=json&tx=' + hash;
        } else if(ar.test(desc)){
            jsonUrl = 'https://arweave.net/' + String(desc).replace(ar,'');
        } else if(arweave.test(desc)){
            jsonUrl = desc;
        } else {
            jsonUrl = 'https://' + arr[0].replace('https://','').replace('http://','');
        }
    }
    return jsonUrl;
}

// Load token content through the direct and relay fallbacks.
function tokenInfo_loadContent(jsonUrl){
    // Handle trying to load any JSON content and show the token content
    if(jsonUrl){
        if(XC.debug)
            XCLogger.log('Attempting to get JSON...');
        // Try to make a request for the JSON directly (might fail due to missing CORS headers)
        $.getJSON( jsonUrl, function(o){ 
            showTokenContent(o);
        }).fail(function(){
            if(XC.debug)
                XCLogger.log('failed to get JSON... retrying using xchain-explorer relay')
            // Try to request the JSON through the xchain relay
            $.getJSON( '/relay?url=' + jsonUrl, function(o){ 
                showTokenContent(o);
            });
        }); 
    } else {
        showTokenContent();
    }
}
