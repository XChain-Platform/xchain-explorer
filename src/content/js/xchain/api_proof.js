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

// Load an action's rows directly from the API and hand the response to callback;
// query/type narrow the results to one address/block/etc when given.
// errback (optional) is called instead of callback when the request does not
// produce a usable body: a non-2xx status, a transport failure, or a 200 whose
// body carries an `error`. A caller that arms an in-flight flag before calling
// MUST pass one, or that flag never clears.
// coin, action, query and type mean the same as for loadDatatablesData above, and
// callback receives the parsed response. For example:
//   loadApiData('BTC', 'block', '862623', null, cb) loads one block;
//   loadApiData('BTC', 'address', '1JDogZS6tQcSxwfxhv6XKKjcyicYA4Feev', 'address', cb)
//     loads the address actions for one address;
//   loadApiData('BTC', 'address', '862623', 'block', cb) loads those in one block.
function loadApiData(coin, action, query, type, callback, errback){
    // Set the API endpoint name based on the action
    let endpoint = null;
    if(['history','block','network','token','action','status','transaction','market','markets'].includes(action) || (action=='address' && type==null)){
        endpoint = action;
    } else if(['address','batch','order_match','swap_match','cross_chain_match'].includes(action)){
        // These take '-es', not '-s'; the three *_match names would otherwise build
        // malformed endpoints ('cross_chain_matchs') that answer 404.
        endpoint = action + 'es';
    } else if(action=='validator_capability'){
        // action+'s' would give the malformed 'validator_capabilitys'; the hub table
        // (and its /api route) is 'validator_capabilities'. Kept in step with the same
        // branch in loadDatatablesData: the two maps are written separately and have
        // drifted before, and a detail fetch that 404s here logs nothing a reader sees.
        endpoint = 'validator_capabilities';
    } else if(action=='consensus_state'){
        // consensus_state is a mass noun (no plural 's'); its /api route keeps the
        // singular table name.
        endpoint = 'consensus_state';
    } else {
        endpoint = action + 's';
    }
    // Set the explorer API url
    let url = '/' + coin + '/api/' + endpoint;
    if(query || action=='history' || action=='block')
        url += '/' + query;
    if(type)
        url += '/' + type;
    if(XC.debug)
        XCLogger.log('Requesting API data from endpoint ' + url);
    // Make request to get the API data and return to the callback function
    let req = $.getJSON(url, function(o){
        if(o.error){
            XCLogger.log('caught error=',o.error);
            if(typeof errback==='function')
                errback(o, null);
        } else {
            if(typeof callback==='function')
                callback(o);
        }
    });
    // jQuery always answers with a jqXHR here; the guard is for the test doubles that
    // stand in for $.getJSON and return nothing.
    if(!req || typeof req.fail !== 'function')
        return;
    req.fail(function(xhr){
        // jQuery routes every non-2xx here, so the success handler above never runs
        // for a 503 COIN_DATA_STALE (served while a coin's indexed tip is stale), a
        // 404, or a dropped connection. Callers that set an in-flight flag before
        // calling were left with it set for the life of the page, which wedged every
        // later request behind a retry loop that never issued one.
        if(XC.debug)
            XCLogger.log('API request failed: ' + url + ' (' + ((xhr && xhr.status) ? xhr.status : 'no response') + ')');
        if(typeof errback==='function')
            errback((xhr && xhr.responseJSON) ? xhr.responseJSON : null, xhr);
    });
}

// Rendered state for a proof widget that did not get a proof. Tone follows the
// reason: an unarmed height or a missing checkpoint is expected on a young chain
// and reads as information, a stale mirror or a rate-limit as a warning, and only
// an unexpected failure reads as an error.
function proofNotice(tone, text){
    return '<span class="badge text-bg-' + tone + '">' + escapeHtml(String(text)) + '</span>';
}

// Turn a proof route's refusal into something a reader can act on. The routes
// answer typed codes rather than prose, and each one means a specific, normal
// thing: 409 = the height is below the slot's arming boundary (or its block was
// never checkpointed), 404 = no signed checkpoint covers this height yet, 503 =
// the hub mirror is too stale to answer, 429 = the per-IP proof cap. Anything
// else falls through to the server's own message.
function proofRefusal(status, body){
    let code = (body && body.code) ? String(body.code) : '';
    let msg  = (body && body.error) ? String(body.error) : 'Proof unavailable';
    if(status==429)
        return ['warning', 'Too many proof requests, try again shortly'];
    if(status==503)
        return ['warning', 'Consensus data is stale on this node: ' + msg];
    if(status==409)
        return ['info', code=='ACTION_BLOCK_NOT_CHECKPOINTED'
            ? 'Not provable yet: this action\'s block has no signed checkpoint'
            : 'Not provable yet: ' + msg];
    if(status==404)
        return ['info', msg];
    return ['danger', msg];
}

// Shared fetch + render for the SPV proof widgets. Deliberately NOT built on
// loadApiData: that helper logs an error response and never calls back, and
// rendering the refusal is the whole point of a proof widget. `render` receives
// the parsed proof and returns the HTML for it; it is responsible for escaping
// anything that came from the server.
function loadProofWidget(url, target, render){
    let $el = $(target);
    if(!$el.length)
        return;
    $el.html('<span class="text-muted">Requesting proof...</span>');
    $.ajax({ url: url, dataType: 'json' })
        .done(function(o){
            try {
                $el.html(render(o));
            } catch(e){
                if(XC.debug)
                    XCLogger.log('proof render failed for ' + url, e);
                $el.html(proofNotice('danger', 'Could not render this proof'));
            }
        })
        .fail(function(xhr){
            let body = (xhr && xhr.responseJSON) ? xhr.responseJSON : {};
            let [tone, text] = proofRefusal(xhr ? xhr.status : 0, body);
            $el.html(proofNotice(tone, text));
        });
}

// Handle converting null values in an object to empty strings
function null2string(obj){
    if(obj === null)
        return '';
    if(typeof obj === 'object' && !Array.isArray(obj)){
        const newObj = {};
        for(const key in obj){
          if(Object.prototype.hasOwnProperty.call(obj, key))
            newObj[key] = null2string(obj[key]);
        }
        return newObj;
    }
    if(Array.isArray(obj))
        return obj.map(item => null2string(item));
    return obj;
}
