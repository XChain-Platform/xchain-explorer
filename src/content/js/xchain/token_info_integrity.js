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
 ********************************************************************/

'use strict';

function tokenInfo_hex(bytes){
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function tokenInfo_fetchPinnedJson(url, expectedHash){
    if(typeof fetch !== 'function' || !globalThis.crypto || !globalThis.crypto.subtle)
        throw new Error('metadata integrity API unavailable');
    const response = await fetch(url);
    if(!response.ok) throw new Error('metadata fetch failed');
    const bytes = await response.arrayBuffer();
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    if(tokenInfo_hex(digest) !== expectedHash){
        const error = new Error('metadata integrity mismatch');
        error.code = 'TOKEN_METADATA_HASH_MISMATCH';
        throw error;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
}

function tokenInfo_integrityFailure(){
    showTokenContent();
    $('#token-metadata-integrity-error').remove();
    $('#token-description').after(
        '<div id="token-metadata-integrity-error" class="alert alert-warning mt-2">'
        + 'Token metadata failed its integrity check.</div>'
    );
}

function tokenInfo_loadPinnedContent(jsonUrl, coin, tick, expectedHash){
    tokenInfo_fetchPinnedJson(jsonUrl, expectedHash).then(showTokenContent).catch(function(error){
        if(error && error.code === 'TOKEN_METADATA_HASH_MISMATCH'){
            tokenInfo_integrityFailure();
            return;
        }
        $.getJSON(tokenInfo_relayUrl(jsonUrl, coin, tick), showTokenContent)
            .fail(tokenInfo_integrityFailure);
    });
}

if(typeof window !== 'undefined')
    window.tokenInfo_loadPinnedContent = tokenInfo_loadPinnedContent;

if(typeof module !== 'undefined' && module.exports)
    module.exports = { tokenInfo_fetchPinnedJson };
